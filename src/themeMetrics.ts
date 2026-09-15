// Theme contrast metrics (the harness's measurement pass over the themes): every shipped
// theme must keep its text readable — each foreground/background token pair the workbench
// paints with is checked as a WCAG contrast ratio, so a new theme (or a token edit) that
// dims a surface below the threshold fails the report instead of shipping unclear text.
// The pairs are the CSS variables the surfaces consume, so the check covers everywhere the
// variables are used — the editor, the tabs, the side bar, the status bar, the fast viewer.

import { THEMES, THEME_EVENT, applyTheme, settings } from './settings';

import type { MetricResult } from './uiMetrics';

/** One readability check: a foreground token over a background token, and the WCAG ratio it
 *  must reach — 4.5 is AA for body text; 3.0 is the AA large-text bar, applied to the dimmer
 *  decorative text (line numbers, descriptions, syntax tokens). */
interface SurfaceCheck {
	label: string;
	foreground: string;
	background: string;
	min: number;
}

/** The syntax tokens cmTheme.ts maps CodeMirror's highlighting onto (fastView.ts uses the
 *  same ones) — each is checked against the editor background. */
const SYNTAX_TOKENS = ['comment', 'string', 'number', 'keyword', 'function', 'type', 'parameter', 'punctuation'];

export const SURFACES: SurfaceCheck[] = [
	{ label: 'editor text', foreground: '--vscode-editor-foreground', background: '--vscode-editor-background', min: 4.5 },
	{ label: 'side bar text', foreground: '--vscode-sideBar-foreground', background: '--vscode-sideBar-background', min: 4.5 },
	{ label: 'status bar text', foreground: '--vscode-statusBar-foreground', background: '--vscode-statusBar-background', min: 4.5 },
	{ label: 'inactive tab text', foreground: '--vscode-tab-inactiveForeground', background: '--vscode-editorGroupHeader-tabsBackground', min: 3.0 },
	{ label: 'input text', foreground: '--vscode-input-foreground', background: '--vscode-input-background', min: 4.5 },
	{ label: 'line numbers', foreground: '--vscode-editorLineNumber-foreground', background: '--vscode-editor-background', min: 3.0 },
	{ label: 'description text', foreground: '--vscode-descriptionForeground', background: '--vscode-editor-background', min: 3.0 },
	...SYNTAX_TOKENS.map((token): SurfaceCheck => ({
		label: `syntax ${token}`,
		foreground: `--syntax-${token}`,
		background: '--vscode-editor-background',
		min: 3.0
	}))
];

/** A parsed colour as linear-channel floats plus alpha; `null` when unparseable. */
export function parseColor(value: string): [number, number, number, number] | null {
	const text = value.trim();
	let match = /^#([0-9a-f]{3})$/i.exec(text);
	if (match) {
		const [r, g, b] = match[1]!.split('').map((c) => parseInt(c + c, 16));
		return [r!, g!, b!, 1];
	}
	match = /^#([0-9a-f]{6})(?:([0-9a-f]{2}))?$/i.exec(text);
	if (match) {
		const r = parseInt(match[1]!.slice(0, 2), 16);
		const g = parseInt(match[1]!.slice(2, 4), 16);
		const b = parseInt(match[1]!.slice(4, 6), 16);
		return [r, g, b, match[2] ? parseInt(match[2], 16) / 255 : 1];
	}
	match = /^rgba?\(([^)]+)\)$/i.exec(text);
	if (match) {
		const parts = match[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
		if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
			return [parts[0]!, parts[1]!, parts[2]!, parts[3] === undefined ? 1 : parts[3]];
		}
	}
	return null;
}

/** Composite a possibly translucent colour over its background, returning opaque channels. */
function flatten(fg: [number, number, number, number], bg: [number, number, number, number]): [number, number, number] {
	const a = fg[3] + bg[3] * (1 - fg[3]);
	const mix = (f: number, b: number) => Math.round((f * fg[3] + b * bg[3] * (1 - fg[3])) / (a || 1));
	return [mix(fg[0], bg[0]), mix(fg[1], bg[1]), mix(fg[2], bg[2])];
}

function luminance([r, g, b]: [number, number, number]): number {
	const channel = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The WCAG contrast ratio of a foreground colour over a background colour. */
export function contrastRatio(foreground: string, background: string): number | null {
	const fg = parseColor(foreground);
	const bg = parseColor(background);
	if (!fg || !bg) return null;
	const l1 = luminance(flatten(fg, bg));
	const l2 = luminance(flatten(bg, [0, 0, 0, 1]));
	const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
	return (hi + 0.05) / (lo + 0.05);
}

/** One surface's verdict as a MetricResult; exposed for the unit tests of the maths. */
export function evaluateSurface(theme: string, surface: SurfaceCheck, foreground: string, background: string): MetricResult {
	const ratio = contrastRatio(foreground, background);
	const name = `${theme}: ${surface.label} readable`;
	if (ratio === null) {
		return { name, status: 'fail', detail: `cannot parse ${surface.foreground}="${foreground}" or ${surface.background}="${background}"` };
	}
	return ratio >= surface.min
		? { name, status: 'pass', detail: `contrast ${ratio.toFixed(2)} (min ${surface.min})` }
		: { name, status: 'fail', detail: `contrast ${ratio.toFixed(2)} under ${surface.min}: ${surface.foreground} ${foreground} on ${surface.background} ${background}` };
}

/** Apply every shipped theme in turn and check each surface's contrast. The theme the user
 *  had is restored afterwards. Without a real stylesheet (jsdom, no `link#theme-css`) every
 *  theme reports skipped, so the pass is a no-op there rather than a false failure. */
export async function runThemeContrastMetrics(): Promise<MetricResult[]> {
	const link = document.querySelector<HTMLLinkElement>('link#theme-css');
	if (!link) {
		return THEMES.map((theme) => ({ name: `${theme.label}: theme stylesheet not loaded`, status: 'skipped' as const, detail: 'no link#theme-css on the page' }));
	}
	const original = settings.theme;
	const results: MetricResult[] = [];
	for (const theme of THEMES) {
		const already = link.getAttribute('href') === theme.css;
		applyTheme(theme.id);
		// applyTheme fires THEME_EVENT once the stylesheet loads (and not at all when the
		// link already points at the theme); a timeout keeps the pass alive if a stylesheet
		// 404s — the checks then fail on the stale colours, loudly.
		if (!already) {
			await new Promise<void>((resolve) => {
				const done = () => { document.removeEventListener(THEME_EVENT, done); clearTimeout(timer); resolve(); };
				const timer = setTimeout(done, 4000);
				document.addEventListener(THEME_EVENT, done);
			});
		}
		const computed = getComputedStyle(document.documentElement);
		for (const surface of SURFACES) {
			const foreground = computed.getPropertyValue(surface.foreground).trim();
			const background = computed.getPropertyValue(surface.background).trim();
			if (foreground === '' || background === '') {
				results.push({ name: `${theme.label}: ${surface.label} readable`, status: 'fail', detail: `theme does not define ${surface.foreground} or ${surface.background}` });
				continue;
			}
			results.push(evaluateSurface(theme.label, surface, foreground, background));
		}
	}
	applyTheme(original);
	return results;
}
