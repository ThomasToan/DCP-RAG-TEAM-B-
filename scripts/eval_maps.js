// Test how well the AI reads marked DCP maps, over random real addresses.
//   node scripts/eval_maps.js [addresses_per_map=2] [seed=1]
// For each area map (heritage, mixed use, Town Centre tiers and precincts) it picks random NSW address points inside
// the map picture, looks up the property, draws the dot exactly as the app does, and asks the model where the dot is.
// The expected answer is computed from the picture itself, not by the model:
//   outline maps: flood-fill from the dot with the outline colour as walls; reaching the map edge = OUTSIDE
//   tier map: the same against the blue line (Tier 1), then the blue and black lines (Tier 2)
//   precinct map: the colour under the dot, matched to the legend
// Known limit: an outline that runs off the edge of the map picture (e.g. the Normanhurst Road inset) always reads as
// OUTSIDE, so check any WRONG on such a map by eye.
// Heritage maps are also checked against NSW data (is the property in that conservation area?), which tests the
// calibration as well as the reading. Needs OPENAI_API_KEY in .env. Costs roughly 4k input tokens per map image.
import OpenAI from 'openai';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { getPropertyFacts } from '../src/lib/server/property.js';
import { MAPS, isAreaMap, placeOnMap, drawDot, markNote } from '../src/lib/server/dcp_maps.js';
import { arcgisQuery } from '../src/lib/server/arcgis.js';

process.loadEnvFile('.env');
const PER_MAP = Number(process.argv[2] ?? 2);
let seed = Number(process.argv[3] ?? 1);
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const model = process.env.OPENAI_MODEL ?? 'gpt-5.6-terra';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const GEOCODE = 'https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Geocoded_Addressing_Theme/FeatureServer/1/query';

const page = (n) => PNG.sync.read(readFileSync(`data/hornsby/pages/p${String(n).padStart(4, '0')}.png`));
const at = (png, x, y) => {
	const i = (y * png.width + x) * 4;
	return [png.data[i], png.data[i + 1], png.data[i + 2]];
};
const isRed = ([r, g, b]) => r > 120 && r - g > 45 && r - b > 45; // includes the pale red of thin or hatched outlines
const isBlue = ([r, g, b]) => b > 150 && b - Math.max(r, g) > 70;
const isDark = ([r, g, b]) => Math.max(r, g, b) < 80;

/** Flood from (x, y) inside the frame; true if the fill reaches the frame edge (so the point is outside the walls). */
function reachesEdge(png, frame, x, y, isWall) {
	const [x0, y0, x1, y1] = frame.map((v, i) => (i < 2 ? v + 3 : v - 3));
	const seen = new Uint8Array(png.width * png.height);
	const stack = [[x, y]];
	while (stack.length) {
		const [cx, cy] = stack.pop();
		if (cx <= x0 || cy <= y0 || cx >= x1 || cy >= y1) return true;
		const k = cy * png.width + cx;
		if (seen[k]) continue;
		seen[k] = 1;
		if (isWall(at(png, cx, cy)) || isWall(at(png, cx + 1, cy)) || isWall(at(png, cx, cy + 1))) continue; // walls thickened by 1 px so faint gaps do not leak
		stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
	}
	return false;
}
const nearWall = (png, x, y, isWall, r = 5) => {
	for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (isWall(at(png, x + dx, y + dy))) return true;
	return false;
};

const PRECINCT_COLOURS = { 'Western Heritage': [240, 110, 100], 'Northern Employment': [250, 190, 110], 'Central Heart': [205, 170, 215], 'Retail Core': [165, 200, 210], 'Transport Corridor': [150, 150, 150], 'Central North': [175, 125, 120] };
function precinctAt(png, x, y) {
	const votes = {};
	for (let dy = -14; dy <= 14; dy += 2) for (let dx = -14; dx <= 14; dx += 2) {
		if (dx * dx + dy * dy < 13 * 13) continue; // the ring just outside the drawn dot
		const c = at(png, x + dx, y + dy);
		if (Math.min(...c) > 235) continue; // white
		let best = null, bd = 1e9;
		for (const [name, ref] of Object.entries(PRECINCT_COLOURS)) {
			const d = ref.reduce((s, v, i) => s + (v - c[i]) ** 2, 0);
			if (d < bd) [best, bd] = [name, d];
		}
		if (bd < 2500) votes[best] = (votes[best] ?? 0) + 1;
	}
	const top = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
	return top && top[1] >= 8 ? top[0] : 'OUTSIDE';
}

function expected(m, png, x, y) {
	if (m.id === 'htc-precincts') return { truth: precinctAt(png, x, y), boundary: false };
	if (m.id === 'htc-parking-tiers') {
		const boundary = nearWall(png, x, y, (c) => isBlue(c) || isDark(c));
		if (!reachesEdge(png, m.frame, x, y, isBlue)) return { truth: 'TIER 1', boundary };
		if (!reachesEdge(png, m.frame, x, y, (c) => isBlue(c) || isDark(c))) return { truth: 'TIER 2', boundary };
		return { truth: 'OUTSIDE', boundary };
	}
	return { truth: reachesEdge(png, m.frame, x, y, isRed) ? 'OUTSIDE' : 'INSIDE', boundary: nearWall(png, x, y, isRed) };
}

const QUESTION = {
	'htc-parking-tiers': 'Is the magenta dot in TIER 1, TIER 2, or OUTSIDE both? Answer with exactly one of: TIER 1, TIER 2, OUTSIDE.',
	'htc-precincts': 'Which precinct in the legend is the magenta dot in? Answer with just the precinct name (for example Retail Core), or OUTSIDE if it is not in any coloured precinct.'
};
const defaultQ = 'Is the magenta dot INSIDE or OUTSIDE the red outline? Answer with exactly one word: INSIDE or OUTSIDE.';
const norm = (s) => s.toUpperCase().replace(/PRECINCT/g, '').replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

async function sampleAddresses(m, n) {
	const t = m.transform;
	const [x0, y0, x1, y1] = m.frame;
	const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => {
		const a = t.ax, b = t.bx ?? 0, c = t.ay ?? 0, d = t.by, det = a * d - b * c, u = x - t.cx, v = y - t.dy;
		return [(d * u - b * v) / det, (-c * u + a * v) / det];
	});
	const lons = corners.map((p) => p[0]), lats = corners.map((p) => p[1]);
	const r = await arcgisQuery(GEOCODE, {
		where: '1=1', geometry: `${Math.min(...lons)},${Math.min(...lats)},${Math.max(...lons)},${Math.max(...lats)}`,
		geometryType: 'esriGeometryEnvelope', inSR: 4326, spatialRel: 'esriSpatialRelIntersects', outFields: 'address', returnGeometry: false, resultRecordCount: 400
	});
	const all = [...new Set((r.features ?? []).map((f) => f.attributes.address).filter(Boolean))];
	const out = [];
	while (out.length < n && all.length) out.push(all.splice(Math.floor(rand() * all.length), 1)[0]);
	return out;
}

const rows = [];
let tokens = 0;
for (const m of MAPS.filter(isAreaMap)) {
	const png = page(m.page);
	for (const address of await sampleAddresses(m, PER_MAP)) {
		let facts;
		try {
			facts = await getPropertyFacts(address);
		} catch (e) {
			console.log(`${m.id} | ${address} | lookup failed (${e.code})`);
			continue;
		}
		const placed = placeOnMap(m, facts.point);
		if (!placed) continue;
		const { truth, boundary } = expected(m, png, placed.x, placed.y);
		const nswIn = m.group === 'heritage' ? (facts.heritage_detail ?? []).some((d) => (m.fit?.nsw_areas ?? []).includes(d.name)) : null;
		const b64 = drawDot(readFileSync(`data/hornsby/pages/p${String(m.page).padStart(4, '0')}.png`).toString('base64'), placed.x, placed.y);
		const resp = await openai.responses.create({
			model,
			input: [{ role: 'user', content: [
				{ type: 'input_text', text: `${markNote(placed)}\n\n${QUESTION[m.id] ?? defaultQ}` },
				{ type: 'input_image', image_url: `data:image/png;base64,${b64}`, detail: 'high' }
			] }]
		});
		tokens += resp.usage?.input_tokens ?? 0;
		const answer = norm(resp.output_text ?? '');
		const ok = answer === norm(truth) || (m.id === 'htc-precincts' && answer.includes(norm(truth)) && truth !== 'OUTSIDE');
		const nswText = nswIn === null ? '' : ` | NSW says ${nswIn ? 'INSIDE' : 'OUTSIDE'}${(nswIn ? 'INSIDE' : 'OUTSIDE') === truth ? '' : ' (DISAGREES with picture)'}`;
		rows.push({ map: m.id, ok, boundary, calibrationOk: nswIn === null ? null : (nswIn ? 'INSIDE' : 'OUTSIDE') === truth });
		console.log(`${m.id} | ${facts.address} | expected ${truth}${boundary ? ' (on boundary)' : ''} | model ${answer} | ${ok ? 'OK' : 'WRONG'}${nswText}`);
	}
}
const scored = rows.filter((r) => !r.boundary);
const cal = rows.filter((r) => r.calibrationOk !== null);
console.log(`\nmodel correct: ${scored.filter((r) => r.ok).length} of ${scored.length} (not counting ${rows.length - scored.length} dots on a boundary; those: ${rows.filter((r) => r.boundary && r.ok).length} of ${rows.length - scored.length} correct)`);
console.log(`heritage calibration agrees with NSW: ${cal.filter((r) => r.calibrationOk).length} of ${cal.length}`);
console.log(`input tokens: ${tokens}`);
