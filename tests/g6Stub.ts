// The @antv/g6 stand-in for the jsdom suites (module 5): the engine is canvas-based and
// jsdom cannot run it, so the module is stubbed with a Graph that keeps the same data
// API the page drives — addNodeData / removeNodeData / updateNodeData / addEdgeData /
// removeEdgeData over plain records, the event registry (`on` / tests `emit`), the
// viewport calls (render / fitView / translateTo / getSize / getCanvasByClient) and
// destroy — so the page's binding and interaction tests drive real state. The suites
// that mount the graph are spared loading the real (heavy) library.

export interface StubNode {
	id: string;
	style?: Record<string, unknown>;
}

export interface StubEdge {
	id: string;
	source: string;
	target: string;
	style?: Record<string, unknown>;
}

export class Graph {
	static instances: Graph[] = [];

	nodeData: StubNode[] = [];

	edgeData: StubEdge[] = [];

	readonly listeners = new Map<string, ((event: unknown) => void)[]>();

	destroyed = false;

	fitted = 0;

	rendered = 0;

	translates: [number, number][] = [];

	constructor(public readonly options: Record<string, unknown>) {
		Graph.instances.push(this);
	}

	addNodeData(data: StubNode[]): void {
		this.nodeData.push(...data);
	}

	removeNodeData(ids: string[]): void {
		this.nodeData = this.nodeData.filter((node) => !ids.includes(String(node.id)));
	}

	updateNodeData(data: Partial<StubNode>[]): void {
		for (const patch of data) {
			const node = this.nodeData.find((candidate) => String(candidate.id) === String(patch.id));
			if (node) node.style = { ...node.style, ...(patch.style ?? {}) };
		}
	}

	getNodeData(): StubNode[] {
		return this.nodeData;
	}

	addEdgeData(data: StubEdge[]): void {
		this.edgeData.push(...data);
	}

	removeEdgeData(ids: string[]): void {
		this.edgeData = this.edgeData.filter((edge) => !ids.includes(String(edge.id)));
	}

	getEdgeData(): StubEdge[] {
		return this.edgeData;
	}

	on(type: string, listener: (event: unknown) => void): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	/** Drive the page's own handlers from the tests. */
	emit(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}

	async render(): Promise<void> {
		this.rendered++;
	}

	drawn = 0;

	async draw(): Promise<void> {
		this.drawn++;
	}

	async fitView(): Promise<void> {
		this.fitted++;
	}

	async translateTo(position: [number, number]): Promise<void> {
		this.translates.push(position);
	}

	getSize(): [number, number] {
		return [600, 300];
	}

	getCanvasByClient(point: [number, number]): [number, number] {
		return point;
	}

	destroy(): void {
		this.destroyed = true;
	}
}

export const instances = Graph.instances;

/** Reset the instance registry (each test mounts its own view). */
export function reset(): void {
	Graph.instances.length = 0;
}
