import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { GET } from '../src/routes/dcp-page/[page]/+server.js';

const pagesExist = existsSync('data/hornsby/pages/p0001.png');
const get = (page) => GET({ params: { page }, fetch: undefined });

describe('GET /dcp-page/[page]: local disk mode (no PIXELRAG_URL)', () => {
	it.each(['0', '-1', '490', '999999', '1.5', 'abc', '', '17; rm -rf', '../../.env'])('rejects %j with 404, never touching the filesystem', async (page) => {
		await expect(get(page)).rejects.toMatchObject({ status: 404 });
	});

	it('accepts the boundary values 1 and 489', () => {
		return Promise.all(
			['1', '489'].map((page) =>
				get(page).catch((e) => {
					if (e.status !== 404 || pagesExist) throw e; // a 404 is only acceptable when we know the file legitimately doesn't exist
				})
			)
		);
	});

	if (pagesExist) {
		it('returns the PNG with a long-lived cache header', async () => {
			const res = await get('1');
			expect(res.headers.get('content-type')).toBe('image/png');
			expect(res.headers.get('cache-control')).toMatch(/immutable/);
			const bytes = new Uint8Array(await res.arrayBuffer());
			expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
		});
	}
});

describe('GET /dcp-page/[page]: proxy mode (PIXELRAG_URL set)', () => {
	// $env/dynamic/private is mocked per-test here (not with a hoisted vi.mock), so the block above
	// keeps using the real module while this block gets a controlled PIXELRAG_URL.
	async function withProxyEnv() {
		vi.resetModules();
		vi.doMock('$env/dynamic/private', () => ({ env: { PIXELRAG_URL: 'https://dcp-hornsby-search.fly.dev' } }));
		return import('../src/routes/dcp-page/[page]/+server.js');
	}

	it('fetches from PIXELRAG_URL/pages/pNNNN.png, never reading local disk', async () => {
		const { GET: proxyGET } = await withProxyEnv();
		let requestedUrl;
		const fetch = async (url) => {
			requestedUrl = url;
			return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'content-type': 'image/png' } });
		};
		const res = await proxyGET({ params: { page: '37' }, fetch });
		expect(requestedUrl).toBe('https://dcp-hornsby-search.fly.dev/pages/p0037.png');
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(res.headers.get('cache-control')).toMatch(/immutable/);
	});

	it('a bad page number is still rejected before any fetch, even in proxy mode', async () => {
		const { GET: proxyGET } = await withProxyEnv();
		const fetch = vi.fn();
		await expect(proxyGET({ params: { page: '0' }, fetch })).rejects.toMatchObject({ status: 404 });
		expect(fetch).not.toHaveBeenCalled();
	});

	it('a failed upstream fetch becomes a 404, not a crash', async () => {
		const { GET: proxyGET } = await withProxyEnv();
		const fetch = async () => new Response('not found', { status: 404 });
		await expect(proxyGET({ params: { page: '37' }, fetch })).rejects.toMatchObject({ status: 404 });
	});
});
