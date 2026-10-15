// The workbench module's facade: the Workbench class shell (workbench.ts) plus every
// concern's methods assigned onto the prototype. Importing this module wires the
// workbench; consumers import the directory (main.ts's dynamic chunk entry).

export * from './workbench';

import { Workbench } from './workbench';
import { layoutMethods } from './layout';
import { menusMethods } from './menus';
import { bootMethods } from './boot';
import { lifecycleMethods } from './lifecycle';

Object.assign(Workbench.prototype, layoutMethods, menusMethods, bootMethods, lifecycleMethods);
