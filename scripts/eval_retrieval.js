// Retrieval check on the running PixelRAG server: does the right page come back, and where should the score floor be?
//   node scripts/eval_retrieval.js            (server: scripts/pixelrag_serve.sh data/hornsby/index_full 30001)
// Questions and expected pages: test/retrieval_questions.json
import { readFileSync } from 'node:fs';
import { search } from './pixelrag_query.js';

const set = JSON.parse(readFileSync(new URL('../test/retrieval_questions.json', import.meta.url), 'utf8'));
const N = Number(process.env.N ?? 60); // chunks to fetch per question, collapsed to pages

const rows = [];
for (const item of set.relevant) {
	const pages = await search(item.q, N);
	const rank = pages.findIndex((p) => item.expect.includes(p.page)) + 1 || null;
	const hit = rank ? pages[rank - 1] : null;
	rows.push({ ...item, rank, top: pages[0], hitScore: hit?.score ?? null, top5: pages.slice(0, 5).map((p) => `${p.page}(${p.score.toFixed(2)})`).join(' ') });
}
const irrelevant = [];
for (const item of set.irrelevant) {
	const pages = await search(item.q, N);
	irrelevant.push({ q: item.q, top: pages[0] });
}

console.log('\nRELEVANT QUESTIONS   (rank = position of the first expected page among the returned pages)');
for (const r of rows) {
	console.log(`${r.rank === 1 ? 'OK  ' : r.rank && r.rank <= 3 ? 'top3' : r.rank && r.rank <= 5 ? 'top5' : 'MISS'}  rank ${String(r.rank ?? '-').padStart(2)}  best ${r.top.score.toFixed(3)}  expected ${JSON.stringify(r.expect.slice(0, 4))}${r.expect.length > 4 ? '...' : ''}  got ${r.top5}`);
	console.log(`      "${r.q}"`);
}
const at = (k) => rows.filter((r) => r.rank && r.rank <= k).length;
console.log(`\nfound at rank 1: ${at(1)}/${rows.length}   in top 3: ${at(3)}/${rows.length}   in top 5: ${at(5)}/${rows.length}   in top 10: ${at(10)}/${rows.length}`);

console.log('\nIRRELEVANT QUESTIONS   (best score returned)');
for (const r of irrelevant) console.log(`  ${r.top.score.toFixed(3)}  page ${String(r.top.page).padStart(3)}  "${r.q}"`);

const relTop = rows.map((r) => r.top.score).sort((a, b) => a - b);
const relHit = rows.filter((r) => r.hitScore != null).map((r) => r.hitScore).sort((a, b) => a - b);
const irrTop = irrelevant.map((r) => r.top.score).sort((a, b) => a - b);
console.log(`\nbest score, relevant questions:   min ${relTop[0].toFixed(3)}   median ${relTop[relTop.length >> 1].toFixed(3)}   max ${relTop.at(-1).toFixed(3)}`);
console.log(`score of the expected page:       min ${relHit[0]?.toFixed(3)}   median ${relHit[relHit.length >> 1]?.toFixed(3)}`);
console.log(`best score, irrelevant questions: min ${irrTop[0].toFixed(3)}   max ${irrTop.at(-1).toFixed(3)}`);
const gap = relTop[0] - irrTop.at(-1);
console.log(gap > 0 ? `separable: floor between ${irrTop.at(-1).toFixed(3)} and ${relTop[0].toFixed(3)}; midpoint ${((irrTop.at(-1) + relTop[0]) / 2).toFixed(3)}` : `NOT separable: lowest relevant (${relTop[0].toFixed(3)}) is below highest irrelevant (${irrTop.at(-1).toFixed(3)})`);
