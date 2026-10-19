import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { MAPS, placeOnMap, areaMapsFor, mapOnPage, drawDot, markNote, accuracyMetres, isAreaMap } from '../src/lib/server/dcp_maps.js';

// Real address points from the NSW geocoder (see docs/hornsby_dcp_maps.md and the README's task 2 notes)
const KILLALOE = { lon: 151.0608839329698, lat: -33.73871494115465 }; // in Beecroft, Cheltenham HCA
const DURAL_16 = { lon: 151.09417182508642, lat: -33.70207278248214 }; // Hornsby, just west of the Town Centre
const DUFFY_10 = { lon: 151.08290904988803, lat: -33.725085738638526 }; // Thornleigh, no HCA, but inside the Beecroft map's picture
const BEECROFT_HCA = 'Beecroft, Cheltenham Heritage Conservation Area';
const byId = (id) => MAPS.find((m) => m.id === id);

const whitePng = (w = 60, h = 60) => {
	const png = new PNG({ width: w, height: h });
	png.data.fill(255);
	return PNG.sync.write(png).toString('base64');
};
const pixel = (b64, x, y) => {
	const png = PNG.sync.read(Buffer.from(b64, 'base64'));
	const i = (y * png.width + x) * 4;
	return [...png.data.slice(i, i + 3)];
};

describe('the calibrated map registry', () => {
	it('holds the 6 heritage maps and the Town Centre maps, each with a transform and a frame', () => {
		expect(MAPS.filter((m) => m.group === 'heritage')).toHaveLength(6);
		expect(MAPS.filter((m) => m.group === 'town-centre').length).toBeGreaterThanOrEqual(15);
		for (const m of MAPS) {
			expect(Object.keys(m.transform).sort()).toEqual(['ax', 'by', 'cx', 'dy']);
			expect(m.frame).toHaveLength(4);
			expect(m.transform.ax).toBeGreaterThan(0); // east is to the right
			expect(m.transform.by).toBeLessThan(0); // north is up
		}
	});

	it('includes the parking tier map and the precinct map as area maps', () => {
		expect(isAreaMap(byId('htc-parking-tiers'))).toBe(true);
		expect(isAreaMap(byId('htc-precincts'))).toBe(true);
		expect(isAreaMap(byId('htc-building-height'))).toBe(false);
	});
});

describe('placing a property on a map', () => {
	it('8 Killaloe Avenue lands inside the Beecroft-Cheltenham map where the trial put it', () => {
		const placed = placeOnMap(byId('hca-beecroft-cheltenham'), KILLALOE);
		expect(placed).not.toBeNull();
		expect(Math.abs(placed.x - 319)).toBeLessThan(15);
		expect(Math.abs(placed.y - 727)).toBeLessThan(15);
	});

	it('a property outside the picture is not placed', () => {
		expect(placeOnMap(byId('hca-the-crescent'), DURAL_16)).toBeNull();
		expect(placeOnMap(byId('htc-parking-tiers'), DURAL_16)).toBeNull();
	});

	it('finds the calibrated map on a page only when the property is inside it', () => {
		expect(mapOnPage(287, DURAL_16)?.map.id).toBe('htc-building-height');
		expect(mapOnPage(287, KILLALOE)).toBeNull();
		expect(mapOnPage(1, DURAL_16)).toBeNull(); // no map on that page
	});

	it.each([[null], [{}], [{ lon: NaN, lat: 1 }]])('a missing or bad point is never placed: %j', (pt) => {
		expect(placeOnMap(byId('hca-beecroft-cheltenham'), pt)).toBeNull();
	});
});

describe('which area maps go with the first message', () => {
	it('a heritage map only when NSW data puts the property in that area', () => {
		const inside = areaMapsFor({ point: KILLALOE, heritage_detail: [{ name: BEECROFT_HCA }] });
		expect(inside.map((p) => p.map.id)).toEqual(['hca-beecroft-cheltenham']);
	});

	it('no heritage map for a property in the picture but not in the area', () => {
		expect(placeOnMap(byId('hca-beecroft-cheltenham'), DUFFY_10)).not.toBeNull();
		expect(areaMapsFor({ point: DUFFY_10, heritage_detail: [] })).toEqual([]);
	});

	it('no maps at all without a point', () => {
		expect(areaMapsFor({ heritage_detail: [{ name: BEECROFT_HCA }] })).toEqual([]);
	});
});

describe('drawing the dot', () => {
	it('paints a magenta centre with a white rim and leaves the rest of the page alone', () => {
		const png = new PNG({ width: 60, height: 60 });
		png.data.fill(0); // black page, so the white rim is visible
		const out = drawDot(PNG.sync.write(png).toString('base64'), 30, 30);
		expect(pixel(out, 30, 30)).toEqual([255, 0, 200]);
		expect(pixel(out, 30 + 11, 30)).toEqual([255, 255, 255]);
		expect(pixel(out, 2, 2)).toEqual([0, 0, 0]);
	});

	it('a dot near the edge is clipped, not an error', () => {
		expect(() => drawDot(whitePng(), 1, 58)).not.toThrow();
	});
});

describe('the note that goes with a marked map', () => {
	it('names the figure, says the dot is the property, and gives the accuracy', () => {
		const m = byId('hca-beecroft-cheltenham');
		const note = markNote({ map: m, x: 1, y: 1 });
		expect(note).toContain('Figure 9.7-a');
		expect(note).toMatch(/MAGENTA DOT marks this property/);
		expect(note).toContain(`about ${accuracyMetres(m)} m`);
		expect(note).toMatch(/Northern Triangle/); // the precinct names printed on the map
	});

	it('accuracy is never claimed better than 10 m', () => {
		for (const m of MAPS) expect(accuracyMetres(m)).toBeGreaterThanOrEqual(10);
	});
});
