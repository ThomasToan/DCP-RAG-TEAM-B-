import { describe, it, expect } from 'vitest';
import { parseCsv, csvCell, shortlist, councilKey } from '../scripts/lib/dcp_index.js';

const row = (lga, title, mb, section = 'in-force') => ({ lga, title, url: `https://x/${title}`, bytes: String(mb * 1e6), section });

describe('parseCsv / csvCell', () => {
	it('round-trips commas, quotes and newlines', () => {
		const cells = ['plain', 'has, comma', 'has "quote"', 'two\nlines', ''];
		const text = `a,b,c,d,e\n${cells.map(csvCell).join(',')}\n`;
		expect(Object.values(parseCsv(text)[0])).toEqual(cells);
	});

	it('handles CRLF and a missing final newline', () => {
		expect(parseCsv('a,b\r\n1,2\r\n3,4')).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }]);
	});
});

describe('shortlist rule', () => {
	it('keeps the LARGEST in-force pdf per council', () => {
		const out = shortlist([row('Ryde', 'Ryde DCP 2014 - as amended 2016', 40), row('Ryde', 'Ryde DCP 2014 - as amended 2020', 90)], 10);
		expect(out).toHaveLength(1);
		expect(out[0].title).toContain('2020');
	});

	it.each([
		['a draft', 'Sutherland Draft DCP 2015'],
		['a maps-only file', 'Sydney DCP Maps (Combined) August 2020'],
		['a precinct-only file', 'Penrith DCP - Key Precinct'],
		['a schedule', 'Foo DCP Schedule 4'],
		['a bare amendment', 'Auburn DCP 2010 Amendment 6']
	])('excludes %s', (_what, title) => {
		expect(shortlist([row('Foo', title, 80)], 10)).toHaveLength(0);
	});

	it('excludes files under 15 MB and anything not in-force', () => {
		const out = shortlist([row('Small', 'Small DCP 2015', 14), row('Old', 'Old DCP 2005', 80, 'superseded'), row('Big', 'Big DCP 2015', 15)], 10);
		expect(out.map((r) => r.lga)).toEqual(['Big']);
	});

	it('treats "City of Canada Bay" and "Canada Bay" as one council', () => {
		expect(councilKey('City of Canada Bay')).toBe(councilKey('Canada Bay'));
		const out = shortlist([row('City of Canada Bay', 'City of Canada Bay DCP', 120), row('Canada Bay', 'Canada Bay DCP 2017', 105)], 10);
		expect(out).toHaveLength(1);
		expect(out[0].bytes).toBe(120e6);
	});

	it('returns the N largest, biggest first, with unique slugs and numeric bytes', () => {
		const rows = ['A', 'B', 'C', 'D'].map((c, i) => row(c, `${c} DCP 2015`, 20 + i * 10));
		const out = shortlist(rows, 3);
		expect(out.map((r) => r.lga)).toEqual(['D', 'C', 'B']);
		expect(new Set(out.map((r) => r.slug)).size).toBe(3);
		expect(typeof out[0].bytes).toBe('number');
	});

	it('ignores rows with no known size', () => {
		expect(shortlist([{ lga: 'X', title: 'X DCP', url: 'u', bytes: '', section: 'in-force' }], 5)).toHaveLength(0);
	});
});
