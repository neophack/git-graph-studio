// The diagnostic shape that crosses from an extension frame (the vscode shim's
// `languages.createDiagnosticCollection`) to the workbench's diagnostics store — the one
// wire shape both the frame hosts and the editor suite speak, kept in the platform layer
// because the hosts run without the workbench (R7).
export interface SerializableDiagnostic {
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
	severity?: number;
	message: string;
	source?: string;
	code?: string | number;
}
