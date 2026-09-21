// CSV reading/writing and the shortlist rule for the DCP ranking. Pure functions, no I/O, unit-tested.

export function parseCsv(text) {
	const rows = [];
	let row = [];
	let cell = '';
	let q = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (q) {
			if (c === '"' && text[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (c === '"') q = false;
			else cell += c;
		} else if (c === '"') q = true;
		else if (c === ',') {
			row.push(cell);
			cell = '';
		} else if (c === '\n') {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = '';
		} else if (c !== '\r') cell += c;
	}
	if (cell || row.length) {
		row.push(cell);
		rows.push(row);
	}
	const [header, ...body] = rows;
	return body.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

export const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/** Drafts, map-only files and precinct-only files are not "a council's DCP": a map-only PDF is trivially 100% image. */
export const EXCLUDE = /\bmaps?\b|draft|exhibition|appendi|schedule|precinct|amendment \d+\s*$/i;
export const MIN_BYTES = 15e6;

export const councilKey = (lga) =>
	lga
		.toLowerCase()
		.replace(/^city of /, '')
		.replace(/\b(sustainable cities|draft)\b/g, '')
		.replace(/\s+/g, ' ')
		.trim();

export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * In-force PDFs of at least 15 MB, drafts/maps/precincts excluded, ONE per council (the largest), then the `top` largest.
 * File size is only a cheap proxy for image share; pass 2 measures the real thing on these.
 * @param {Record<string,string>[]} indexRows rows of data/dcp_index.csv
 * @param {number} top
 */
export function shortlist(indexRows, top) {
	const best = new Map();
	for (const r of indexRows) {
		const bytes = Number(r.bytes);
		if (r.section !== 'in-force' || !bytes || bytes < MIN_BYTES || EXCLUDE.test(r.title)) continue;
		const k = councilKey(r.lga);
		if (!best.has(k) || bytes > Number(best.get(k).bytes)) best.set(k, r);
	}
	const used = new Set();
	return [...best.values()]
		.sort((a, b) => Number(b.bytes) - Number(a.bytes))
		.slice(0, top)
		.map((r) => {
			let slug = slugify(councilKey(r.lga)) || 'dcp';
			while (used.has(slug)) slug += '-2';
			used.add(slug);
			return { ...r, bytes: Number(r.bytes), slug };
		});
}
