// The relations window's opener, registered once by the workbench: the hover card's
// footer asks for it here instead of threading a callback through every editor mount —
// the same shape the extension definition opener rides. A window that never registers
// (the tests' bare pages) answers null and the card's button stays inert.

export type HoverRelationsOpener = (sym: { kind: string; name: string; path: string; line: number }) => void;

let opener: HoverRelationsOpener | null = null;

export function setHoverRelationsOpener(fn: HoverRelationsOpener | null): void {
	opener = fn;
}

export function hoverRelationsOpener(): HoverRelationsOpener | null {
	return opener;
}
