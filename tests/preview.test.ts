// The previews: image files map to their MIME types (the viewer itself is
// tests/imageViewer.test.ts); a Markdown file's preview renders through markdown-it,
// follows the source editor's edits, and resolves relative images from the file's folder.

import { describe, expect, it, vi } from 'vitest';

import { EditorGroup } from '../src/features/editor';
import { imageMime, sanitizeMarkdown } from '../src/platform/markdown';
import { backend } from './tauriMock';
import { click, flush } from './helpers';

const REPO = 'C:\\repo';
// A 1×1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('image types', () => {
	it('maps extensions to MIME types', () => {
		expect(imageMime('a.PNG')).toBe('image/png');
		expect(imageMime('b.jpeg')).toBe('image/jpeg');
		expect(imageMime('c.svg')).toBe('image/svg+xml');
		expect(imageMime('d.txt')).toBeNull();
	});
});

describe('markdown', () => {
	it('sanitises rendered markup', () => {
		const article = document.createElement('article');
		article.innerHTML = '<h1>Hi</h1><script>alert(1)</script><link rel="stylesheet" href="https://x.y/evil.css"><base href="https://x.y/"><meta http-equiv="refresh" content="0;url=https://x.y/"><a href="https://x.y" onclick="evil()">x</a><a href="other.md">o</a><iframe></iframe>';
		sanitizeMarkdown(article);
		expect(article.querySelector('script')).toBeNull();
		expect(article.querySelector('iframe')).toBeNull();
		// A refresh tag navigates the webview the way <base> retargets its links - both go.
		expect(article.querySelector('link, base, meta')).toBeNull();
		const anchors = article.querySelectorAll('a');
		expect(anchors[0]!.getAttribute('onclick')).toBeNull();
		expect(anchors[0]!.target).toBe('_blank');
		expect(anchors[1]!.title).toBe('other.md');
	});

	it('renders a preview that follows the source editor and resolves relative images', async () => {
		(window as unknown as { markdownIt: unknown }).markdownIt = {
			render: (text: string) => text.split('\n').map((line) => (line.startsWith('# ') ? `<h1>${line.slice(2)}</h1>` : line.startsWith('![') ? `<img src="${line.slice(line.indexOf('(') + 1, line.indexOf(')'))}">` : `<p>${line}</p>`)).join('')
		};
		const files: Record<string, string> = { [`${REPO}\\docs\\guide.md`]: '# Guide\n![shot](images/shot.png)\n' };
		backend.on('read_file', ({ path }) => ({ contents: files[path as string] ?? '', binary: false, size: 1, encoding: 'utf8', eol: 'lf' }));
		backend.on('read_file_base64', ({ path }) => (path === `${REPO}\\docs\\images\\shot.png` ? PNG : (() => { throw 'missing'; })()));
		backend.on('file_fingerprint', () => '1:1');
		backend.on('backup_write', () => null);
		backend.on('backup_clear', () => null);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(REPO);
		await group.openFile(`${REPO}\\docs\\guide.md`);
		await group.openMarkdownPreview();
		await flush();
		const body = document.querySelector('.markdown-preview-body')!;
		expect(body.querySelector('h1')!.textContent).toBe('Guide');
		expect(body.querySelector('img')!.src).toBe(`data:image/png;base64,${PNG}`);
		expect(group.activeInput).toEqual({ kind: 'markdown', path: `${REPO}\\docs\\guide.md` });

		// Editing the source re-renders the preview after a short delay.
		group.openFilePaths(); // the source tab is still open
		const source = [...(group as unknown as { open: { input: { kind: string }; view?: { dispatch: (t: unknown) => void; state: { doc: { length: number } } } }[] }).open].find((e) => e.input.kind === 'file')!;
		source.view!.dispatch({ changes: { from: source.view!.state.doc.length, insert: '\nmore text' } });
		await new Promise((resolve) => setTimeout(resolve, 400));
		await flush();
		expect(body.textContent).toContain('more text');

		// Reopening the preview activates the existing tab rather than adding one.
		await group.openMarkdownPreview(`${REPO}\\docs\\guide.md`);
		expect(document.querySelectorAll('.markdown-preview-body')).toHaveLength(1);
	});

	it('tags rendered blocks with their source line, the scroll sync map', async () => {
		// A fresh module registry, so loadMarkdownIt picks up this stub rather than the one
		// the previous test already cached. The stub's rules render their token's attributes,
		// as markdown-it's own token renderer does.
		vi.resetModules();
		const rules = {
			paragraph_open: (tokens: { attrs?: [string, string][] }[], idx: number) => '<p' + (tokens[idx]!.attrs ?? []).map(([name, value]) => ` ${name}="${value}"`).join('') + '>'
		};
		const instance = {
			// Renders through `renderer.rules`, as markdown-it's own renderer does - which is
			// what lets the source-line annotation wrap the rules.
			render: (text: string) => text.split('\n').map((line, index) => {
				const token = { map: [index, index + 1] as [number, number], attrs: [] as [string, string][], attrSet: (name: string, value: string) => { token.attrs.push([name, value]); } };
				return (instance.renderer.rules.paragraph_open as unknown as (tokens: unknown[], idx: number) => string)([token], 0) + line + '</p>';
			}).join(''),
			renderer: { rules: { ...rules } }
		};
		(window as unknown as { markdownit: unknown }).markdownit = instance;
		const { renderMarkdown } = await import('../src/platform/markdown');
		const article = document.createElement('article');
		expect(await renderMarkdown('zero\none\ntwo', article)).toBe(true);
		const paragraphs = article.querySelectorAll('p[data-line]');
		expect(paragraphs).toHaveLength(3);
		expect(paragraphs[2]!.dataset.line).toBe('2');
	});

	it('shows the open-to-the-side preview button on a Markdown file\'s tab strip', async () => {
		backend.on('read_file', ({ path }) => ({ contents: path.endsWith('.txt') ? 'x' : '# T\n', binary: false, size: 1, encoding: 'utf8', eol: 'lf' }));
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(REPO);
		await group.openFile(`${REPO}\\a.txt`);
		await flush();
		expect(document.querySelector('.markdown-preview-button')).toBeNull();
		await group.openFile(`${REPO}\\b.md`);
		await flush();
		const button = document.querySelector<HTMLButtonElement>('.markdown-preview-button')!;
		expect(button).not.toBeNull();
		expect(button.title).toContain('Open Preview to the Side');
		let requested = '';
		group.onOpenPreviewToSide = (path) => { requested = path; };
		click(button);
		expect(requested).toBe(`${REPO}\\b.md`);
	});
});

describe('markdown links', () => {
	it('gives headings their GitHub slugs and scrolls anchors in place, never to the browser', () => {
		const article = document.createElement('article');
		article.innerHTML = '<h2>Product summary</h2><h2>Module map</h2><h2>Product summary</h2><a href="#product-summary">up</a><a href="mailto:x@y.z">mail</a>';
		sanitizeMarkdown(article);
		const headings = article.querySelectorAll('h2');
		expect(headings[0]!.id).toBe('product-summary');
		expect(headings[1]!.id).toBe('module-map');
		expect(headings[2]!.id).toBe('product-summary-1');
		const anchor = article.querySelectorAll('a')[0]!;
		// No target attribute: one would open a new window - the webview forwards that to
		// the system browser, the `http://tauri.localhost/#...` page the user saw.
		expect(anchor.target).toBe('');
		let scrolled = '';
		const original = Element.prototype.scrollIntoView;
		Element.prototype.scrollIntoView = function (this: Element) { scrolled = this.id; };
		try {
			click(anchor);
		} finally {
			Element.prototype.scrollIntoView = original;
		}
		expect(scrolled).toBe('product-summary');
		expect(window.location.hash).toBe('');
		// mailto: stays inert, its target shown as the tooltip.
		const mail = article.querySelectorAll('a')[1]!;
		expect(mail.title).toBe('mailto:x@y.z');
	});

	it('hands a relative link to the caller\'s opener and stays inert without one', () => {
		const opened: string[] = [];
		const article = document.createElement('article');
		article.innerHTML = '<a href="docs/plan.md#L7">plan</a><a href="mailto:x@y.z">mail</a>';
		sanitizeMarkdown(article, { openRelative: (href) => opened.push(href) });
		click(article.querySelectorAll('a')[0]);
		expect(opened).toEqual(['docs/plan.md#L7']);
		// No opener (the extension README page): inert with its target as the tooltip.
		const plain = document.createElement('article');
		plain.innerHTML = '<a href="docs/plan.md">plan</a>';
		sanitizeMarkdown(plain);
		const anchor = plain.querySelector('a')!;
		expect(anchor.target).toBe('');
		expect(anchor.title).toBe('docs/plan.md');
	});

	it('opens a preview\'s relative link in the editor, the #L line riding along', async () => {
		// A fresh module registry, so this test's markdown-it stub (a link renderer) is
		// what the earlier preview's cached loader is replaced by.
		vi.resetModules();
		const stub = {
			render: (text: string) => text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '<a href="$2">$1</a>')
		};
		const globals = window as unknown as Record<string, unknown>;
		globals.markdownit = stub;
		globals.markdownIt = stub;
		const { EditorGroup: FreshGroup } = await import('../src/features/editor');
		const files: Record<string, string> = {
			[`${REPO}\\docs\\guide.md`]: '[plan](plan.md#L3)\n',
			[`${REPO}\\docs\\plan.md`]: 'one\ntwo\nthree\n'
		};
		backend.on('read_file', ({ path }) => ({ contents: files[path as string] ?? '', binary: false, size: 1, encoding: 'utf8', eol: 'lf' }));
		backend.on('file_fingerprint', () => '1:1');
		backend.on('backup_write', () => null);
		backend.on('backup_clear', () => null);
		const group = new FreshGroup(document.getElementById('editorGroup')!);
		group.setRoot(REPO);
		await group.openFile(`${REPO}\\docs\\guide.md`);
		await group.openMarkdownPreview();
		await flush();
		click(document.querySelector('.markdown-preview-body a'));
		await flush();
		expect(group.activeInput).toEqual({ kind: 'file', path: `${REPO}\\docs\\plan.md` });
	});
});
