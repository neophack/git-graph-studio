// The mermaid stand-in for the jsdom suites (module 17): jsdom cannot run ELK or
// measure text, so the renderer is stubbed with one that parses the mermaid source
// the page hands it and emits mermaid's own element shapes — `g.node` with
// `flowchart-N<index>-<n>` ids, edge elements with `L_N<from>_N<to>` ids, clusters
// and a viewBox — so the page's binding and interaction tests drive real DOM. The
// suites that can mount the page are spared loading the real (heavy) library.

export interface RenderCall {
	id: string;
	/** The mermaid source mermaid.render received — tests assert on it. */
	text: string;
}

const calls: RenderCall[] = [];

/** Every initialize() the pages made — the config-parity assertions read these. */
const initializations: Record<string, unknown>[] = [];

/** Parse the flowchart source into mermaid's element shapes. */
function fakeSvg(text: string): string {
	const nodes: string[] = [];
	const edges: string[] = [];
	const clusters: string[] = [];
	for (const line of text.split('\n')) {
		const node = /^\s*N(\d+)\["([^"]*)"\]\s*$/.exec(line);
		if (node) {
			nodes.push(
				`<g class="node default" id="flowchart-N${node[1]}-0"><rect class="basic label-container" rx="5" ry="5"></rect><g class="label"><text>${node[2]}</text></g></g>`
			);
			continue;
		}
		const edge = /^\s*N(\d+) (-->|-\.->)\|"?([^"|]*)"?\|? N(\d+)\s*$/.exec(line);
		if (edge) {
			const id = `L_N${edge[1]}_N${edge[4]}_0`;
			edges.push(
				`<g class="edgePaths"><path class="edge-thickness-normal" id="${id}" d="M0 0 L100 100"></path></g>`,
				`<g class="edgeLabels"><g class="edgeLabel" id="${id}" data-id="${id}"><g class="label"><text>${edge[3]}</text></g></g></g>`
			);
			continue;
		}
		const cluster = /^\s*subgraph G\d+\["([^"]*)"\]\s*$/.exec(line);
		if (cluster) clusters.push(`<g class="cluster"><text>${cluster[1]}</text></g>`);
	}
	return (
		`<svg id="mermaid-stub" viewBox="0 0 600 400" xmlns="http://www.w3.org/2000/svg">` +
		`<style>.t0{fill:#dbeafe}</style>` +
		clusters.join('') +
		nodes.join('') +
		edges.join('') +
		`</svg>`
	);
}

const mermaid = {
	registerLayoutLoaders: async (): Promise<void> => {
		/* the stub lays nothing out — the ids it mints are the contract */
	},
	initialize: (config: Record<string, unknown>): void => {
		initializations.push(config);
	},
	render: async (id: string, text: string): Promise<{ svg: string }> => {
		calls.push({ id, text });
		return { svg: fakeSvg(text) };
	}
};

export default mermaid;

/** Every render the stubbed pages made, oldest first. */
export { calls as rendered, initializations };
