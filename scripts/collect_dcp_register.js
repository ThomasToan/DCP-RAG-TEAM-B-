// Phase 2, pass 1: build data/dcp_index.csv from the NSW Planning Portal DCP register.
//
//   node scripts/collect_dcp_register.js            fetch the register page, HEAD every in-force PDF for its size
//   node scripts/collect_dcp_register.js --offline  reuse data/register.html, skip nothing else
//
// The register (https://www.planningportal.nsw.gov.au/DCP) is a static HTML list, no API. In-force DCPs are ONE
// flat list with no council headings, so the council is guessed from the link text. HEAD requests read
// Content-Length only: nothing is downloaded here.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const REGISTER_URL = 'https://www.planningportal.nsw.gov.au/DCP';
const DATA = new URL('../data/', import.meta.url);
const HTML_PATH = new URL('register.html', DATA);
const CSV_PATH = new URL('dcp_index.csv', DATA);
const UA = 'Mozilla/5.0 (student research; DCP image-share ranking exercise)';
const offline = process.argv.includes('--offline');

mkdirSync(DATA, { recursive: true });

async function getRegisterHtml() {
	if (offline && existsSync(HTML_PATH)) return readFileSync(HTML_PATH, 'utf8');
	const res = await fetch(REGISTER_URL, { headers: { 'user-agent': UA } });
	if (!res.ok) throw new Error(`register page: HTTP ${res.status}`);
	const html = await res.text();
	writeFileSync(HTML_PATH, html);
	return html;
}

const decode = (s) =>
	s
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&#0?39;|&rsquo;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, ' ')
		.trim();

/** "Bathurst Regional RDCP 2014 - as amended..." -> "Bathurst Regional" */
function guessCouncil(title) {
	const t = title.replace(/\(PDF\)/gi, '').trim();
	const m = /^(.*?)\s+(?:R?DCP|Development Control Plan|Development Control Plans|DCP)\b/i.exec(t);
	const name = (m ? m[1] : t.split(/\s+-\s+|\s+\d{4}/)[0]).replace(/\s+(City|Shire|Regional|Municipal)?\s*Council$/i, '').trim();
	return name || t.split(' ').slice(0, 2).join(' ');
}

function parse(html) {
	const rows = [];
	// each section starts at an <h4>; the section name is the h4 text
	const parts = html.split(/<h4[^>]*>/i).slice(1);
	for (const part of parts) {
		const section = decode(part.slice(0, part.indexOf('</h4>')));
		if (!/in-force|repealed|superseded/i.test(section)) continue; // skip "Sydney Harbour Foreshore Maps"
		for (const m of part.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
			let url = m[1].replace(/&amp;/g, '&');
			if (url.startsWith('//')) url = `https:${url}`;
			if (!/^https?:/i.test(url)) continue;
			const title = decode(m[2]);
			rows.push({
				section: /in-force/i.test(section) ? 'in-force' : /repealed/i.test(section) ? 'repealed' : 'superseded',
				lga: guessCouncil(title),
				title,
				url,
				is_pdf: /\.pdf(\?|$)/i.test(url)
			});
		}
	}
	return rows;
}

async function head(url) {
	try {
		const res = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) });
		return { status: res.status, bytes: Number(res.headers.get('content-length')) || null, type: (res.headers.get('content-type') ?? '').split(';')[0] };
	} catch (e) {
		return { status: 0, bytes: null, type: e.name === 'TimeoutError' ? 'timeout' : 'error' };
	}
}

/** small concurrency limiter, so we stay polite to the S3 bucket and the portal */
async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: limit }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i], i);
			}
		})
	);
	return out;
}

const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

const html = await getRegisterHtml();
const rows = parse(html);
const bySection = (s) => rows.filter((r) => r.section === s);
console.log(`register: ${rows.length} links  (in-force ${bySection('in-force').length}, repealed ${bySection('repealed').length}, superseded ${bySection('superseded').length})`);

const targets = rows.filter((r) => r.section === 'in-force' && r.is_pdf);
console.log(`HEAD-checking ${targets.length} in-force PDFs (reads size only, downloads nothing)...`);
let done = 0;
await mapLimit(targets, 6, async (r) => {
	Object.assign(r, await head(r.url));
	if (++done % 50 === 0) console.log(`  ${done}/${targets.length}`);
});

const header = ['lga', 'title', 'url', 'pages', 'bytes', 'section', 'status', 'type'];
const lines = [header.join(',')].concat(rows.map((r) => [r.lga, r.title, r.url, '', r.bytes, r.section, r.status, r.type].map(csvCell).join(',')));
writeFileSync(CSV_PATH, lines.join('\n') + '\n');

const ok = targets.filter((r) => r.status === 200 && r.bytes);
const bad = targets.filter((r) => !(r.status === 200 && r.bytes));
console.log(`\n${ok.length} PDFs with a known size, ${bad.length} without (dead link, no Content-Length, or timeout)`);
console.log(`total size of the in-force PDFs: ${(ok.reduce((s, r) => s + r.bytes, 0) / 1e9).toFixed(2)} GB`);
console.log(`wrote ${CSV_PATH.pathname}`);
