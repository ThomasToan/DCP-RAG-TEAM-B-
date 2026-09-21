import { describe, it, expect } from 'vitest';
import { ringsAreaM2, formatPlan } from '../src/lib/server/geo.js';

describe('ringsAreaM2', () => {
	// 0.001 deg square at the equator: 111.319 m wide x 110.574 m tall
	const square = (x, y, d) => [[x, y], [x, y + d], [x + d, y + d], [x + d, y], [x, y]]; // clockwise, like Esri outer rings

	it('matches the known size of a 0.001 degree square at the equator', () => {
		expect(ringsAreaM2([square(0, 0, 0.001)])).toBeCloseTo(12309.2, -1); // within ~5 m2
	});

	it('shrinks east-west distances with latitude (cos phi)', () => {
		const equator = ringsAreaM2([square(0, 0, 0.001)]);
		const at60 = ringsAreaM2([square(0, 60, 0.001)]);
		expect(at60 / equator).toBeGreaterThan(0.49);
		expect(at60 / equator).toBeLessThan(0.51);
	});

	it('subtracts a hole (counter-clockwise inner ring)', () => {
		const outer = square(0, 0, 0.002);
		const hole = square(0.0005, 0.0005, 0.001).reverse();
		const whole = ringsAreaM2([outer]);
		expect(ringsAreaM2([outer, hole])).toBeCloseTo(whole - ringsAreaM2([hole]), 0);
		expect(ringsAreaM2([outer, hole])).toBeLessThan(whole);
	});

	it('does not care which way the ring winds', () => {
		expect(ringsAreaM2([square(0, 0, 0.001).reverse()])).toBeCloseTo(ringsAreaM2([square(0, 0, 0.001)]), 6);
	});

	it('returns 0 for empty input', () => {
		expect(ringsAreaM2([])).toBe(0);
	});
});

describe('formatPlan', () => {
	it.each([
		['DP246833', 'DP 246833'],
		['SP12345', 'SP 12345'],
		['dp1234', 'DP 1234'],
		['WEIRD/1', 'WEIRD/1']
	])('%s -> %s', (input, out) => expect(formatPlan(input)).toBe(out));

	it('is safe on null', () => expect(formatPlan(null)).toBe(''));
});
