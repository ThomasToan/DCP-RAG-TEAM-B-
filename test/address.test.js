import { describe, it, expect } from 'vitest';
import { normaliseAddress } from '../src/lib/server/address.js';
import { PropertyError } from '../src/lib/server/property-error.js';

describe('normaliseAddress', () => {
	it('converts a typed address to the geocoder spelling', () => {
		const a = normaliseAddress('15 Ellalong St, Pelaw Main NSW 2321');
		expect(a.key).toBe('15 ELLALONG STREET PELAW MAIN');
		expect(a.houseNumber).toBe('15');
		expect(a.street).toBe('ELLALONG STREET');
		expect(a.suburb).toBe('PELAW MAIN');
		expect(a.unit).toBeNull();
	});

	it('is case-insensitive and leaves already-canonical input alone', () => {
		expect(normaliseAddress('15 ellalong street pelaw main').key).toBe('15 ELLALONG STREET PELAW MAIN');
	});

	it.each([
		['Unit 3/12 Smith Rd', '12 SMITH ROAD', '3'],
		['3/12 Smith Pde Bondi', '12 SMITH PARADE BONDI', '3'],
		['U3 12 Smith St', '12 SMITH STREET', '3'],
		['Flat 2A, 12 Smith Ave', '12 SMITH AVENUE', '2A']
	])('strips the unit from %s', (input, key, unit) => {
		const a = normaliseAddress(input);
		expect(a.key).toBe(key);
		expect(a.unit).toBe(unit);
	});

	it('keeps house-number suffixes and ranges', () => {
		expect(normaliseAddress('12A Smith Ave').key).toBe('12A SMITH AVENUE');
		expect(normaliseAddress('12-14 Smith St').key).toBe('12-14 SMITH STREET');
	});

	it('does not expand ST when it means Saint', () => {
		const a = normaliseAddress('5 St Johns Rd St Marys');
		expect(a.key).toBe('5 ST JOHNS ROAD ST MARYS');
		expect(a.street).toBe('ST JOHNS ROAD');
		expect(a.suburb).toBe('ST MARYS');
	});

	it('expands only the first street type, so a suburb starting with ST survives', () => {
		expect(normaliseAddress('5 Smith St St Marys').key).toBe('5 SMITH STREET ST MARYS');
	});

	it('handles apostrophes, "The" streets and 4-digit house numbers', () => {
		expect(normaliseAddress("7 O'Connell St").key).toBe("7 O'CONNELL STREET");
		expect(normaliseAddress('1 The Esplanade Cronulla').street).toBe('THE ESPLANADE');
		expect(normaliseAddress('2000 Pacific Hwy').key).toBe('2000 PACIFIC HIGHWAY');
	});

	it('drops a trailing postcode but not a leading house number', () => {
		expect(normaliseAddress('12 Smith St 2321').key).toBe('12 SMITH STREET');
	});

	it('cannot smuggle LIKE wildcards into the query', () => {
		const a = normaliseAddress("1 Smith St%_' OR 1=1");
		expect(a.key).not.toMatch(/[%_]/);
	});

	it('returns street=null when no street type is present', () => {
		const a = normaliseAddress('12 Smith');
		expect(a.street).toBeNull();
		expect(a.key).toBe('12 SMITH');
	});

	it.each([[''], ['   '], ['Smith St'], ['12'], ['x'.repeat(201)]])('rejects %j as BAD_ADDRESS', (input) => {
		try {
			normaliseAddress(input);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(PropertyError);
			expect(e.code).toBe('BAD_ADDRESS');
		}
	});
});
