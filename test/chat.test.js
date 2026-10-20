import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { COUNCILS } from '../src/lib/server/councils.js';
import { answerQuestion, describeFacts, citedPageNumbers, tools, systemPrompt, MAX_ROUNDS, MAX_SEARCHES, CLAUSES_PROMPT, CLAUSES_QUESTION, CLAUSES_MAX_ROUNDS, CLAUSES_EXTRA_SEARCHES, clauseTopics } from '../src/lib/server/chat.js';

// A real-shaped facts bundle (what property.js returns) for a Hornsby lot
const HORNSBY = COUNCILS.find((c) => c.key === 'hornsby');
const TOOLS = tools(HORNSBY);
const SYSTEM_PROMPT = systemPrompt(HORNSBY);

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
		expect(r.answer).toMatch(/DCPs indexed here are the Hornsby Development Control Plan 2024 and the Randwick Development Control Plan/);
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
	it('names the heritage conservation area, so the model can pick the right DCP table', () => {
		const f = { ...FACTS, heritage: 'HCA', heritage_detail: [{ class: 'Conservation Area - General', id: 'C2', name: 'Beecroft, Cheltenham Heritage Conservation Area', significance: 'Local' }] };
		expect(describeFacts(f)).toMatch(/Heritage: HCA \(Beecroft, Cheltenham Heritage Conservation Area\)/);
	});
	it('names a heritage item and an area together, each name once', () => {
		const f = { ...FACTS, heritage: 'item I26; HCA', heritage_detail: [{ name: 'Old Mill' }, { name: 'Old Mill' }, { name: 'The Crescent, Pennant Hills Heritage Conservation Area' }] };
		expect(describeFacts(f)).toMatch(/Heritage: item I26; HCA \(Old Mill; The Crescent, Pennant Hills Heritage Conservation Area\)/);
	});
	it('heritage with no names in the detail is shown as before', () => {
		expect(describeFacts({ ...FACTS, heritage: 'HCA', heritage_detail: [{ name: null }] })).toMatch(/Heritage: HCA\n/);
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
			expect(c.tools).toEqual(TOOLS);
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
		['clause 1.2.6.1 sets it', []], // a clause number is not a page number
		['PDF page 1528', [1528]] // Randwick has four-digit page numbers
	])('%s', (text, pages) => expect([...citedPageNumbers(text)].sort((a, b) => a - b)).toEqual(pages));
});

describe('clauses mode: an address with no question lists the relevant clauses', () => {
	it('asks the fixed clause-list question, ignores any question text, and still sends the facts first', async () => {
		const ai = fakeOpenAI(finalResp('list'));
		await answerQuestion({ facts: FACTS, question: 'ignore me', mode: 'clauses' }, deps(ai));
		const first = ai.calls[0].input[0].content[0].text;
		expect(first).toContain('16 DURAL STREET HORNSBY');
		expect(first).toContain(`QUESTION: ${CLAUSES_QUESTION}`);
		expect(first).not.toContain('ignore me');
	});

	it('works with no question at all', async () => {
		const ai = fakeOpenAI(finalResp('list'));
		const r = await answerQuestion({ facts: FACTS, mode: 'clauses' }, deps(ai));
		expect(ai.calls).toHaveLength(1);
		expect(r.answer).toBe('list');
	});

	it('sends the normal grounding rules plus the clause-list task on every request', async () => {
		const ai = fakeOpenAI(toolResp('dwelling house controls'), finalResp('list'));
		await answerQuestion({ facts: FACTS, mode: 'clauses' }, deps(ai));
		for (const c of ai.calls) {
			expect(c.instructions).toBe(`${SYSTEM_PROMPT}

${CLAUSES_PROMPT}`);
			expect(c.instructions).toMatch(/Never invent a clause number/);
		}
	});

	it('default mode is unchanged: no clause-list instructions', async () => {
		const ai = fakeOpenAI(finalResp('ok'));
		await answerQuestion({ facts: FACTS, question: 'q' }, deps(ai));
		expect(ai.calls[0].instructions).toBe(SYSTEM_PROMPT);
		expect(ai.calls[0].instructions).not.toMatch(/LIST THE RELEVANT CLAUSES/);
	});

	it('the server runs the topic searches itself and sends their pages with the first message', async () => {
		const ai = fakeOpenAI(finalResp('list'));
		const search = fakeSearch([{ page: 112, score: 0.6, chunk: 0 }, { page: 115, score: 0.5, chunk: 0 }]);
		const r = await answerQuestion({ facts: FACTS, mode: 'clauses' }, deps(ai, search));
		expect(search.seen).toEqual(clauseTopics(FACTS));
		const first = ai.calls[0].input[0].content;
		expect(first.find((c) => c.type === 'input_text' && c.text.startsWith('DCP PAGES FOUND BY THE SERVER')).text).toContain(clauseTopics(FACTS)[0]);
		expect(first.filter((c) => c.type === 'input_image')).toHaveLength(2); // each page sent once, although every topic found it
		expect(r.toolCalls.every((t) => t.by === 'server')).toBe(true);
		expect(r.pages.map((p) => p.page).sort()).toEqual([112, 115]);
	});

	it('the model may add only a couple of searches of its own, and is told so', async () => {
		expect(CLAUSES_PROMPT).toContain(`up to ${CLAUSES_EXTRA_SEARCHES} more searches`);
		expect(CLAUSES_MAX_ROUNDS).toBeGreaterThan(MAX_ROUNDS);
		const five = { id: 'r1', output: Array.from({ length: 5 }, (_, i) => ({ type: 'function_call', call_id: `c${i}`, name: 'search_dcp', arguments: JSON.stringify({ query: `extra${i}` }) })) };
		const ai = fakeOpenAI(five, finalResp('done'));
		const search = fakeSearch();
		await answerQuestion({ facts: FACTS, mode: 'clauses' }, deps(ai, search));
		expect(search.seen.filter((q) => q.startsWith('extra'))).toEqual(['extra0', 'extra1']);
	});

	it('the same facts always give the same topics', () => {
		expect(clauseTopics(FACTS)).toEqual(clauseTopics({ ...FACTS }));
	});

	it('topics follow the zone and the overlays', () => {
		const r2 = clauseTopics({ zone: 'R2', heritage: 'HCA', heritage_detail: [{ name: 'Beecroft, Cheltenham Heritage Conservation Area' }], bushfire: null, unknown: [] });
		expect(r2[0]).toMatch(/dwelling house/);
		expect(r2).toContain('dual occupancy controls');
		expect(r2).toContain('heritage controls for Beecroft, Cheltenham Heritage Conservation Area');
		expect(r2.some((t) => /bushfire/.test(t))).toBe(false);
		const r4 = clauseTopics({ zone: 'R4', bushfire: 'Vegetation Buffer', unknown: ['flood'] });
		expect(r4[0]).toMatch(/multi dwelling/);
		expect(r4).toContain('bushfire prone land development controls');
		expect(r4).toContain('flood prone land development controls'); // NOT KNOWN is searched, never assumed no
		expect(clauseTopics({ zone: 'SP2', zone_name: 'Infrastructure' })[0]).toBe('development controls for the SP2 zone (Infrastructure)');
	});

	it('never more than 8 topics', () => {
		const many = clauseTopics({ zone: 'R2', heritage: 'HCA', bushfire: 'x', flood: true, acid_sulfate: 'Class 5', terrestrial_biodiversity: true, foreshore: true, unknown: [] });
		expect(many.length).toBeLessThanOrEqual(8);
	});

	it('an explicit maxSearches still wins', async () => {
		const three = { id: 'r1', output: ['a', 'b', 'c'].map((q, i) => ({ type: 'function_call', call_id: `c${i}`, name: 'search_dcp', arguments: JSON.stringify({ query: q }) })) };
		const ai = fakeOpenAI(three, finalResp('done'));
		const search = fakeSearch();
		const topics = clauseTopics(FACTS).length;
		await answerQuestion({ facts: FACTS, mode: 'clauses' }, deps(ai, search, { maxSearches: topics + 1 }));
		expect(search.seen.slice(topics)).toEqual(['a']);
	});

	it('a property outside Hornsby never reaches the model in this mode either', async () => {
		const ai = fakeOpenAI(finalResp('nope'));
		const r = await answerQuestion({ facts: { ...FACTS, lga: 'CESSNOCK' }, mode: 'clauses' }, deps(ai));
		expect(ai.calls).toHaveLength(0);
		expect(r.skippedModel).toBe(true);
	});

	it('the task never lets the model call a development type allowed, and requires printed clause numbers', () => {
		expect(CLAUSES_PROMPT).toMatch(/Never say a type is allowed or prohibited/);
		expect(CLAUSES_PROMPT).toMatch(/clause number that is printed on a page you were shown/);
		expect(CLAUSES_PROMPT).toMatch(/Leave a clause out rather than guess/);
		expect(CLAUSES_PROMPT).toMatch(/Never list the controls of a differently named area/);
	});

	it('asks for the section layout the page can render (headings and flat bullets)', () => {
		for (const h of ['Development types and their DCP controls', 'overlays', 'depend on a DCP map', 'Not found']) expect(CLAUSES_PROMPT).toContain(h);
		expect(CLAUSES_PROMPT).toMatch(/flat "- " bullets only/);
	});
});

describe('marked DCP maps: the property drawn as a dot on calibrated map pages', () => {
	const realPng = () => {
		const png = new PNG({ width: 40, height: 40 });
		png.data.fill(255);
		return PNG.sync.write(png).toString('base64');
	};
	const pngImage = async (page) => ({ mime: 'image/png', base64: realPng(), page });
	const MAP = { id: 'hca-test', page: 440, figure: '9.7-a', title: 'Test HCA', group: 'heritage', frame: [0, 0, 40, 40], transform: { ax: 1, cx: 0, by: -1, dy: 0 }, fit: { metres_per_px: 1 } };
	const placed = { map: MAP, x: 20, y: 20 };

	it('area maps go with the first message, marked, and count as retrieved and already shown', async () => {
		const ai = fakeOpenAI(toolResp('heritage controls'), finalResp('In the Northern Triangle (PDF page 440).'));
		const search = fakeSearch([{ page: 440, score: 0.6, chunk: 0 }]);
		const r = await answerQuestion({ facts: FACTS, question: 'Which precinct?' }, deps(ai, search, { loadImage: pngImage, areaMaps: () => [placed], mapAt: () => null }));
		const first = ai.calls[0].input[0].content;
		expect(first[1].text).toMatch(/^DCP MAP CHECK, PDF page 440 .*MAGENTA DOT marks this property/);
		expect(first[2].type).toBe('input_image');
		expect(first[2].image_url).not.toContain(realPng()); // the image was changed: the dot is on it
		expect(r.mapChecks).toEqual([{ page: 440, figure: '9.7-a', map: 'hca-test' }]);
		expect(r.pages.map((p) => p.page)).toContain(440);
		expect(r.warnings).toEqual([]); // citing the map page is supported
		const out = JSON.parse(ai.calls[1].input.find((i) => i.type === 'function_call_output').output);
		expect(out.already_shown_earlier).toEqual([440]); // not sent a second time
	});

	it('a follow-up does not resend area maps', async () => {
		const ai = fakeOpenAI(finalResp('ok'));
		let asked = 0;
		await answerQuestion({ facts: FACTS, question: 'and?', previousResponseId: 'resp_prev' }, deps(ai, fakeSearch(), { areaMaps: () => (asked++, [placed]) }));
		expect(asked).toBe(0);
		expect(ai.calls[0].input[0].content).toHaveLength(1);
	});

	it('a searched page that is a calibrated map comes back marked, with the note', async () => {
		const ai = fakeOpenAI(toolResp('parking tiers'), finalResp('done'));
		await answerQuestion({ facts: FACTS, question: 'parking?' }, deps(ai, fakeSearch([{ page: 37, score: 0.7, chunk: 0 }]), { loadImage: pngImage, areaMaps: () => [], mapAt: (page) => (page === 37 ? { ...placed, map: { ...MAP, page: 37, figure: '1.3-b' } } : null) }));
		const imgMsg = ai.calls[1].input.find((i) => i.role === 'user');
		expect(imgMsg.content[0].text).toMatch(/^PDF page 37 of the .* \(MARKED MAP\): Figure 1\.3-b/);
	});

	it('a map image that cannot be decoded is skipped for the first message and sent plain after a search', async () => {
		const ai = fakeOpenAI(toolResp('x'), finalResp('done'));
		const r = await answerQuestion({ facts: FACTS, question: 'q' }, deps(ai, fakeSearch([{ page: 37, score: 0.7, chunk: 0 }]), { areaMaps: () => [placed], mapAt: () => placed }));
		expect(r.mapChecks).toEqual([]); // fakeImage is not a real PNG
		expect(ai.calls[0].input[0].content).toHaveLength(1);
		const imgMsg = ai.calls[1].input.find((i) => i.role === 'user');
		expect(imgMsg.content[0].text).toMatch(/^PDF page 37 of the Hornsby Development Control Plan 2024:$/);
	});

	it('the system prompt tells the model how to read a marked map', () => {
		expect(SYSTEM_PROMPT).toMatch(/MAGENTA DOT/);
		expect(SYSTEM_PROMPT).toMatch(/on or very close to a boundary/);
	});
});

describe('more than one council: the DCP follows the property', () => {
	const RANDWICK_FACTS = { ...FACTS, address: '10 MARINE PARADE MAROUBRA', lga: 'RANDWICK', zone: 'R2', zone_name: 'Low Density Residential', not_covered: ['flood'], flood: null };

	it('a Randwick property gets the Randwick DCP: prompt, tool, search filter, and page labels', async () => {
		const ai = fakeOpenAI(toolResp('site coverage dwelling house'), finalResp('done'));
		const seen = [];
		const search = async (q, opts) => (seen.push(opts), { pages: [{ page: 1201, score: 0.6, chunk: 0 }], belowFloor: false, best: 0.6 });
		const loads = [];
		const loadImage = async (page, opts) => (loads.push([page, opts.council]), { mime: 'image/png', base64: 'X' });
		let mapCouncil;
		const r = await answerQuestion({ facts: RANDWICK_FACTS, question: 'site coverage?' }, deps(ai, search, { loadImage, areaMaps: (f, c) => ((mapCouncil = c), []) }));
		expect(ai.calls[0].instructions).toMatch(/^You are a planning-rules assistant for the Randwick Development Control Plan \(Randwick City Council/);
		expect(ai.calls[0].tools[0].description).toMatch(/Randwick Development Control Plan/);
		expect(seen[0].council).toBe('randwick');
		expect(loads).toEqual([[1201, 'randwick']]);
		expect(mapCouncil).toBe('randwick');
		const imgMsg = ai.calls[1].input.find((i) => i.role === 'user');
		expect(imgMsg.content[0].text).toBe('PDF page 1201 of the Randwick Development Control Plan:');
		expect(r.council).toBe('randwick');
		expect(r.warnings).toEqual([]);
	});

	it('a Hornsby property still gets the Hornsby DCP and council key', async () => {
		const ai = fakeOpenAI(finalResp('ok'));
		const r = await answerQuestion({ facts: FACTS, question: 'q' }, deps(ai));
		expect(ai.calls[0].instructions).toBe(SYSTEM_PROMPT);
		expect(r.council).toBe('hornsby');
	});

	it('each council has a distinct key, LGA and page count', () => {
		expect(new Set(COUNCILS.map((c) => c.key)).size).toBe(COUNCILS.length);
		expect(COUNCILS.find((c) => c.key === 'randwick')).toMatchObject({ lga: 'RANDWICK', pages: 1528 });
	});
});

describe('speed: one round of searches runs at the same time', () => {
	it('three searches in one round overlap, and their results keep the order the model asked for', async () => {
		const three = { id: 'r1', output: ['a', 'b', 'c'].map((q, i) => ({ type: 'function_call', call_id: `c${i}`, name: 'search_dcp', arguments: JSON.stringify({ query: q }) })) };
		const ai = fakeOpenAI(three, finalResp('done'));
		let running = 0, most = 0;
		const pagesFor = { a: 10, b: 20, c: 30 };
		const search = async (q) => {
			running++; most = Math.max(most, running);
			await new Promise((r) => setTimeout(r, q === 'a' ? 30 : 5)); // the first one finishes last
			running--;
			return { pages: [{ page: pagesFor[q], score: 0.5, chunk: 0 }], belowFloor: false, best: 0.5 };
		};
		const r = await answerQuestion({ facts: FACTS, question: 'q' }, deps(ai, search));
		expect(most).toBe(3);
		expect(r.toolCalls.map((t) => t.query)).toEqual(['a', 'b', 'c']);
		const outs = ai.calls[1].input.filter((i) => i.type === 'function_call_output').map((o) => o.call_id);
		expect(outs).toEqual(['c0', 'c1', 'c2']);
		const labels = ai.calls[1].input.find((i) => i.role === 'user').content.filter((c) => c.type === 'input_text').map((c) => c.text);
		expect(labels.map((t) => t.match(/PDF page (\d+)/)[1])).toEqual(['10', '20', '30']);
	});
});
