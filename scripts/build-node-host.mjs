// Rebuilds node-host.cjs without running the whole prepare (dev loop helper).
import { readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(appDir, "target", "studio");

const { build } = await import("vite");
await build({
	configFile: false,
	logLevel: "warn",
	build: {
		outDir: join(out, "bundled", "app-resources"),
		emptyOutDir: false,
		minify: false,
		sourcemap: false,
		target: "node20",
		lib: {
			entry: join(appDir, "src", "nodeHost.ts"),
			formats: ["cjs"],
			fileName: () => "node-host.cjs",
		},
		rollupOptions: { external: [/^node:/] },
	},
});

mkdirSync(join(out, "."), { recursive: true });
copyFileSync(join(out, "bundled", "app-resources", "node-host.cjs"), join(out, "node-host.cjs"));
console.log("node-host.cjs rebuilt");
