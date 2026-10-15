// The extension host's assembly: the class shell (extensionHost.ts) plus every
// concern's methods assigned onto the prototype. Importing this module wires the
// host; the public surface is the same single-file extHost.ts once exported.

import { ExtensionHost } from './extensionHost';
import { framesMethods } from './frames';
import { storeMethods } from './store';
import { activationMethods } from './activation';
import { dispatchMethods } from './dispatch';
import { pagesMethods } from './pages';
import { builtinCommandsMethods } from './builtinCommands';
import { webviewsMethods } from './webviews';
import { claudeMethods } from './claude';
import { statusItemsMethods } from './statusItems';
import { outputChannelsMethods } from './outputChannels';
import { treeViewsMethods } from './treeViews';
import { providersMethods } from './providers';
import { hostRequestsMethods } from './hostRequests';
import { pushesMethods } from './pushes';

Object.assign(
	ExtensionHost.prototype,
	framesMethods,
	storeMethods,
	activationMethods,
	dispatchMethods,
	pagesMethods,
	builtinCommandsMethods,
	webviewsMethods,
	claudeMethods,
	statusItemsMethods,
	outputChannelsMethods,
	treeViewsMethods,
	providersMethods,
	hostRequestsMethods,
	pushesMethods
);

export * from './extensionHost';
export { HOST_REQUEST_EVENT, HOST_STATE_EVENT, BACKEND_RESTARTED_EVENT } from './extensionHost';
export { type ActivationPolicy, type PageDiffRequest, type PageTheme, type ExtStatusBarItem, type FormatterSelector, EXT_HOST_LOG_OWNER } from './sharedTypes';
export { extIconRelPath, extTitle, MARKETPLACE_URL } from './store';
export { ACTIVATION_TIMEOUT, parseActivationPolicy } from './activation';
export { extAssetBase, extAssetUrl, themeVars } from './pages';
export { localizeAssetRoots } from './webviews';
export { claudePageMessage, claudeTapKind } from './claude';
export { formatterScore } from './providers';
