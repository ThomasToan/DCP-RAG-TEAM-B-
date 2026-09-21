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
	pagesDir: 'data/hornsby/pages'
};

/** PDF page number from a hit's source file name (p0037.png -> 37); null if it does not look like one of ours. */
export function pageOf(hit) {
	const m = /p(\d+)\.png/i.exec(hit?.url ?? hit?.path ?? '');
	return m ? Number(m[1]) : null;
}

/**
 * @param {string} query
 * @param {Partial<typeof DEFAULTS> & { fetch?: typeof fetch }} [opts]
 * @returns {Promise<{ pages: { page: number, score: number, chunk: number }[], belowFloor: boolean, best: number|null }>}
 */
export async function searchPages(query, opts = {}) {
	const { url, floor, chunksToFetch, topPages } = { ...DEFAULTS, ...opts };
	const doFetch = opts.fetch ?? fetch;

	const res = await doFetch(`${url}/search`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ queries: [{ text: query }], n_docs: chunksToFetch })
	});
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
	const { pagesDir } = { ...DEFAULTS, ...opts };
	const file = join(pagesDir, `p${String(page).padStart(4, '0')}.png`);
	return { mime: 'image/png', base64: (await readFile(file)).toString('base64') };
}
