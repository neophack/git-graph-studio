// The @antv/G6 stand-in for the jsdom suites (module 17): jsdom has no canvas, so the
// drawing's library is stubbed with a Graph that records its construction, its data and
// its event handlers — the analysis tests drive those to verify the page's mapping, and
// every suite that can mount the page is spared loading the real (heavy) library.

export class Graph {
	readonly options: Record<string, unknown>;
	readonly handlers = new Map<string, ((event: unknown) => void)[]>();
	rendered = 0;
	destroyed = false;

	constructor(options: Record<string, unknown>) {
		this.options = options;
		created.push(this);
	}

	on(name: string, handler: (event: unknown) => void): void {
		const list = this.handlers.get(name) ?? [];
		list.push(handler);
		this.handlers.set(name, list);
	}

	/** Fire a recorded event the way the page's handlers expect it. */
	emit(name: string, event: unknown): void {
		for (const handler of this.handlers.get(name) ?? []) handler(event);
	}

	async render(): Promise<void> {
		this.rendered++;
	}

	async layout(): Promise<void> {
		/* the layout is recorded through options.layout */
	}

	setLayout(layout: unknown): void {
		this.options.layout = layout;
	}

	async fitView(): Promise<void> {
		/* nothing to fit without a canvas */
	}

	resize(): void {
		/* no canvas to re-measure */
	}

	destroy(): void {
		this.destroyed = true;
	}
}

/** Every Graph the stubbed pages created, oldest first — tests grab the last. */
export const created: Graph[] = [];
