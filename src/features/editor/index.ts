// The Editor Suite module's facade: the module's public surface under one import path —
// cross-feature imports resolve here (plan §5.3); the module's own files reach each
// other directly. The light half only: the CodeMirror-carrying modules (textEditor,
// docEditView, editorExtras, autocomplete, expandSelection, comments, cmTheme, and the
// provider views) stay behind lazy.ts's async seams — a static star-export here would
// chain the whole editor suite (CodeMirror included) into the boot closure, and the
// first paint parses what boot statically reaches. A test or tool needing a heavy
// symbol imports its module directly.

export * from './inputs';
export * from './group';
export { tabDrag } from './tabs';
export { askToSaveMany } from './dirty';
export { fileEditorResolver } from './open';

import { EditorGroup } from './group';
import { openMethods } from './open';
import { mountMethods } from './mount';
import { tabsMethods } from './tabs';
import { breadcrumbsMethods } from './breadcrumbs';
import { navigateMethods } from './navigate';
import { dirtyMethods } from './dirty';

Object.assign(EditorGroup.prototype, openMethods, mountMethods, tabsMethods, breadcrumbsMethods, navigateMethods, dirtyMethods);
export * from './editorArea';
export * from './docFind';
export * from './snippetRegistry';
export * from './findWidget';
export * from './bookmarks';
export * from './types';
export * from './editorCompletions';
export * from './editorDecorations';
export * from './editorHovers';
