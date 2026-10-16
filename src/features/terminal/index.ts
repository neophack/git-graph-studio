// The Integrated Terminal module's facade: the module's public surface under one import path —
// cross-feature imports resolve here (plan §5.3); the module's own files reach each
// other directly.

export * from './terminal';
export * from './outputFollow';
