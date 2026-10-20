import hornsby from './page_text/hornsby.json' with { type: 'json' };
import randwick from './page_text/randwick.json' with { type: 'json' };

/**
 * Keyword search (BM25) over the text layer of each DCP page, made by scripts/extract_page_text.py. It complements
 * the image search: exact planning terms ("site coverage", "boarding house") and clause numbers are words on the page,
 * and an image embedding can rank a similar-looking page above the one that actually says them.
 */

const PAGE_TEXT = { hornsby, randwick };

const STOP = new Set(
	('a an and are as at be by can do does for from has have how i if in into is it its my of on or our so such than that the their then there these this to was what when where which who why will with would ' +
		'any all about also may must should could per under over up out not no yes me we you your').split(' ')
);

/** Lower case words and numbers, stop words removed, simple plural folding (lots -> lot, storeys -> storey). */
export function tokens(text) {
	const out = [];
	for (let w of String(text).toLowerCase().match(/[a-z0-9]+(?:\.[0-9]+)*/g) ?? []) {
		if (STOP.has(w) || (w.length < 2 && !/\d/.test(w))) continue;
		if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
		else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
		out.push(w);
	}
	return out;
}

const K1 = 1.2;
const B = 0.75;
const built = new Map();

function index(council) {
	if (built.has(council)) return built.get(council);
	const pages = PAGE_TEXT[council];
	if (!pages) throw new Error(`no page text for council ${council}`);
	const docs = pages.map((t) => {
		const tf = new Map();
		const words = tokens(t);
		for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
		return { tf, len: words.length };
	});
	const df = new Map();
	for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
	const avgdl = docs.reduce((s, d) => s + d.len, 0) / docs.length || 1;
	const ix = { docs, df, avgdl, n: docs.length };
	built.set(council, ix);
	return ix;
}

/**
 * Pages ranked by BM25 for the query. Page numbers are 1-based PDF pages.
 * @returns {{ page: number, score: number }[]}
 */
export function searchText(query, council, limit = 10) {
	const { docs, df, avgdl, n } = index(council);
	const terms = [...new Set(tokens(query))];
	if (!terms.length) return [];
	const scored = [];
	docs.forEach((d, i) => {
		let s = 0;
		for (const w of terms) {
			const f = d.tf.get(w);
			if (!f) continue;
			const idf = Math.log(1 + (n - df.get(w) + 0.5) / (df.get(w) + 0.5));
			s += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avgdl));
		}
		if (s > 0) scored.push({ page: i + 1, score: s });
	});
	return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
