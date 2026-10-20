import { error } from '@sveltejs/kit';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '$env/dynamic/private';
import { fetchWithRetry } from '$lib/server/dcp_search.js';
import { councilByKey } from '$lib/server/councils.js';

/**
 * Serves one rendered DCP page as a PNG, e.g. GET /dcp-page/hornsby/37.
 * The council must be one in councils.js and the page a small positive integer within that DCP, both checked
 * before touching the filesystem or building a URL, so the route can never read an arbitrary file or fetch an
 * arbitrary path.
 *
 * Local dev: reads data/<council>/pages off disk. Production: a Vercel function has no local copy of the page
 * images, so PIXELRAG_URL set proxies to the Fly server's own copy instead (deploy/pixelrag/Caddyfile serves them
 * at /pages/<council>/pNNNN.png alongside /search).
 */
export async function GET({ params, fetch }) {
	const council = councilByKey(params.council);
	const page = Number(params.page);
	if (!council || !Number.isInteger(page) || page < 1 || page > council.pages) error(404, 'No such page');
	const name = `p${String(page).padStart(4, '0')}.png`;
	const cache = { 'cache-control': 'public, max-age=31536000, immutable' };

	if (env.PIXELRAG_URL) {
		// one retry: right after Fly wakes a stopped machine, its edge can briefly forward a request
		// before the app inside is listening, giving a real-but-wrong response rather than a thrown error
		const res = await fetchWithRetry(fetch, `${env.PIXELRAG_URL}/pages/${council.key}/${name}`);
		if (!res.ok) error(404, 'Page image not available');
		return new Response(res.body, { headers: { 'content-type': res.headers.get('content-type') || 'image/png', ...cache } });
	}

	let bytes;
	try {
		bytes = await readFile(join('data', council.key, 'pages', name));
	} catch {
		error(404, 'Page image not rendered yet');
	}
	return new Response(bytes, { headers: { 'content-type': 'image/png', ...cache } });
}
