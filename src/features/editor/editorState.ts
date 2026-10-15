// The editor suite's module-level mutable state: the loaded CodeMirror host module and
// the windowed-editor module. A leaf, so the concern files and the class shell can all
// reach the same slots without importing each other (R5).

import type * as TextEditor from './textEditor';

export const editorState: {
	cm: typeof TextEditor | null;
	docEditModule: typeof import('./docEditView') | null;
} = { cm: null, docEditModule: null };
