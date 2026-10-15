// The Editor Suite module's facade: the module's public surface under one import path —
// cross-feature imports resolve here (plan §5.3); the module's own files reach each
// other directly.

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
export * from './textEditor';
export * from './comments';
export * from './docEditView';
export * from './docFind';
export * from './editorExtras';
export * from './autocomplete';
export * from './snippetRegistry';
export * from './findWidget';
export * from './bookmarks';
export * from './cmTheme';
export * from './types';
export * from './editorCompletions';
export * from './editorDecorations';
export * from './editorDecorationsView';
export * from './editorHovers';
export * from './editorProviderViews';
export * from './editorDiagnosticsView';
