/**
 * The DCPs this app can answer from. A property is matched to its DCP by its LGA (from NSW data), and `key` is
 * the council's folder name everywhere: data/<key>/pages, /pages/<key>/ on the search server, and the PixelRAG
 * `department` that limits a search to that council's pages.
 */
export const COUNCILS = [
	{
		key: 'hornsby',
		lga: 'HORNSBY',
		council: 'Hornsby Shire Council',
		dcp: 'Hornsby Development Control Plan 2024',
		version: 'book version updated 26 June 2026',
		pages: 489
	},
	{
		key: 'randwick',
		lga: 'RANDWICK',
		council: 'Randwick City Council',
		dcp: 'Randwick Development Control Plan',
		version: 'complete DCP, Part A1 dated 27 July 2026',
		pages: 1528
	}
];

export const councilForLga = (lga) => COUNCILS.find((c) => c.lga === String(lga ?? '').toUpperCase()) ?? null;
export const councilByKey = (key) => COUNCILS.find((c) => c.key === key) ?? null;
export const DCP_LIST = COUNCILS.map((c) => `the ${c.dcp}`).join(' and ');
