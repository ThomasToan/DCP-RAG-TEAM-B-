CREATE EXTENSION IF NOT EXISTS vector;

-- Which document and version the pages came from.
CREATE TABLE dcp (
  id         serial PRIMARY KEY,
  lga        text NOT NULL,
  title      text NOT NULL,
  version    date NOT NULL,          -- amendment date of the consolidated copy
  source_url text
);

-- The unit of retrieval is a PAGE, not a clause.
CREATE TABLE dcp_page (
  id          bigserial PRIMARY KEY,
  dcp_id      int  NOT NULL REFERENCES dcp(id),
  page_no     int  NOT NULL,
  image_path  text NOT NULL,          -- data/<lga>/pages/0123.png
  tile_ids    text[] NOT NULL,        -- PixelRAG tile ids for this page
  part        text,                   -- from the table of contents page ranges
  clause_nos  text[],                 -- clause ids detected on the page, if any
  applies     jsonb NOT NULL DEFAULT '{}',  -- FINAL applicability: rules merged over llm_tags
  llm_tags    jsonb,                  -- raw vision-model tags, kept so re-merging never re-spends API budget
  tagged_at   timestamptz,
  UNIQUE (dcp_id, page_no)
);
CREATE INDEX ON dcp_page USING gin (tile_ids);
CREATE INDEX ON dcp_page USING gin (applies);

-- Per-address fact bundle cache (ArcGIS is slow and rate-limited). 30-day TTL enforced in code.
CREATE TABLE property_facts (
  address_key text PRIMARY KEY,       -- normalised address
  facts       jsonb NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);
