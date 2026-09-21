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
| 1 | Address -> property facts (`src/lib/server/property.js`) | done, 54 tests |
| 2 | Rank NSW DCPs by image share, pick the LGA | next |
| 3 | Hand-built eval set (10 addresses + expected clauses) | |
| 4 | Render pages, PixelRAG index, tile -> page map | |
| 5 | Applicability rules + LLM tagging + SQL filter (no embeddings) | |
| 6 | Visual rank + score floor | |
| 7 | UI | |
| 8 | markitdown text baseline vs image path | |
| 9 | Write-up | |

## Run it

```bash
docker compose up -d          # Postgres 16 + pgvector on localhost:5433
npm install
cp .env.example .env          # then add OPENAI_API_KEY (needed from Phase 5)
npm test                      # 54 tests, no network needed (recorded ArcGIS fixtures)
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

## Layout

```
src/lib/server/   address.js  arcgis.js  geo.js  property.js  property-cache.js  db.js
scripts/          try_address.js  find_addresses.js  record_fixtures.js
sql/              01_schema.sql   (dcp, dcp_page, property_facts)
test/             unit tests + recorded ArcGIS fixtures
```
