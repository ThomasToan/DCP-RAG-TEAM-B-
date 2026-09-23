# Deploying: Fly.io (search server) + Vercel (chat app)

Two services, because the search model needs ~9 GB RAM and Vercel functions cap at 2-4 GB
(verified on Vercel's own docs) — it cannot run there on any plan. There is also no real hosted
PixelRAG API to point at instead (pixelrag.ai is a docs/demo site, not a service that takes a
custom index). So: the chat app goes on Vercel as normal, and the search server goes on Fly.io,
talking to each other over one environment variable, `PIXELRAG_URL`.

Verified before writing this: search server RAM = **8.6 GiB RSS** measured live (`ps aux` on the
running process), cold start = **24 s** with the model already cached, a query once warm =
under 1-2 s.

## 1. The search server (Fly.io) — do this first

You need a Fly.io account (**requires a credit card**) and the `flyctl` CLI. This is the one part
that costs real money. **Two things learned the hard way on a real deploy**, both already fixed in
this repo, kept here so the reasoning isn't lost:

- Fly's remote build machine has less RAM than the machine that runs the app. The Dockerfile used
  to *load* the model at build time (`from_pretrained`, which mmaps the 4.25 GB weights file) and
  the build died with `unable to mmap ... Cannot allocate memory`. Fixed: the build now only
  *downloads* the file (`snapshot_download`); the real load happens at container start, on the
  real machine.
- Fly caps memory per shared-CPU size at **2 GB × vCPU count** (confirmed by the platform's own
  error: `shared-cpu-2x` refused >4096 MiB). Our 8.6 GiB need doesn't fit `shared-cpu-4x` either
  (its ceiling is exactly 8192 MiB, no headroom) — `fly.toml` uses **`shared-cpu-8x` at 12288 MiB**.
  Verified price (Sydney, where Fly placed this app for us): **$0.0324/hour**, billed only while
  running (auto-stop is on) — full-time 24/7 would be $83.94/month, but a demo used occasionally
  should be a few dollars total, not that.

```bash
# 1. Install flyctl (see https://fly.io/docs/flyctl/install/ for your OS), then:
fly auth signup   # or: fly auth login

# 2. From the PROJECT ROOT (so the build sees data/hornsby/*):
fly apps create dcp-hornsby-search   # pick a different name if this one is taken;
                                      # update `app = "..."` in fly.toml to match
fly deploy --ha=false   # --ha=false: a demo doesn't need Fly's default 2-machine redundancy,
                         # and the 2nd machine roughly doubles cost if it ever runs concurrently

# 3. If flyctl complains about `memory_mb` in fly.toml, deploy without it, then:
fly scale memory 12288 -a dcp-hornsby-search
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

**If `fly deploy` gets interrupted** (e.g. Ctrl+C while it's waiting on a health check) you can
end up with an extra unhealthy machine sitting around. Check with `fly status`; if one shows
`1 total, 1 passing` and another shows `1 total, 1 critical`, the passing one is fine and already
serving traffic - just remove the broken one:
```bash
fly machine destroy <bad-machine-id> -a dcp-hornsby-search --force
```

## 2. The chat app (Vercel)

**This app needs `@sveltejs/adapter-vercel`, not `adapter-node`** (already set in `vite.config.js`
in this repo - flagging it because it's an easy thing to silently break if the adapter ever gets
reverted). On Windows, building with adapter-vercel needs symlink permission: turn on
**Settings → Privacy & security → For developers → Developer Mode** once, or the build fails with
`EPERM: operation not permitted, symlink`. This only affects testing the build locally
(`npm run build`); Vercel's own remote build runs on Linux and is unaffected either way.

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

**`data/` must be excluded from the upload** (`.vercelignore`, already in this repo) - without it,
`vercel --prod` tries to upload Phase 2's leftover council PDFs (~2 GB, some files over 100 MB) and
fails with `File size limit exceeded (100 MB)`. None of `data/` is needed at runtime: page images
come from `PIXELRAG_URL`, property facts from Postgres.

**Vercel functions must run in the SAME region as the Fly machine** (`vercel.json`,
`"regions": ["syd1"]` for Sydney - already in this repo). Vercel defaults to `iad1` (US). A real
deploy without this pinned showed the actual failure mode: Fly's own logs said
`could not find a good candidate within 40 attempts at load balancing` from Fly's **iad** edge,
even though the machine runs in **syd** - the US-based Vercel function's request landed at Fly's
nearest (US) edge first, which then failed to route across Fly's network to the Sydney machine. A
retry does not fix this (tried it first - a failing request just took 82s to fail instead of 40s);
matching the region does.

After the first deploy, run the schema against the new database once:
```bash
vercel env pull --environment=production .env.production.local
psql "$(grep '^DATABASE_URL=' .env.production.local | cut -d= -f2- | tr -d '"')" -f sql/01_schema.sql
rm .env.production.local   # don't leave production DB credentials sitting on disk
```

## Expect the first request after idle to be genuinely slow

With auto-stop machines, the first real user action after Fly's machine has gone idle triggers a
cold start: model reload (~15-25s) plus, for `/api/ask`, however long OpenAI's own multi-round tool
calling takes on top of that (30-60s+ for a real question, even warm - see the chat brain section
above). **A first request can legitimately take 60-100+ seconds.** This is a genuine cost/latency
trade-off of choosing auto-stop over an always-on machine, not a bug: verified live, a real
`/api/ask` call on a cold machine completed correctly in 100s; the same question again (warm)
completed in 42s. If this is a real usability concern, raise `min_machines_running` to `1` in
`fly.toml` (removes the cold start entirely, at the full hourly rate around the clock instead).

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
