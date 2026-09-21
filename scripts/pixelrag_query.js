// Ask the running PixelRAG server (scripts/pixelrag_serve.sh) one or more questions; show the best PAGES.
//   node scripts/pixelrag_query.js "how many parking spaces per dwelling" "can I remove a tree"
//   PIXELRAG_URL=http://127.0.0.1:30001 (default)   N=10 (chunks to fetch per question)
//
// A hit is one chunk (a quarter of a page). We collapse hits to pages (best chunk wins) because pages are what a
// person reads and what a citation points at. The page number comes from the source file name (p0037.png -> 37).
import { pathToFileURL } from 'node:url';

const BASE = process.env.PIXELRAG_URL ?? 'http://127.0.0.1:30001';
const N = Number(process.env.N ?? 12);

const pageOf = (hit) => Number(/p(\d+)\.png/i.exec(hit.url ?? hit.path ?? '')?.[1] ?? NaN);

export async function search(text, n = N) {
	const res = await fetch(`${BASE}/search`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ queries: [{ text }], n_docs: n })
	});
	if (!res.ok) throw new Error(`search failed: HTTP ${res.status} ${await res.text()}`);
	const hits = (await res.json()).results[0].hits;
	const best = new Map();
	for (const h of hits) {
		const page = pageOf(h);
		if (!best.has(page) || h.score > best.get(page).score) best.set(page, { page, score: h.score, chunk: h.chunk_index, article_id: h.article_id });
	}
	return [...best.values()].sort((a, b) => b.score - a.score);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	for (const q of process.argv.slice(2)) {
		const t = Date.now();
		const pages = await search(q);
		console.log(`\nQ: ${q}   (${((Date.now() - t) / 1000).toFixed(1)} s)`);
		pages.slice(0, 5).forEach((p, i) => console.log(`  ${i + 1}. page ${String(p.page).padStart(3)}   score ${p.score.toFixed(3)}   (best chunk ${p.chunk})`));
	}
}
