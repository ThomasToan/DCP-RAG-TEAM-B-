import { error } from '@sveltejs/kit';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULTS } from '$lib/server/dcp_search.js';

const MAX_PAGE = 489; // Hornsby DCP 2024 page count; bump if the indexed DCP changes

/**
 * Serves one rendered DCP page as a PNG, e.g. GET /dcp-page/37.
 * The page number is validated as a small positive integer before touching the filesystem,
 * so the route can never be used to read an arbitrary file.
 */
export async function GET({ params }) {
	const page = Number(params.page);
	if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) error(404, 'No such page');

	const path = join(DEFAULTS.pagesDir, `p${String(page).padStart(4, '0')}.png`);
	let bytes;
	try {
		bytes = await readFile(path);
	} catch {
		error(404, 'Page image not rendered yet');
	}
	return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' } });
}
