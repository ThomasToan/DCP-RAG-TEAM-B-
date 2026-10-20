import { describe, it, expect } from 'vitest';
import { tokens, searchText } from '../src/lib/server/text_search.js';

describe('keyword search over the DCP page text', () => {
	it('folds plurals, drops stop words, keeps clause numbers', () => {
		expect(tokens('The setbacks for 2 storeys under clause 3.1.1')).toEqual(['setback', '2', 'storey', 'clause', '3.1.1']);
	});
	it('finds the Randwick site coverage table (PDF page 359) first', () => {
		expect(searchText('site coverage for a dwelling house', 'randwick', 3)[0].page).toBe(359);
	});
	it('finds the Hornsby tree preservation pages (17 to 21)', () => {
		expect([17, 18, 19, 20, 21]).toContain(searchText('can I remove or cut down a tree on my property', 'hornsby', 1)[0].page);
	});
	it('a question with no DCP words finds nothing', () => {
		expect(searchText('how do I bake bread', 'hornsby')).toEqual([]);
	});
	it('an unknown council is an error, not a silent empty result', () => {
		expect(() => searchText('trees', 'cessnock')).toThrow();
	});
});
