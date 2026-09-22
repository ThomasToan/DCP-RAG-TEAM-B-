import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PropertyError } from '../src/lib/server/property-error.js';

// Every dependency of the route is mocked, EXCEPT property-error.js: we throw real PropertyError
// instances so the route's `instanceof PropertyError` branch is exercised for real.
const mockEnv = { env: { OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'gpt-5.6-terra' } };
vi.mock('$env/dynamic/private', () => mockEnv);
vi.mock('openai', () => ({ default: class FakeOpenAI { constructor(opts) { this.opts = opts; } } }));
vi.mock('$lib/server/db.js', () => ({ getPool: () => 'FAKE_POOL' }));
vi.mock('$lib/server/property-cache.js', () => ({ pgPropertyCache: (pool) => ({ pool, get: async () => null, set: async () => {} }) }));
const getPropertyFacts = vi.fn();
vi.mock('$lib/server/property.js', () => ({ getPropertyFacts: (...a) => getPropertyFacts(...a) }));
const answerQuestion = vi.fn();
vi.mock('$lib/server/chat.js', async () => {
	const real = await vi.importActual('../src/lib/server/chat.js');
	return { ...real, answerQuestion: (...a) => answerQuestion(...a) };
});

const { POST } = await import('../src/routes/api/ask/+server.js');

const FACTS = {
	address: '16 DURAL STREET HORNSBY', site_oid: 12345, point: { lon: 1, lat: 2 },
	lot: 'SP 7670', lot_area_m2: 1010.1, lga: 'HORNSBY', zone: 'R4', zone_name: 'High Density Residential',
	unknown: [], not_covered: [], notes: [], sources: { zone: { layer: 'x' } }
};
const post = (body) => POST({ request: { json: async () => body } });
const postRaw = (text) => POST({ request: { json: async () => JSON.parse(text) } });

beforeEach(() => {
	getPropertyFacts.mockReset().mockResolvedValue(FACTS);
	answerQuestion.mockReset().mockResolvedValue({ answer: 'Yes, PDF page 37.', pages: [{ page: 37, score: 0.57 }], warnings: [], responseId: 'resp_1', toolCalls: [] });
	mockEnv.env.OPENAI_API_KEY = 'sk-test';
});

describe('POST /api/ask: input validation (nothing downstream is called)', () => {
	it('rejects invalid JSON', async () => {
		const res = await POST({ request: { json: async () => { throw new SyntaxError('bad json'); } } });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('BAD_REQUEST');
		expect(getPropertyFacts).not.toHaveBeenCalled();
	});

	it.each([[{}], [{ address: '' }], [{ address: '   ' }], [{ address: 5 }]])('rejects a missing/blank/non-string address: %j', async (body) => {
		const res = await post({ ...body, question: 'Can I build a shed?' });
		expect(res.status).toBe(400);
		expect(getPropertyFacts).not.toHaveBeenCalled();
	});

	it.each([[''], ['   '], ['x'.repeat(1001)], [5], [null]])('rejects a missing/blank/too-long/non-string question: %j', async (question) => {
		const res = await post({ address: '16 Dural St, Hornsby', question });
		expect(res.status).toBe(400);
		expect(getPropertyFacts).not.toHaveBeenCalled();
	});

	it('rejects a non-string previousResponseId', async () => {
		const res = await post({ address: '16 Dural St, Hornsby', question: 'q', previousResponseId: 42 });
		expect(res.status).toBe(400);
		expect(getPropertyFacts).not.toHaveBeenCalled();
	});

	it('accepts a missing previousResponseId (a fresh conversation)', async () => {
		const res = await post({ address: '16 Dural St, Hornsby', question: 'q' });
		expect(res.status).toBe(200);
	});
});

describe('POST /api/ask: missing server configuration', () => {
	it('500s with no OpenAI call attempted when OPENAI_API_KEY is unset', async () => {
		mockEnv.env.OPENAI_API_KEY = '';
		const res = await post({ address: '16 Dural St, Hornsby', question: 'q' });
		expect(res.status).toBe(500);
		expect((await res.json()).error).toBe('SERVER_MISCONFIGURED');
		expect(getPropertyFacts).not.toHaveBeenCalled();
		expect(answerQuestion).not.toHaveBeenCalled();
	});
});

describe('POST /api/ask: address resolution failures', () => {
	it.each([
		['NOT_FOUND', 404],
		['BAD_ADDRESS', 404],
		['AMBIGUOUS', 404],
		['NO_LOT', 404],
		['UPSTREAM', 502]
	])('%s maps to HTTP %i and never calls the model', async (code, status) => {
		getPropertyFacts.mockRejectedValue(new PropertyError(code, `boom: ${code}`, { hint: 1 }));
		const res = await post({ address: '999999 Nowhere Rd', question: 'q' });
		expect(res.status).toBe(status);
		const body = await res.json();
		expect(body).toMatchObject({ error: code, message: `boom: ${code}`, details: { hint: 1 } });
		expect(answerQuestion).not.toHaveBeenCalled();
	});

	it('an unexpected (non-PropertyError) failure is not swallowed', async () => {
		getPropertyFacts.mockRejectedValue(new TypeError('unexpected'));
		await expect(post({ address: 'x', question: 'q' })).rejects.toThrow('unexpected');
	});
});

describe('POST /api/ask: the happy path', () => {
	it('forwards facts, question and previousResponseId to the chat brain', async () => {
		await post({ address: '16 Dural St, Hornsby', question: 'Can I build a shed?', previousResponseId: 'resp_0' });
		expect(answerQuestion).toHaveBeenCalledTimes(1);
		const [input, deps] = answerQuestion.mock.calls[0];
		expect(input).toEqual({ facts: FACTS, question: 'Can I build a shed?', previousResponseId: 'resp_0' });
		expect(deps.model).toBe('gpt-5.6-terra');
		expect(deps.openai).toBeInstanceOf(Object);
	});

	it('the response never leaks internal fact fields (ids, coordinates, raw ArcGIS sources)', async () => {
		const res = await post({ address: '16 Dural St, Hornsby', question: 'q' });
		const body = await res.json();
		expect(body.facts).not.toHaveProperty('site_oid');
		expect(body.facts).not.toHaveProperty('point');
		expect(body.facts.address).toBe(FACTS.address);
		expect(body.facts.summary).toContain('R4');
	});

	it('returns the answer, cited pages, warnings and conversation id', async () => {
		const res = await post({ address: '16 Dural St, Hornsby', question: 'q' });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ answer: 'Yes, PDF page 37.', pages: [{ page: 37, score: 0.57 }], warnings: [], responseId: 'resp_1', skippedModel: false });
	});

	it('reuses one OpenAI client across requests rather than reconnecting every time', async () => {
		await post({ address: '16 Dural St, Hornsby', question: 'q1' });
		await post({ address: '16 Dural St, Hornsby', question: 'q2' });
		const clients = answerQuestion.mock.calls.map(([, deps]) => deps.openai);
		expect(clients[0]).toBe(clients[1]);
	});
});

describe('POST /api/ask: the model call fails', () => {
	it('returns a safe 502 instead of a stack trace, and does not throw', async () => {
		answerQuestion.mockRejectedValue(new Error('OpenAI is down'));
		const res = await post({ address: '16 Dural St, Hornsby', question: 'q' });
		expect(res.status).toBe(502);
		expect((await res.json()).error).toBe('ANSWER_FAILED');
	});
});
