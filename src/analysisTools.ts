// The Code Analysis tool registry (module 17): the five tools the Analysis sidebar lists
// and the editor pages host. This module is deliberately dependency-free — the sidebar
// (first paint) and the lazy pages module both read it, so it must not import either.
// The type-only i18n import keeps the keys compile-checked without a runtime edge.

import type { t } from './i18n';

export type AnalysisToolId = 'callgraph' | 'metrics' | 'deadcode' | 'security' | 'imports';

export interface AnalysisTool {
	id: AnalysisToolId;
	icon: string;
	/** `t()` key of the tool's name (the sidebar row's label and the page's title). */
	titleKey: Parameters<typeof t>[0];
	/** `t()` key of the one-line description under the label. */
	descriptionKey: Parameters<typeof t>[0];
}

export const ANALYSIS_TOOLS: AnalysisTool[] = [
	{
		id: 'callgraph',
		// `callout` has no glyph in the codicons font — the row rendered blank.
		icon: 'graph',
		titleKey: 'analysis.tool.callgraph',
		descriptionKey: 'analysis.tool.callgraph.desc'
	},
	{
		id: 'metrics',
		icon: 'pulse',
		titleKey: 'analysis.tool.metrics',
		descriptionKey: 'analysis.tool.metrics.desc'
	},
	{
		id: 'deadcode',
		icon: 'circle-slash',
		titleKey: 'analysis.tool.deadcode',
		descriptionKey: 'analysis.tool.deadcode.desc'
	},
	{
		id: 'security',
		icon: 'shield',
		titleKey: 'analysis.tool.security',
		descriptionKey: 'analysis.tool.security.desc'
	},
	{
		id: 'imports',
		icon: 'type-hierarchy-sub',
		titleKey: 'analysis.tool.imports',
		descriptionKey: 'analysis.tool.imports.desc'
	}
];

export function analysisTool(id: AnalysisToolId): AnalysisTool {
	const tool = ANALYSIS_TOOLS.find((entry) => entry.id === id);
	if (!tool) throw new Error(`unknown analysis tool: ${id}`);
	return tool;
}
