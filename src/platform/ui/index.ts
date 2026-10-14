// The UI kit's facade: every building block the workbench's views are drawn with, under the
// original export names (the 55 importers of the old src/ui.ts only changed their path).
// Platform is a leaf layer — nothing here imports features/, workbench/, hosts/ or remote/.

export * from './dom';
export * from './codicon';
export * from './notify';
export * from './progress';
export * from './contextMenu';
export * from './quickInput';
