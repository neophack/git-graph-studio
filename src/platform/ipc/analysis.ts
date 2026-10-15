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

/** `analysis_module_graph`: the workspace's cross-file calls lifted to modules (the
 *  directories that group the files) — module edges, the file pairs under them and the
 *  call sites under those. */
export interface ModuleInfo { name: string; files: number; symbols: number }
export interface ModuleEdge { from: string; to: string; calls: number; files: number }
export interface CallSiteRow { from: string; to: string; line: number; column: number }
export interface FileDep { from: string; to: string; calls: number; sites: CallSiteRow[] }
export interface ModuleGraphData {
	modules: ModuleInfo[];
	edges: ModuleEdge[];
	fileEdges: FileDep[];
	totalCalls: number;
	totalFileEdges: number;
}

export interface DiagramNode {
	path: string;
	label: string;
	/** The area whose subgraph holds the block; "" is the root, null the unboxed
	 *  overflow of a workspace with more areas than gitdiagram's group cap. */
	module: string | null;
	/** The area's pastel tone slot — the `t<n>` class in the mermaid source. */
	tone: number;
	callsIn: number;
	callsOut: number;
}

export interface DiagramEdge {
	id: string;
	from: string;
	to: string;
	calls: number;
	/** A cycle's back edge — mermaid's dashed `-.->`. */
	dashed: boolean;
}

export interface ModuleDiagram {
	nodes: DiagramNode[];
	edges: DiagramEdge[];
	droppedFiles: number;
	droppedEdges: number;
	/** The diagram as mermaid source — what the view renders and what the page's
	 *  copy action exports. */
	mermaid: string;
}

export const analysisStatus = () => invoke<AnalysisStatus>('analysis_status');
export const analysisRebuild = (onEvent: Channel<AnalysisIndexEvent>) => invoke<AnalysisStatus>('analysis_rebuild', { onEvent });
export const analysisMetrics = (onEvent: Channel<MetricsEvent>) => invoke<void>('analysis_metrics', { onEvent });
export const analysisDeadCode = (includeExported: boolean, onEvent: Channel<DeadCodeEvent>) =>
	invoke<void>('analysis_dead_code', { includeExported, onEvent });
export const analysisSecurity = (onEvent: Channel<SecurityEvent>) => invoke<void>('analysis_security', { onEvent });
export const analysisModuleGraph = (folders?: string[]) =>
	invoke<ModuleGraphData>('analysis_module_graph', folders === undefined ? undefined : { folders });
export const analysisModuleDiagram = (focus: string | null, filter: string, folders?: string[]) =>
	invoke<ModuleDiagram>('analysis_module_diagram', { focus, filter, ...(folders !== undefined && { folders }) });
export const analysisImportGraph = () => invoke<ImportGraphData>('analysis_import_graph');
