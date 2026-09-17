// The previews: an image file opens in the image preview (checkerboard stage, zoom toolbar,
// dimensions) instead of a text editor; a Markdown file's preview renders through markdown-it,
// follows the source editor's edits, and resolves relative images from the file's folder.

import { describe, expect, it, vi } from 'vitest';

import { EditorGroup } from '../src/editor';
import { imageMime, sanitizeMarkdown } from '../src/markdown';
import { backend } from './tauriMock';
import { click, flush } from './helpers';

const REPO = 'C:\\repo';
// A 1×1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('image preview', () => {
	it('maps extensions to MIME types', () => {
		expect(imageMime('a.PNG')).toBe('image/png');
		expect(imageMime('b.jpeg')).toBe('image/jpeg');
		expect(imageMime('c.svg')).toBe('image/svg+xml');
		expect(imageMime('d.txt')).toBeNull();
	});

	it('opens an image as a preview with a zoom toolbar', async () => {
		backend.on('read_file_base64', () => PNG);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(REPO);
		await group.openFile(`${REPO}\\logo.png`);
		await flush();
		expect(backend.callsTo('read_file')).toEqual([]); // never read as text
		const pane = document.querySelector('.editor-pane.image-preview')!;
		expect(pane).not.toBeNull();
		const image = pane.querySelector<HTMLImageElement>('img.image-preview-img')!;
		expect(image.src).toBe(`data:image/png;base64,${PNG}`);
		expect(pane.querySelector('.image-preview-zoom')!.textContent).toBe('Fit');
		click([...pane.querySelectorAll('button')].find((b) => b.title === 'Zoom In'));
		expect(pane.querySelector('.image-preview-zoom')!.textContent).toBe('125%');
		click([...pane.querySelectorAll('button')].find((b) => b.title === 'Actual Size'));
		expect(pane.querySelector('.image-preview-zoom')!.textContent).toBe('100%');
		click([...pane.querySelectorAll('button')].find((b) => b.title === 'Fit to Window'));
		expect(image.classList.contains('fit')).toBe(true);
		expect(pane.querySelector('.image-preview-status')!.textContent).toContain('B');
		expect(group.activeInput).toEqual({ kind: 'file', path: `${REPO}\\logo.png` });
	});

	it('zooms with the mouse wheel, notch by notch like the toolbar', async () => {
		backend.on('read_file_base64', () => PNG);
		const group = new EditorGroup(document.getElementById('editorGroup')!);
		group.setRoot(REPO);
		await group.openFile(`${REPO}\\logo.png`);
		await flush();
		const pane = document.querySelector('.editor-pane.image-preview')!;
		const image = pane.querySelector<HTMLImageElement>('img.image-preview-img')!;
		// jsdom loads no images, so the intrinsic size is pinned by hand.
		Object.defineProperty(image, 'naturalWidth', { value: 320 });
		Object.defineProperty(image, 'naturalHeight', { value: 240 });
		const stage = pane.querySelector<HTMLElement>('.image-preview-stage')!;
		const notch = (deltaY: number) => {
			const event = new WheelEvent('wheel', { deltaY, cancelable: true });
			stage.dispatchEvent(event);
			return event;
		};
		const wheelIn = notch(-100);
		expect(wheelIn.defaultPrevented).toBe(true); // the stage neither scrolls nor zooms the page
		expect(pane.querySelector('.image-preview-zoom')!.textContent).toBe('125%');
		expect(image.style.width).toBe('400px');
		expect(image.classList.contains('fit')).toBe(false);
		notch(100);
		expect(pane.querySelector('.image-preview-zoom')!.textContent).toBe('100%');
		notch(100);
		expect(pane.querySelector('.image-preview-zoom')!.textContent).toBe('80%');
		const horizontal = new WheelEvent('wheel', { deltaX: 100, deltaY: 0, cancelable: true });
		stage.dispatchEvent(horizontal);
		expect(horizontal.defaultPrevented).toBe(false); // pans, does not zoom
	});
});

describe('markdown', () => {
	it('sanitises rendered markup', () => {
		const article = document.createElement('article');
		article.innerHTML = '<h1>Hi</h1><script>alert(1)</script><link rel="stylesheet" href="https://x.y/evil.css"><base href="https://x.y/"><a href="https://x.y" onclick="evil()">x</a><a href="other.md">o</a><iframe></iframe>';
		sanitizeMarkdown(article);
		expect(article.querySelector('script')).toBeNull();
		expect(article.querySelector('iframe')).toBeNull();
		expect(article.querySelector('link, base')).toBeNull();
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
		const { renderMarkdown } = await import('../src/markdown');
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
