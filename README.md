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

The 2026-09-21 supervisor meeting changed the goal: use the **Hornsby** DCP, and build a **chat** that answers "can I build X at
this address?" with reasons and clause numbers, judged later by professional planners (who supply the tests). Get it running
first, then share a Vercel link.

| Step | | State |
|---|---|---|
| 0 | Setup: SvelteKit, Docker Postgres + pgvector, WSL2 PixelRAG environment | done |
| 1 | Address -> property facts (`src/lib/server/property.js`), works in Hornsby | done |
| 2 | Rank NSW DCPs by image share | done, then superseded: Danny chose Hornsby |
| 3 | Hornsby DCP 2024 + PixelRAG 10-page test on CPU | done, see below |
| 4 | Index all 489 pages on a free Colab GPU (`notebooks/hornsby_index_colab.ipynb`) | done: 1,956 vectors, 16 MB (`data/hornsby/index_full`) |
| 5 | Chat brain: facts + retrieved page images -> answer citing clause and page (`src/lib/server/chat.js`, try it with `scripts/ask.js`) | done as a CLI, tested on the full index |
| 6 | Chat UI (`src/routes/+page.svelte`, `/api/ask`) | done, tested in-browser |
| 7 | Deploy (Fly.io search server + Vercel app) | in progress, see `deploy/pixelrag/README.md` |

## Hornsby DCP 2024 + PixelRAG: first test

Source: Hornsby Shire Council, "Hornsby Development Control Plan 2024" book version, updated 26 June 2026 (42 MB, 489 pages, 832
bookmarks). The council site returns 403 to scripts, so the PDF is downloaded by hand into `data/hornsby/raw/hdcp-2024.pdf`.
Its ten Parts map to page ranges (`scripts/inspect_pdf.py parts`): General p9-59, Rural 60-107, Residential 108-210,
Business 211-314, Industrial 315-329, Subdivision 330-343, Community 344-364, River Settlements 365-399, Heritage 400-467,
Annexures 468-489. Danny's "clause 126.1" (trees) is clause **1.2.6.1 Tree Preservation** (p17).

**Image share:** 29% of pages are image-dominated (Danny estimated ~20%): Business 50%, Residential 37%, General only 4%.

**PixelRAG on CPU** (base `Qwen3-VL-Embedding-2B`, float32, no screenshot adapter: the adapter only works on PixelRAG's GPU backend):
each page becomes 4 chunks; **14.4 s per chunk**, so all 489 pages (1,956 chunks) would take about **7.8 hours**. Model download
4.27 GB, one time. Queries take under a second. Every chunk maps back to its page and carries its x/y position, so we can cite
pages and highlight regions. Test index: 10 pages (`data/hornsby/index_sample`).

| Question | Top page | Expected |
|---|---|---|
| parking spaces per dwelling, Hornsby town centre | **p37** (0.57, next best 0.50) | p37, Danny's map + Tier 1/2 table |
| can I remove or cut down a tree | **p17** (0.41, next 0.35) | p17 Tree Preservation |
| where can townhouses or high density be built | p294, p209, p177, **p111 is 4th** | p111 Housing Strategy Precincts map |
| how do I bake bread | best score 0.23 | nothing relevant (real questions scored 0.39-0.57) |

Caveats: 10 pages only, so rankings will get harder at 489; the score floor needs calibrating on the full index.

## The chat brain (first live results, 10-page index)

`node scripts/ask.js "16 Dural Street, Hornsby" "<question>"` runs the whole chain: address -> property facts (server side) ->
the model calls one tool, `search_dcp(query)`, which asks PixelRAG for pages -> the page **images** go to the model
(OpenAI Responses API, `gpt-5.6-terra`) -> an answer that cites PDF page and clause. Safety rules, all unit-tested: the property
is decided by the server, never by the model; the tool takes only a search phrase; at most 5 search rounds; a property outside
Hornsby never reaches the model; a page image is sent once; a page number in the answer that was not retrieved is flagged;
unknown facts (service down, or no state data) are shown as NOT KNOWN / NOT COVERED, never as "no".

| Question | Result |
|---|---|
| How many parking spaces for a 2-bedroom apartment? | Found p37 (Danny's Tier 1/2 map + Table 1.3.2-d): 0.8 (Tier 1) or 1 (Tier 2) per dwelling, plus visitors; said it cannot place the lot on the Tier map. 37k tokens (before de-duplicating images) |
| I want to cut down a large backyard tree, do I need approval? | Found p17, clause 1.2.6.1(a)-(c) and Table 1.2.6-a: probably yes unless exempt species; said species is unknown. 6k tokens |

Ideas noted for later: the NSW planning services include a tree-canopy layer, which could give the model a real "trees on this lot"
fact for Danny's "there is a tree on the lot" example; the search score floor (0.30) still needs calibrating on the full index.

## Full 489-page index: retrieval results

Built on a free Colab T4 (`--device auto`, base model, fp16). The 10-page GPU index gave the same rankings as the CPU index
(scores within 0.001). Checked with `node scripts/eval_retrieval.js` (11 real questions whose right pages come from the PDF's
bookmarks and Danny's meeting, plus 5 nonsense questions; answer key in `test/retrieval_questions.json`):

| | Result |
|---|---|
| Right page is the top result | 7 of 11 |
| Right page in the top 3 / top 5 / top 10 | 9 / 11 / 11 of 11 |
| Best score for real questions | 0.446 - 0.576 |
| Best score for nonsense ("how do I bake bread" ...) | 0.296 - 0.351 |

- The "nothing relevant" score floor moved from 0.30 (tuned on 10 pages, where nonsense scored 0.23) to **0.40**: with 489 pages
  nonsense scores higher, and 0.30 would have let it through. Small sample; re-run the evaluation when the index or model changes.
- Weak spots: "cut down a tree" only reaches the main clause page (p17) by rank 5 in a raw search, because 234 pages mention
  trees; the chat recovers because the model rephrases and searches several times. (Hybrid search over the PDF text layer would likely fix this
  but would no longer be a pure image test.)
- One apparent miss was my labelling error: for the townhouse question the answer key listed only the precinct map (p111), but
  pages 124-125 (section 3.2 Medium Density Housing, "town houses") are equally valid. The key was corrected after inspection and says so.

Live answers on the full index (`scripts/ask.js`, 16 Dural Street, Hornsby, R4):
- Tree removal: cites p17 clause 1.2.6.1(a)-(c), p18 exemptions (d)-(e), p19 Table 1.2.6-b (Tree Permit); "probably yes" and lists what
  it cannot know. 60k tokens.
- "Can I build townhouses on this lot?": notices the DCP ties its townhouse section 3.2 to the **R3** zone (p15, Table 1.2.1-b, checked against
  the page) while this lot is R4, says permissibility is an LEP question it has no data for, and refuses a definite yes. Before the
  search cap it ran 9 searches and 150k tokens; with `MAX_SEARCHES = 4` it uses 35k (about $0.05-0.10) with the same conclusion, slightly less detail.
- Cost reference: OpenAI's usage page showed $0.14 for the first two 10-page-index questions.

## Chat UI

`/api/ask` (POST `{address, question, previousResponseId?}`) wires the address box to the whole pipeline: property
facts (server-computed and cached; the client never supplies facts, only the address text) -> `chat.js` -> a trimmed
JSON response (no internal ids/coordinates). `/dcp-page/[page]` serves one rendered page as PNG, page number validated
1-489 before any filesystem access. The page (`src/routes/+page.svelte`) is an address box, a question box, and a
conversation view with the model's Markdown rendered properly (`src/lib/markdown.js`: a small hand-written renderer,
not a dependency, that escapes all input before adding any tag) and the cited pages shown as clickable-size images,
with a follow-up composer that carries `previousResponseId`.

Verified in the browser against the live stack (Postgres + full 489-page PixelRAG index + OpenAI), not just mocks: a
first question, a follow-up in the same conversation, and an out-of-Hornsby address (correctly refused with no model
call). No console errors.

## Deployment

Two services, since the search server needs ~8.8 GB RAM (measured live) and Vercel functions cap
at 2-4 GB (verified on Vercel's docs) on any plan, and there is no real hosted PixelRAG API to use
instead (pixelrag.ai has no way to point it at a custom index). Full steps, verified pricing and
the one known limitation (the search server has no auth - low risk, the only data behind it is the
public DCP): **`deploy/pixelrag/README.md`**.

- **Search server**: Fly.io, `deploy/pixelrag/Dockerfile` (Caddy in front of `pixelrag serve`,
  one public port; the model and the 489 rendered pages are baked into the image so a fresh
  machine never depends on Hugging Face being reachable). `fly.toml` at the project root.
- **Chat app**: Vercel, unchanged code; `PIXELRAG_URL` set switches it from localhost + local disk
  to the Fly URL + fetching page images over HTTP (`src/lib/server/dcp_search.js`'s `pagesSource`).
- **Database**: Neon via Vercel Marketplace (`vercel install neon`) - its pooled `DATABASE_URL` is
  exactly the variable `db.js` already reads, so no code changes needed there.

## Phase 2 (superseded by the meeting): which DCP? (measured, not guessed)

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
src/lib/server/   address.js  arcgis.js  geo.js  property.js  property-cache.js  db.js  chat.js  dcp_search.js
src/lib/          markdown.js
src/routes/       +page.svelte  api/ask/+server.js  dcp-page/[page]/+server.js
scripts/          ask.js  eval_retrieval.js  pixelrag_sample.sh  pixelrag_serve.sh  pixelrag_query.js
                  try_address.js  find_addresses.js  record_fixtures.js  list_flood_lgas.js
                  collect_dcp_register.js  rank_dcps.js  pdf_stats.py  inspect_pdf.py  lib/(score, dcp_index, wsl)
sql/              01_schema.sql   (dcp, dcp_page, property_facts)
test/             unit tests + recorded ArcGIS fixtures
```
