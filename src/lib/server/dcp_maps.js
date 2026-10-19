import { PNG } from 'pngjs';
import registry from './dcp_maps.json' with { type: 'json' };

/**
 * DCP map pictures calibrated to real coordinates (by scripts/calibrate_maps.py), so the server can draw the property
 * on them as a dot and show the AI where it falls. The AI reads the picture; the dot position is computed here from the
 * property's NSW coordinates, never chosen by the model.
 */

export const MAPS = registry.maps;

/** Maps sent with the first message for every property inside them: the ones that decide WHICH rules apply. */
const AREA_MAPS = new Set(['heritage']);
const AREA_MAP_IDS = new Set(['htc-parking-tiers', 'htc-precincts']);

const INSET = 8; // a dot this close to the picture edge is treated as outside the map

export const isAreaMap = (m) => AREA_MAPS.has(m.group) || AREA_MAP_IDS.has(m.id);

/** Pixel position of (lon, lat) on the map's page image. */
export function toPixel(m, lon, lat) {
	const t = m.transform;
	return { x: t.ax * lon + t.cx, y: t.by * lat + t.dy };
}

/** The map, with the dot position, if the point falls inside the map picture; otherwise null. */
export function placeOnMap(m, point) {
	if (!point || !Number.isFinite(point.lon) || !Number.isFinite(point.lat)) return null;
	const { x, y } = toPixel(m, point.lon, point.lat);
	const [x0, y0, x1, y1] = m.frame;
	if (x < x0 + INSET || x > x1 - INSET || y < y0 + INSET || y > y1 - INSET) return null;
	return { map: m, x: Math.round(x), y: Math.round(y) };
}

/**
 * Area maps to show for this property: Town Centre tier and precinct maps when the property falls inside the picture,
 * and a heritage map only when NSW data puts the property in one of that map's conservation areas (the picture then
 * shows the precinct and the boundary; for every other property it would add nothing).
 */
export function areaMapsFor(facts) {
	const names = new Set((facts?.heritage_detail ?? []).map((d) => d.name).filter(Boolean));
	return MAPS.filter(isAreaMap)
		.filter((m) => m.group !== 'heritage' || (m.fit?.nsw_areas ?? []).some((n) => names.has(n)))
		.map((m) => placeOnMap(m, facts?.point))
		.filter(Boolean);
}

/** The calibrated map on this PDF page that the property falls inside, if any (pages hold at most one calibrated map). */
export function mapOnPage(page, point) {
	for (const m of MAPS) {
		if (m.page !== page) continue;
		const placed = placeOnMap(m, point);
		if (placed) return placed;
	}
	return null;
}

/** Rough position accuracy for the note to the model: calibration error plus the address point inside its lot. */
export function accuracyMetres(m) {
	return Math.max(10, Math.round((m.fit?.metres_per_px ?? 2) * 4 + 5));
}

/** One sentence that tells the model how to read a marked map. */
export function markNote(placed) {
	const m = placed.map;
	const parts = [
		`Figure ${m.figure} (${m.title}). The MAGENTA DOT marks this property, placed by the server from the property's NSW coordinates (accurate to about ${accuracyMetres(m)} m).`
	];
	if (m.labels) parts.push(m.labels);
	return parts.join(' ');
}

/** The page image with a magenta dot (white rim) drawn at the property. Input and output are base64 PNG. */
export function drawDot(base64, x, y, radius = 9) {
	const png = PNG.sync.read(Buffer.from(base64, 'base64'));
	const { width, height, data } = png;
	const rim = radius + 3;
	for (let dy = -rim; dy <= rim; dy++) {
		for (let dx = -rim; dx <= rim; dx++) {
			const d2 = dx * dx + dy * dy;
			if (d2 > rim * rim) continue;
			const px = x + dx;
			const py = y + dy;
			if (px < 0 || py < 0 || px >= width || py >= height) continue;
			const i = (py * width + px) * 4;
			const [r, g, b] = d2 <= radius * radius ? [255, 0, 200] : [255, 255, 255];
			data[i] = r;
			data[i + 1] = g;
			data[i + 2] = b;
			data[i + 3] = 255;
		}
	}
	return PNG.sync.write(png).toString('base64');
}
