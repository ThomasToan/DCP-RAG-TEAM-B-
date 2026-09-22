<script>
	import { renderMarkdown } from '$lib/markdown.js';

	let address = $state('');
	let question = $state('');
	let submittedAddress = $state('');
	let loading = $state(false);
	let error = $state('');
	let facts = $state(null);
	let messages = $state([]); // { role: 'user'|'assistant', text, pages? }
	let previousResponseId = $state(null);
	let factsOpen = $state(false);

	const canAsk = $derived(!loading && address.trim() && question.trim());

	async function ask() {
		if (!canAsk) return;
		const q = question.trim();
		const isFirst = !previousResponseId;
		error = '';
		loading = true;
		messages = [...messages, { role: 'user', text: q }];
		question = '';

		try {
			const res = await fetch('/api/ask', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ address: address.trim(), question: q, previousResponseId })
			});
			const body = await res.json();
			if (!res.ok) {
				error = body.message || 'Something went wrong.';
				if (body.details?.suggestions?.length) error += ` Did you mean: ${body.details.suggestions.join(', ')}?`;
				messages = messages.slice(0, -1); // the question never got an answer: don't leave it dangling
				question = q; // give it back so the user can fix and resend
				return;
			}
			if (isFirst) {
				facts = body.facts;
				submittedAddress = body.facts.address;
			}
			previousResponseId = body.responseId;
			messages = [...messages, { role: 'assistant', text: body.answer, pages: body.pages, warnings: body.warnings }];
		} catch {
			error = 'Could not reach the server. Check your connection and try again.';
			messages = messages.slice(0, -1);
			question = q;
		} finally {
			loading = false;
		}
	}

	function newAddress() {
		address = '';
		submittedAddress = '';
		facts = null;
		messages = [];
		previousResponseId = null;
		error = '';
		factsOpen = false;
	}

	function onKeydown(e) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			ask();
		}
	}
</script>

<svelte:head>
	<title>Hornsby DCP assistant</title>
</svelte:head>

<main>
	<h1>Hornsby DCP assistant</h1>
	<p class="sub">Ask what the Hornsby Development Control Plan 2024 says about a property. Answers cite the DCP page and clause; a Council planner makes the final call.</p>

	{#if !submittedAddress}
		<section class="address-box">
			<label for="address">Property address</label>
			<input id="address" type="text" bind:value={address} placeholder="e.g. 16 Dural Street, Hornsby" onkeydown={(e) => e.key === 'Enter' && address.trim() && document.getElementById('question')?.focus()} />
			<label for="question">Question</label>
			<textarea id="question" bind:value={question} placeholder="e.g. Can I build a granny flat here?" rows="2" onkeydown={onKeydown}></textarea>
			<button onclick={ask} disabled={!canAsk}>{loading ? 'Asking…' : 'Ask'}</button>
			{#if error}<p class="error">{error}</p>{/if}
		</section>
	{:else}
		<section class="conversation">
			<div class="address-bar">
				<strong>{submittedAddress}</strong>
				<button class="link" onclick={newAddress}>change address</button>
			</div>

			{#if facts}
				<details bind:open={factsOpen} class="facts">
					<summary>Property facts {factsOpen ? '' : '(click to show)'}</summary>
					<pre>{facts.summary}</pre>
					{#if facts.notes?.length}
						<ul class="notes">
							{#each facts.notes as note}<li>{note}</li>{/each}
						</ul>
					{/if}
				</details>
			{/if}

			<div class="messages">
				{#each messages as m}
					<div class="message {m.role}">
						{#if m.role === 'assistant'}
							<div class="text answer">{@html renderMarkdown(m.text)}</div>
						{:else}
							<p class="text">{m.text}</p>
						{/if}
						{#if m.pages?.length}
							<div class="pages">
								{#each m.pages as p}
									<figure>
										<img src="/dcp-page/{p.page}" alt="DCP page {p.page}" loading="lazy" />
										<figcaption>page {p.page}</figcaption>
									</figure>
								{/each}
							</div>
						{/if}
						{#if m.warnings?.length}
							<p class="warning">⚠ {m.warnings.join(' ')}</p>
						{/if}
					</div>
				{/each}
				{#if loading}<div class="message assistant"><p class="text loading">Searching the DCP…</p></div>{/if}
			</div>

			{#if error}<p class="error">{error}</p>{/if}

			<div class="composer">
				<textarea bind:value={question} placeholder="Ask a follow-up question…" rows="2" onkeydown={onKeydown} disabled={loading}></textarea>
				<button onclick={ask} disabled={!canAsk}>{loading ? '…' : 'Ask'}</button>
			</div>
		</section>
	{/if}
</main>

<style>
	main {
		max-width: 760px;
		margin: 0 auto;
		padding: 24px 16px 48px;
		font-family: system-ui, sans-serif;
	}
	h1 {
		font-size: 22px;
		margin-bottom: 4px;
	}
	.sub {
		color: #555;
		font-size: 14px;
		margin-top: 0;
		margin-bottom: 24px;
	}
	label {
		display: block;
		font-size: 13px;
		font-weight: 600;
		margin: 12px 0 4px;
	}
	input,
	textarea {
		width: 100%;
		box-sizing: border-box;
		font: inherit;
		font-size: 15px;
		padding: 8px 10px;
		border: 1px solid #ccc;
		border-radius: 6px;
		resize: vertical;
	}
	button {
		margin-top: 12px;
		padding: 8px 18px;
		font-size: 15px;
		border: none;
		border-radius: 6px;
		background: #1a5fa4;
		color: white;
		cursor: pointer;
	}
	button:disabled {
		background: #99b6cf;
		cursor: not-allowed;
	}
	button.link {
		background: none;
		color: #1a5fa4;
		text-decoration: underline;
		padding: 0;
		margin: 0;
		font-size: 13px;
	}
	.error {
		color: #b00020;
		font-size: 14px;
	}
	.address-bar {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		border-bottom: 1px solid #ddd;
		padding-bottom: 8px;
		margin-bottom: 12px;
	}
	.facts {
		background: #f5f7fa;
		border: 1px solid #dde3ea;
		border-radius: 6px;
		padding: 8px 12px;
		margin-bottom: 16px;
		font-size: 13px;
	}
	.facts summary {
		cursor: pointer;
		font-weight: 600;
	}
	.facts pre {
		white-space: pre-wrap;
		font-family: inherit;
	}
	.notes {
		color: #8a6d00;
	}
	.messages {
		display: flex;
		flex-direction: column;
		gap: 16px;
		margin-bottom: 16px;
	}
	.message {
		padding: 10px 14px;
		border-radius: 8px;
	}
	.message.user {
		background: #eaf1fa;
		align-self: flex-end;
		max-width: 80%;
	}
	.message.assistant {
		background: #f6f6f4;
		border: 1px solid #eee;
	}
	.text {
		white-space: pre-wrap;
		margin: 0;
		line-height: 1.5;
	}
	.text.loading {
		color: #777;
		font-style: italic;
	}
	.answer :global(h3),
	.answer :global(h4) {
		margin: 14px 0 6px;
		font-size: 15px;
	}
	.answer :global(h3:first-child) {
		margin-top: 0;
	}
	.answer :global(p) {
		margin: 0 0 10px;
	}
	.answer :global(ul) {
		margin: 0 0 10px;
		padding-left: 20px;
	}
	.answer :global(table) {
		border-collapse: collapse;
		margin: 8px 0;
		font-size: 14px;
	}
	.answer :global(th),
	.answer :global(td) {
		border: 1px solid #ddd;
		padding: 4px 10px;
		text-align: left;
	}
	.answer :global(th) {
		background: #eee;
	}
	.warning {
		color: #8a6d00;
		font-size: 13px;
	}
	.pages {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		margin-top: 10px;
	}
	.pages figure {
		margin: 0;
		text-align: center;
	}
	.pages img {
		width: 140px;
		border: 1px solid #ccc;
		border-radius: 4px;
		display: block;
	}
	.pages figcaption {
		font-size: 12px;
		color: #666;
	}
	.composer {
		display: flex;
		gap: 8px;
		align-items: flex-end;
	}
	.composer textarea {
		flex: 1;
	}
	.composer button {
		margin-top: 0;
	}
</style>
