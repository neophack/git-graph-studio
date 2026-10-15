// The viewer classes' public types: the editor suite imports them type-only (the classes
// themselves load lazily through platform/lazy), so the shapes live beside nothing.
export type FastView = import('./fastView').FastView;
export type HexView = import('./hexView').HexView;
export type HexCompareView = import('./hexCompare').HexCompareView;
