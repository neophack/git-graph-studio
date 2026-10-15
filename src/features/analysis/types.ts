// The Code Analysis module's public types (plan §5.3/5.4): shapes the editor and the MCP
// page consume without importing the analysis pages.

/** What a hosted page hands the editor: rows open files in the editor area. */
export interface AnalysisPageView {
	onOpen: ((path: string, line: number) => void) | null;
}
