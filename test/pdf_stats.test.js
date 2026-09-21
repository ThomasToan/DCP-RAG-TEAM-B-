import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, readFileSync } from 'node:fs';
import { hasWsl, runPy } from '../scripts/lib/wsl.js';
import { summarise } from '../scripts/lib/score.js';

// Needs WSL2 Ubuntu with the ~/dcp-venv PyMuPDF environment (see requirements-wsl.txt); skipped elsewhere.
const wsl = hasWsl();

describe.skipIf(!wsl)('pdf_stats.py on a synthetic PDF with a known answer', () => {
	/** @type {any} */ let result;

	beforeAll(async () => {
		mkdirSync(new URL('../data/test/', import.meta.url), { recursive: true });
		await runPy(['test/helpers/make_pdf.py', 'data/test/synth.pdf']);
		await runPy(['scripts/pdf_stats.py', 'data/test/synth.pdf', 'data/test/synth.json']);
		result = JSON.parse(readFileSync(new URL('../data/test/synth.json', import.meta.url), 'utf8'));
	}, 120_000);

	it('reads all five pages', () => {
		expect(result.status).toBe('ok');
		expect(result.page_count).toBe(5);
		expect(result.page_stats).toHaveLength(5);
	});

	it('page 1 (text only) is not image-dominated', () => {
		const [chars, big, cov, drawings] = result.page_stats[0];
		expect(chars).toBeGreaterThan(1000);
		expect([big, cov, drawings]).toEqual([0, 0, 0]);
	});

	it('page 2 (big image) has a raster covering about 62% of the page', () => {
		const [chars, big, cov] = result.page_stats[1];
		expect(chars).toBeLessThan(200);
		expect(big).toBe(1);
		expect(cov).toBeGreaterThan(0.55);
		expect(cov).toBeLessThan(0.7);
	});

	it('page 3 is blank', () => {
		expect(result.page_stats[2]).toEqual([0, 0, 0, 0]);
	});

	it('page 4 (vector diagram) has drawings but no raster', () => {
		const [chars, big, , drawings] = result.page_stats[3];
		expect(chars).toBeLessThan(20);
		expect(big).toBe(0);
		expect(drawings).toBeGreaterThanOrEqual(50);
	});

	it('page 5: a 100x100 icon does not count as a big raster', () => {
		expect(result.page_stats[4][1]).toBe(0);
	});

	it('feeds score.js: 2 of 5 pages are image-dominated (the picture page and the vector diagram)', () => {
		const s = summarise(result.page_stats);
		expect(s.share.primary).toBe(0.4); // page 2 (coverage) and page 4 (short text + 60 paths)
		expect(s.bigRaster).toBe(0.2); // page 2 only: the 100x100 icon on page 5 does not count
		expect(s.lowText).toBe(0.6); // pages 2, 3, 4
		expect(s.blank).toBe(0.2); // page 3
		expect(s.vectorHeavy).toBe(0.2); // page 4
	});

	it('a file that is not a PDF is reported as an error, not a crash', async () => {
		await runPy(['scripts/pdf_stats.py', 'README.md', 'data/test/notpdf.json']);
		const r = JSON.parse(readFileSync(new URL('../data/test/notpdf.json', import.meta.url), 'utf8'));
		expect(r.status).toBe('error');
	}, 60_000);
});
