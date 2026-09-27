// Rewrites the webview-rendered check to attach to CDP iframe targets directly.
import { readFileSync, writeFileSync } from "node:fs";

const p = "scripts/probes/claude-code-live-check.mjs";
let s = readFileSync(p, "utf8");

const start = s.indexOf("\t/* 4. The chat webview rendered:");
const endMarker = "\tcheck('the claude-code chat webview rendered', webviewOk, webviewDetail);";
const end = s.indexOf(endMarker);
if (start < 0 || end < 0) throw new Error("block markers miss");

const replacement = [
	"\t/* 4. The chat webview rendered: a ggs:// webview frame target exists, and claude's",
	"\t * own webview bundle actually booted inside it (its root element is in the DOM). */",
	"\tconst frameTargets = (await targets()).filter((target) => target.type === 'iframe');",
	"\tlet webviewOk = false;",
	'\tlet webviewDetail = ">no iframe targets<";',
	"\tfor (const view of frameTargets) {",
	"\t\ttry {",
	"\t\t\tconst viewSession = await session(view);",
	'\t\t\tconst probe = await viewSession.evaluate(\'(() => ({ url: location.href.slice(0, 60), title: document.title.slice(0, 40), root: Boolean(document.querySelector("#root, #app")), children: document.body ? document.body.childElementCount : 0 }))()\');',
	'\t\t\twebviewDetail = JSON.stringify(probe).slice(0, 140);',
	"\t\t\tif (/ggs:/i.test(probe.url) && probe.root && probe.children > 0) { webviewOk = true; }",
	"\t\t\tviewSession.close();",
	"\t\t\tif (webviewOk) break;",
	"\t\t} catch { /* frames that refuse evaluation are skipped */ }",
	"\t}",
	"\tcheck('the claude-code chat webview rendered', webviewOk, webviewDetail);",
].join("\n");

s = s.slice(0, start) + replacement + s.slice(end + endMarker.length);
writeFileSync(p, s);
console.log("webview check rewritten");
