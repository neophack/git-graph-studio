# Module Analysis 图表分包计划（mermaid 5.5 MB → 约 2.6 MB）

> **实施状态（2026-10-15）**：已实施并实测（第 4 节的 1–6 全过；7、8 的实机检查
> 待跑——本轮环境无法启动 GUI）。主构建 `diagram-closure.json` total **2 744 771 B
> （2.62 MiB，15 个 chunk）**，远程构建 2 719 018 B；基线 5 527 419 B 单块 +
> xterm 293 KB。闭包构成：elk 1 405 KB + mermaid.core 572 KB + layout-elk 渲染
> 521 KB + transform 91 KB + flowDiagram 63 KB + 其余小块；cytoscape / katex /
> sequence 等其余图表 chunk 均不在闭包内。`from"./xterm-` 的静态导入者两个构建
> 都为 **0 个**（终端路径走动态导入，连"只剩终端路径"都好于预期）；cjs-helpers
> 单独成块（236 B，消费方 6 个）。first-paint 与 HEAD 基线逐字节一致（846 205 B、
> 同 8 个 chunk）；主构建资产总量 9.17 MB（基线 8.81 MB——"总字节数不变，只是
> 拆开"成立；metrics 里 17.30 MB 是主 + remote 两棵树）。第 6 节的结构性断言
> **已加上**（`diagramClosurePlugin` 构建期失败：闭包出现 xterm / codemirror /
> cm-merge / cm-language-data / tauri / msgpack 命名 chunk 即失败；触发路径已实测——
> 临时把 elk 加进黑名单，构建按预期失败并点名闭包中的两个 chunk，随后还原）。`typecheck`、`npm test`（74 文件
> 1151 用例）全过。待办：`npx tauri dev` 与 `npx tauri build` 实机验证第 7、8 条
> （Network 面板确认只加载闭包内 chunk），以及 owner 对断言去留的最终确认。

> 归属：模块 15（Build & Release Pipeline）的分包配置；受益方为模块 17（Code Analysis）
> 的 Module Analysis 绘图。基线是 2026-10-14 `target/studio/dist` 的正式构建。
> 本文的"预期"都要靠第 4 节的实测来验收（AGENTS.md：用数字说话，不用形容词）。
> 范围只限分包，不碰渲染器、布局和外观：mermaid、ELK、gitdiagram 配置都原样保留。

## 1. 现状

| 产物 | 大小 | 说明 |
| --- | --- | --- |
| `mermaid-*.js` | 5 527 419 B（5.3 MiB） | 首次画图时一次性加载，dist 中最大的文件 |
| 其中实际用到的 | 约 2.6 MiB | flowchart + mermaid core + ELK 布局（见 1.2） |

### 1.1 原因一：`manualChunks` 把 mermaid 的按需拆分合并回了一个文件

`vite.config.ts:80`（`vite.remote.config.ts:63` 同样如此）：

```ts
if (id.includes('node_modules/mermaid/') || id.includes('node_modules/@mermaid-js/') || id.includes('node_modules/elkjs/')) return 'mermaid';
```

mermaid 12 的 ESM 发行版（`dist/mermaid.core.mjs` + `dist/chunks/mermaid.core/`，134 个文件）
把每种图表类型（sequence、gantt、mindmap、c4、architecture、cynefin、usecase、swimlanes……）
以及它们的重依赖（cytoscape 434 KiB、katex 256 KiB……）都做成了 `import()` 按需加载。
上面这条规则把所有模块强制塞进同一个 chunk，动态导入因此全部失效：只画一张
`flowchart TD`，却要把所有图表类型一起下载、解析。

### 1.2 实验：只去掉 mermaid 的强制分组

实验构建（scratch 配置，只把 mermaid / @mermaid-js 的规则改为 `undefined`，elkjs 单独
保留为 `elk`），按 chunk 的静态导入图计算"画一张 Module Analysis 图"实际加载的闭包：

| chunk | 大小 |
| --- | --- |
| `elk-*`（elkjs，GWT 编译产物） | 1 438 647 B |
| `mermaid.core-*` | 589 258 B |
| `elk-NQ2RJTNK-*`（@mermaid-js/layout-elk 的渲染部分） | 533 482 B |
| `xterm-*` ⚠ 不该出现，见 1.3 | 292 999 B |
| `transform-*`、`flowDiagram-*` 及其余小 chunk | 约 185 KB |
| **合计** | **3 039 232 B；去掉 xterm 后约 2 746 000 B（≈2.6 MiB）** |

其余图表类型都变成独立 chunk，永远不会被这个应用加载。

### 1.3 原因二：Rollup 的 CommonJS 辅助模块落进了 xterm chunk

`\0commonjsHelpers.js`（`getDefaultExportFromCjs` 等）是 `@rollup/plugin-commonjs` 生成的
虚拟模块，它的 id 不含 `node_modules/`，不会命中任何 `manualChunks` 规则。xterm（CJS 包）
最先引用它，Rollup 就把它挂进了 `xterm` 这个手工 chunk。

- **当前正式构建已经受影响**：`mermaid-*.js` 执行了
  `import{g as …,c as …}from"./xterm-*.js"`，也就是说第一次画图就会顺带加载 293 KB 的终端模拟器。
- 去掉 mermaid 的强制分组后，问题放大成 48 个 chunk 都从 `xterm-*` 导入。

## 2. 改动

两处 `manualChunks`（`vite.config.ts`、`vite.remote.config.ts`）同步修改：

1. **删掉 mermaid 的强制分组**，交还给 mermaid 自己的动态导入拆分：
   ```ts
   // mermaid ships one lazily imported chunk per diagram type; grouping it by hand
   // collapses all of them into the first render. Only the ELK engine is named.
   if (id.includes('node_modules/elkjs/')) return 'elk';
   ```
   `@mermaid-js/layout-elk` 不单独命名，让 Rollup 按它自己的 `import()` 拆分。
2. **给 CommonJS 辅助模块单独分组**，和现有的 `preload` 规则同一个道理（放在 xterm 规则之前）：
   ```ts
   // Rollup's CommonJS interop helpers: on their own, or they land in whichever manual
   // chunk first imports them (xterm) and every CJS consumer then pulls that chunk in.
   if (id.includes('commonjsHelpers')) return 'cjs-helpers';
   ```
3. 改写 `manualChunks` 上方 mermaid 那条注释，说明为什么只命名 elk。

`src/moduleDiagram.ts` 不需要改：它本来就用 `import('mermaid')` 和
`import('@mermaid-js/layout-elk')` 懒加载。

## 3. 测量：把"画图闭包"记进 metrics

参照 `firstPaintPlugin`（`vite.config.ts`）加一个同类记录，避免下次退化时没人发现：

- 在 `generateBundle` 里，以携带下列模块的 chunk 为根，沿 `imports`（静态）遍历：
  `mermaid/dist/mermaid.core.mjs`、`@mermaid-js/layout-elk` 的入口、mermaid 的
  `flowDiagram-*.mjs`，以及 layout-elk 动态导入的渲染 chunk。具体 module id 在实现时从
  bundle 的 `moduleIds` 里确认，根的选取写进注释。
- 输出 `dist/diagram-closure.json`（结构与 `first-paint.json` 一致：`total` + `chunks`）。
- `scripts/measure.mjs` 读取它，写进 `metrics.json` 的 `sizes.diagramJs`，打印方式与
  first-paint 一样。
- 按原则 6 只记录不设门槛。唯一的**结构性**断言：闭包里不得出现 `xterm`、`codemirror`、
  `cm-*` 这类无关的命名 chunk，出现就让构建失败。这是"不该加载的东西被加载了"的
  正确性检查，不是体积预算；是否加这条断言由 owner 决定，见第 6 节。

## 4. 验收

| # | 检查 | 期望 |
| --- | --- | --- |
| 1 | `npx vite build` 后的 `diagram-closure.json` 的 `total` | ≈2.6 MiB（基线 5.3 MiB + xterm 0.28 MiB） |
| 2 | `grep -l 'from"./xterm-' target/studio/dist/assets/*.js` | 只剩终端路径上的 chunk（实现时逐个确认），不再有任何 mermaid / 图表 chunk |
| 3 | `diagram-closure.json` 的 chunk 列表 | 不含 `cytoscape`、`katex`、`sequenceDiagram` 等其他图表类型的 chunk（它们只在动态导入里出现） |
| 4 | `first-paint.json` | 与基线相同（这次改动不应碰首屏） |
| 5 | 远程构建 `target/studio/dist/remote/` | 1–3 同样成立；`tests/remote.test.ts` 的 first-paint 资源选取不受影响 |
| 6 | `npm run typecheck`、`npm test` | 通过（`tests/analysis.test.ts` 用 stub 替换了 mermaid，不受分包影响） |
| 7 | `npx tauri dev` 实机：打开 Module Analysis（整个工作区 + 资源管理器里选文件夹各一次），切换明暗主题 | 图正常绘制，DevTools Network 里只有闭包内的 chunk，没有 xterm、cytoscape、katex |
| 8 | `npx tauri build` 后的打包版重复第 7 条 | 同上（`tauri://` 协议下的懒加载路径和 dev 不同，必须单独验） |

第 7、8 条是 AGENTS.md 的"打包回归要在 `tauri dev` 下排除"，这次改的是
`prepare`/Vite 产物，属于必须实测的范围。

## 5. 影响与风险

- **外观和行为**：不变。渲染器、ELK 配置、gitdiagram 的 classDef 都没碰。
- **dist 文件数**：增加约 130 个（mermaid 的各图表 chunk）。总字节数基本不变，只是拆开了。
  Tauri 把资源嵌进二进制，安装包大小基本不变；远程 Service Worker 按需缓存，不会预取。
- **加载往返**：首次画图从 1 个请求变成约 15 个。本地 `tauri://` 协议下可以忽略；远程经
  Hub 时 HTTP/2 多路复用，影响也很小。用第 7、8 条的实测确认。
- **mermaid 升级**：内部 chunk 名带 hash（如 `flowDiagram-KWPJA3E3`）。第 3 节的根选取要按
  模块路径模式匹配，不能写死文件名。
- **回滚**：恢复一行 `manualChunks` 规则即可。

## 6. 待 owner 决定

1. 第 3 节的结构性断言（画图闭包里出现无关命名 chunk 就让构建失败）要不要加。不加的话，
   这个检查只作为 `measure.mjs` 的报告项。
2. 后续是否继续瘦身（不在本计划范围内）：剩下的 2.6 MiB 里有 1.9 MiB 是 ELK
   （elkjs + layout-elk）。如果要再降，可以去掉 mermaid，直接用 elkjs + 手写 SVG
   （约 1.4 MiB，布局不变）；改用 dagre 会让布局质量明显下降，不建议。这两条都属于模块 17
   的架构变更，需要单独立项。

## 7. 文档同步

- AGENTS.md 模块 15 的 Assets 条目：补一句"图表分包交给 mermaid 自己的动态导入，只有 elkjs
  和 CommonJS 辅助模块是命名 chunk"，并说明 `diagram-closure.json` 的用途。
- AGENTS.md 模块 14：`measure.mjs` 新增的 `sizes.diagramJs` 记录项。
- 本文在实施后补上"实施状态"和实测数字（参照 `ci-speed-plan.md` 的格式）。
