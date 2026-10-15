// Rebuilds node-host.cjs without running the whole prepare (dev loop helper). The vite
// lib-mode config is the one prepare.mjs's step 3½ runs (node-host-bundle.mjs).
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNodeHost } from "./node-host-bundle.mjs";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
await buildNodeHost(appDir, join(appDir, "target", "studio"));
console.log("node-host.cjs rebuilt");
