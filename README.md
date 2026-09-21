# DCP clause finder: image RAG

Given a NSW street address, show every Development Control Plan (DCP) page that applies to that
property, for the most image-heavy DCP in the state, using **page images** as the unit of retrieval
(PixelRAG) instead of extracted text.

Two halves, and plain vector search only does one of them:

| Half | Decided by | Built from |
|---|---|---|
| **Applicable** | the property's facts (zone, lot size, heritage, bushfire, flood...) | address -> parcel -> planning layers, then a SQL filter. Deterministic, no LLM |
| **Relevant** | what the user asks ("can I build a granny flat") | visual vector search over page images |

Structure first, embeddings second. The question this project answers: **for the other 125 councils,
when is the image path worth its cost, and how can we tell from the PDF alone?**

## Status

| Phase | | State |
|---|---|---|
| 0 | Setup: SvelteKit, Docker Postgres + pgvector, WSL2 PixelRAG environment | done |
| 1 | Address -> property facts (`src/lib/server/property.js`) | done |
| 2 | Rank NSW DCPs by image share, pick the LGA | done: Port Macquarie-Hastings |
| 3 | Hand-built eval set (10 addresses + expected clauses) | next |
| 4 | Render pages, PixelRAG index, tile -> page map | |
| 5 | Applicability rules + LLM tagging + SQL filter (no embeddings) | |
| 6 | Visual rank + score floor | |
| 7 | UI | |
| 8 | markitdown text baseline vs image path | |
| 9 | Write-up | |

## Phase 2: which DCP? (measured, not guessed)

**Method.** The NSW Planning Portal register (`/DCP`, a static HTML list, no API) has 561 links; 379 are in-force,
374 of those are PDFs totalling 5.7 GB. Pass 1 read each file's size with `HEAD` (no download). The shortlist is
in-force PDFs of at least 15 MB, drafts / map-only / precinct-only files excluded (a map-only file is trivially 100% image),
one PDF per council (the largest), top 25 by size = 2.1 GB. Pass 2 downloaded those and measured every page with PyMuPDF
(`scripts/pdf_stats.py`: characters of text, raster images at least 200x200 px, share of the page they cover, vector paths).

**Definition.** A page is *image-dominated* if pictures cover 30%+ of it, or it has under 200 characters of text **and** a
graphic (a big raster or 5+ vector paths). Defined once in `scripts/lib/score.js`.

| # | Council | Pages | MB | Image-dominated | Note |
|---|---|---|---|---|---|
| 1 | Campbelltown | 397 | 70 | 41% | **Disqualified.** Volume 2 is seven site-specific precinct plans (Minto, Glenfield, UWS, Edmondson Park...), not a general DCP |
| 2 | **Port Macquarie-Hastings** | 489 | 52 | 33% | **Chosen.** Whole-council DCP 2013 as amended June 2021, 1,196 bookmarks |
| 3 | Maitland | 893 | 71 | 30% | Whole-council, Parts A-F |
| 4 | Marrickville | 1,396 | 126 | 29% | Merged into Inner West in 2016 |
| 5 | The Hills | 1,233 | 179 | 26% | |
| 6 | Ryde | 1,347 | 102 | 25% | |
| 7 | Inner West (Ashfield) | 965 | 66 | 25% | |
| 8 | Parramatta | 1,621 | 95 | 25% | |
| 9 | Cessnock | 2,112 | 135 | 23% | 2013 amendment |
| 10 | Lake Macquarie | 1,167 | 117 | 22% | |

Full table for all 25: `data/dcp_ranking.csv`. Sampled pages of the chosen DCP are real figures (lot-orientation diagrams,
Port Macquarie Town Centre block plans with footprints and setbacks, stormwater plans): in text extraction each collapses to a caption.

**What Phase 2 found**
- The exercise's literal rule ("any raster over 200x200, or under 200 characters") is polluted by page furniture: logos and
  backgrounds put a big raster on 78% of Marrickville's pages and 89% of Inner West's, though only about 25-30% of their pages
  are image-dominated. Campbelltown is #1 under 4 of the 5 definitions in `score.js`; the literal one is the outlier.
- My first definition counted any short text page as "image-dominated" and wrongly ranked Willoughby #2 (29% of its pages are
  plain short text with no graphics). Requiring graphic evidence moved it to #24. A synthetic PDF with a known answer and a unit
  test now guard this.
- "Largest Part" is the wrong pick rule for a split DCP: it chose Campbelltown's site-specific volume. A candidate must be a
  whole-council DCP with general and zone-based parts, which is what the applicability filter needs.
- Signals from the PDF alone (n=25, all large files, so range-restricted; treat as a first look): total size ρ=0.52 and MB per
  page ρ=0.43 with image-dominated share; page count 0.13; median text per page 0.25. InDesign-made files scored *lower*
  (12%, n=2) than Acrobat-processed ones (21%, n=19): "designed document" is not the same as "image-heavy".
- The register is partly stale: many "in-force" copies are 2013-2018 amendments, and merged councils (Marrickville, Leichhardt,
  Ashfield, Armidale Dumaresq...) no longer match current LGA names.
- **The state flood-planning layer covers only 10 of ~128 LGAs** (Bathurst Regional, Clarence Valley, Forbes, Hornsby,
  Mid-Western Regional, Tamworth Regional, Wentworth, Wingecarribee, Wollongong, Yass Valley), so Port Macquarie-Hastings has no
  state flood data. `property.js` now reports `flood: null` plus `not_covered: ['flood']` there, never `false`.

**Indexed version:** Port Macquarie-Hastings DCP 2013, as amended June 2021, the only in-force copy on the register.

## Run it

```bash
docker compose up -d          # Postgres 16 + pgvector on localhost:5433
npm install
cp .env.example .env          # then add OPENAI_API_KEY (needed from Phase 5)
npm test                      # ~90 tests, no network needed (recorded ArcGIS fixtures)
node scripts/try_address.js "15 Ellalong St, Pelaw Main"     # live lookup
```

PixelRAG runs in WSL2 Ubuntu (Python 3.12 venv, pinned in `requirements-wsl.txt`), CPU only.

## What Phase 1 found (differs from the exercise spec)

- The geocoder stores `15 ELLALONG STREET PELAW MAIN` (street type spelled out, no comma/state), so
  addresses are normalised first (`address.js`).
- Geocoder `address = 'X'` takes 6-7 s; a prefix `LIKE 'X%'` takes 0.2 s.
- Lot `Shape__Area` is degrees squared and `planlotarea` is often null, so area is computed from the
  polygon (`geo.js`, within 0.03% of an independent metric-CRS calculation).
- Bushfire, flood and LGA are not in `EPI_Primary_Planning_Layers`; see the layer table in `property.js`.
- The NSW gateway returns bursts of 502s. One retry, a mirror layer for flood, and a layer that is still
  down becomes `unknown`, never `false`. Partial results are never cached.
- Flood planning polygons do not exist for Cessnock in this dataset (they do for Wollongong, Bathurst,
  Wingecarribee, Hornsby), so the chosen LGA must be checked for flood coverage.
- A missing address returns suggestions, never a neighbouring lot's facts.
- Outside the 10 LGAs with state flood polygons, "no polygon" is a data gap, so flood is `null` + `not_covered`, not `false` (found in Phase 2).

## Layout

```
src/lib/server/   address.js  arcgis.js  geo.js  property.js  property-cache.js  db.js
scripts/          try_address.js  find_addresses.js  record_fixtures.js  list_flood_lgas.js
                  collect_dcp_register.js  rank_dcps.js  pdf_stats.py  inspect_pdf.py  lib/(score, dcp_index, wsl)
sql/              01_schema.sql   (dcp, dcp_page, property_facts)
test/             unit tests + recorded ArcGIS fixtures
```
