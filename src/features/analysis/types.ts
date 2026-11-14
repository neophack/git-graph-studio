// The Code Analysis module's public types (plan §5.3/5.4): shapes the editor and the MCP
// page consume without importing the analysis pages.

import type { AnalysisStatus } from '../../platform/ipc/analysis';

/** What a hosted page hands the editor: rows open files in the editor area, and the
 *  analysis index's status pushes reach it (a page whose load waits on a cold index
 *  build shows the build's live progress — the click's first answer is movement). */
export interface AnalysisPageView {
	onOpen: ((path: string, line: number) => void) | null;
	/** The `studio://analysis-index` payload, routed by the editor area; null after a
	 *  release. Optional: pages with no build to show ignore it. */
	noteBuildStatus?(status: AnalysisStatus | null): void;
}
