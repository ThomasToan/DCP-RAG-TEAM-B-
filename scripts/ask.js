// End-to-end from the command line: address -> property facts -> PixelRAG page search -> AI answer with page citations.
//   node scripts/ask.js "16 Dural St, Hornsby" "How many parking spaces do I need for a 2 bedroom apartment?"
// Needs: the PixelRAG server running (scripts/pixelrag_serve.sh), OPENAI_API_KEY in .env, and rendered pages in data/hornsby/pages.
import OpenAI from 'openai';
import { getPropertyFacts } from '../src/lib/server/property.js';
import { PropertyError } from '../src/lib/server/property-error.js';
import { answerQuestion, describeFacts } from '../src/lib/server/chat.js';

process.loadEnvFile('.env');
const [address, question] = process.argv.slice(2);
if (!address || !question) {
	console.error('usage: node scripts/ask.js "<address>" "<question>"');
	process.exit(2);
}
if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'sk-...') {
	console.error('OPENAI_API_KEY is not set in .env');
	process.exit(2);
}
const model = process.env.OPENAI_MODEL ?? 'gpt-5.6-terra'; // the model the order-agent spec names; override with OPENAI_MODEL

let facts;
try {
	facts = await getPropertyFacts(address);
} catch (e) {
	if (!(e instanceof PropertyError)) throw e;
	console.log(`Could not resolve the address (${e.code}): ${e.message}`, e.details?.suggestions?.length ? `\nDid you mean: ${e.details.suggestions.join(' | ')}` : '');
	process.exit(1);
}
console.log('--- facts the model is given ---\n' + describeFacts(facts) + '\n');

const t0 = Date.now();
const r = await answerQuestion(
	{ facts, question },
	{ openai: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), model, searchOpts: { url: process.env.PIXELRAG_URL ?? 'http://127.0.0.1:30001' } }
);

console.log(`--- searches the model ran (${r.rounds ?? 0} tool round${r.rounds === 1 ? '' : 's'}) ---`);
for (const t of r.toolCalls) console.log(`  "${t.query}" -> pages ${t.pages.join(', ') || 'none above the score floor'}`);
console.log('\n--- answer ---\n' + r.answer);
if (r.pages.length) console.log('\nretrieved pages: ' + r.pages.map((p) => `${p.page} (${p.score.toFixed(2)})`).join(', '));
if (r.warnings.length) console.log('WARNINGS: ' + r.warnings.join(' | '));
if (r.usage) console.log(`\n(${((Date.now() - t0) / 1000).toFixed(1)} s, tokens in/out: ${r.usage.input_tokens}/${r.usage.output_tokens}, model ${model})`);
