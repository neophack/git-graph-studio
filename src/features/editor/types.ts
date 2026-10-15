// The editor module's public types: the diff/editor input shapes other modules (Source
// Control, the extension host, the remote workbench) consume without importing the editor
// implementation (plan §5.3/5.4 — types only, importable by any layer).

/** One side of a diff: a file at a revision (`*` working tree, `:index` staged, `HEAD`, a hash…),
 *  or nothing (an added/deleted file's missing side). */
export interface DiffSide {
	revision: string;
	path: string;
	/** Shown in the header over the pane, e.g. "HEAD" or "Working Tree". */
	label: string;
	/** False when the file does not exist on this side. */
	exists: boolean;
	/** Set when `path` is an absolute filesystem path, not a repo-relative one at a revision -
	  *  a Beyond Compare-style compare of two files on disk reads it directly. */
	local?: boolean;
	/** The side's text, supplied by whoever opened the diff (an extension's text-document
	 *  content provider) instead of being read from a repository or disk. */
	content?: string;
}

/** Where a programmatically opened editor lands: `'beside'` answers the focused group's
 *  right neighbour (a fresh right split when it has none — VS Code's `ViewColumn.Beside`),
 *  a 1-based number that group index (`ViewColumn.One`…, created by splitting when it does
 *  not exist yet). `undefined` is the focused group, VS Code's default. */
export type EditorPlacement = 'beside' | number;

/** A diff the workbench was asked to open (the editor input's diff shape minus the kind). */
export interface DiffRequest {
	id: string;
	title: string;
	/** The repository the revisions belong to (the open repository, or a submodule when the
	 *  diff was opened from its graph). */
	repo?: string;
	/** The request came from the Git Graph view: the extension opens the native diff editor,
	 *  whose binary sides show as placeholders - so a binary pair opens the shell's diff
	 *  editor with the same notice instead of substituting the hex comparison. */
	binaryNotice?: boolean;
	left: DiffSide;
	right: DiffSide;
}
