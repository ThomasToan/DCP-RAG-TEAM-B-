import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const FIXTURE_PATH = new URL('../fixtures/arcgis.json', import.meta.url);

/** Same request => same key. property.js builds params in a fixed order, so the raw body is stable. */
export const fixtureKey = (url, body) => createHash('sha1').update(`${url}\n${String(body)}`).digest('hex');

export const loadFixtures = () => (existsSync(FIXTURE_PATH) ? JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) : {});

export function saveFixtures(table) {
	const sorted = Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)));
	writeFileSync(FIXTURE_PATH, JSON.stringify(sorted));
}

/** A fetch that answers only from recorded responses and fails loudly on anything unrecorded. */
export function replayFetch(table, { onCall } = {}) {
	return async (url, init) => {
		onCall?.(String(url), init);
		const hit = table[fixtureKey(url, init?.body)];
		if (!hit) {
			const params = decodeURIComponent(String(init?.body)).slice(0, 220);
			throw new Error(`no recorded ArcGIS response for ${url}\n  ${params}\n(run: node scripts/record_fixtures.js)`);
		}
		return new Response(hit.body, { status: hit.status });
	};
}

/** Real fetch that also stores every good (HTTP 200, JSON, no ArcGIS error) response into `table`. */
export function recordingFetch(table) {
	return async (url, init) => {
		const res = await fetch(url, init);
		const body = await res.clone().text();
		try {
			if (res.ok && !JSON.parse(body).error) table[fixtureKey(url, init?.body)] = { status: 200, body };
		} catch {
			/* not JSON (gateway HTML): never record it */
		}
		return res;
	};
}
