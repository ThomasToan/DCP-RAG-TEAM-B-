import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { searchText } from './text_search.js';

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
	/** Page images are data/<council>/pages/pNNNN.png locally and /pages/<council>/pNNNN.png on the search server. */
	council: 'hornsby',
	/**
	 * 'fs' (default): loadPageImage reads data/<council>/pages off local disk - true for the CLI scripts and
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

/**
 * The index is an IVF index: vectors are grouped into clusters and a search normally checks only some of them (the
 * combined index has 202 clusters and defaults to checking 128). With about 8,000 vectors checking every cluster costs
 * a few milliseconds, so search them all and never miss a page for that reason.
 */
const SEARCH_ALL_CLUSTERS = 1024;

/** Keyword-search pages merged into the image ranking, and the usual reciprocal-rank-fusion constant. */
const TEXT_PAGES = 8;
const RRF_K = 60;

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
 * @returns {Promise<{ pages: { page: number, score: number, chunk: number|null, foundBy: 'image'|'text'|'both' }[], belowFloor: boolean, best: number|null }>}  score = image similarity (0 for a page found only by keywords)
 */
export async function searchPages(query, opts = {}) {
	const { url, floor, chunksToFetch, topPages, council } = { ...DEFAULTS, ...opts };
	const doFetch = opts.fetch ?? fetch;

	const res = await fetchWithRetry(
		doFetch,
		`${url}/search`,
		{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queries: [{ text: query }], n_docs: chunksToFetch, department: council, nprobe: SEARCH_ALL_CLUSTERS }) },
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
	const top = ranked[0]?.score ?? null;
	// The image score alone decides "the DCP has nothing on this": keyword matches on a nonsense question are noise.
	if (top == null || top < floor) return { pages: [], belowFloor: true, best: top };
	if (opts.hybrid === false) return { pages: ranked.filter((p) => p.score >= floor).slice(0, topPages).map((p) => ({ ...p, foundBy: 'image' })), belowFloor: false, best: top };

	// Hybrid: merge the image ranking with a keyword ranking of the page text (reciprocal rank fusion). A page high in
	// either list, or present in both, comes first.
	let text = [];
	try {
		text = (opts.searchText ?? searchText)(query, council, TEXT_PAGES);
	} catch {
		/* no text for this council: image ranking only */
	}
	const fused = new Map();
	ranked.forEach((p, i) => {
		if (p.score >= floor) fused.set(p.page, { ...p, foundBy: 'image', rrf: 1 / (RRF_K + i + 1) });
	});
	text.forEach((t, i) => {
		const img = ranked.find((p) => p.page === t.page);
		const prev = fused.get(t.page);
		const add = 1 / (RRF_K + i + 1);
		if (prev) fused.set(t.page, { ...prev, foundBy: 'both', rrf: prev.rrf + add });
		else fused.set(t.page, { page: t.page, score: img?.score ?? 0, chunk: img?.chunk ?? null, foundBy: img ? 'both' : 'text', rrf: (img ? 1 / (RRF_K + ranked.indexOf(img) + 1) : 0) + add });
	});
	const pages = [...fused.values()]
		.sort((a, b) => b.rrf - a.rrf)
		.slice(0, topPages)
		.map(({ rrf, ...p }) => p);
	return { pages, belowFloor: false, best: top };
}

/** @returns {Promise<{ mime: string, base64: string }>} */
export async function loadPageImage(page, opts = {}) {
	const { council, pagesSource, url } = { ...DEFAULTS, ...opts };
	const name = `p${String(page).padStart(4, '0')}.png`;

	if (pagesSource === 'http') {
		const doFetch = opts.fetch ?? fetch;
		const res = await fetchWithRetry(doFetch, `${url}/pages/${council}/${name}`, undefined, opts.sleep);
		if (!res.ok) throw new Error(`fetching page ${page} failed: HTTP ${res.status}`);
		const bytes = Buffer.from(await res.arrayBuffer());
		return { mime: res.headers.get('content-type') || 'image/png', base64: bytes.toString('base64') };
	}

	const file = join(opts.pagesDir ?? join('data', council, 'pages'), name);
	return { mime: 'image/png', base64: (await readFile(file)).toString('base64') };
}
