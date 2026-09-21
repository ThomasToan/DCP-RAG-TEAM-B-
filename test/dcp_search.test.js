import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pageOf, searchPages, loadPageImage, DEFAULTS } from '../src/lib/server/dcp_search.js';

const hit = (page, score, chunk = 0) => ({ score, chunk_index: chunk, url: `data/hornsby/pages/p${String(page).padStart(4, '0')}.png` });
const fakeFetch = (hits, status = 200) => async () => new Response(JSON.stringify({ results: [{ hits }] }), { status });

describe('pageOf', () => {
	it.each([
		[{ url: 'data/hornsby/pages/p0037.png' }, 37],
		[{ path: 'x/p0449.png' }, 449],
		[{ url: 'C:\\pages\\P0005.PNG' }, 5]
	])('%j -> %s', (h, page) => expect(pageOf(h)).toBe(page));

	it('returns null for anything that is not one of our page files', () => {
		expect(pageOf({ url: 'https://example.com/a.png' })).toBeNull();
		expect(pageOf({})).toBeNull();
		expect(pageOf(undefined)).toBeNull();
	});
});

describe('searchPages', () => {
	it('collapses chunk hits to pages: best chunk wins, sorted by score', async () => {
		const r = await searchPages('q', { fetch: fakeFetch([hit(17, 0.41, 0), hit(33, 0.35, 2), hit(17, 0.44, 3), hit(37, 0.5, 1)]) });
		expect(r.pages.map((p) => [p.page, p.score, p.chunk])).toEqual([[37, 0.5, 1], [17, 0.44, 3], [33, 0.35, 2]]);
		expect(r.belowFloor).toBe(false);
		expect(r.best).toBe(0.5);
	});

	it('drops pages under the score floor, so nonsense returns nothing', async () => {
		const r = await searchPages('how do I bake bread', { fetch: fakeFetch([hit(209, 0.234), hit(282, 0.226)]) });
		expect(r.pages).toEqual([]);
		expect(r.belowFloor).toBe(true);
		expect(r.best).toBe(0.234); // still reported, so a caller can log how close it was
	});

	it('the floor default keeps every real question and drops the nonsense one measured on the 10-page index', () => {
		expect(DEFAULTS.floor).toBeGreaterThan(0.234);
		expect(DEFAULTS.floor).toBeLessThan(0.389);
	});

	it('caps the number of pages returned', async () => {
		const hits = [10, 11, 12, 13, 14, 15].map((p, i) => hit(p, 0.6 - i * 0.01));
		expect((await searchPages('q', { fetch: fakeFetch(hits), topPages: 3 })).pages).toHaveLength(3);
	});

	it('ignores hits whose source is not a page file', async () => {
		const r = await searchPages('q', { fetch: fakeFetch([{ score: 0.9, url: 'nope.png' }, hit(5, 0.4)]) });
		expect(r.pages.map((p) => p.page)).toEqual([5]);
	});

	it('sends the question and chunk count to /search', async () => {
		let seen;
		const f = async (url, init) => ((seen = { url, body: JSON.parse(init.body) }), new Response(JSON.stringify({ results: [{ hits: [] }] })));
		await searchPages('tree removal', { fetch: f, url: 'http://x:1', chunksToFetch: 7 });
		expect(seen.url).toBe('http://x:1/search');
		expect(seen.body).toEqual({ queries: [{ text: 'tree removal' }], n_docs: 7 });
	});

	it('throws on an HTTP error rather than pretending nothing matched', async () => {
		await expect(searchPages('q', { fetch: fakeFetch([], 500) })).rejects.toThrow(/HTTP 500/);
	});

	it('an empty result is not an error', async () => {
		const r = await searchPages('q', { fetch: fakeFetch([]) });
		expect(r).toEqual({ pages: [], belowFloor: true, best: null });
	});
});

describe('loadPageImage', () => {
	it('reads p0037.png from the pages folder as base64', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'pages-'));
		writeFileSync(join(dir, 'p0037.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		const img = await loadPageImage(37, { pagesDir: dir });
		expect(img.mime).toBe('image/png');
		expect(Buffer.from(img.base64, 'base64')).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	});

	it('rejects for a page that was never rendered', async () => {
		await expect(loadPageImage(9999, { pagesDir: tmpdir() })).rejects.toThrow();
	});
});
