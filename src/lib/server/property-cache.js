/**
 * `property_facts` cache: ArcGIS is slow and rate-limited, so the demo must not hit it on every chat turn.
 * Takes a `pg` Pool as an argument (no SvelteKit imports) so scripts and tests can use it too.
 *
 * @param {import('pg').Pool} pool
 * @param {number} [ttlDays]
 * @returns {import('./property.js').FactsCache}
 */
export function pgPropertyCache(pool, ttlDays = 30) {
	return {
		async get(key) {
			const r = await pool.query(
				`SELECT facts FROM property_facts
				  WHERE address_key = $1 AND fetched_at > now() - make_interval(days => $2)`,
				[key, ttlDays]
			);
			return r.rows[0]?.facts ?? null;
		},
		async set(key, facts) {
			await pool.query(
				`INSERT INTO property_facts (address_key, facts) VALUES ($1, $2)
				 ON CONFLICT (address_key) DO UPDATE SET facts = EXCLUDED.facts, fetched_at = now()`,
				[key, facts]
			);
		}
	};
}
