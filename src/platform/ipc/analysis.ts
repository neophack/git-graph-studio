// The typed IPC seam of the Code Analysis domain (plan §5.6): the index status and
// rebuild, the three streaming reports (metrics, dead code, security), the module graph
// and its curated diagram, and the import graph with cycles — the ggs-analysis crate
// behind the app's commands/analysis adapters. The row and graph shapes the pages and
// the diagram renderer share live here once.
import { invoke, type Channel } from './core';

/** The analysis index's status as `analysis_status` reports and `analysis_rebuild`
 *  answers with. */
export interface AnalysisStatus {
	state: 'empty' | 'building' | 'ready';
	done: number;
	total: number;
	files: number;
	symbols: number;
	calls: number;
}

/** What `analysis_rebuild` pushes before the final answer. */
export type AnalysisIndexEvent = { kind: 'progress'; done: number; total: number } | { kind: 'done'; files: number; symbols: number; calls: number; cancelled: boolean };

export interface MetricRow {
	path: string; name: string; kind: string; container: string | null; line: number;
	lines: number; params: number; complexity: number; nesting: number; refs: number; hotspot: number;
	/** The big-code-analysis columns — present when that engine measured the function. */
	cognitive?: number; halstead?: number; lloc?: number; mi?: number;
}

export interface DeadRow {
	path: string; name: string; kind: string; container: string | null; line: number; exported: boolean; lines: number;
}

export interface Finding {
	ruleId: string; severity: 'error' | 'warning' | 'info'; message: string;
	path: string; line: number; column: number; cwe: string;
}

export type MetricsEvent = { kind: 'batch'; rows: MetricRow[] } | { kind: 'done'; files: number; functions: number; cancelled: boolean };
export type DeadCodeEvent = { kind: 'batch'; rows: DeadRow[] } | { kind: 'done'; found: number; cancelled: boolean };
export type SecurityEvent = { kind: 'batch'; findings: Finding[] } | { kind: 'done'; files: number; findings: number; cancelled: boolean };

export interface ImportGraphData {
	edges: [string, string][];
	cycles: string[][];
}

/** `analysis_module_overview`: nine-volume-backed layered module architecture overview
 *  (zero `AnalysisData` build) with progressive drill-down (`scope` + `depth`), Tarjan
 *  SCC cycle detection, coupling/instability metrics, and on-demand Mermaid export. */
export interface ModuleFileSummary {
	path: string;
	symbols: number;
}

export interface ModuleNode {
	id: string;
	label: string;
	kind: 'module' | 'file' | 'external';
	expandable: boolean;
	files: number;
	symbols: number;
	fanIn: number;
	fanOut: number;
	instability: number;
	inCycle: boolean;
	layer: number;
	topFiles: ModuleFileSummary[];
	effectiveLines?: number;
	complexity?: number;
	gotoCount?: number;
	tokenEvents?: number;
}

export interface ModuleEdgeTypes {
	calls: boolean;
	typeRefs: boolean;
	baseRefs: boolean;
	imports: boolean;
}

export interface ModuleEdge {
	id: string;
	from: string;
	to: string;
	weight: number;
	symbolRefs: number;
	callRefs: number;
	typeRefs: number;
	baseRefs: number;
	importRefs: number;
	filePairs: number;
	topSymbols: string[];
	isCycle: boolean;
}

export interface ModuleOverview {
	scope: string;
	depth: number;
	breadcrumbs: string[];
	nodes: ModuleNode[];
	edges: ModuleEdge[];
	cycles: string[][];
	totalFiles: number;
	totalSymbols: number;
	totalEdges: number;
	mermaid: string;
}

/** `analysis_module_edge_detail`: on-demand L2 evidence for a single dependency edge —
 *  resolved imports and exact call sites read only from the edge's `from`-side files. */
export interface EdgeImport {
	fromFile: string;
	toFile: string;
	specifier: string;
}

export interface EdgeCallSite {
	symbol: string;
	receiver: string | null;
	line: number;
	column: number;
}

export interface EdgeFilePair {
	fromFile: string;
	toFile: string;
	symbols: string[];
	sites: EdgeCallSite[];
}

export interface ModuleEdgeDetail {
	from: string;
	to: string;
	imports: EdgeImport[];
	filePairs: EdgeFilePair[];
	scannedFiles: number;
}

export const analysisStatus = () => invoke<AnalysisStatus>('analysis_status');
export const analysisRebuild = (onEvent: Channel<AnalysisIndexEvent>) => invoke<AnalysisStatus>('analysis_rebuild', { onEvent });
export const analysisMetrics = (onEvent: Channel<MetricsEvent>) => invoke<void>('analysis_metrics', { onEvent });
export const analysisDeadCode = (includeExported: boolean, onEvent: Channel<DeadCodeEvent>) =>
	invoke<void>('analysis_dead_code', { includeExported, onEvent });
export const analysisSecurity = (onEvent: Channel<SecurityEvent>) => invoke<void>('analysis_security', { onEvent });
export const analysisModuleOverview = (
	scope: string | null,
	depth: number,
	folders?: string[],
	edgeTypes?: ModuleEdgeTypes
) =>
	invoke<ModuleOverview>('analysis_module_overview', {
		scope: scope || null,
		depth,
		...(folders !== undefined && { folders }),
		...(edgeTypes !== undefined && { edgeTypes })
	});
export const analysisModuleEdgeDetail = (
	from: string,
	to: string,
	scope: string | null,
	depth: number,
	folders?: string[]
) =>
	invoke<ModuleEdgeDetail>('analysis_module_edge_detail', {
		from,
		to,
		scope: scope || null,
		depth,
		...(folders !== undefined && { folders })
	});
export const analysisImportGraph = () => invoke<ImportGraphData>('analysis_import_graph');
