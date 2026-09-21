// How "image-dominated" a DCP is, computed from the raw per-page numbers that pdf_stats.py saves.
// Single source of truth for the definition; unit-tested; the PDFs never need re-reading to change it.
//
// A page row is [chars, bigRasters, rasterCoverage, drawings]:
//   chars           non-whitespace characters of extractable text
//   bigRasters      images >= 200x200 px (icons and logos are smaller)
//   rasterCoverage  share of the page covered by those big images, 0..1
//   drawings        vector paths on the page (many DCP diagrams are vector, not photos)

const LOW_TEXT = 200;

/**
 * The ranking uses `primary`. The others exist to show the ranking does not hinge on the definition.
 *
 * Why not just the exercise's wording ("a raster > 200x200, or < 200 chars of text")? Measured on 25 DCPs, a big raster
 * appears on 78-90% of pages in some documents: repeated page furniture (backgrounds, logos), not content. And a short
 * text page with no graphics at all is not "content in an image". So `primary` demands graphic evidence.
 */
export const DEFINITIONS = {
	primary: {
		label: 'short text AND a graphic (raster or 5+ paths), or pictures cover 30%+',
		test: ([c, b, cov, d]) => cov >= 0.3 || (c < LOW_TEXT && (b > 0 || d >= 5))
	},
	strictGraphic: {
		label: 'as primary but the graphic needs 20+ paths',
		test: ([c, b, cov, d]) => cov >= 0.3 || (c < LOW_TEXT && (b > 0 || d >= 20))
	},
	cover30: { label: 'pictures cover 30%+ of the page', test: ([, , cov]) => cov >= 0.3 },
	cover50: { label: 'pictures cover 50%+ of the page', test: ([, , cov]) => cov >= 0.5 },
	literal: { label: 'exercise wording: any big raster OR < 200 chars (polluted by page furniture)', test: ([c, b]) => b > 0 || c < LOW_TEXT }
};

export const isBlank = ([c, b, , d]) => c < 20 && b === 0 && d < 5;

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * @param {number[][]} rows  page rows from pdf_stats.py
 * @returns {{pages:number, share: Record<string, number>, blank:number, lowText:number, bigRaster:number, fullPage:number, vectorHeavy:number, medianChars:number}}
 */
export function summarise(rows) {
	const n = rows.length;
	const share = Object.fromEntries(Object.entries(DEFINITIONS).map(([k, d]) => [k, n ? rows.filter(d.test).length / n : 0]));
	const frac = (fn) => (n ? rows.filter(fn).length / n : 0);
	return {
		pages: n,
		share,
		blank: frac(isBlank),
		lowText: frac(([c]) => c < LOW_TEXT),
		bigRaster: frac(([, b]) => b > 0),
		fullPage: frac(([, , cov]) => cov >= 0.9),
		vectorHeavy: frac(([, , , d]) => d >= 50),
		medianChars: n ? median(rows.map((r) => r[0])) : 0
	};
}
