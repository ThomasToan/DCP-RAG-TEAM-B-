/**
 * Every failure of the property pipeline is one of these codes, so callers (and the UI)
 * can tell "you typed it wrong" from "the government service is down".
 *
 *   BAD_ADDRESS  input could not be parsed (no house number, empty, too long)
 *   NOT_FOUND    parsed fine, geocoder has no such address; `details.suggestions` may help
 *   AMBIGUOUS    several suburbs match; `details.candidates` lists them
 *   NO_LOT       address geocoded but no cadastral lot found at the point
 *   UPSTREAM     an ArcGIS service failed after its single retry
 */
export class PropertyError extends Error {
	/**
	 * @param {'BAD_ADDRESS'|'NOT_FOUND'|'AMBIGUOUS'|'NO_LOT'|'UPSTREAM'} code
	 * @param {string} message
	 * @param {Record<string, unknown>} [details]
	 */
	constructor(code, message, details = {}) {
		super(message);
		this.name = 'PropertyError';
		this.code = code;
		this.details = details;
	}
}
