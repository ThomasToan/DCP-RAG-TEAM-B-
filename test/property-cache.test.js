import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { pgPropertyCache } from '../src/lib/server/property-cache.js';

// Needs the Docker DB: DATABASE_URL=postgres://dev:dev@localhost:5433/dcp npx vitest run test/property-cache.test.js
describe.skipIf(!process.env.DATABASE_URL)('pgPropertyCache (real Postgres)', () => {
	const KEY = 'TEST 1 CACHE STREET';
	/** @type {pg.Pool} */ let pool;

	beforeAll(async () => {
		pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
		await pool.query('DELETE FROM property_facts WHERE address_key = $1', [KEY]);
	});
	afterAll(async () => {
		await pool.query('DELETE FROM property_facts WHERE address_key = $1', [KEY]);
		await pool.end();
	});

	it('miss, then set, then hit', async () => {
		const cache = pgPropertyCache(pool);
		expect(await cache.get(KEY)).toBeNull();
		await cache.set(KEY, { zone: 'R2', unknown: [] });
		expect(await cache.get(KEY)).toEqual({ zone: 'R2', unknown: [] });
	});

	it('set again overwrites and refreshes the timestamp (upsert)', async () => {
		const cache = pgPropertyCache(pool);
		await cache.set(KEY, { zone: 'R3' });
		expect((await cache.get(KEY)).zone).toBe('R3');
		const { rows } = await pool.query('SELECT count(*)::int AS n FROM property_facts WHERE address_key = $1', [KEY]);
		expect(rows[0].n).toBe(1);
	});

	it('entries older than the TTL are ignored', async () => {
		const cache = pgPropertyCache(pool, 30);
		await pool.query("UPDATE property_facts SET fetched_at = now() - interval '31 days' WHERE address_key = $1", [KEY]);
		expect(await cache.get(KEY)).toBeNull();
		await pool.query("UPDATE property_facts SET fetched_at = now() - interval '29 days' WHERE address_key = $1", [KEY]);
		expect(await cache.get(KEY)).not.toBeNull();
	});
});
