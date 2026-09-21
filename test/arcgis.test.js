import { describe, it, expect, vi } from 'vitest';
import { arcgisQuery } from '../src/lib/server/arcgis.js';
import { PropertyError } from '../src/lib/server/property-error.js';

const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
const html502 = () => new Response('<html><h1>502 Bad Gateway</h1></html>', { status: 502 });
const noSleep = async () => {};

/** fetch that plays back `responses` in order and counts calls */
const scripted = (...responses) => {
	const fn = vi.fn(async () => {
		const r = responses.shift();
		if (r instanceof Error) throw r;
		return r;
	});
	return fn;
};

describe('arcgisQuery retry policy', () => {
	it('returns the parsed JSON on success with a single call', async () => {
		const f = scripted(json({ features: [1] }));
		expect(await arcgisQuery('http://x/query', { where: '1=1' }, { fetch: f, sleep: noSleep })).toEqual({ features: [1] });
		expect(f).toHaveBeenCalledTimes(1);
	});

	it('POSTs the params as a form body (no polygon in the URL)', async () => {
		const f = scripted(json({ features: [] }));
		await arcgisQuery('http://x/query', { where: '1=1', geometry: '{"rings":[]}' }, { fetch: f, sleep: noSleep });
		const [url, init] = f.mock.calls[0];
		expect(url).toBe('http://x/query');
		expect(init.method).toBe('POST');
		expect(String(init.body)).toContain('f=json');
		expect(String(init.body)).toContain('where=1%3D1');
	});

	it('retries ONCE after a 502 and succeeds', async () => {
		const f = scripted(html502(), json({ features: [] }));
		await arcgisQuery('http://x/query', {}, { fetch: f, sleep: noSleep });
		expect(f).toHaveBeenCalledTimes(2);
	});

	it('gives up after exactly two attempts and throws a retryable UPSTREAM error', async () => {
		const f = scripted(html502(), html502(), json({ features: [] }));
		const err = await arcgisQuery('http://x/query', {}, { fetch: f, sleep: noSleep, label: 'flood' }).catch((e) => e);
		expect(err).toBeInstanceOf(PropertyError);
		expect(err.code).toBe('UPSTREAM');
		expect(err.details.retryable).toBe(true);
		expect(err.message).toContain('flood');
		expect(f).toHaveBeenCalledTimes(2); // the third scripted response is never used
	});

	it('treats an HTML body with HTTP 200 as a failure and retries', async () => {
		const f = scripted(new Response('<html>maintenance</html>', { status: 200 }), json({ ok: 1 }));
		expect(await arcgisQuery('http://x/query', {}, { fetch: f, sleep: noSleep })).toEqual({ ok: 1 });
		expect(f).toHaveBeenCalledTimes(2);
	});

	it('retries a network error and a timeout', async () => {
		const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
		const f = scripted(timeout, new TypeError('fetch failed'));
		const err = await arcgisQuery('http://x/query', {}, { fetch: f, sleep: noSleep }).catch((e) => e);
		expect(err.code).toBe('UPSTREAM');
		expect(f).toHaveBeenCalledTimes(2);
	});

	it('does NOT retry a 4xx ArcGIS error: that is our bug, not an outage', async () => {
		const f = scripted(json({ error: { code: 400, message: 'Unable to complete operation.' } }));
		const err = await arcgisQuery('http://x/query', { where: 'bad' }, { fetch: f, sleep: noSleep }).catch((e) => e);
		expect(err.code).toBe('UPSTREAM');
		expect(err.details.retryable).toBe(false);
		expect(f).toHaveBeenCalledTimes(1);
	});

	it('does retry a 5xx ArcGIS error object', async () => {
		const f = scripted(json({ error: { code: 500, message: 'boom' } }), json({ features: [] }));
		await arcgisQuery('http://x/query', {}, { fetch: f, sleep: noSleep });
		expect(f).toHaveBeenCalledTimes(2);
	});

	it('waits between the two attempts', async () => {
		const sleep = vi.fn(async () => {});
		await arcgisQuery('http://x/query', {}, { fetch: scripted(html502(), json({})), sleep });
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(1000);
	});
});
