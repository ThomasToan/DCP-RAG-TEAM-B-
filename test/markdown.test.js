import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown.js';

describe('renderMarkdown', () => {
	it('renders a heading', () => {
		expect(renderMarkdown('## Property facts')).toBe('<h3>Property facts</h3>');
	});

	it('renders bold inside a paragraph', () => {
		expect(renderMarkdown('The zone is **R4**.')).toBe('<p>The zone is <strong>R4</strong>.</p>');
	});

	it('renders a bullet list', () => {
		expect(renderMarkdown('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
	});

	it('renders a paragraph, a list, and another paragraph as separate blocks', () => {
		const html = renderMarkdown('Intro line.\n\n- a\n- b\n\nOutro line.');
		expect(html).toBe('<p>Intro line.</p>\n<ul><li>a</li><li>b</li></ul>\n<p>Outro line.</p>');
	});

	it('joins consecutive non-blank lines into one paragraph with <br>', () => {
		expect(renderMarkdown('line one\nline two')).toBe('<p>line one<br>line two</p>');
	});

	it('renders a GFM table with a right-aligned column marker', () => {
		const md = '| Location | Spaces |\n|---|---:|\n| Tier 1 | 0.8 |\n| Tier 2 | 1 |';
		expect(renderMarkdown(md)).toBe('<table><thead><tr><th>Location</th><th>Spaces</th></tr></thead><tbody><tr><td>Tier 1</td><td>0.8</td></tr><tr><td>Tier 2</td><td>1</td></tr></tbody></table>');
	});

	it.each([
		['<script>alert(1)</script>', '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'],
		['**<img src=x onerror=alert(1)>**', '<p><strong>&lt;img src=x onerror=alert(1)&gt;</strong></p>'],
		['5 > 3 and 2 < 4', '<p>5 &gt; 3 and 2 &lt; 4</p>'],
		[`it's a "test"`, '<p>it&#39;s a &quot;test&quot;</p>']
	])('escapes dangerous or special characters: %j', (input, expected) => {
		expect(renderMarkdown(input)).toBe(expected);
	});

	it('cannot be tricked into emitting an unescaped tag via a crafted table cell', () => {
		const md = '| a |\n|---|\n| <script>x</script> |';
		expect(renderMarkdown(md)).not.toContain('<script>x</script>');
		expect(renderMarkdown(md)).toContain('&lt;script&gt;');
	});

	it('handles empty input', () => {
		expect(renderMarkdown('')).toBe('');
		expect(renderMarkdown(undefined)).toBe('');
	});

	it('a full realistic answer renders headings, bold citations, bullets and a table together', () => {
		const md = [
			'## Property facts',
			'',
			'- The lot is **R4 High Density Residential**.',
			'- Bushfire: **Vegetation Buffer**.',
			'',
			'## Conclusion',
			'',
			'| Location | Spaces |',
			'|---|---:|',
			'| Tier 1 | 0.8 |',
			'',
			'**PDF page 37, Table 1.3.2-d.**'
		].join('\n');
		const html = renderMarkdown(md);
		expect(html).toContain('<h3>Property facts</h3>');
		expect(html).toContain('<li>The lot is <strong>R4 High Density Residential</strong>.</li>');
		expect(html).toContain('<h3>Conclusion</h3>');
		expect(html).toContain('<table>');
		expect(html).toContain('<td>0.8</td>');
		expect(html).toContain('<p><strong>PDF page 37, Table 1.3.2-d.</strong></p>');
	});
});
