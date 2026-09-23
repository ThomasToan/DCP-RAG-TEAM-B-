import { describe, it, expect, vi } from 'vitest';
import { fetchWithRetry } from '../src/lib/server/dcp_search.js';

const ok = (body = '{}') => new Response(body, { status: 200 });
const bad = (status = 404) => new Response('nope', { status });
const noSleep = async () => {};

/** fetch that plays back responses/throws in order */
const scripted = (...items) => {
	const fn = vi.fn(async () => {
		const item = items.shift();
		if (item instanceof Error) throw item;
		return item;
	});
	return fn;
};

describe('fetchWithRetry: the Fly cold-start race (a wrong-but-real response, not a thrown error)', () => {
	it('returns immediately on a first-try success, with no delay', async () => {
		const f = scripted(ok());
		const sleep = vi.fn();
		const res = await fetchWithRetry(f, 'http://x', undefined, sleep);
		expect(res.ok).toBe(true);
		expect(f).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it('retries ONCE after a bad response and returns the good one', async () => {
		const f = scripted(bad(404), ok());
		const res = await fetchWithRetry(f, 'http://x', undefined, noSleep);
		expect(res.ok).toBe(true);
		expect(f).toHaveBeenCalledTimes(2);
	});

	it('retries once after a thrown network error and returns the good response', async () => {
		const f = scripted(new TypeError('fetch failed'), ok());
		const res = await fetchWithRetry(f, 'http://x', undefined, noSleep);
		expect(res.ok).toBe(true);
		expect(f).toHaveBeenCalledTimes(2);
	});

	it('gives up after exactly two attempts: a second bad response is returned, not retried again', async () => {
		const f = scripted(bad(404), bad(503), ok());
		const res = await fetchWithRetry(f, 'http://x', undefined, noSleep);
		expect(res.ok).toBe(false);
		expect(res.status).toBe(503);
		expect(f).toHaveBeenCalledTimes(2); // the third scripted response is never used
	});

	it('a second thrown error propagates, it is not swallowed into a fake response', async () => {
		const boom = new Error('still down');
		const f = scripted(new Error('first'), boom);
		await expect(fetchWithRetry(f, 'http://x', undefined, noSleep)).rejects.toBe(boom);
	});

	it('waits between the two attempts', async () => {
		const sleep = vi.fn(async () => {});
		await fetchWithRetry(scripted(bad(404), ok()), 'http://x', undefined, sleep);
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(1000);
	});

	it('passes the url and init through unchanged to fetch', async () => {
		const f = scripted(ok());
		const init = { method: 'POST', body: 'x' };
		await fetchWithRetry(f, 'http://x/search', init, noSleep);
		expect(f).toHaveBeenCalledWith('http://x/search', init);
	});

	it('a genuinely broken endpoint (fails both attempts) is reported, not retried forever', async () => {
		const f = scripted(bad(500), bad(500), ok(), ok()); // extra scripted oks must never be consumed
		const res = await fetchWithRetry(f, 'http://x', undefined, noSleep);
		expect(res.status).toBe(500);
		expect(f).toHaveBeenCalledTimes(2);
	});
});
