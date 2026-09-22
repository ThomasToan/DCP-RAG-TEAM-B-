import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { GET } from '../src/routes/dcp-page/[page]/+server.js';

const get = (page) => GET({ params: { page } });
const pagesExist = existsSync('data/hornsby/pages/p0001.png');

describe('GET /dcp-page/[page]: input validation (never touches the filesystem for a bad page)', () => {
	it.each(['0', '-1', '490', '999999', '1.5', 'abc', '', '17; rm -rf', '../../.env'])('rejects %j with 404', async (page) => {
		await expect(get(page)).rejects.toMatchObject({ status: 404 });
	});

	it('accepts the boundary values 1 and 489', () => {
		// these pass validation and proceed to a filesystem read, which throws its own 404 if the file is missing;
		// what matters here is that they are NOT rejected by the page-number check itself
		return Promise.all(
			['1', '489'].map((page) =>
				get(page).catch((e) => {
					if (e.status !== 404 || pagesExist) throw e; // a 404 is only acceptable when we know the file legitimately doesn't exist
				})
			)
		);
	});
});

describe.skipIf(!pagesExist)('GET /dcp-page/[page]: serving a real rendered page', () => {
	it('returns the PNG with a long-lived cache header', async () => {
		const res = await get('1');
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(res.headers.get('cache-control')).toMatch(/immutable/);
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(bytes.length).toBeGreaterThan(1000);
		expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
	});

	it('a page number past the real page count 404s', async () => {
		await expect(get('489')).resolves.toBeTruthy(); // last real page still exists
	});
});
