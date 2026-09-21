import { describe, it, expect } from 'vitest';
import { DEFINITIONS, summarise, isBlank } from '../scripts/lib/score.js';

// page row = [chars, bigRasters, rasterCoverage, drawings]
const TEXT_PAGE = [2500, 0, 0, 0];
const PICTURE_PAGE = [40, 1, 0.62, 0]; // big photo, one caption
const DIAGRAM_PAGE = [60, 0, 0, 80]; // vector diagram, one caption
const SHORT_TEXT_PAGE = [120, 0, 0, 0]; // last page of a chapter: 3 lines, nothing else
const BLANK_PAGE = [0, 0, 0, 0];
const LOGO_TEXT_PAGE = [2500, 1, 0.02, 0]; // page furniture: a big-ish logo, but the content is text

const primary = DEFINITIONS.primary.test;

describe('primary definition', () => {
	it('counts a picture page and a vector diagram page', () => {
		expect(primary(PICTURE_PAGE)).toBe(true);
		expect(primary(DIAGRAM_PAGE)).toBe(true);
	});

	it('does NOT count a plain short text page (the flaw the first attempt had)', () => {
		expect(primary(SHORT_TEXT_PAGE)).toBe(false);
	});

	it('does not count a blank page or a text page', () => {
		expect(primary(BLANK_PAGE)).toBe(false);
		expect(primary(TEXT_PAGE)).toBe(false);
	});

	it('does not count a text page just because it carries a logo', () => {
		expect(primary(LOGO_TEXT_PAGE)).toBe(false);
	});

	it('counts a text-rich page whose pictures cover 30%+ of it (photo with a long caption)', () => {
		expect(primary([900, 2, 0.31, 0])).toBe(true);
		expect(primary([900, 2, 0.29, 0])).toBe(false);
	});

	it('needs 5+ paths for a vector page: table borders alone (4 paths) are not a diagram', () => {
		expect(primary([100, 0, 0, 4])).toBe(false);
		expect(primary([100, 0, 0, 5])).toBe(true);
	});
});

describe('the literal exercise wording is polluted by page furniture', () => {
	it('flags every page that has any big raster, even a text page with a logo', () => {
		expect(DEFINITIONS.literal.test(LOGO_TEXT_PAGE)).toBe(true);
		expect(DEFINITIONS.literal.test(SHORT_TEXT_PAGE)).toBe(true);
	});
});

describe('isBlank', () => {
	it('is true only when there is no text, no raster and almost no drawing', () => {
		expect(isBlank(BLANK_PAGE)).toBe(true);
		expect(isBlank([19, 0, 0, 4])).toBe(true);
		expect(isBlank([19, 0, 0, 5])).toBe(false);
		expect(isBlank(SHORT_TEXT_PAGE)).toBe(false);
	});
});

describe('summarise', () => {
	const rows = [TEXT_PAGE, PICTURE_PAGE, DIAGRAM_PAGE, SHORT_TEXT_PAGE, BLANK_PAGE];
	const s = summarise(rows);

	it('reports shares under every definition', () => {
		expect(s.pages).toBe(5);
		expect(s.share.primary).toBe(0.4);
		expect(s.share.cover30).toBe(0.2);
		expect(s.share.cover50).toBe(0.2);
		expect(s.share.literal).toBe(0.8); // everything except the text page
		expect(Object.keys(s.share).sort()).toEqual(Object.keys(DEFINITIONS).sort());
	});

	it('reports the descriptive shares', () => {
		expect(s.blank).toBe(0.2);
		expect(s.lowText).toBe(0.8);
		expect(s.bigRaster).toBe(0.2);
		expect(s.vectorHeavy).toBe(0.2);
		expect(s.fullPage).toBe(0);
		expect(s.medianChars).toBe(60);
	});

	it('is safe on an empty document', () => {
		const e = summarise([]);
		expect(e.pages).toBe(0);
		expect(e.share.primary).toBe(0);
		expect(e.medianChars).toBe(0);
	});

	it('the ranking order under primary is robust to the 5+ vs 20+ path threshold on these examples', () => {
		expect(DEFINITIONS.strictGraphic.test(DIAGRAM_PAGE)).toBe(true); // 80 paths
		expect(DEFINITIONS.strictGraphic.test([100, 0, 0, 10])).toBe(false);
	});
});
