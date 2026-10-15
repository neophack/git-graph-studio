// The extension status bar items and their push to the status bar.

import type { ExtensionHost } from './extensionHost';




/** The output channel the extension host log writes to (`extLog.ts`). */

/** The statusItems concern of ExtensionHost — assigned onto the prototype by host/index.ts. */
export const statusItemsMethods: ThisType<ExtensionHost> = {
	emitStatusBarItems(): void {
		this.onStatusBarItems?.([...this.statusItems.values()]);
	},
};
