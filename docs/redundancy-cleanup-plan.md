# 代码冗余清理与待优化项计划

> 状态:**执行中**(2026-10-15 启动)。已落地:P1 全部(§2.1–§2.5,`tsc --noUnusedLocals`
> 1492 → 0)、P5-a 护栏全部(`noUnusedLocals` 进 tsconfig、未用依赖扫描进 check-crate-graph、
> `scripts/check-doc-paths.mjs` 进 check-seams)、P4-a 文档修正(28 条路径、重复的 ggs-config
> 节、两段退役机制史压缩)、**P2-TS 全部(§3.2 T1–T12,2026-10-15)**。§2.5 的两个
> probe(claude-code-compat / ui-interaction-check)按 §9 待 owner 决定,未动。
> P2-Rust / P3 / P4-b / §4.6 未开始。
> P2-TS 验收:`npm run typecheck`(含 e2e)、`npm test`(1164 用例)、
> `node scripts/check-seams.mjs` 全部通过(2026-10-15)。T8(Relay/Transport 头部
> 常量)经复核为测量假阳性——"重复"的行是两个文件各自的多行 import 清单(测量法只
> 排除以 `import ` 开头的行),协议常量本就集中在 `frame.ts` 一处,无需合并;T7 的
> viewerBoot `el` 裁决为有意隔离(镜像页不运行工作台,签名不同),已加注释说明。
> 原始验收基线(2026-10-15,`c4d63aa`):`cargo test --workspace --all-features`
> (45 套件)、`cargo clippy --all-targets --all-features -- -D warnings` 亦全绿
> (与一条并行的 remote 开发线共享同一棵工作树);P2-TS 无 Rust 改动,未重跑。
>
> 与 [architecture-restructure-plan.md](architecture-restructure-plan.md) 的关系：重整计划
> P0–P6 已基本落地（crate 拆分、目录归位、拆大文件）。本计划处理的是**落地后留下的冗余**：
> 拆文件时"只移动"原则带来的导入残留、跨 crate 的重复实现、过期文档路径，以及几项
> 可量化的优化。重整计划仍未完成的 P6-4（A/B 复测）、P6-5、P6-6 不在这里重复，
> 只在 §5 说明本计划如何与 P6-6 衔接。
>
> 本文所有数字都是 2026-10-15 在 `c4d63aa` 上用 §1.0 的命令实测得到的。验收时用同样的命令复测
> （AGENTS.md：数字，不是形容词）。

## 目录

0. [一句话](#0-一句话)
1. [现状（实测）](#1-现状实测)
2. [P1：零风险删除](#2-p1零风险删除)
3. [P2：合并重复实现](#3-p2合并重复实现)
4. [P3：待优化项](#4-p3待优化项)
5. [P4：文档冗余](#5-p4文档冗余)
6. [P5：防回归护栏](#6-p5防回归护栏)
7. [执行顺序与工期](#7-执行顺序与工期)
8. [不做的事](#8-不做的事)
9. [待 owner 决定](#9-待-owner-决定)
10. [验收](#10-验收)

## 0. 一句话

当前最大的冗余来自 P5 拆文件：原文件的整段 import 被原样复制进每个关注点文件，现在有
**1 492 条未使用符号诊断**。其次是同一种算法在不同 crate 里各写一份：base64、glob、
Hub 隧道协议、git 测试辅助。第三是 AGENTS.md：它有 178 KB，每次 agent 会话都要加载，
里面有 28 条已经不存在的路径，还有一整节内容重复出现了两次。
真正的死代码不多（TS 15 个导出、Rust 14 个 `pub` 项）。多数清理可以机械地完成，
做完后要立即加上护栏，防止回退。

## 1. 现状（实测）

### 1.0 测量方法

| 指标 | 命令 / 方法 |
| ---- | ----------- |
| TS 未使用符号 | `npx tsc --noEmit --noUnusedLocals`（只统计，不改 tsconfig） |
| TS 未引用导出 | 脚本：`src/**/*.ts` 中每个 `export` 名，在 `src`/`tests`/`dev`/`scripts`/入口 HTML 中按词边界搜索 |
| 重复代码块 | 脚本：去掉空行、注释、`use`/`import` 和单独括号行后，按 8 行窗口做哈希，合并连续命中 |
| Rust 未引用 `pub` | 脚本：`pub fn/struct/enum/const/...` 名在整个仓库（含 `extensions-src/`）中按词搜索 |
| Rust 未用依赖 | 每个 `Cargo.toml` 的 `[dependencies]` 名在该 crate 源码中搜索（启发式，需编译确认） |
| 包体 | `target/studio/metrics.json` 与 `target/studio/dist/assets/` 实际文件 |

P5-1 会把这三个脚本整理后放进 `scripts/`（§6），让复测可重复。

### 1.1 TypeScript

| 项 | 数量 | 说明 |
| -- | ---- | ---- |
| `noUnusedLocals` 诊断 | **1 492** | 357 条是整条 import 声明未用（TS6192），28 条是未用类型，其余是单个导入名 |
| 其中非 import 的未用声明 | 12 | 见 §2.2 |
| 未用参数（`noUnusedParameters` 额外） | ~14 | |
| 完全无人引用的导出 | 15 | 11 个在 `remote/tauriShim/`（有意镜像 Tauri API，保留），4 个是真死代码 |
| 只在本文件使用的导出 | 186 | 可以去掉 `export`，优先级低 |
| 重复代码块（≥8 行） | 23 组，约 300 行 | 见 §3.2 |
| `tests/*.ts` 未纳入 typecheck | 29 455 行 | `tsconfig.json` 只 include `src`，`tsconfig.e2e.json` 只 include `tests/e2e`；单独检查有 279 个错误 |

未用 import 集中在 P5 拆出的文件里，按文件计：

| 文件组 | 诊断数 |
| ------ | ------ |
| `features/extensions/host/*`（16 个文件） | 677 |
| `features/editor/*`（拆出的 9 个文件） | 380 |
| `workbench/{boot,lifecycle,menus,layout,workbench}.ts` | 262 |
| `features/scm/{view,commitInput,groups,rowActions,menus}.ts` | 122 |
| `hosts/nodeShims/*` | 59 |
| 其余 | 25 |

这些多余的 import 不只是噪音。`scripts/check-seams.mjs` 的 TS 依赖图（R1–R10）把它们
都当成真实的边来计算，所以真实的耦合被掩盖了，一个模块的懒加载边界也可能被假边拖进
不该进的 chunk（见 §4.2）。

### 1.2 Rust

| 项 | 数量 | 说明 |
| -- | ---- | ---- |
| 完全无人引用的 `pub` 项 | 14 | 见 §2.3 |
| 只在本文件使用的 `pub` 项 | 164 | 可降为 `pub(crate)`/私有，优先级低 |
| 重复代码块（≥8 行，含测试） | 56 组，约 770 行 | 其中一半以上在 `ggs-node/tests/it/*.rs` |
| 根 crate 声明但未使用的依赖 | 6 + 1 | `getrandom` `ignore` `flate2` `rmp-serde` `serde_bytes` `rpassword` 零引用；`zip` 只在测试里用 |
| 疑似未用依赖（子 crate） | 2 | `ggs-git → serde_json`、`ggs-providers → hex` |
| 同一算法的多份实现 | 见 §3.1 | base64 ×4、VS Code glob ×2、SHA-1/SHA-256 ×2（自研 + crates.io）、Hub 协议 ×2、git 测试辅助 ×3 |

### 1.3 包体（`target/studio/dist`，Windows，2026-10-15）

| 项 | 字节 |
| -- | ---- |
| `dist/assets` 合计 | 9.3 MiB（225 个文件） |
| 首屏 JS | 846 205（codemirror 430 008 + main 365 746 + …） |
| Module Analysis 画图闭包 | 2 744 771 |
| **mermaid 中从不加载的图类型 chunk** | **2 490 858（26 个文件）** |

应用只画 `flowchart`，但 cynefin（690 KB）、cytoscape（444 KB）、katex（261 KB）、
usecase、architecture、sequence、gantt 等图类型的 chunk 都被打进了安装包。它们按需加载，
不影响运行时，但每份安装包都多带了约 2.4 MiB。

### 1.4 文档

| 项 | 实测 |
| -- | ---- |
| AGENTS.md 大小 | 177 771 字节（每次 agent 会话都加载） |
| AGENTS.md 中已不存在的路径 | 28 条，例如 `src-tauri/src/ggs_bash/`、`src-tauri/src/git.rs`、`src-tauri/src/node_runtime/`、`src-tauri/src/ext_protocol.rs`、`src/features/editor/editor.ts`、`src/features/extensions/extHost.ts`、`src/findOptions.ts`、`tests/it/node_runtime.rs` |
| 重复段落 | 模块 19 中 **`ggs-config`** 一节出现两次（第 1591 行与第 1899 行） |
| 追溯式叙述 | 大量 "2026-09-xx, the owner's direction…" 的历史背景直接写在模块图里，与 git 历史重复 |

## 2. P1：零风险删除

这一阶段只做删除。删掉的代码在运行时都是死的，行为不变，`npm test` 和 `cargo test` 全程
保持绿色。

### 2.1 清掉 P5 拆分留下的未用 import（1 条 PR，按模块分提交）

- 用 `tsc --noUnusedLocals` 的诊断列表驱动删除：TS6192 删掉整条声明，TS6133/TS6196 删掉
  单个名字。可以写一个一次性脚本按诊断位置改写；只要 import 子句里没有副作用导入
  （`import './x.css'`），改写就是机械的。
- **副作用导入一律不动**。`import '…'` 不带名字的形式 tsc 不会报告，不受影响。
- 按 §1.1 的分组分 5 个提交：extensions/host → editor → workbench → scm → nodeShims+其余。
- 每个提交后检查：`npm run typecheck`、`npm test`、`node scripts/check-seams.mjs`。
  check-seams 的 allowlist 应该只会变短，不会变长。
- 用 `npm run build:vite` 对比 `first-paint.json` 和 chunk 清单，确认没有 chunk 意外变大。
  预期是不变或变小。

### 2.2 TS 真死代码（12 处声明 + 4 个导出）

| 位置 | 名字 |
| ---- | ---- |
| `src/features/editor/inputs.ts:165` | `binCompareId` |
| `src/workbench/workbench.ts:994` | `compareTitle` |
| `src/features/search/callTree.ts:227` | 本地 `basename`（与 `platform/ui/dom.ts` 的同名函数重复） |
| `src/hosts/extHostBoot.ts:57,242` | `RpcResponse`、`binaries` |
| `src/features/analysis/analysisPages.ts:264` | `checkbox` 字段 |
| `src/features/viewers/fastView.ts:112` | `lineHeight` 字段 |
| `src/features/search/symbolDbView.ts:48` | `name` |
| `src/features/extensions/host/hostRequests.ts:328` | 解构中的 `diagExtId`（改为 `_`） |
| `src/features/providers/providersPage.ts:81`、`src/hosts/vscodeApi/treeViews.ts:79` | 未读的构造参数属性 |
| `src/features/selftest/selfTestPage.ts:12` | 未用导入 `registerSelfTests` |
| 导出 | `mergeEditor.ts` `resolutionRange`、`contributions.ts` `hasMenuItems`、`platform/ipc/fs.ts` `fsUploadOffset` / `fsWriteChunk` |

`fsUploadOffset` / `fsWriteChunk` 要先确认：`tests/ipcContract.test.ts` 是否按名字遍历
wrapper。如果契约测试需要它们，就保留；否则删除，后端命令只由 remote 路径使用。

### 2.3 Rust 真死代码（14 项）

| crate | 项 |
| ----- | -- |
| ggs-base `paths.rs` | `cache_home`、`extension_data`、`index_home` |
| ggs-git `runner.rs` | `is_safe_stash_selector`、`output_with_input`、`record_line`、`run_quietly` |
| ggs-index `symbols/parse.rs` | `supports` |
| ggs-node `lib.rs` | `link_napi_host` |
| ggs-remote-proto | `REPLY_CHUNK`（`MAX_CONTROL_MESSAGE` 被 daemon 使用，保留） |
| ggs-bash `regexlite.rs` | `group_count` |
| ggs-text `viewer/mod.rs` | `text_windows_read_plain_lines_and_cap`（确认是否为漏标 `#[test]` 的测试；如果是，要补上标记而不是删除） |
| app `state.rs` | `take_startup_actions` |

删除前在 `extensions-src/`（daemon/hub 有自己的 workspace）里再 `git grep -w` 一遍。

### 2.4 根 crate 的多余依赖

- 从 `src-tauri/Cargo.toml` 的 `[dependencies]` 中删除 `getrandom`、`ignore`、`flate2`、
  `rmp-serde`、`serde_bytes`、`rpassword`。它们在 `src-tauri/src/` 里零引用，实际使用者
  （ggs-fs、ggs-config、ggs-providers…）各自声明了依赖。
- `zip` 只在 `remote_host.rs` 的测试里使用，移到 `[dev-dependencies]`。
- 删除 `ggs-git → serde_json`、`ggs-providers → hex` 前先编译确认（启发式扫描可能漏掉宏里的用法）。
- 验收：`cargo build`、`cargo test --workspace --all-features`、clippy 都通过；
  `node scripts/measure-build.mjs` 的依赖计数不增加。

### 2.5 一次性脚本与死 i18n 键

- 删除 `scripts/rewrite-webview-check.mjs`：它是一次性的源码改写脚本，目标块已经改写完成，
  仓库里没有任何引用。
- `scripts/probes/claude-code-compat.mjs`、`scripts/probes/ui-interaction-check.mjs` 没有任何
  引用，也不在模块图里。两个选择：仍有用就登记进模块 14 / 12 的 probe 清单，否则删除。
  见 §9。
- i18n 中字面量从未出现的键，排除动态拼接的 `settings.*` / `*.applied.*` 后剩下：
  `extensions.pageMissing`、`extensions.marketplaceInstalled`、`quickopen.atMode`、
  `quickopen.hashMode`、`remote.switcher.noTabs`、`remote.editorToolbar.indent`、
  `setting.remote.{windowedOpenBytes,searchBatch,followDeviceTheme}`、
  `providers.usage.range.{today,week,month}`。逐个确认是否经模板字符串拼接
  （`providers.usage.range.*` 很可能是 `` `…range.${r}` `` 拼出来的），确认是死键后
  从 `en.ts` 和 `zh-cn.ts` 中同时删除。

## 3. P2：合并重复实现

### 3.1 Rust

| # | 重复 | 现状 | 目标 | 风险 |
| - | ---- | ---- | ---- | ---- |
| R1 | **base64** | 自研 3 份：`ggs-bash/applets.rs:4712`、`ggs-node/builtins/fs.rs:159`、`ggs-node/builtins/core.rs:230`（这一份包了 `base64` crate）；另外 ggs-ext / ggs-fs / ggs-node / ggs-providers / app 都依赖 `base64` crate | 在 `ggs-codec` 加 `base64` 模块（标准与 url-safe、宽松解码），ggs-bash 与 ggs-node 改用它，并沿用 P6-3 去掉 hash crate 的做法让侧车图去掉 `base64` crate；桌面侧是否也换掉见 §9 | 低。必须保留 ggs-bash 的 GNU 解码宽容度（忽略空白）和 Node 的 base64url 无填充语义，先写向量测试 |
| R2 | **SHA-1 / SHA-256 / hex** | `ggs-codec::hash` 已有自研实现，但 `sha1` crate 仍被 ggs-git / ggs-index / ggs-text 使用，`sha2` 被 app 的 `remote_host.rs` 使用，`hex` crate 被 4 个 crate 使用 | `ggs-codec` 补上流式接口（`Sha1::new/update/finalize -> [u8;20]`，P6-3 已经为 HMAC 抽出了流式核心）和字节输出接口，然后替换；`hex` 改用 `ggs_codec::hash::to_hex` | **中**。`ggs-index::compare`（文件夹比较）和符号库指纹对吞吐敏感，替换前后必须在 `tests/it/perf.rs` 与 `examples/` 上跑基准，变慢就保留 crate 版本（性能门槛不能为了去重而放宽，AGENTS.md「Do not weaken a sweep or budget test」） |
| R3 | **VS Code 风格 glob**（`*` `?` `**`） | `ggs-index/scan.rs:43`（Search 视图 include/exclude）与 `ggs-ext/fsapi.rs:85`（`workspace.findFiles`）语义相同，各写了一份 | 合并到 `ggs-base`（L0、无依赖），两边改为调用；`ggs-bash/glob.rs` 的 POSIX fnmatch 语义不同（`[...]`、隐藏文件规则），**不合并** | 低。先把两边的现有测试合并成一张表，同时跑新旧实现 |
| R4 | **Hub 隧道协议** | `daemon/src/hub/msg.rs` 与 `hub/src/msg.rs` 有 ~90 行逐字相同；WebSocket 帧编解码（`daemon/src/ws/frame.rs` vs `hub/src/frame.rs`）有 4 段共 ~45 行相同；`identity.rs` 的 uuid 校验相同 | 移进共享 crate：扩展 `ggs-remote-proto`，或者新建 `ggs-hub-proto`（如果 hub 不该看到 app↔daemon 的控制消息） | 中。两个独立 workspace 共用路径依赖；`remote-daemon-test` 与 `remote-hub-test` 两个 CI job 都要绿，`hub_link.rs` 端到端必须通过 |
| R5 | **git 测试辅助** | `src-tauri/src/test_git_helpers.rs`、`ggs-ext/src/test_git.rs`、ggs-git 自己的 `testkit_ext` 三份（各文件头注释都承认是复制品，原因是 dev-dependency 环） | 新建 dev-only crate `ggs-testkit-git`（依赖 `ggs-testkit` + `ggs-git`），app 和 ggs-ext 改用它；ggs-git 自己的测试因为环仍然保留一份。三份变一份半 | 低。按 `check-crate-graph` 的白名单登记 |
| R6 | 三条 DEFLATE 栈 | `flate2`(zlib-rs，ggs-can)、`zip` crate 的 deflate（ggs-ext / ggs-fs）、`ggs-codec::compress` 自研 inflate（ggs-bash / ggs-config） | **只评估，不强求**。ggs-can 只解压 BLF 的 zlib 块，可以评估改用 ggs-codec 的 inflate；先测 BLF 大文件的解析吞吐（`ggs-can` 已有大文件测试），变慢就不换 | 中 |
| R7 | crate 内部的重复段 | `cmd_providers.rs:157/187/304` 三段 ~17 行；`ggs-node/require.rs:524/632` ~31 行；`ggs-text/viewer/{mod,indexed}.rs` ~19 行；`ggs-index/symbols/store.rs:390/608`；`ggs-bash/applets.rs` 4 组 | 各自抽出局部辅助函数 | 低 |
| R8 | 测试代码重复 | `ggs-node/tests/it/node_runtime.rs` 里同一个 10 行启动样板出现 7 次，27 行样板出现 3 次 | 抽成 `fn spawn_runtime(..)` / `fn rpc(..)` 测试辅助 | 低 |

### 3.2 TypeScript

已全部落地(2026-10-15)。各条的落点:T1 `events.ts` 再导出 `shared.ts` 的一份;
T2 `features/viewers/hexShared.ts`(已登记进模块 7 的文件清单);T3 `platform/ui/dom.ts`
的 `formatBytes(count, { gb, iec, trim })` 按各调用方原拼写带参;T4 dom.ts 新增
Windows 盘符感知的 `parentOf`,remote 三文件改用 dom.ts 的 `joinPath`/`parentOf`;
T5 `remote/widgets.ts`(登记进模块 19);T6 保留 markdown.ts 的 `string | null` 版,
extAssets 只留 `extImageMime` 的 jpeg 兜底;T7 裁决为有意隔离,已加注释;T8 复核为
测量假阳性(见顶部状态),不合并;T9 `vscodeApi/index.ts` 的
`serveExtensionHostCall(tables, …)` 两个宿主共用;T10 六组各自抽局部辅助
(`webviewUriFor`/`webviewCspSource`、`promptTeardown`、`collectExisting`、
`resetFindState`、`confirmDiscardOne`+`discardChangesOf`、`findToggleChord`);
T11 `tests/helpers.ts` 的 `workbenchShell()` + `DefaultingHandlers`;T12
`scripts/node-host-bundle.mjs` 的 `buildNodeHost()`,prepare 与 dev 助手共用。

| # | 重复 | 位置 | 目标 |
| - | ---- | ---- | ---- |
| T1 | **EventEmitter ×2**（65 行逐字） | `hosts/nodeShims/events.ts:11` 与 `hosts/nodeShims/shared.ts:8` | 保留 `shared.ts` 那份（`Buffer` 等已在那里），`events.ts` 改为再导出 |
| T2 | hexView / hexCompare 共用段（5 组，约 80 行） | `features/viewers/hexView.ts` 与 `hexCompare.ts`（行渲染、偏移格式化、选区、滚动） | 抽 `features/viewers/hexShared.ts`，在模块 7 登记 |
| T3 | `formatBytes` ×4 | `can/canLogView.ts:119`、`viewers/hexView.ts:220`（已导出）、`remote/navDrawer.ts:36`、`remote/shell.ts:33` | 统一到 `platform/ui/dom.ts`（与 `basename`/`joinPath` 放在一起），先比对四份的单位与精度差异，有差异就带参数 |
| T4 | `joinPath` ×3、`parentOf` ×2、`basename` ×2 | `remote/remoteFilePicker.ts`、`remote/transfer.ts`、`remote/mirror/explorerTransfer.ts`、`search/callTree.ts` | 改用 `platform/ui/dom.ts` 的版本；`parentOf` 补进 dom.ts |
| T5 | `codicon` / `toggleSwitch` ×2 | `remote/navDrawer.ts` 与 `remote/settingsPage.ts` | `codicon` 改用 `platform/ui/codicon`；`toggleSwitch` 抽进 `remote/` 内的共享小文件 |
| T6 | `imageMime` ×2，签名不同 | `platform/extAssets.ts:9`（返回 string）与 `platform/markdown.ts:127`（返回 string \| null） | 保留一个 `string \| null` 版本，另一处加默认值 |
| T7 | `el` ×2 | `remote/mirror/viewerBoot.ts:17` | 先确认 viewer 是否故意不加载 ui 套件（它是无脚本沙箱帧的引导，可能有意隔离），确认是有意隔离就加注释说明，否则改用 `platform/ui/dom` |
| T8 | Relay / Transport 头部常量 | `remote/relay.ts:15` 与 `remote/transport.ts:12` 10 行相同 | 抽进 `remote/` 的协议常量文件 |
| T9 | 扩展宿主两份启动段 | `hosts/extHostBoot.ts:112` 与 `hosts/nodeHost.ts:104` 11 行相同 | 抽进 `hosts/` 的共享叶子 |
| T10 | 文件内重复 | `vscodeApi/webviews.ts:43/157`、`vscodeApi/window.ts:255/302`、`explorer.ts:264/343`、`canRawView.ts:412/441`、`scm/rowActions.ts` 两组、`docFind.ts` vs `findWidget.ts` | 局部辅助函数 |
| T11 | 测试启动样板 ×3 | `tests/{commandSweep,selfTest,workbenchLifecycle}.test.ts` 23 行、`tests/{scenarioHarness,singleFile,uiSweep}.test.ts` 12 行 | 并入 `tests/helpers.ts` |
| T12 | `scripts/build-node-host.mjs` | 与 `prepare.mjs` 第 3½ 步重复了一份 vite 配置 | prepare.mjs 导出 `buildNodeHost()`，build-node-host.mjs 只调用它；或者给 prepare 加 `--node-host-only` 并删掉这个脚本 |

### 3.3 不合并的"相似实现"（有意为之，写明原因，防止有人误合并）

- **`ggs-node/src/prelude.js`（5 239 行）与 `src/hosts/nodeShims/`（TS）**：两份 Node 内置模块
  实现（EventEmitter、Buffer、stream…）。前者运行在 Boa 侧车里，有 native 绑定；后者运行在
  沙箱 iframe 里，只能走 postMessage 桥。两边的底层能力不同，强行共用代码收益小、风险大。
  长期方向是用 vite 把 TS 实现打成 IIFE 给 Boa 求值（`ggsVscodeShim` 已经这么做了），
  但这属于模块 12 的架构立项，不在本计划内（§8）。
- `ggs-bash/glob.rs`：POSIX fnmatch 语义，见 R3。
- `ggs-bash/regexlite.rs` 与 `regex` crate：前者实现 BRE/ERE 和 GNU 方言，是 Git Bash 兼容性的一部分。
- `remote/tauriShim/*`：有意镜像 `@tauri-apps/api` 的完整导出面，未引用的导出属于契约，保留。

## 4. P3：待优化项

### 4.1 mermaid 未用图类型不进安装包（−约 2.4 MiB）

- 现状见 §1.3。mermaid 12 按图类型懒加载 chunk；应用只渲染 `flowchart`
  （`moduleDiagram.ts`），其余 26 个 chunk 永远不会被请求。
- 做法：在 `vite.config.ts` / `vite.remote.config.ts` 里加一个插件，把 mermaid 的图类型
  动态导入（`diagrams/*/…Diagram`）除 flowchart 外解析到一个抛出
  "diagram type not bundled" 的桩模块。也可以先评估 mermaid 是否支持只注册 flowchart
  的入口。
- 验收：`diagram-closure.json` 不变；`dist/assets` 减少 ≥ 2.3 MiB；Module Analysis 的
  vitest 和 `?full=1` harness 都通过。如果出现 mermaid 内部的跨类型共享 chunk，把它保留，
  只去掉叶子 chunk。
- 与 [mermaid-chunking-plan.md](mermaid-chunking-plan.md) §6 第 2 条（去掉 mermaid、
  直接用 ELK）不冲突：本项是那条之前的低风险一步。

### 4.2 首屏 chunk 里的意外成员

- `first-paint.json` 中出现了 `pathGate-*.js`（Remote 模块的文件名）和 `extModuleLoader-*.js`。
  它们可能是 Rollup 把共享模块合并后按首个模块命名的 chunk，也可能是 §2.1 那些假 import
  边拉进来的。
- 做法：§2.1 落地后重新构建并对比；仍然存在的话，用 `vite build --sourcemap` 看 chunk 的
  真实成员，再决定移走或改为动态导入。
- 验收：`firstPaintJs.size` 不增加，最好减少；不加门槛（原则 6）。

### 4.3 `tests/*.ts` 纳入 typecheck

- 现状：29 455 行单测不参加 `npm run typecheck`，单独检查有 279 个错误。
  主要是访问 private 成员（TS2341，66 个）、属性不存在（TS2339，63 个，可能是测试与实现
  已经漂移）、参数类型不匹配（TS2345，36 个）。
- 做法：新增 `tsconfig.tests.json`（`types: ["node", "vitest/globals"]`、vite 的
  `ImportMeta.env` 与 `__APP_VERSION__` 声明）。先修 TS2339 和 TS2345，它们最可能对应
  已经失效的断言；private 访问改用 `as unknown as` 的测试专用视图或 `@internal` 访问器。
  修完后把它并入 `npm run typecheck`。
- 好处：重构时，测试里引用已经删除或改名的成员会在 typecheck 阶段报错。现在只有运行 vitest
  才能发现，并且只有走到那个分支时才会出错。

### 4.4 继续拆超大文件（按需，不阻塞其他项）

| 文件 | 行数 | 建议 |
| ---- | ---- | ---- |
| `ggs-bash/src/applets.rs` | 9 527 | 按 2026-10-14 parity 批次的分组拆为 `applets/{text,bytes,digest,file,convert,wrap,term}.rs` |
| `ggs-can/src/lib.rs` | 4 990 | 拆为 `blf.rs` / `asc.rs` / `stats.rs` / `convert.rs` |
| `ggs-providers/src/lib.rs` | 3 636 | 拆为 store / seal / presets / probe / usage / ccswitch / claude_settings |
| `ggs-node/src/prelude.js` | 5 239 | 按 builtin 拆成多个文件，用 `include_str!` 拼接（`concat!` 或 build.rs），不改变求值顺序 |
| `features/viewers/hexView.ts` | 1 410 | T2 落地后自然变小 |

拆法沿用重整计划 P5 的"只移动"原则，并且**同一个改动里要跑一次 §2.1 的未用 import 清理**，
避免再次产生 1 492 条诊断那样的问题。

### 4.5 收窄可见性（低优先级）

TS 有 186 个只在本文件使用的导出，Rust 有 164 个只在本文件使用的 `pub` 项。收窄后
依赖图和 crate 的 API 面都会更清楚，但没有运行时收益。只在顺手修改这些文件时处理，
不单独开 PR。

### 4.6 `src-tauri/gen/schemas/` 是生成物（492 KB）

tauri-build 每次构建都会重新生成这个目录。它在仓库里，和不变量"Nothing generated in the
source tree"冲突。是否加入 `.gitignore` 见 §9（tauri 的 capability 编辑器和一些 IDE 插件会读取这里）。

## 5. P4：文档冗余

### 5.1 立即可做（不需要 owner 拍板）

1. **修正 28 条失效路径**。例如 `src-tauri/src/ggs_bash/` 应为 `crates/ggs-bash/src/`，
   `src-tauri/src/git.rs` 应为 `crates/ggs-git/src/runner.rs`，`src-tauri/src/node_runtime/`
   应为 `crates/ggs-node/src/`。完整清单用 §6 的路径检查脚本生成。
2. **删除模块 19 中重复的 `ggs-config` 一节**：第 1591 行与第 1899 行说的是同一件事，
   合并成一节，保留第 1899 行那份"sanctioned exception to the naming seam"的说明。
3. 把模块 12 里已退役机制的大段历史（`ggx-rpc/1`、C-ABI host、`.ggx` 格式、`ggs/2` 词汇表）
   压缩成一句"已移除（日期），见 git 历史"。

### 5.2 需要 owner 决定（与重整计划 P6-6 合并处理）

AGENTS.md 有 178 KB，每次 agent 会话都完整加载。大部分篇幅是带日期的决策叙述
（"2026-10-13, the owner's direction: …"），这些内容在 commit message 和各 plan 文档里已经有了。
建议：

- AGENTS.md 只保留**现状**：模块使命、文件归属、接缝规则、完成定义，目标 ≤ 40 KB。
- 决策史迁到 `docs/decisions/`（每个模块一个文件，或者 ADR 形式），AGENTS.md 里链接过去。
- 模块的文件清单交给 `modules.json`（已机器化，P6-1），AGENTS.md 只写目录或 crate 级引用，
  也就是 P6-6 的方案。

## 6. P5：防回归护栏

| 护栏 | 做法 | 级别 |
| ---- | ---- | ---- |
| TS 未用符号 | §2.1/§2.2 完成后，在 `tsconfig.json` 中开启 `noUnusedLocals: true`（`noUnusedParameters` 视噪音决定，可用 `_` 前缀豁免） | typecheck 失败 |
| Rust 未用依赖 | CI 加 `cargo machete`（纯静态扫描，秒级），或者把 §1.0 的启发式扫描并入 `scripts/check-crate-graph` | CI 失败 |
| 文档路径失效 | 新增 `scripts/check-doc-paths.mjs`：把 AGENTS.md / README.md 中反引号包裹的仓库路径逐个 `existsSync`，在 check-seams 的全局 setup 里运行 | 测试失败 |
| 重复代码 | 把 §1.0 的重复块扫描整理成 `scripts/measure-dupes.mjs`，结果写进 `metrics.json` 的 `code.duplicateLines`（只记录不设门槛，与原则 6 一致） | 只度量 |
| i18n 死键 | 在 `tests/` 的 i18n 测试里加一条：每个键要么以字面量出现，要么命中声明过的动态前缀白名单 | 测试失败 |
| 拆文件规范 | AGENTS.md 的 per-change method 第 3 条（重构）加一句："拆文件后 `tsc --noUnusedLocals` 必须为零" | 评审 |

## 7. 执行顺序与工期

| 阶段 | 内容 | 预估 | 依赖 |
| ---- | ---- | ---- | ---- |
| P1 | §2 全部（import 清理、死代码、根依赖、脚本、死键） | 1–1.5 天 | 无 |
| P5-a | 开启 `noUnusedLocals`、cargo machete、doc 路径检查 | 0.5 天 | P1 |
| P4-a | §5.1 文档修正 | 0.5 天 | P5-a（路径检查可以直接生成清单） |
| P2-TS | §3.2 T1–T12 | 1–1.5 天 | P1 |
| P2-Rust | §3.1 R1、R3、R5、R7、R8 | 1.5–2 天 | P1 |
| P2-Rust-perf | §3.1 R2（先跑基准）、R6（只评估） | 1–2 天 | P2-Rust |
| P2-Remote | §3.1 R4 | 1 天 | 无（独立 workspace，可并行） |
| P3 | §4.1 mermaid、§4.2 首屏、§4.3 测试 typecheck | 2–3 天 | P1（§4.2 依赖 P1 的结果） |
| P3-split | §4.4 拆大文件 | 按需 | P5-a |
| P4-b | §5.2 AGENTS.md 瘦身 | 1–2 天 | owner 决定 |

P1 → P5-a 是关键路径：先清干净再上锁，否则每清一批就会有新的残留进来。
其余阶段都可以与日常功能开发并行，每个子项一个 PR，按 AGENTS.md 的完成定义验收。

## 8. 不做的事

- 不合并 §3.3 列出的"相似但有意分开"的实现。
- 不为了去重而改变任何用户可见行为、协议格式或磁盘格式（包括 bytecode 缓存键和
  symbol 库指纹：R2 换实现后，哈希值必须逐字节一致，否则旧缓存会失效）。
- 不放宽任何性能预算或扫描测试来让去重通过（`tests/it/perf.rs` 的预算保持原样）。
- 不在本计划内用 TS 重写 `prelude.js`，也不去掉 mermaid 换手写 ELK 渲染。两者都是模块级架构
  立项。
- 不收窄 `remote/tauriShim` 的导出面。

## 9. 待 owner 决定

1. `scripts/probes/claude-code-compat.mjs`、`scripts/probes/ui-interaction-check.mjs`：
   登记进模块图，还是删除？
2. 桌面侧是否也去掉 `base64` crate（R1）。去掉后依赖更少，但 ggs-ext / ggs-fs / ggs-providers
   要改用自研实现；不去掉的话只有 ggs-node 侧车受益。
3. `src-tauri/gen/schemas/` 是否加入 `.gitignore`（§4.6）。
4. AGENTS.md 瘦身方案（§5.2，与 P6-6 一起定）。
5. Hub 协议放进 `ggs-remote-proto` 还是新建 `ggs-hub-proto`（R4）：取决于是否允许 hub
   二进制看到 app↔daemon 的控制消息类型（只是类型，不是数据）。

## 10. 验收

| 指标 | 基线（2026-10-15） | 目标 |
| ---- | ------------------ | ---- |
| `tsc --noUnusedLocals` 诊断 | 1 492 | 0，并在 tsconfig 中开启 |
| TS 完全无人引用的导出（不含 tauriShim） | 4 | 0 |
| Rust 完全无人引用的 `pub` 项 | 14 | 0 |
| 根 crate 未用依赖 | 6（+ zip 在正式依赖中） | 0（zip 移到 dev） |
| AGENTS.md 失效路径 | 28 | 0，并由检查脚本守住 |
| base64 实现份数 | 4（3 份自研 + crate） | 1（ggs-codec），桌面侧见 §9-2 |
| VS Code glob 实现份数 | 2 | 1 |
| Hub 协议重复行 | ~150 | 0 |
| git 测试辅助份数 | 3 | 1.5（ggs-git 自留一份） |
| `dist/assets` | 9.3 MiB | ≤ 7.0 MiB（§4.1） |
| `tests/*.ts` typecheck 错误 | 279（未纳入） | 0，并纳入 `npm run typecheck` |
| 重复代码行（TS / Rust 非测试） | ~300 / ~400 | 记入 `metrics.json`，只度量 |
| 性能 | `tests/it/perf.rs` 现有预算 | 全部通过，R2 前后基准差 ≤ 噪声 |

每个 PR 都按 AGENTS.md 的完成定义验收：`npm run typecheck`、`npm test`、
`cargo test --workspace --all-features`、`cargo clippy … -D warnings`。涉及 vite 配置、
prepare 或首屏的改动（§4.1、§4.2、T12）还要在 `npx tauri dev` 下跑一遍，排除打包后才出现的回归。
