import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Client for the PixelRAG search API (scripts/pixelrag_serve.sh) plus page-image loading.
 * No SvelteKit imports: the CLI, the tests and the app all use this file.
 *
 * A search hit is one CHUNK (a strip of a page). We collapse hits to PAGES (best chunk wins), because pages are what a
 * person reads and what an answer cites.
 */

export const DEFAULTS = {
	url: 'http://127.0.0.1:30001',
	/**
	 * Scores below this are treated as "the DCP has nothing on this". Calibrated on the FULL 489-page index with
	 * `node scripts/eval_retrieval.js`: the best score for 5 nonsense questions was 0.296-0.351 and for 11 real questions
	 * 0.446-0.576. (On the 10-page index nonsense scored only 0.23, so a floor tuned there, 0.30, let nonsense through.)
	 * Small sample: re-run the evaluation whenever the index or the model changes.
	 */
	floor: 0.4,
	chunksToFetch: 12,
	topPages: 4,
	pagesDir: 'data/hornsby/pages',
	/**
	 * 'fs' (default): loadPageImage reads pagesDir off local disk - true for the CLI scripts and
	 * for local dev, where the SvelteKit server and the rendered PNGs are on the same machine.
	 * 'http': fetch `${url}/pages/pNNNN.png` from the PixelRAG server instead. Needed in production:
	 * a Vercel function has no local copy of the 250 MB of page images, only the deployed Fly
	 * server does (see deploy/pixelrag/Caddyfile, which serves them alongside /search).
	 */
	pagesSource: 'fs'
};

/** PDF page number from a hit's source file name (p0037.png -> 37); null if it does not look like one of ours. */
export function pageOf(hit) {
	const m = /p(\d+)\.png/i.exec(hit?.url ?? hit?.path ?? '');
	return m ? Number(m[1]) : null;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One retry after a short delay, for the transient window right after a Fly machine wakes from
 * auto-stop. Seen live: two real requests a few seconds apart during a cold start, one got a clean
 * 200 and the other a plain HTTP 404 (not a thrown error - Fly's edge had already started
 * forwarding traffic before the app inside had finished starting). Not for general resilience
 * against a genuinely broken server: exactly one retry, then whatever the second attempt returned
 * (success, failure response, or thrown error) is final.
 */
export async function fetchWithRetry(doFetch, url, init, sleep = defaultSleep) {
	let last;
	for (let attempt = 0; attempt < 2; attempt++) {
		if (attempt > 0) await sleep(3000);
		try {
			const res = await doFetch(url, init);
			if (res.ok) return res;
			last = res;
		} catch (e) {
			last = e;
		}
	}
	if (last instanceof Response) return last;
	throw last;
}

/**
 * @param {string} query
 * @param {Partial<typeof DEFAULTS> & { fetch?: typeof fetch }} [opts]
 * @returns {Promise<{ pages: { page: number, score: number, chunk: number }[], belowFloor: boolean, best: number|null }>}
 */
export async function searchPages(query, opts = {}) {
	const { url, floor, chunksToFetch, topPages } = { ...DEFAULTS, ...opts };
	const doFetch = opts.fetch ?? fetch;

	const res = await fetchWithRetry(
		doFetch,
		`${url}/search`,
		{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queries: [{ text: query }], n_docs: chunksToFetch }) },
		opts.sleep
	);
	if (!res.ok) throw new Error(`PixelRAG search failed: HTTP ${res.status}`);
	const hits = (await res.json()).results?.[0]?.hits ?? [];

	const best = new Map();
	for (const h of hits) {
		const page = pageOf(h);
		if (page == null) continue;
		if (!best.has(page) || h.score > best.get(page).score) best.set(page, { page, score: h.score, chunk: h.chunk_index });
	}
	const ranked = [...best.values()].sort((a, b) => b.score - a.score);
	const kept = ranked.filter((p) => p.score >= floor).slice(0, topPages);
	return { pages: kept, belowFloor: kept.length === 0, best: ranked[0]?.score ?? null };
}

/** @returns {Promise<{ mime: string, base64: string }>} */
export async function loadPageImage(page, opts = {}) {
	const { pagesDir, pagesSource, url } = { ...DEFAULTS, ...opts };
	const name = `p${String(page).padStart(4, '0')}.png`;

	if (pagesSource === 'http') {
		const doFetch = opts.fetch ?? fetch;
		const res = await fetchWithRetry(doFetch, `${url}/pages/${name}`, undefined, opts.sleep);
		if (!res.ok) throw new Error(`fetching page ${page} failed: HTTP ${res.status}`);
		const bytes = Buffer.from(await res.arrayBuffer());
		return { mime: res.headers.get('content-type') || 'image/png', base64: bytes.toString('base64') };
	}

	const file = join(pagesDir, name);
	return { mime: 'image/png', base64: (await readFile(file)).toString('base64') };
}
