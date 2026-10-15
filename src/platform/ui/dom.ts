// DOM construction and the path vocabulary every view spells, the lowest building block
// of the hand-written UI (no framework — plan §3.3).

import { onLocaleChange, t, type LocaleKey } from '../i18n';

export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	children: (Node | string | null | undefined)[] = []
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (className) element.className = className;
	for (const child of children) {
		if (child === null || child === undefined) continue;
		element.append(child);
	}
	return element;
}

/** A sidebar-title element whose label follows the locale (the `sidebar-title` shape every
 *  built-in view spells): constructed once, relabelled in place when the display language
 *  switches — the view's own body does the same through `onLocaleChange`. */
export function liveSidebarTitle(key: LocaleKey): HTMLElement {
	const label = el('span', 'label', [t(key)]);
	onLocaleChange(() => {
		label.textContent = t(key);
	});
	return el('div', 'sidebar-title', [label]);
}

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/* ---------- Delayed tooltips and the busy cursor (M7 7.8) ---------- */

/** How long the pointer must rest on an element before its tooltip appears - long enough
 *  that a pass across the bar shows nothing (VS Code's own delay). */
const TOOLTIP_DELAY = 500;
let tooltipTimer: number | null = null;
let tooltipElement: HTMLElement | null = null;

function hideTooltip(): void {
	if (tooltipTimer !== null) {
		clearTimeout(tooltipTimer);
		tooltipTimer = null;
	}
	tooltipElement?.remove();
	tooltipElement = null;
}

/** A delayed custom tooltip in place of the native `title` popup (M7 7.8): VS Code-style
 *  hover-after-a-rest, keyboard-reachable, and gone on any pointer or focus move. The text
 *  is a callback so a label that changes (a status item's counts) stays fresh. */
export function tooltip(element: HTMLElement, text: () => string): void {
	// The native title would race this tooltip with its own popup; the accessible name stays
	// for screen readers either way.
	element.removeAttribute('title');
	element.setAttribute('aria-label', text());
	const show = () => {
		hideTooltip();
		tooltipTimer = window.setTimeout(() => {
			tooltipTimer = null;
			const tip = el('div', 'tooltip', [text()]);
			tooltipElement = tip;
			(document.getElementById('overlays') ?? document.body).appendChild(tip);
			const bounds = element.getBoundingClientRect();
			tip.style.left = `${Math.max(4, Math.min(bounds.left, window.innerWidth - 260))}px`;
			tip.style.top = `${bounds.bottom + 4}px`;
		}, TOOLTIP_DELAY);
	};
	element.addEventListener('mouseenter', show);
	element.addEventListener('focusin', show);
	element.addEventListener('mouseleave', hideTooltip);
	element.addEventListener('blur', hideTooltip);
	element.addEventListener('mousedown', hideTooltip);
}

/** The workbench's busy state (M7 7.8): a progress cursor over everything while a long,
 *  user-initiated task runs, without blocking a single interaction. */
export function busy(on: boolean): void {
	document.body.classList.toggle('busy', on);
}

export function basename(path: string): string {
	const normalised = path.replace(/[\\/]+$/, '');
	const index = Math.max(normalised.lastIndexOf('/'), normalised.lastIndexOf('\\'));
	return index === -1 ? normalised : normalised.slice(index + 1);
}

export function dirname(path: string): string {
	const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return index === -1 ? '' : path.slice(0, index);
}

export function joinPath(base: string, name: string): string {
	const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
	return base.replace(/[\\/]+$/, '') + separator + name;
}

/** The parent of a path in either separator dialect, Windows-drive aware (`C:\` keeps its
 *  separator, `/` is its own parent): `null` when the path has none above it — the shape
 *  the remote folder pickers walk up with. */
export function parentOf(path: string): string | null {
	const trimmed = path.replace(/[\\/]+$/, '');
	const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
	if (at < 0) return null;
	if (at === 0) return '/';
	const parent = trimmed.slice(0, at);
	return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

/** One byte-size formatter for every view (the CAN overview, the hex viewers' copy
 *  notices, the remote traffic line): 1 decimal place, one unit per 1024 step. The
 *  options keep each caller's prior spelling — `gb` adds the terabyte-free GB step
 *  (CAN traces), `iec` spells KiB/MiB (the hex viewers), `trim` drops a trailing
 *  `.0` (the hex viewers). */
export function formatBytes(count: number, opts: { gb?: boolean; iec?: boolean; trim?: boolean } = {}): string {
	const step = (value: number, places: number) => {
		const fixed = value.toFixed(places);
		return opts.trim ? String(Number(fixed)) : fixed;
	};
	if (count < 1024) return `${count} B`;
	if (count < 1024 * 1024) return `${step(count / 1024, 1)} ${opts.iec ? 'KiB' : 'KB'}`;
	if (opts.gb && count >= 1024 ** 3) return `${step(count / 1024 ** 3, 2)} GB`;
	return `${step(count / (1024 * 1024), 1)} ${opts.iec ? 'MiB' : 'MB'}`;
}

/** Forward slashes, as git and the graph view spell paths. */
export function toPosix(path: string): string {
	return path.replaceAll('\\', '/');
}

/** `path` relative to `root` (both spelled either way), or `path` itself when outside. */
export function relativeTo(root: string, path: string): string {
	const normalisedRoot = toPosix(root).replace(/\/$/, '');
	const normalisedPath = toPosix(path);
	if (normalisedPath === normalisedRoot) return '';
	return normalisedPath.startsWith(normalisedRoot + '/') ? normalisedPath.slice(normalisedRoot.length + 1) : normalisedPath;
}
