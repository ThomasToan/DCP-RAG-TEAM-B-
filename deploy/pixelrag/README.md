# Deploying: Fly.io (search server) + Vercel (chat app)

Two services, because the search model needs ~9 GB RAM and Vercel functions cap at 2-4 GB
(verified on Vercel's own docs) — it cannot run there on any plan. There is also no real hosted
PixelRAG API to point at instead (pixelrag.ai is a docs/demo site, not a service that takes a
custom index). So: the chat app goes on Vercel as normal, and the search server goes on Fly.io,
talking to each other over one environment variable, `PIXELRAG_URL`.

Verified before writing this: search server RAM = **8.8 GB** measured live (`ps aux` on the
running process), cold start = **24 s** with the model already cached, a query once warm =
under 1-2 s.

## 1. The search server (Fly.io) — do this first

You need a Fly.io account (**requires a credit card**) and the `flyctl` CLI. This is the one part
that costs real money, though for occasional demo use with auto-stop it should be a few dollars
at most, not the $22/month full-time rate (Fly's own pricing: $0.0309/hour for the 8 GB machine
this needs, billed only while it's actually running).

```bash
# 1. Install flyctl (see https://fly.io/docs/flyctl/install/ for your OS), then:
fly auth signup   # or: fly auth login

# 2. From the PROJECT ROOT (so the build sees data/hornsby/*):
fly apps create dcp-hornsby-search   # pick a different name if this one is taken;
                                      # update `app = "..."` in fly.toml to match
fly deploy

# 3. If flyctl complains about `memory_mb` in fly.toml, deploy without it, then:
fly scale memory 8192 -a dcp-hornsby-search
```

`fly deploy` builds the Docker image (downloads the ~4.3 GB model during the build — this step
alone can take 10-20 minutes depending on your connection) and starts the machine. When it
finishes, note the URL it prints, something like `https://dcp-hornsby-search.fly.dev`.

**Check it worked:**
```bash
curl https://dcp-hornsby-search.fly.dev/health
curl -X POST https://dcp-hornsby-search.fly.dev/search -H 'content-type: application/json' \
  -d '{"queries":[{"text":"car parking rates"}],"n_docs":5}'
curl -I https://dcp-hornsby-search.fly.dev/pages/p0037.png   # should be HTTP 200, image/png
```

The first request after any idle period takes ~25 s (the machine was stopped and has to load the
model back into memory) — that's expected, not a bug.

## 2. The chat app (Vercel)

```bash
npm i -g vercel        # if you don't have it
vercel login
vercel link            # run from the project root

# database: Neon's pooled DATABASE_URL is exactly the env var db.js already reads - no code change
vercel install neon

# secrets
vercel env add OPENAI_API_KEY production
vercel env add PIXELRAG_URL production     # paste the Fly URL from step 1, no trailing slash

vercel --prod
```

After the first deploy, run the schema against the new database once (get the connection string
with `vercel env pull` or from the Neon dashboard):
```bash
psql "$DATABASE_URL" -f sql/01_schema.sql
```

## What changes between local dev and production

| | Local dev | Production |
|---|---|---|
| Search server | `scripts/pixelrag_serve.sh` on your machine, port 30001 | Fly.io, `PIXELRAG_URL` |
| Page images | read straight off `data/hornsby/pages` | fetched from `PIXELRAG_URL/pages/...` (`pagesSource: 'http'`, `src/lib/server/dcp_search.js`) |
| Postgres | Docker Compose, port 5433 | Neon, via `DATABASE_URL` |

No other code differs — `src/routes/api/ask/+server.js` picks the mode based on whether
`PIXELRAG_URL` is set.

## Known limitation: the search server has no auth

`/search` and `/pages/*` are public on the Fly URL, with no login and no rate limit beyond Fly's
own. The only data behind them is the public Hornsby DCP, so the worst case is someone else
querying it for free and running up a small hosting bill — not a data leak. Worth tightening
later (a shared bearer token checked in front of `pixelrag serve`) if this goes beyond a demo.
