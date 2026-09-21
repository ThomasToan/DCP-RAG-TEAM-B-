import { PropertyError } from './property-error.js';

/**
 * The NSW geocoder stores addresses like `15 ELLALONG STREET PELAW MAIN`: upper case, street type
 * spelled out, no commas, no state, no postcode. Users type `15 Ellalong St, Pelaw Main NSW 2321`.
 * This module turns the second into the first.
 */

/** Abbreviation -> the spelled-out form the geocoder uses. */
const ABBREVIATIONS = {
	ST: 'STREET', STR: 'STREET', RD: 'ROAD', AVE: 'AVENUE', AV: 'AVENUE', PDE: 'PARADE',
	DR: 'DRIVE', DRV: 'DRIVE', CRES: 'CRESCENT', CR: 'CRESCENT', CL: 'CLOSE', CT: 'COURT',
	PL: 'PLACE', LN: 'LANE', HWY: 'HIGHWAY', TCE: 'TERRACE', BLVD: 'BOULEVARD', CCT: 'CIRCUIT',
	ESP: 'ESPLANADE', GR: 'GROVE', SQ: 'SQUARE', WY: 'WAY', PKWY: 'PARKWAY', RDG: 'RIDGE',
	PROM: 'PROMENADE', CIR: 'CIRCLE', GDNS: 'GARDENS', HTS: 'HEIGHTS', BVD: 'BOULEVARD',
	CRST: 'CREST', TRK: 'TRACK', WLK: 'WALK', ARC: 'ARCADE', BWAY: 'BROADWAY'
};

/** Street-type words as the geocoder spells them. */
const FULL_TYPES = new Set([
	...Object.values(ABBREVIATIONS),
	'AVENUE', 'BOULEVARD', 'BROADWAY', 'CIRCUIT', 'CLOSE', 'CRESCENT', 'DRIVE', 'ESPLANADE',
	'GLADE', 'GREEN', 'GROVE', 'LANE', 'LOOP', 'MEWS', 'PASS', 'PATH', 'POINT', 'QUAY',
	'RETREAT', 'RISE', 'ROUTE', 'ROW', 'TRAIL', 'VIEW', 'VISTA', 'OUTLOOK', 'LANDING'
]);

const UNIT_WORDS = 'UNIT|APT|APARTMENT|FLAT|SUITE|SHOP|LEVEL|LVL|U';
const HOUSE_NUMBER = /^\d+[A-Z]?(?:-\d+[A-Z]?)?$/;

/**
 * @typedef {object} ParsedAddress
 * @property {string} input        what the user typed
 * @property {string} key          canonical form: geocoder spelling, also the cache key
 * @property {string} houseNumber  `15`, `12A`, `12-14`
 * @property {string|null} street  through the street-type word, e.g. `ELLALONG STREET`; null if none found
 * @property {string} suburb       tokens after the street type (may be empty)
 * @property {string|null} unit    unit/flat number that was stripped, if any
 */

/**
 * @param {string} input
 * @returns {ParsedAddress}
 */
export function normaliseAddress(input) {
	if (typeof input !== 'string' || !input.trim()) {
		throw new PropertyError('BAD_ADDRESS', 'Enter a street address, e.g. "15 Ellalong St, Pelaw Main".');
	}
	if (input.length > 200) {
		throw new PropertyError('BAD_ADDRESS', 'Address is too long.');
	}

	let s = input
		.toUpperCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[,;.]/g, ' ')
		.replace(/[^A-Z0-9 '/\-]/g, ' ') // drops % and _ too, so nothing can act as a LIKE wildcard
		.replace(/\s+/g, ' ')
		.trim();

	// Trailing state / country / postcode. Only when something meaningful remains before it.
	s = s.replace(/\s+AUSTRALIA$/, '').replace(/\s+NSW(?:\s+\d{4})?$/, '').replace(/\s+NSW\s+/, ' ');
	const noPostcode = s.replace(/\s+[2]\d{3}$/, '');
	if (noPostcode.split(' ').length >= 3) s = noPostcode;

	// Unit forms: `UNIT 3/12 SMITH ST`, `U3 12 SMITH ST`, `3/12 SMITH ST`. The geocoder holds the parent lot.
	let unit = null;
	const named = new RegExp(`^(?:${UNIT_WORDS})\\s*([A-Z]?\\d+[A-Z]?)\\s*[/\\- ]\\s*(?=\\d)`).exec(s);
	const slashed = /^([A-Z]?\d+[A-Z]?)\s*\/\s*(?=\d)/.exec(s);
	const m = named ?? slashed;
	if (m) {
		unit = m[1];
		s = s.slice(m[0].length);
	}

	const tokens = s.split(' ').filter(Boolean);
	const houseNumber = tokens[0];
	if (!houseNumber || !HOUSE_NUMBER.test(houseNumber)) {
		throw new PropertyError('BAD_ADDRESS', 'Address needs a house number first, e.g. "15 Ellalong St".');
	}
	const rest = tokens.slice(1);
	if (rest.length === 0) {
		throw new PropertyError('BAD_ADDRESS', 'Address needs a street name after the house number.');
	}

	// First street-type word at index >= 1 (index 0 would be a name like `ST JOHNS`). Expand it once only:
	// a later `ST` is part of a suburb (`ST MARYS`), not a street type.
	let typeIdx = -1;
	for (let i = 1; i < rest.length; i++) {
		if (rest[i] in ABBREVIATIONS || FULL_TYPES.has(rest[i])) {
			typeIdx = i;
			break;
		}
	}
	if (typeIdx >= 0 && rest[typeIdx] in ABBREVIATIONS) rest[typeIdx] = ABBREVIATIONS[rest[typeIdx]];

	const street = typeIdx >= 0 ? rest.slice(0, typeIdx + 1).join(' ') : null;
	const suburb = typeIdx >= 0 ? rest.slice(typeIdx + 1).join(' ') : '';
	return {
		input,
		key: [houseNumber, ...rest].join(' '),
		houseNumber,
		street,
		suburb,
		unit
	};
}
