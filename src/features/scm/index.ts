// The Source Control module's facade: the module's public surface under one import path —
// cross-feature imports resolve here (plan §5.3); the module's own files reach each
// other directly.

export * from './view';

import { SourceControlView } from './view';
import { commitInputMethods } from './commitInput';
import { groupsMethods } from './groups';
import { rowActionsMethods } from './rowActions';
import { menusMethods } from './menus';

Object.assign(SourceControlView.prototype, commitInputMethods, groupsMethods, rowActionsMethods, menusMethods);
export * from './gitCommands';
export * from './fileHistory';
export type { BlameLine } from './types';
