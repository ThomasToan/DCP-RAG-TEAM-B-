import { PropertyError } from './property-error.js';

const TIMEOUT_MS = 15_000;
// The NSW gateway 502s in bursts; 600 ms was too short to ride one out (seen: two 502s in a row).
const RETRY_DELAY_MS = 1500;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Query one ArcGIS REST layer (`<layer>/query`).
 *
 * POST, not GET: lot polygons in the URL blow past gateway length limits.
 * The NSW gateway is flaky (502 from Azure Application Gateway was seen while building this),
 * so a network error, timeout, 5xx, or HTML body gets exactly ONE retry. A 4xx / ArcGIS `error`
 * object is our bug and is not retried. No loops, so a bad request can never become a call storm.
 *
 * @param {string} url      full `.../MapServer/<id>/query` (or FeatureServer) URL
 * @param {Record<string, string|number|boolean>} params
 * @param {{ fetch?: typeof fetch, label?: string, sleep?: (ms:number)=>Promise<void> }} [opts]
 * @returns {Promise<any>}  parsed ArcGIS JSON
 */
export async function arcgisQuery(url, params, opts = {}) {
	const { fetch: fetchImpl = fetch, label = url, sleep = defaultSleep } = opts;
	const body = new URLSearchParams({ f: 'json' });
	for (const [k, v] of Object.entries(params)) body.set(k, String(v));

	let lastProblem = 'unknown';
	for (let attempt = 0; attempt < 2; attempt++) {
		if (attempt > 0) await sleep(RETRY_DELAY_MS);
		try {
			const res = await fetchImpl(url, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body,
				signal: AbortSignal.timeout(TIMEOUT_MS)
			});
			if (res.status >= 500) {
				lastProblem = `HTTP ${res.status}`;
				continue;
			}
			const text = await res.text();
			let json;
			try {
				json = JSON.parse(text);
			} catch {
				lastProblem = `non-JSON body (HTTP ${res.status})`;
				continue;
			}
			if (json.error) {
				if (Number(json.error.code) >= 500) {
					lastProblem = `ArcGIS error ${json.error.code}`;
					continue;
				}
				throw new PropertyError('UPSTREAM', `${label}: ${json.error.message ?? 'query rejected'}`, {
					label,
					code: json.error.code,
					retryable: false
				});
			}
			return json;
		} catch (e) {
			if (e instanceof PropertyError) throw e;
			lastProblem = e?.name === 'TimeoutError' ? 'timeout' : (e?.message ?? String(e));
		}
	}
	throw new PropertyError('UPSTREAM', `${label} unavailable (${lastProblem})`, { label, retryable: true });
}
