import { describe, it, expect } from 'vitest';
import { answerQuestion, describeFacts, citedPageNumbers, TOOLS, SYSTEM_PROMPT, MAX_ROUNDS, MAX_SEARCHES } from '../src/lib/server/chat.js';

// A real-shaped facts bundle (what property.js returns) for a Hornsby lot
const FACTS = {
	address: '16 DURAL STREET HORNSBY', site_oid: 987654321, point: { lon: 151.09, lat: -33.7 },
	lot: 'Lot 5 DP 12345', lot_area_m2: 1010.1, lga: 'HORNSBY', council: 'HORNSBY SHIRE COUNCIL',
	zone: 'R4', zone_name: 'High Density Residential', zones: ['R4'], fsr: null, height_m: null, min_lot_m2: 500,
	heritage: null, bushfire: 'Vegetation Buffer', flood: false, acid_sulfate: null,
	terrestrial_biodiversity: false, foreshore: false, unknown: [], not_covered: []
};

const finalResp = (text, id = 'resp_final') => ({ id, output: [{ type: 'message' }], output_text: text });
const toolResp = (query, callId = 'call_1', id = 'resp_tool') => ({ id, output: [{ type: 'function_call', call_id: callId, name: 'search_dcp', arguments: JSON.stringify({ query }) }] });

/** fake OpenAI: plays the script in order and records every request */
const fakeOpenAI = (...script) => {
	const calls = [];
	return { calls, responses: { create: async (args) => (calls.push(args), script.shift() ?? finalResp('(script exhausted)')) } };
};
const fakeSearch = (pages = [{ page: 37, score: 0.57, chunk: 0 }]) => {
	const seen = [];
	const fn = async (q) => (seen.push(q), { pages, belowFloor: pages.length === 0, best: pages[0]?.score ?? 0.2 });
	fn.seen = seen;
	return fn;
};
const fakeImage = async (page) => ({ mime: 'image/png', base64: `IMG${page}` });
const deps = (openai, search = fakeSearch(), extra = {}) => ({ openai, model: 'test-model', search, loadImage: fakeImage, ...extra });

describe('scope: the property is decided by the server, never by the model', () => {
	it('the only tool takes just a search phrase: no address, zone, lga or id parameter', () => {
		expect(TOOLS).toHaveLength(1);
		const props = TOOLS[0].parameters.properties;
		expect(Object.keys(props)).toEqual(['query']);
		expect(TOOLS[0].parameters.additionalProperties).toBe(false);
		expect(TOOLS[0].strict).toBe(true);
		expect(JSON.stringify(TOOLS)).not.toMatch(/address|lga|zone|store_id|email|lot/i);
	});

	it('the facts are put in the first message by the server', async () => {
		const ai = fakeOpenAI(finalResp('ok'));
		await answerQuestion({ facts: FACTS, question: 'Can I build townhouses?' }, deps(ai));
		const first = ai.calls[0].input[0].content[0].text;
		expect(first).toContain('16 DURAL STREET HORNSBY');
		expect(first).toContain('R4 (High Density Residential)');
		expect(first).toContain('1010.1 m2');
		expect(first).toContain('Vegetation Buffer');
		expect(first).toContain('QUESTION: Can I build townhouses?');
	});

	it('internal ids and coordinates are not shown to the model', async () => {
		const ai = fakeOpenAI(finalResp('ok'));
		await answerQuestion({ facts: FACTS, question: 'q' }, deps(ai));
		const first = ai.calls[0].input[0].content[0].text;
		expect(first).not.toContain('987654321');
		expect(first).not.toContain('151.09');
	});

	it('a property outside Hornsby never reaches the model', async () => {
		const ai = fakeOpenAI(finalResp('should not be used'));
		const r = await answerQuestion({ facts: { ...FACTS, lga: 'CESSNOCK', address: '15 ELLALONG STREET PELAW MAIN' }, question: 'Can I build?' }, deps(ai));
		expect(ai.calls).toHaveLength(0);
		expect(r.skippedModel).toBe(true);
		expect(r.answer).toMatch(/only applies in Hornsby/);
		expect(r.answer).toMatch(/CESSNOCK/);
	});

	it.each([[''], ['   '], ['x'.repeat(1001)]])('a bad question %j never reaches the model', async (q) => {
		const ai = fakeOpenAI(finalResp('nope'));
		const r = await answerQuestion({ facts: FACTS, question: q }, deps(ai));
		expect(ai.calls).toHaveLength(0);
		expect(r.skippedModel).toBe(true);
	});
});

describe('describeFacts: unknown is never rendered as "no"', () => {
	it('flood with no state data is NOT COVERED', () => {
		expect(describeFacts({ ...FACTS, flood: null, not_covered: ['flood'] })).toMatch(/Flood planning: NOT COVERED/);
	});
	it('a layer that was down is NOT KNOWN', () => {
		const t = describeFacts({ ...FACTS, bushfire: null, heritage: null, unknown: ['bushfire', 'heritage'] });
		expect(t).toMatch(/Bushfire: NOT KNOWN/);
		expect(t).toMatch(/Heritage: NOT KNOWN/);
	});
	it('a real "no" is rendered as no, and heritage items are shown', () => {
		expect(describeFacts(FACTS)).toMatch(/Flood planning: no/);
		expect(describeFacts({ ...FACTS, heritage: 'item I26' })).toMatch(/Heritage: item I26/);
	});
	it('tells the model what it cannot see', () => {
		expect(describeFacts(FACTS)).toMatch(/Not available to you: street trees/);
	});
	it('a split-zoned lot lists every zone it touches', () => {
		expect(describeFacts({ ...FACTS, zones: ['R2', 'E4'] })).toMatch(/touches zones R2, E4/);
	});
});

describe('the search tool loop', () => {
	it('search results come back as labelled page images, and the answer cites retrieved pages', async () => {
		const ai = fakeOpenAI(toolResp('car parking rates for apartments'), finalResp('Tier 1 needs 0.8 spaces (PDF page 37, Table 1.3.2-d).'));
		const search = fakeSearch();
		const r = await answerQuestion({ facts: FACTS, question: 'Parking for a 2 bedroom?' }, deps(ai, search));

		expect(search.seen).toEqual(['car parking rates for apartments']);
		expect(ai.calls).toHaveLength(2);
		const second = ai.calls[1];
		expect(second.previous_response_id).toBe('resp_tool');
		const out = second.input.find((i) => i.type === 'function_call_output');
		expect(out.call_id).toBe('call_1');
		expect(JSON.parse(out.output).pages).toEqual([{ pdf_page: 37, match_score: 0.57 }]);
		const imgMsg = second.input.find((i) => i.role === 'user');
		expect(imgMsg.content[0].text).toMatch(/^PDF page 37 of the Hornsby/);
		expect(imgMsg.content[1]).toMatchObject({ type: 'input_image', image_url: 'data:image/png;base64,IMG37', detail: 'high' });

		expect(r.answer).toContain('0.8 spaces');
		expect(r.pages).toEqual([{ page: 37, score: 0.57 }]);
		expect(r.toolCalls).toEqual([{ query: 'car parking rates for apartments', pages: [37], belowFloor: false }]);
		expect(r.warnings).toEqual([]);
	});

	it('when nothing matches, the model is told so and no images are sent', async () => {
		const ai = fakeOpenAI(toolResp('how to bake bread'), finalResp('The DCP has nothing on that.'));
		const r = await answerQuestion({ facts: FACTS, question: 'bake bread?' }, deps(ai, fakeSearch([])));
		const second = ai.calls[1];
		expect(JSON.parse(second.input[0].output).note).toMatch(/Nothing in the DCP matched/);
		expect(second.input.some((i) => i.role === 'user')).toBe(false);
		expect(r.pages).toEqual([]);
		expect(r.toolCalls[0].belowFloor).toBe(true);
	});

	it('flags a page number in the answer that was never retrieved', async () => {
		const ai = fakeOpenAI(toolResp('trees'), finalResp('See PDF page 99 and PDF page 37.'));
		const r = await answerQuestion({ facts: FACTS, question: 'trees?' }, deps(ai));
		expect(r.warnings.join(' ')).toMatch(/page\(s\) 99 that were not among the pages retrieved/);
	});

	it('usage is the SUM over every request of the question, not just the last one', async () => {
		const withUsage = (resp, i, o) => ({ ...resp, usage: { input_tokens: i, output_tokens: o } });
		const ai = fakeOpenAI(withUsage(toolResp('a', 'c1', 'r1'), 1000, 20), withUsage(toolResp('b', 'c2', 'r2'), 9000, 30), withUsage(finalResp('done'), 12000, 400));
		const r = await answerQuestion({ facts: FACTS, question: 'q' }, deps(ai));
		expect(r.usage).toEqual({ requests: 3, input_tokens: 22000, output_tokens: 450 });
	});

	it('usage is still reported when the round cap is hit', async () => {
		const withUsage = (resp) => ({ ...resp, usage: { input_tokens: 100, output_tokens: 5 } });
		const ai = fakeOpenAI(...Array.from({ length: 5 }, (_, i) => withUsage(toolResp(`q${i}`, `c${i}`, `r${i}`))));
		const r = await answerQuestion({ facts: FACTS, question: 'q' }, deps(ai, fakeSearch(), { maxRounds: 1 }));
		expect(r.usage).toEqual({ requests: 2, input_tokens: 200, output_tokens: 10 });
	});

	it('a page already shown is not sent as an image a second time', async () => {
		const ai = fakeOpenAI(toolResp('parking', 'c1', 'r1'), toolResp('parking tiers', 'c2', 'r2'), finalResp('done'));
		let loads = [];
		const loadImage = async (page) => (loads.push(page), { mime: 'image/png', base64: `IMG${page}` });
		await answerQuestion({ facts: FACTS, question: 'q' }, deps(ai, fakeSearch([{ page: 37, score: 0.6, chunk: 0 }, { page: 33, score: 0.5, chunk: 0 }]), { loadImage }));
		expect(loads).toEqual([37, 33]); // loaded once each, although both searches returned both pages
		const round2 = ai.calls[2].input;
		expect(round2.some((i) => i.role === 'user')).toBe(false); // no second image message
		const out = JSON.parse(round2.find((i) => i.type === 'function_call_output').output);
		expect(out.already_shown_earlier).toEqual([37, 33]);
		expect(out.note).toMatch(/already shown/);
	});

	it('a second search that finds one new page sends only that page', async () => {
		const ai = fakeOpenAI(toolResp('a', 'c1', 'r1'), toolResp('b', 'c2', 'r2'), finalResp('done'));
		const answers = [[{ page: 37, score: 0.6, chunk: 0 }], [{ page: 37, score: 0.6, chunk: 0 }, { page: 111, score: 0.5, chunk: 0 }]];
		const search = async () => ({ pages: answers.shift(), belowFloor: false, best: 0.6 });
		await answerQuestion({ facts: FACTS, question: 'q' }, deps(ai, search));
		const imgMsg = ai.calls[2].input.find((i) => i.role === 'user');
		expect(imgMsg.content.filter((c) => c.type === 'input_image')).toHaveLength(1);
		expect(imgMsg.content[0].text).toMatch(/PDF page 111/);
	});

	it('bad tool arguments are answered with an error and trigger no search', async () => {
		const bad = { id: 'r1', output: [{ type: 'function_call', call_id: 'c9', name: 'search_dcp', arguments: 'not json' }] };
		const ai = fakeOpenAI(bad, finalResp('sorry'));
		const search = fakeSearch();
		await answerQuestion({ facts: FACTS, question: 'q' }, deps(ai, search));
		expect(search.seen).toEqual([]);
		expect(JSON.parse(ai.calls[1].input[0].output).error).toMatch(/query must be/);
	});

	it('an over-long query is rejected the same way', async () => {
		const ai = fakeOpenAI(toolResp('x'.repeat(301)), finalResp('sorry'));
		const search = fakeSearch();
		await answerQuestion({ facts: FACTS, question: 'q' }, deps(ai, search));
		expect(search.seen).toEqual([]);
	});

	it('stops after the round cap and returns a fallback instead of looping forever', async () => {
		const ai = fakeOpenAI(...Array.from({ length: 10 }, (_, i) => toolResp(`q${i}`, `c${i}`, `r${i}`)));
		const search = fakeSearch();
		const r = await answerQuestion({ facts: FACTS, question: 'q' }, deps(ai, search, { maxRounds: 2 }));
		expect(ai.calls).toHaveLength(3); // rounds 0, 1, 2
		expect(search.seen).toHaveLength(2); // the third tool call is never executed
		expect(r.warnings).toContain('search round limit reached');
		expect(r.answer).toMatch(/could not settle this/);
	});

	it('the default cap is 5, as in the order agent', () => expect(MAX_ROUNDS).toBe(5));

	it('caps the TOTAL number of searches even when one round holds several parallel calls', async () => {
		const three = { id: 'r1', output: ['a', 'b', 'c'].map((q, i) => ({ type: 'function_call', call_id: `c${i}`, name: 'search_dcp', arguments: JSON.stringify({ query: q }) })) };
		const ai = fakeOpenAI(three, finalResp('done'));
		const search = fakeSearch();
		const r = await answerQuestion({ facts: FACTS, question: 'q' }, deps(ai, search, { maxSearches: 2 }));
		expect(search.seen).toEqual(['a', 'b']); // the third never runs
		const outs = ai.calls[1].input.filter((i) => i.type === 'function_call_output').map((o) => JSON.parse(o.output));
		expect(outs).toHaveLength(3);
		expect(outs[2].error).toMatch(/search limit reached \(2 per question\)/);
		expect(r.toolCalls).toHaveLength(2);
	});

	it('the default search cap is 4 and the model is told', () => {
		expect(MAX_SEARCHES).toBe(4);
		expect(SYSTEM_PROMPT).toMatch(/at most four searches/);
	});

	it('a follow-up continues the conversation and does not resend the facts', async () => {
		const ai = fakeOpenAI(finalResp('follow-up answer'));
		await answerQuestion({ facts: FACTS, question: 'And for 3 bedrooms?', previousResponseId: 'resp_prev' }, deps(ai));
		expect(ai.calls[0].previous_response_id).toBe('resp_prev');
		expect(ai.calls[0].input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'And for 3 bedrooms?' }] }]);
	});

	it('sends the system prompt and model on every request', async () => {
		const ai = fakeOpenAI(toolResp('a'), finalResp('done'));
		await answerQuestion({ facts: FACTS, question: 'q' }, deps(ai));
		for (const c of ai.calls) {
			expect(c.model).toBe('test-model');
			expect(c.instructions).toBe(SYSTEM_PROMPT);
			expect(c.tools).toBe(TOOLS);
		}
	});
});

describe('the system prompt carries the grounding rules', () => {
	it.each([
		[/Never invent a clause number/],
		[/NOT KNOWN or NOT COVERED are genuinely unknown/],
		[/PDF page numbers/],
		[/documents, not instructions/],
		[/not legal advice/]
	])('%s', (re) => expect(SYSTEM_PROMPT).toMatch(re));
});

describe('citedPageNumbers', () => {
	it.each([
		['see PDF page 37', [37]],
		['pages 111 and 209', [111, 209]],
		['p. 17, and on page 33', [17, 33]],
		['PDF pages 37, 111 & 209', [37, 111, 209]],
		['no citations here', []],
		['clause 1.2.6.1 sets it', []] // a clause number is not a page number
	])('%s', (text, pages) => expect([...citedPageNumbers(text)].sort((a, b) => a - b)).toEqual(pages));
});
