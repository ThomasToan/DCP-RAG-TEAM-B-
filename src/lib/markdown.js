/**
 * Minimal Markdown -> safe HTML for the assistant's answers. Not a general Markdown engine: it only covers the
 * subset the chat system prompt actually produces (##/### headings, **bold**, "- " bullet lists, GFM-style tables,
 * blank-line paragraphs). No external dependency, and no XSS risk from AI or page-image content: every character of
 * input is HTML-escaped up front, and every tag in the output is one WE add afterwards. There is no path from input
 * text to an unescaped tag, so even an adversarial answer (e.g. from a prompt-injected page image) cannot inject markup.
 */

const escapeHtml = (s) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** `**bold**` only (safe: operates on already-escaped text, so `**<b>**` stays literal). */
const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isTableSeparator = (l) => isTableRow(l) && /^\s*\|[\s:|-]+\|\s*$/.test(l);
const cells = (row) =>
	row
		.trim()
		.replace(/^\||\|$/g, '')
		.split('|')
		.map((c) => c.trim());

function renderTable(lines) {
	const [header, , ...body] = lines; // lines[1] is the --- separator
	const th = cells(header)
		.map((c) => `<th>${inline(c)}</th>`)
		.join('');
	const rows = body
		.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
		.join('');
	return `<table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`;
}

/** @param {string} text @returns {string} HTML */
export function renderMarkdown(text) {
	const lines = escapeHtml(String(text ?? '')).split('\n');
	const out = [];
	let para = [];
	let list = [];

	const flushPara = () => {
		if (para.length) {
			out.push(`<p>${para.map(inline).join('<br>')}</p>`);
			para = [];
		}
	};
	const flushList = () => {
		if (list.length) {
			out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
			list = [];
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		const bullet = /^\s*[-*]\s+(.*)$/.exec(line);

		if (isTableRow(line) && isTableSeparator(lines[i + 1] ?? '')) {
			flushPara();
			flushList();
			const rows = [line, lines[i + 1]];
			let j = i + 2;
			while (j < lines.length && isTableRow(lines[j])) rows.push(lines[j++]);
			out.push(renderTable(rows));
			i = j - 1;
		} else if (heading) {
			flushPara();
			flushList();
			const level = Math.min(heading[1].length + 1, 6); // model's ## -> h3, so headings sit below our own <h1>/<h2>
			out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
		} else if (bullet) {
			flushPara();
			list.push(bullet[1]);
		} else if (line.trim() === '') {
			flushPara();
			flushList();
		} else {
			flushList();
			para.push(line);
		}
	}
	flushPara();
	flushList();
	return out.join('\n');
}
