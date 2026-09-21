// Phase 2, pass 2: shortlist -> download -> measure -> rank.
//
//   node scripts/rank_dcps.js                 top 25 by size: download, analyse, print the ranking
//   node scripts/rank_dcps.js --top 10        smaller shortlist
//   node scripts/rank_dcps.js --analyse-only  skip downloads (files already in data/dcp_raw/)
//
// Input:  data/dcp_index.csv        from collect_dcp_register.js (pass 1, sizes only)
// Output: data/dcp_raw/*.pdf        downloaded PDFs (gitignored)
//         data/dcp_stats/*.json     per-page stats from pdf_stats.py (gitignored, doubles as a cache)
//         data/dcp_ranking.csv      the table this exercise has to publish
//
// Shortlist rule (documented in the README): in-force PDFs of at least 15 MB, drafts / map-only / precinct-only
// files excluded (a map-only file is trivially 100% image and would corrupt the ranking), ONE PDF per council
// (the largest, as the exercise says), then the N largest.
import { createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { runPy } from './lib/wsl.js';
import { parseCsv, csvCell, shortlist } from './lib/dcp_index.js';
import { DEFINITIONS, summarise } from './lib/score.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : dflt);
const TOP = Number(opt('top', 25));
const JOBS = Number(opt('jobs', 3));
const ANALYSE_ONLY = args.includes('--analyse-only');
const UA = 'Mozilla/5.0 (student research; DCP image-share ranking exercise)';

const DATA = new URL('../data/', import.meta.url);
const RAW = new URL('dcp_raw/', DATA);
const STATS = new URL('dcp_stats/', DATA);
const INDEX = new URL('dcp_index.csv', DATA);
for (const d of [RAW, STATS]) mkdirSync(d, { recursive: true });

// ---------- download ----------
async function download(r) {
	const dest = new URL(`${r.slug}.pdf`, RAW);
	if (existsSync(dest) && statSync(dest).size === r.bytes) return 'cached';
	const tmp = new URL(`${r.slug}.pdf.part`, RAW);
	for (let attempt = 1; ; attempt++) {
		try {
			const res = await fetch(r.url, { headers: { 'user-agent': UA }, redirect: 'follow' });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
			const size = statSync(tmp).size;
			if (size !== r.bytes) throw new Error(`got ${size} bytes, register said ${r.bytes}`);
			const fd = openSync(tmp, 'r');
			const magic = Buffer.alloc(5);
			readSync(fd, magic, 0, 5, 0);
			closeSync(fd);
			if (magic.toString('latin1') !== '%PDF-') throw new Error('not a PDF (bad magic bytes)');
			renameSync(tmp, dest);
			return 'downloaded';
		} catch (e) {
			if (attempt >= 2) throw new Error(`${r.slug}: ${e.message}`);
			console.log(`  retrying ${r.slug} (${e.message})`);
		}
	}
}

async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
	}));
	return out;
}

// ---------- main ----------
const index = parseCsv(readFileSync(INDEX, 'utf8'));
const picks = shortlist(index, TOP);
const totalMB = picks.reduce((s, r) => s + r.bytes, 0) / 1e6;
console.log(`shortlist: ${picks.length} councils, ${totalMB.toFixed(0)} MB\n`);

if (!ANALYSE_ONLY) {
	console.log('downloading (skips files already complete)...');
	const t0 = Date.now();
	await mapLimit(picks, JOBS, async (r) => {
		const t = Date.now();
		try {
			const how = await download(r);
			console.log(`  ${how.padEnd(10)} ${r.slug.padEnd(28)} ${(r.bytes / 1e6).toFixed(1).padStart(6)} MB  ${((Date.now() - t) / 1000).toFixed(0)}s`);
		} catch (e) {
			r.failed = e.message;
			console.log(`  FAILED     ${e.message}`);
		}
	});
	console.log(`downloads done in ${((Date.now() - t0) / 60000).toFixed(1)} min\n`);
}

console.log('measuring pages (PyMuPDF in WSL)...');
await mapLimit(picks.filter((r) => !r.failed), JOBS, async (r) => {
	const out = new URL(`${r.slug}.json`, STATS);
	if (existsSync(out)) return;
	try {
		await runPy(['scripts/pdf_stats.py', `data/dcp_raw/${r.slug}.pdf`, `data/dcp_stats/${r.slug}.json`]);
		console.log(`  measured   ${r.slug}`);
	} catch (e) {
		r.failed = e.message;
		console.log(`  FAILED     ${r.slug}: ${e.message}`);
	}
});

// ---------- rank ----------
const ranked = [];
for (const r of picks) {
	const f = new URL(`${r.slug}.json`, STATS);
	if (!existsSync(f)) continue;
	const s = JSON.parse(readFileSync(f, 'utf8'));
	if (s.status !== 'ok') { console.log(`  skipped ${r.slug}: ${s.error}`); continue; }
	ranked.push({ ...r, ...summarise(s.page_stats), creator: s.creator, producer: s.producer, mb: r.bytes / 1e6 });
}
ranked.sort((a, b) => b.share.primary - a.share.primary || b.mb / b.pages - a.mb / a.pages);

const pct = (x) => `${(x * 100).toFixed(0)}%`.padStart(5);
console.log('\nRANKING by share of image-dominated pages (definition: ' + DEFINITIONS.primary.label + ')\n');
console.log(' #  council                 pages    MB  MB/pg  img-dom  cover30  any-raster  low-text  vector  creator');
ranked.forEach((r, i) => {
	console.log(
		`${String(i + 1).padStart(2)}  ${r.slug.padEnd(22)} ${String(r.pages).padStart(6)} ${r.mb.toFixed(0).padStart(5)} ${(r.mb / r.pages).toFixed(2).padStart(6)}  ${pct(r.share.primary)}   ${pct(r.share.cover30)}   ${pct(r.bigRaster)}     ${pct(r.lowText)}   ${pct(r.vectorHeavy)}   ${(r.creator || r.producer || '?').slice(0, 26)}`
	);
});

// does the winner depend on how we define "image-dominated"? rank of the top councils under every definition
const rankUnder = (key) => new Map([...ranked].sort((a, b) => b.share[key] - a.share[key]).map((r, i) => [r.slug, i + 1]));
const ranks = Object.fromEntries(Object.keys(DEFINITIONS).map((k) => [k, rankUnder(k)]));
console.log('\nROBUSTNESS: rank of the top 8 under each definition of "image-dominated"');
console.log('council                 ' + Object.keys(DEFINITIONS).map((k) => k.padStart(15)).join(''));
ranked.slice(0, 8).forEach((r) => console.log(`${r.slug.padEnd(24)}` + Object.keys(DEFINITIONS).map((k) => String(ranks[k].get(r.slug)).padStart(15)).join('')));
console.log('(literal = the exercise wording; it is polluted by logos/backgrounds repeated on every page)');

const cols = ['rank', 'lga', 'title', 'url', 'pages', 'mb', 'mb_per_page', ...Object.keys(DEFINITIONS).map((k) => `share_${k}`), 'share_blank', 'share_low_text', 'share_any_big_raster', 'share_full_page_image', 'share_vector_heavy', 'median_chars_per_page', 'creator', 'producer'];
const csv = [cols.join(',')].concat(ranked.map((r, i) => [i + 1, r.lga, r.title, r.url, r.pages, r.mb.toFixed(1), (r.mb / r.pages).toFixed(3), ...Object.keys(DEFINITIONS).map((k) => r.share[k].toFixed(4)), r.blank.toFixed(4), r.lowText.toFixed(4), r.bigRaster.toFixed(4), r.fullPage.toFixed(4), r.vectorHeavy.toFixed(4), r.medianChars, r.creator, r.producer].map(csvCell).join(',')));
writeFileSync(new URL('dcp_ranking.csv', DATA), csv.join('\n') + '\n');

// fill the `pages` column of the index for everything we measured
const pagesByUrl = new Map(ranked.map((r) => [r.url, r.pages]));
const header = Object.keys(index[0]);
writeFileSync(INDEX, [header.join(',')].concat(index.map((r) => header.map((h) => csvCell(h === 'pages' && pagesByUrl.has(r.url) ? pagesByUrl.get(r.url) : r[h])).join(','))).join('\n') + '\n');
console.log(`\nwrote data/dcp_ranking.csv and filled pages in data/dcp_index.csv`);
