// Compare image-only search with hybrid (image + keyword) search, through the app's own searchPages.
//   PIXELRAG_URL=https://dcp-hornsby-search.fly.dev node scripts/eval_search.js
// Question sets: test/retrieval_questions.json (Hornsby) and test/retrieval_questions_randwick.json (Randwick).
import { readFileSync } from 'node:fs';
import { searchPages } from '../src/lib/server/dcp_search.js';

const url = process.env.PIXELRAG_URL ?? 'http://127.0.0.1:30001';
const sets = { hornsby: 'test/retrieval_questions.json', randwick: 'test/retrieval_questions_randwick.json' };
for (const [council, file] of Object.entries(sets)) {
	const qs = JSON.parse(readFileSync(file, 'utf8')).relevant;
	const tally = { image: [0, 0, 0], hybrid: [0, 0, 0] }; // first, in top 2, in the 4 pages sent
	for (const { q, expect } of qs) {
		const line = [];
		for (const mode of ['image', 'hybrid']) {
			const r = await searchPages(q, { url, council, hybrid: mode === 'hybrid' });
			const rank = r.pages.findIndex((p) => expect.includes(p.page)) + 1;
			if (rank === 1) tally[mode][0]++;
			if (rank && rank <= 2) tally[mode][1]++;
			if (rank) tally[mode][2]++;
			line.push(`${mode} ${rank || '-'} [${r.pages.map((p) => p.page + (p.foundBy === 'text' ? 't' : p.foundBy === 'both' ? '*' : '')).join(',')}]`);
		}
		console.log(`${council} | ${q.slice(0, 55).padEnd(55)} | ${line.join(' | ')}`);
	}
	for (const m of ['image', 'hybrid']) console.log(`${council} ${m.padEnd(6)}: right page first ${tally[m][0]}/${qs.length}, in top 2 ${tally[m][1]}/${qs.length}, among the 4 pages sent ${tally[m][2]}/${qs.length}`);
}
console.log('(t = found only by keywords, * = found by both)');
