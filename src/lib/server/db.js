import pg from 'pg';
import { env } from '$env/dynamic/private';

/** One pooled client for the whole app, created on first use. */
let pool;
export function getPool() {
	pool ??= new pg.Pool({ connectionString: env.DATABASE_URL });
	return pool;
}
