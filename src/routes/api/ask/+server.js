import { json } from '@sveltejs/kit';
import OpenAI from 'openai';
import { env } from '$env/dynamic/private';
import { getPropertyFacts } from '$lib/server/property.js';
import { PropertyError } from '$lib/server/property-error.js';
import { pgPropertyCache } from '$lib/server/property-cache.js';
import { getPool } from '$lib/server/db.js';
import { answerQuestion, describeFacts } from '$lib/server/chat.js';

const MODEL = env.OPENAI_MODEL || 'gpt-5.6-terra';
let openai;

/**
 * POST /api/ask   { address, question, previousResponseId? }
 *
 * The address is resolved to property facts server-side (never trusted from the client beyond the raw text typed),
 * exactly as in property.js's own design: the facts bundle is the scope, and it is computed here, not sent by the
 * browser. `previousResponseId` only continues an OpenAI conversation; it grants no extra access on its own.
 */
export async function POST({ request }) {
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'BAD_REQUEST', message: 'Expected JSON body.' }, { status: 400 });
	}
	const { address, question, previousResponseId } = body ?? {};
	if (typeof address !== 'string' || !address.trim()) {
		return json({ error: 'BAD_REQUEST', message: 'Enter an address.' }, { status: 400 });
	}
	if (typeof question !== 'string' || !question.trim() || question.length > 1000) {
		return json({ error: 'BAD_REQUEST', message: 'Enter a question (under 1,000 characters).' }, { status: 400 });
	}
	if (previousResponseId != null && typeof previousResponseId !== 'string') {
		return json({ error: 'BAD_REQUEST', message: 'Invalid conversation id.' }, { status: 400 });
	}
	if (!env.OPENAI_API_KEY) {
		return json({ error: 'SERVER_MISCONFIGURED', message: 'OPENAI_API_KEY is not set.' }, { status: 500 });
	}

	let facts;
	try {
		facts = await getPropertyFacts(address, { cache: pgPropertyCache(getPool()) });
	} catch (e) {
		if (e instanceof PropertyError) {
			return json({ error: e.code, message: e.message, details: e.details }, { status: e.code === 'UPSTREAM' ? 502 : 404 });
		}
		throw e;
	}

	openai ??= new OpenAI({ apiKey: env.OPENAI_API_KEY });
	// PIXELRAG_URL points at the deployed search server (Fly.io); unset in local dev, where
	// answerQuestion/dcp_search.js fall back to their own http://127.0.0.1:30001 default and read
	// page images off local disk. Set, it also switches page-image loading to fetch over HTTP: a
	// Vercel function has no local copy of the 250 MB of rendered pages, only the Fly server does.
	const searchOpts = env.PIXELRAG_URL ? { url: env.PIXELRAG_URL, pagesSource: 'http' } : {};
	let result;
	try {
		result = await answerQuestion({ facts, question, previousResponseId }, { openai, model: MODEL, searchOpts });
	} catch (e) {
		console.error('answerQuestion failed', e);
		return json({ error: 'ANSWER_FAILED', message: 'Something went wrong answering that question. Please try again.' }, { status: 502 });
	}

	return json({
		facts: { address: facts.address, lot: facts.lot, lot_area_m2: facts.lot_area_m2, summary: describeFacts(facts), notes: facts.notes, sources: facts.sources },
		answer: result.answer,
		pages: result.pages,
		warnings: result.warnings,
		responseId: result.responseId,
		skippedModel: result.skippedModel ?? false
	});
}
