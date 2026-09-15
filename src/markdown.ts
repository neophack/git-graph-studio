// Markdown rendering for the workbench (the Markdown preview, the extension detail page's
// README): markdown-it - the same bundle the Git Graph webview ships, exposed as the
// workbench's own vendor asset by scripts/prepare.mjs - loaded once on first use, its output
// sanitised (no scripts, styles, frames or handler attributes; links open externally), and
// relative images resolved by the caller.

import { openUrl } from '@tauri-apps/plugin-opener';

/** A token as the renderer's rules see it: block tokens carry the source lines they cover
 *  (`map`, 0-based, [first, last)), and can gain attributes rendered on their opening tag. */
interface MarkdownItToken {
	map?: [number, number] | null;
	attrSet?(name: string, value: string): void;
}
type RenderRule = (tokens: MarkdownItToken[], idx: number, options: unknown, env: unknown, self: unknown) => string;

type MarkdownIt = {
	render(text: string): string;
	renderer: { rules: Record<string, RenderRule> };
};

/** How long the vendor script gets to load before a preview falls back to the source. */
const MARKDOWN_IT_LOAD_TIMEOUT_MS = 10_000;

let markdownItPromise: Promise<MarkdownIt | null> | null = null;

export function loadMarkdownIt(): Promise<MarkdownIt | null> {
	if (!markdownItPromise) {
		markdownItPromise = new Promise((resolve) => {
			// The bundled build exposes its constructed instance as `window.markdownit`
			// (all lowercase); `markdownIt` is accepted for any bundle that spells it so.
			const globals = window as unknown as { markdownit?: MarkdownIt; markdownIt?: MarkdownIt };
			const existing = globals.markdownit ?? globals.markdownIt;
			if (existing) return resolve(annotateSourceLines(existing));
			const script = document.createElement('script');
			script.src = '/vendor/markdown-it.min.js';
			// A script that never reports (a blocked load, a stalled webview) must not hang
			// every preview forever: after the grace period the source shows instead.
			const deadline = window.setTimeout(() => resolve(null), MARKDOWN_IT_LOAD_TIMEOUT_MS);
			script.onload = () => {
				window.clearTimeout(deadline);
				const loaded = globals.markdownit ?? globals.markdownIt;
				resolve(loaded ? annotateSourceLines(loaded) : null);
			};
			script.onerror = () => {
				window.clearTimeout(deadline);
				resolve(null);
			};
			document.head.appendChild(script);
		});
	}
	return markdownItPromise;
}

/** Wrap every renderer rule so a block token that knows its source lines carries them into
 *  the DOM as `data-line` - what the Markdown preview's scroll sync maps scrolling by. */
function annotateSourceLines(renderer: MarkdownIt): MarkdownIt {
	const rules = renderer?.renderer?.rules;
	if (!rules) return renderer;
	for (const [name, rule] of Object.entries(rules)) {
		if (typeof rule !== 'function') continue;
		rules[name] = (tokens, idx, options, env, self) => {
			const token = tokens[idx];
			if (token?.map && token.attrSet) token.attrSet('data-line', String(token.map[0]));
			return rule(tokens, idx, options, env, self);
		};
	}
	return renderer;
}

/** Strip the markup rendered markdown must never run inside the workbench: scripts, styles,
 *  event handler attributes and iframes. markdown-it escapes source text, but raw HTML passes
 *  through. Links: http(s) open in the system browser, in-page anchors scroll, anything else
 *  is inert (its target shown as the tooltip). */
export function sanitizeMarkdown(article: HTMLElement): void {
	// A <link> or <base> pasted through raw HTML would load a stylesheet or retarget every
	// relative link of the page - neither has a place in a rendered document.
	for (const element of Array.from(article.querySelectorAll('script, style, link, base, iframe, object, embed'))) {
		element.remove();
	}
	for (const element of article.querySelectorAll('*')) {
		for (const attribute of Array.from(element.attributes)) {
			if (attribute.name.toLowerCase().startsWith('on')) element.removeAttribute(attribute.name);
		}
	}
	for (const anchor of Array.from(article.querySelectorAll('a'))) {
		const href = anchor.getAttribute('href') ?? '';
		anchor.target = '_blank';
		anchor.rel = 'noopener';
		if (/^https?:/i.test(href)) {
			anchor.addEventListener('click', (event) => {
				event.preventDefault();
				void openUrl(href);
			});
		} else if (href.startsWith('#')) {
			// In-page anchor: let the browser scroll the rendered article.
		} else {
			anchor.title = href;
			anchor.addEventListener('click', (event) => event.preventDefault());
		}
	}
}

/** Render markdown into `article` (cleared first), sanitised, then resolve relative images
 *  through `resolveImage` (a data URL, or null to hide the image). Returns false when the
 *  renderer is unavailable, so the caller can show the source instead. */
export async function renderMarkdown(text: string, article: HTMLElement, resolveImage?: (relative: string) => Promise<string | null>): Promise<boolean> {
	const renderer = await loadMarkdownIt();
	if (!renderer) return false;
	article.innerHTML = renderer.render(text);
	sanitizeMarkdown(article);
	if (resolveImage) {
		for (const image of Array.from(article.querySelectorAll('img'))) {
			const src = image.getAttribute('src') ?? '';
			if (/^(https?:|data:)/i.test(src)) continue; // remote images load as-is
			const relative = src.replace(/^\.\//, '').replace(/^\//, '').split(/[?#]/)[0]!;
			void resolveImage(relative).then((url) => {
				if (url) image.src = url;
				else image.hidden = true;
			});
		}
	}
	return true;
}

/** The MIME type an image file's data URL needs, by extension. */
export function imageMime(name: string): string | null {
	const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
	switch (ext) {
		case 'png': return 'image/png';
		case 'jpg': case 'jpeg': return 'image/jpeg';
		case 'gif': return 'image/gif';
		case 'webp': return 'image/webp';
		case 'bmp': return 'image/bmp';
		case 'ico': return 'image/x-icon';
		case 'svg': return 'image/svg+xml';
		case 'avif': return 'image/avif';
		default: return null;
	}
}
