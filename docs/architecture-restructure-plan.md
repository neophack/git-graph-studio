# 代码结构重整计划：模块化、低耦合、依赖少、编译快

> 状态：**提案**（2026-10-14），尚未开始执行。
>
> 与 [ci-speed-plan.md](ci-speed-plan.md) 的关系：那份计划改的是 **CI 流水线和依赖清单**；
> 本计划改的是 **源码结构本身**——crate 边界、文件归属、调用方向、状态归属、接口形状。
> 两者互不冲突：本计划落地后，CI 计划里的若干问题（boa 每个 profile 重编、feature 组合、
> 测试二进制链接整个 lib、Linux 测试机需要 WebKitGTK）会自然变小或消失。
>
> 与 [ggs-development-plan.md](ggs-development-plan.md) 的关系：开发计划 §3 的七条架构原则
> **全部保留**，本计划只改变它们落在哪些路径上（例如原则 2 的"git 只经 `src-tauri/src/git.rs`"
> 变成"git 只经 `ggs-git` crate 的 `runner` 模块"）。AGENTS.md 规定"计划与本文件冲突时以计划为准"，
> 所以每个阶段落地时要在同一个改动里同步修订开发计划 §3 和 AGENTS.md 中的路径。
>
> 本文所有"预估"都要用 P0 的实测数字验收（AGENTS.md：数字，不是形容词）。


## 实施状态（2026-10-14，P3-8 完成时）

> 本段由执行过程维护；每个阶段边界更新一次。度量来自 `node scripts/measure-build.mjs`
> （`metrics.json` 的 `build.*`；本机 Windows，dev profile，warm 缓存）。

### 已落地

| 阶段 | 状态 | 提交 |
| ---- | ---- | ---- |
| P0-1 measure-build.mjs | ✅ | `72ba3d7` |
| P1 护栏（TS 图 R1–R10 + allowlist、check-ipc、check-crate-graph、test_support 门控） | ✅ | `560f8b6` |
| P2-1 workspace 骨架 | ✅ | `bf8f2dd` |
| P2-2 ggs-base | ✅ | `617e9c4` |
| P2-3 ggs-proto | ✅ | `a82bb37` |
| P2-4 ggs-codec | ✅ | `309026a` |
| P2-5/6/7 ggs-git(locate+runner)、ggs-shellenv | ✅ | `454b510`–`4eccf12` |
| P2-8 ggs-bash 独立 package | ✅ | `4458dd5` |
| P2-9 ggs-node 独立 package | ✅ | `b073817` |
| P2-10 ggs-remote-proto | ✅ | `596791f` |
| P2-11 ggs-config 独立 package | ✅ | `8466fb6` |
| P2-12 ggs-testkit | ✅ | `0c6db4c` |
| P3-1 EventSink/BatchSink + events.rs + search 样板 | ✅ | `e583703` |
| P3-2 ggs-can | ✅ | `537871d` |
| P3-3 ggs-text（viewer/encoding/grammar/probe/backup） | ✅ | `e5e640c` |
| P3-4 ggs-fs（文件服务引擎 + 传输 + 遍历） | ✅ | `bc4cd0b` |
| P3-5 ggs-git(三)（ops + revision；gerrit 下载留 app） | ✅ | `2034b6a` |
| P3-6 ggs-index（scan/search/replace/compare/hexdiff/fuzzy/symbols；perf.rs 留 app，见下） | ✅ | 本次 |
| P3-7 ggs-analysis（git mv analysis/* + index 模块；dump-diagram 输出逐字节一致已验） | ✅ | 本次 |
| P3-8 ggs-mcp（mcp.rs 整文件 git mv；两命令适配；握手冒烟过） | ✅ | 本次 |

P0-2（target 目录写入者）未执行：本机 `src-tauri/target/` 未复现（构建走
`target/studio/cargo`），`incremental` 目录 17.5 GB 为多 feature 时代的历史累积，
一次 `cargo clean` 或 `cargo sweep` 即回收——留待与 P6-4 一并处理。

### P3 进行中的要点

- **适配层模式定型**（can → text → fs → git 一致）：`#[tauri::command]` 留在 app 的
  `*_commands.rs`，引擎下沉 crate；进度经回调 / `EventSink`，状态类型
  （CanLogState/ViewerState/TransferState）由 crate 拥有、app `manage()`。
- **ggs-testkit 的环**（P3-5 发现）：dev-dependency 环会让 cargo 造出两份 ggs-git、
  类型分裂 —— testkit 砍掉 ggs-git 依赖只留 Scratch 路径/配置；git 构造器落在
  ggs-git 自己的 `cfg(test)` 扩展（`testkit_ext`），app 测试侧持同样的小镜像
  （`src/test_git_helpers.rs`）。后续 crate 的测试按此办理。
- cmd_ext ⇄ cmd_fs / cmd_fs ⇄ cmd_ext / cmd_search ⇄ can_log / viewer ⇄ cmd_fs
  四条计划点名的横向边已全部消解（P3-2/3/4/5）。
- **P3-6 的两处计划偏差**：
  - `tests/it/perf.rs` **留在 app**（计划原写"迁入 ggs-index"）：它不只是
    遍历/搜索/索引的基准——还驱动引擎后端进程（ext_process/cmd_ext）、分析构建
    （analysis）与 SCM 状态（ggs-git），搬进 crate 会要求 crate 反向依赖 app。
    它的 walk/search/index 三相现在直接调 ggs-index；P3-14 复测时整个门禁不动。
  - `SymbolIndex` 的进度回调是 `&(dyn Fn + Sync)`（穿过 rayon worker），而
    `BatchSink::send` 是 `&mut self`——桥是一个 `Mutex<&mut dyn BatchSink>`
    （RefCell 不行：!Sync）。
  - P3-5 漏改了 `tests/it/perf.rs` 的 `git_graph_studio_lib::scm_ops` 导入（HEAD 上
    `--all-targets` 已断）；P3-6 顺带修复（`use ggs_git::ops as scm_ops`）。
  - app 顺手清掉 P3-3 之后残留的死清单项（ropey/syntect/fancy-regex）与随本次
    迁走的 sha1/hex/encoding_rs/tree-sitter 系（app 只透传 grammar-*）。
- **P3-7 的落点**：`AnalysisIndex` 与三个流式报告运行器（run_metrics / run_dead_code /
  run_security）随引擎入 crate，进度走同样的 EventSink/BatchSink 缝（同一个
  Mutex 桥）；`grammar-*` 转发链变成 app → ggs-index（解析文法）+ ggs-analysis
  （→ big-code-analysis）。app 清单再减三员：rayon、regex、big-code-analysis
  全部落进 crate。验收按计划做了：`dump-diagram` 在迁移前后对同一棵树
  （crates/ggs-index）的输出 `cmp` 逐字节一致。
- **P3-8 的落点**：mcp.rs 本就近乎无 tauri（两个命令无 State），整文件 `git mv`
  即成 crate；`catalogue_infos` 转公开给 app 适配层。验收：`cargo run --bin
  git-graph-studio -- --mcp .` 对 initialize / tools/list 的真实握手回答正常
  （17 个工具）。16 个 mcp 测试随文件入 crate，app lib 211 → 195。

### 度量（P2 后实测 vs 计划 §3.2 的预估）

| 场景 | P2 后 | 说明 |
| ---- | ----- | ---- |
| 改 `ggs_bash/applets.rs` 一行 → `cargo build` | **1.1 s** | 计划目标"只有 ggs-bash crate 和它的二进制"达成：桌面 lib 不再编译那 28k 行 |
| 改 `cmd_scm.rs` / `viewer/find.rs` / `lib.rs` 一行 → build | 8.0 / 8.1 / 10.1 s | 仍在 app crate（P3/P4 的对象）；`cargo test --no-run` 各 +1–2 s（链接） |
| 产物依赖数（`cargo tree -e normal` 去重） | app 473 / ggs-node 208 / **ggs-bash 8** / ggs-config 12 | ggs-bash 曾以 feature 形态编整个 lib（计划基线 36 crate；codec 下沉后更小） |
| feature 形态开关 | 只剩 `desktop`（P4-2 删） | `node-runtime`/`ggs-bash`/`testkit` 随各自 package 消失 |
| 生产代码 `for_tests` | 0（`rg` 验证） | P2-12 验收 |
| crate 成员 | 10（app + 9 crates/） | 白名单 `scripts/crate-graph.json` 全部 enforced |

### 度量补充（P3-6 后实测）

| 场景 | P3-6 后 | 说明 |
| ---- | ----- | ---- |
| 改 `crates/ggs-index/src/search.rs` 一行 → `cargo build --workspace --all-features` | **15.0 s** | ggs-index + 下游的 app 两级重编 + 链接；改 app 侧适配（`cmd_search.rs`）则只有 app 一级 |
| crate 成员 | P3-6 后 15，P3-7 后 16，P3-8 后 17（app + 16 crates/） | `check-crate-graph` 17 members 全部 enforced |
| workspace 测试 | P3-6 后 703，P3-7 后 704 通过 / 0 失败 | clippy `-D warnings`、typecheck、vitest 1145 同绿 |

### 测试守恒

P2 前全绿基线 = 639（app lib）+ 48（it）。P2 后 = app lib 443 + it 3 +
ggs-base 9 + ggs-proto 6 + ggs-codec 8 + ggs-git 10 + ggs-shellenv 5 +
ggs-bash 148+6 + ggs-node 17+39 + ggs-remote-proto 2 —— 每一次迁移的差额都
对应随文件走的测试（P2-5 一次误删 5 个 shellenv 测试被计数对账抓住并当场恢复）。
P3-6：app lib 325 → 266（-59，恰为 cmd_search 24 + cmd_symbols 5 + cmd_fuzzy 9 +
parse 12 + store 9），ggs-index 65 = 迁移 59 + 新增 6（sink/门面新测试 5 + 1 个
原合并测试拆分）。
P3-7：app lib 253 → 211（-42，恰为 analysis/ 七文件 + cmd_analysis 3），ggs-analysis
43 = 迁移 42 + 新增 1（报告运行器过 VecSink 的测试）。

---

## 目录

0. [一句话](#0-一句话)
1. [现状](#1-现状2026-10-14-实测windows-本机)
2. [设计原则](#2-设计原则)
3. [目标与度量](#3-目标与度量)
4. [Rust 目标结构](#4-rust-目标结构)
5. [TypeScript 目标结构](#5-typescript-目标结构)
6. [模块清单机器化](#6-模块清单机器化)
7. [分阶段执行（PR 级清单）](#7-分阶段执行pr-级清单)
8. [脚本、CI、打包、文档的同步改动](#8-脚本ci打包文档的同步改动)
9. [风险与对策](#9-风险与对策)
10. [不做的事](#10-不做的事)
11. [验收](#11-验收)
- [附录 A：Rust 逐文件迁移表](#附录-arust-逐文件迁移表)
- [附录 B：TypeScript 逐文件迁移表](#附录-btypescript-逐文件迁移表)
- [附录 C：IPC 领域与命令清单](#附录-cipc-领域与命令清单)
- [附录 D：检查脚本规格](#附录-d检查脚本规格)
- [附录 E：Cargo.toml 草图](#附录-ecargotoml-草图)

---

## 0. 一句话

把一个 83k 行、靠 `cfg(feature)` 切出三种形态、同时产出四个二进制的单体 crate，拆成一个
**按层分级的 Cargo workspace**——只有最顶层的 app crate 认识 tauri，业务逻辑全部落在不带
tauri 的小 crate 里，三个 sidecar 各自独立；把前端 150 个大部分平铺在 `src/` 根下的文件按
模块收进目录，引入基础层 `platform/` 和扩展点 `hooks`，由 `check-seams.mjs` **强制无环、
强制分层、强制 IPC 契约一致**。迁移按阶段推进，每一步都是一个可独立合并、全绿的 PR。

---

## 1. 现状（2026-10-14 实测，Windows 本机）

### 1.1 Rust：一个 crate 承担了四个产物

| 事实 | 数字 / 位置 |
| --- | --- |
| `src-tauri/src/` 全部在一个 lib crate（`git_graph_studio_lib`）里 | 83 182 行 Rust + 5 238 行 `node_runtime/prelude.js` |
| 同一个 lib 编出 4 个二进制 | `git-graph-studio`（主程序，安装后叫 `ggs`）、`ggs-node`、`ggs-bash`、`ggs-config` |
| 靠 feature 切形态 | `desktop` / `node-runtime` / `ggs-bash` 三个开关；`lib.rs` 里 29 处 `cfg(feature)`，`symbols/parse.rs` 9 处 |
| 桌面 lib 编进了整个 GGS Bash | `ggs_bash/` 28 346 行（占全部 Rust 的 **34%**）——桌面端实际只用到 `pref.rs`（613 行：找 git / git bash、Shell 偏好、claude env）和 `archive::zip_entry`（ggs-config 借用） |
| 测试辅助编进了生产库 | `lib.rs:36` 的 `pub mod test_support` 无 `cfg(test)`；`cmd_ext::pin_extensions_home_for_tests` / `unpin_extensions_home_for_tests` 等测试钩子也在发布代码里 |
| 组合根过大 | `lib.rs` 2 342 行，`generate_handler!` 注册 179 个命令，里面混着：`AppState`、打开文件夹/工作区、设置与快捷键读写、启动上下文、命令行子命令解析、macOS "Open With"、Linux WebKit dmabuf 兼容、资源重验证、开发探针钩子、主窗口构建 |
| 一个"上帝状态" | `AppState` 聚合了 repos、单文件模式、启动动作、文件列表缓存、符号缓存、搜索代、传输代、符号索引、分析索引、watcher、延迟服务……被 `cmd_scm`（40 处）、`cmd_fs`（16）、`cmd_analysis`（8）、`cmd_search`（6）、`cmd_symbols`（5）、`viewer`、`cmd_fuzzy` 共同依赖 |
| 全局单例 | 46 处 `static` / `OnceLock` / `Mutex` 全局状态（如 `ext_process::global()`、`HOST_REQUEST_FRONTEND`） |
| 超大文件 | `ggs_bash/applets.rs` 9 527、`can_log.rs` 5 153、`cmd_ext.rs` 4 825、`cmd_providers.rs` 4 046、`cmd_fs.rs` 2 638、`ggs_bash/mod.rs` 2 637、`viewer/mod.rs` 2 369、`lib.rs` 2 342、`mcp.rs` 2 261 |
| 依赖图 | all-features 420 个 crate（`cargo tree -e normal --prefix none` 去重口径）；ggs-node 形态 191；ggs-bash 形态仅 36 |

**模块间的环和横向乱引**（`crate::` 引用统计，节选）：

| 引用方 | 被引用 | 用到的东西 | 问题 |
| --- | --- | --- | --- |
| `cmd_fs` | `cmd_ext` | `percent_decode`、`extensions_home_dir` | 文件服务依赖扩展商店 |
| `cmd_ext` | `cmd_fs` | `revision_file_bytes` | 与上一行成环 |
| `cmd_ext` | `ext_process` | 进程控制 | — |
| `ext_process` | `cmd_ext` | 安装目录、manifest | 与上一行成环 |
| `cmd_symbols` | `cmd_search` | `build_matcher`、`read_searchable`、`scan_text`、`cached_symbols`、`is_symbol_source` | — |
| `cmd_search` | `cmd_symbols` | `references_for` | 与上一行成环 |
| `cmd_search` | `can_log` | `read_line_bounded`、`LineRead` | 全文搜索依赖 CAN 解析器 |
| `analysis/mod.rs` | `cmd_fs`、`cmd_search`、`symbols` | `walk_files`、`is_symbol_source`、`parse::*` | 分析引擎依赖命令层 |
| `viewer/mod.rs` | `cmd_fs`、`AppState` | `probe`、`backups_dir`、`backup_write_into` | 视图引擎依赖命令层和组合根 |
| `git.rs` | `ggs_bash::pref` | `find_git_exe` | 唯一 git 运行器依赖 shell |
| `pty.rs` | `ggs_bash::pref` | `find_git_bash` | — |
| `cmd_providers` | `ggs_bash::pref`、`cmd_ext`、`ext_process`、`ext_child` | 偏好、`extensions_home_dir`、`global()`、`resolve_engine_host`、`ext_child_stop_for` | provider 存储直接操纵扩展进程 |
| `remote_config` | `ggs_bash::archive` | `zip_entry` | 配置 CLI 依赖 shell |
| `remote_host` | `cmd_app`、`cmd_ext`、`cmd_fs`、`ext_process`、`pty`、`ensure_main_window` | — | — |
| `test_support` | `cmd_ext`、`ext_process` | 测试钩子 | 测试代码驱动生产单例 |
| `ggs_bash` 测试 | `ext_process::resolve_engine_host` | 找自己的二进制 | 应该用 `CARGO_BIN_EXE_*` |

**业务逻辑与 tauri 胶水混写**：`viewer/mod.rs` 48 处 `tauri::` 引用、`cmd_scm.rs` 45、
`cmd_fs.rs` 44、`can_log.rs` 30、`cmd_search.rs` 10。后果：这些逻辑的单元测试只能在带
tauri（Linux 上还要 WebKitGTK 系统库）的编译形态里跑。

**外部依赖的实际使用点**（决定拆 crate 后每个依赖去哪）：

| 外部 crate | 使用文件 |
| --- | --- |
| ropey、fancy-regex | `viewer/*` |
| syntect | `viewer/doc.rs`、`ext_grammar.rs` |
| rayon | `analysis/mod.rs`、`cmd_analysis`、`cmd_fs`、`cmd_search`、`cmd_symbols`、`symbols/store.rs`、`viewer/indexed.rs`、`viewer/mod.rs` |
| regex | `analysis/security.rs`、`cmd_search` |
| zip | `cmd_ext`、`cmd_fs`（`zip_tree`）、`remote_host` |
| flate2 | 只有 `can_log` |
| plist | `cmd_assoc`、`ext_grammar` |
| ignore | 只有 `cmd_fs`（`walk_files`） |
| notify | 只有 `watcher` |
| trash | 只有 `cmd_fs` |
| encoding_rs | `encoding.rs`、`cmd_search`、`viewer/indexed.rs` |
| tree-sitter、grammar-* | 只有 `symbols/parse.rs` |
| big-code-analysis | 只有 `analysis/bca.rs` |
| aes-gcm、getrandom | `cmd_providers`、`node_runtime/builtins/core.rs` |
| ureq | `cmd_providers`、`ext_gallery`、`scm_ops`（下载 gerrit commit-msg hook）、`node_runtime/builtins/net.rs` |
| sha1 / hex | `cmd_fs`、`cmd_search`、`scm_ops`、`symbols/store.rs`、`node_runtime` |
| interprocess、rmp-serde、tokio | `remote_host`（tokio 也在 `cmd_fs`） |
| portable-pty | 只有 `pty` |
| winreg | `cmd_assoc`、`ggs_bash/pref.rs` |
| rpassword | 只有 `remote_config` |

可以看到：绝大多数重依赖只被一两个文件使用，天然适合各自归入一个 crate。

### 1.2 编译代价从哪来

1. **crate 是 rustc 的并行单位和增量单位。** 改 `applets.rs` 一行 → 整个 83k 行的桌面
   lib 前端重跑（解析、宏展开、类型检查、借用检查都是 crate 粒度的），重新 codegen，再重新
   链接主程序和测试二进制。改 `cmd_scm.rs` 一行也一样要背着 GGS Bash、CAN、分析引擎、
   viewer 一起走。增量编译只能在 crate 内部按查询复用，跨不出 crate 的前端阶段。
2. **同一个 lib 按 feature 组合被编多遍**：`tauri dev`（desktop + ggs-bash）、
   `ggs-node` profile（node-runtime，且 profile 不同）、`cargo test --all-features`
   （全开）各是一份独立的 lib 产物；切一次 feature 就是一次 83k 行的全量编译。
3. **三个独立 workspace、三个 target 目录**：app、`extensions-src/ggs-remote/daemon`、
   `extensions-src/ggs-remote/hub` 各自编 tokio / rustls / serde / rmp-serde。
4. **磁盘**：`src-tauri/target/debug` **9.7 GB**（deps 4.9 GB + incremental 4.4 GB + build
   404 MB）。deps 目录 566 个 rlib，同名多份的有 `windows_sys`×18、`tauri_utils`×11、
   `getrandom`×11、`thiserror`×10、`base64`×10——版本重复 + feature 变体 + 历史残留。
   incremental 4.4 GB 几乎全部属于那一个巨型 lib crate 的各个 feature 变体。注：
   `.cargo/config.toml` 指向的是 `../target/studio/cargo`，`src-tauri/target/` 的来源
   （疑似 IDE / rust-analyzer 覆盖了 target-dir）待 P0 确认。
5. **依赖版本重复**（`cargo tree -d`）：`base64` 0.22/0.23、`getrandom` 0.2/0.3/0.4、
   `hashbrown` 0.12/0.15/0.17、`indexmap` 1/2、`digest` 0.10/0.11、`crypto-common` 0.1/0.2、
   `block-buffer` 0.10/0.12、`miniz_oxide` 0.8/0.9、`png` 0.17/0.18、`bitflags` 1/2、
   `foldhash` 0.1/0.2……其中 `getrandom 0.2`、`base64 0.22` 是我们自己的直接依赖选的版本，
   其余多数来自 tauri / big-code-analysis 的传递依赖。

### 1.3 TypeScript：平铺 + 环 + 核心反向依赖 remote

| 事实 | 数字 |
| --- | --- |
| `src/` 下 150 个 .ts，约 85 个平铺在根目录 | 56 935 行 |
| 静态 import 环（Tarjan 强连通分量） | **6 文件大环**：`editor ⇄ explorer ⇄ extHost ⇄ fileHistory ⇄ scm ⇄ treeView`；另有 `analysisPages ⇄ mcpPage`、`nodeShims ⇄ nodeShims/processSurfaces` |
| 核心代码静态 import `remote/` | **16 处**，另有 2 处动态 import |
| 扇出最大 | `workbench.ts` 34、`editor.ts` 24、`remote/shell.ts` 20、`extHost.ts` 16、`remote/navDrawer.ts` 11 |
| 扇入最大（事实上的基础层） | `ui.ts` 55、`i18n.ts` 48、`settings.ts` 21、`commands.ts` 18、`remote/session.ts` 15、`state.ts` 13、`contributions.ts` 11 |
| 超大文件 | `vscodeApi.ts` 4 585、`extHost.ts` 4 219、`editor.ts` 3 399、`workbench.ts` 2 250、`scm.ts` 1 755、`nodeShims.ts` 1 694、`i18n.ts` 1 645、`hexView.ts` 1 415、`editorArea.ts` 1 361 |
| IPC | 46 个文件直接 `invoke('xxx')`，161 个不同的命令名；Rust 侧注册 179 个。**没有任何东西核对两边一致** |
| 模块图漂移 | `editorCompletions.ts`、`editorDecorations.ts`、`editorDecorationsView.ts`、`editorHovers.ts`、`editorProviderViews.ts`、`vscodeNamespaceProbe.ts` 不在 AGENTS.md 的模块图里——"每个文件恰属一个模块"的契约靠手工维护，已经漂了 |

**6 文件大环的每一条边**（全部可以低成本解开，见 5.4）：

| 边 | import 的内容 | 性质 |
| --- | --- | --- |
| `editor → fileHistory` | `type BlameLine, FileHistoryView` | 仅类型 |
| `editor → extHost` | `extFileDataUrl` | 一个 URL 工具函数 |
| `explorer → editor` | `fileIcon, fileIconColor` | 一个图标工具函数 |
| `extHost → editor` | `type EditorPlacement` | 仅类型 |
| `extHost → treeView` | `type SerializedTreeItem` | 仅类型 |
| `fileHistory → scm` | `type DiffRequest` | 仅类型 |
| `scm → extHost` | `extFileDataUrl` | 同上 |
| `scm → editor` | `type DiffSide`、`fileIcon, fileIconColor` | 类型 + 图标 |
| `scm → explorer` | `type StatusMap` | 仅类型 |
| `treeView → extHost` | `extFileDataUrl` | 同上 |
| `analysisPages → mcpPage` | `McpPage` | 页面注册 |
| `mcpPage → analysisPages` | `type AnalysisPageView` | 仅类型 |
| `nodeShims ⇄ processSurfaces` | `makeChildProcess…` / `type Buffer, ShimHost` | 类型回边 |

**核心 → remote 的 16 处静态 import**：

| 引用方 | 被引用 | 内容 |
| --- | --- | --- |
| `docEditView.ts` | `remote/editLock` | `editLockDefault, registerEditLock` |
| `editor.ts` | `remote/editLock` | 同上 |
| `editor.ts` | `remote/nav` | `revealEditorPage` |
| `editor.ts` | `remote/openThreshold` | `windowedEditThreshold` |
| `extHost.ts` | `remote/assetUrl` | `assetUrl` |
| `extHost.ts` | `remote/session` | `addressedHere, frontendClass, frontendId, remoteEnv` |
| `extHost.ts` | `remote/mirror/protocol` | `panelStream, viewStream` |
| `extHost.ts` | `remote/mirror/webviewFrames` | `parseStream, setWebviewFrameSource` |
| `panel.ts` | `remote/nav` | `dismissFullScreenSideView, fullScreenSideViewOpen` |
| `transfer.ts` | `remote/session` | `remoteEnv` |
| `transfer.ts` | `remote/mirror/hostStub` | `mirrorViewersNow` |
| `workbench.ts` | `remote/summary` | `startSummaryReporter` |
| `workbench.ts` | `remote/mirror/hostStub` | `installMirrorHost, mirrorViewersActive` |
| `workbench.ts` | `remote/workbenchSync` | `installWorkbenchSync` |
| `workbench.ts` | `remote/session` | `remoteEnv` |
| `workbench.ts` | `remote/nav` | `phoneShell` |

外加动态 import：`extHost → remote/mirror/webviewCopy`、`transfer → remote/transfer`。

### 1.4 结构性缺陷造成过的 bug（从 AGENTS.md 与提交历史归纳）

这些都不是"写错了一行"，而是结构让错误容易发生、难以被测试抓到：

| 历史问题 | 结构性根因 | 本计划的对应 |
| --- | --- | --- |
| `vscode_shim_boa` 缺 `node-runtime` 门控，默认特性下 `cargo test` 编不过（ci-speed-plan P2 才发现） | 一个 crate 多个 feature 形态，某些组合从没人编 | 删除 feature 形态，crate 即形态（4.9） |
| zip 精简特性组合编不过（ci-speed-plan P3 被证伪） | 依赖特性分散在一个大 manifest，改动面不可控 | 依赖下沉到使用它的 crate，`[workspace.dependencies]` 统一版本（4.11） |
| 测试钩子（`pin_extensions_home_for_tests`）进了发布二进制 | `test_support` 是生产模块 | `ggs-testkit` 只做 dev-dependency（4.8） |
| 切换 terminalShell 后后端以旧 shell 重启（设置写入与 refresh 竞争，2026-10-13） | 设置读写散在 `lib.rs`、`pref.rs`、前端三处，没有单一所有者 | 设置存储归 `ggs-base::settings`，写完成是 API 的一部分 |
| 远程页面看不到 claude-code 的 `setContext`、"View Git Graph" 在桌面打开（2026-10-11） | 前端身份/路由逻辑散在 `extHost` 与 `remote/` 双向引用 | 核心 → remote 反转为 hooks（5.5） |
| 模块图漏登记文件 | 手工维护的清单 | `modules.json` + 目录即模块，由脚本校验（第 6 节） |
| IPC 命令改名后前端仍调旧名，只在运行时失败 | 161 个字符串散在 46 个文件 | `platform/ipc/` + `check-ipc.mjs`（5.6） |

---

## 2. 设计原则

本计划的每一条具体决定都可以追溯到下列原则之一。

1. **crate 是边界，不是文件夹。** Rust 里"模块化"以 cargo 能强制的 crate 依赖为准；
   `pub(crate)` 默认，跨 crate 的东西才 `pub`。一个 crate 用不到的依赖不出现在它的
   manifest 里。
2. **只有一个 crate 认识 tauri。** 所有 `#[tauri::command]`、`AppHandle`、`Channel`、
   `State` 只存在于 app crate；下层 crate 用普通 Rust 类型和 trait 表达"推送"和"流"。
3. **依赖只向下。** 层级固定（L0 基础 → L1 领域 → sidecar/app），同层依赖必须在白名单上；
   环在 Rust 里编译不过，在 TS 里由脚本拒绝。
4. **组合根负责连线，模块之间不互相命名。** 沿用并推广现有的
   `ext_process::add_spawn_env_source`（providers 与 ext_process 不互相引用，由
   `lib.rs` 连线）的做法：跨领域协作通过"注册接口 + 组合根连线"完成。
5. **状态有主人。** 每份可变状态属于一个 crate 的一个类型，由 app 创建并放入
   `tauri::State`；进程级全局变量只保留真正进程唯一的东西，并在 crate 文档里逐条列出。
6. **形态由 crate 决定，不由 feature 决定。** sidecar 是独立 package；feature 只用于
   "可选的能力"（如 `grammar-*`），不用于"这是哪个程序"。
7. **测试跟着逻辑走。** 逻辑在哪个 crate，测试就在哪个 crate，且能在没有 tauri、没有
   WebKitGTK、没有网络的环境里运行；app crate 只测连线和适配。
8. **前端的基础层是叶子。** `platform/` 不 import 任何上层；功能模块之间只经各自的
   `index.ts` 或命令注册表交互；远程形态通过扩展点注入，核心代码不认识 `remote/`。
9. **契约有单一出处。** IPC 命令名、事件名、设置键、模块归属各有一个机器可读的出处和
   一个校验脚本。
10. **只移动，不改行为。** 结构 PR 只做 `git mv`、改 import、提取函数；任何行为变化单独
    提交并先写红灯测试。

---

## 3. 目标与度量

### 3.1 目标

| 目标 | 度量（P0 建基线，每阶段复测，写入 `metrics.json` 的 `build.*`） |
| --- | --- |
| 编译快 | ① 冷编译 `cargo build`（dev）墙钟；② 四个增量场景：改一行 `ggs_bash/applets.rs`、改一行 `cmd_scm.rs`、改一行 `viewer/find.rs`、改一行 `lib.rs`，之后 `cargo build` 与 `cargo test --no-run` 的时间；③ `npm run typecheck` 时间；④ `npm test` 时间 |
| 编译空间少 | 一次干净 `cargo build && cargo test --no-run` 后 target 目录大小（分 deps / incremental / build）；`cargo tree -d` 的重复版本数 |
| 依赖少 | 每个产物的 `cargo tree -e normal` crate 数（app / ggs-node / ggs-bash / ggs-config） |
| 低耦合 | Rust：内部 crate 依赖图与 4.3 的白名单一致；TS：静态 import 环 = 0，核心 → `remote/` 静态 import = 0，跨功能模块的非 `index.ts` import = 0 |
| bug 少 | feature 形态数（今天 3 个开关）；生产代码里的测试钩子数 = 0；IPC 命令名两侧一致；不需要 tauri 就能运行的 Rust 测试占比；模块图漂移 = 0 |

### 3.2 预估（待 P0 验证）

| 项 | 今天 | 目标 |
| --- | --- | --- |
| 桌面 app crate 源码行数 | 83 182 | 约 8 000–10 000（组合根、命令适配、窗口、远程宿主、pty、文件关联、watcher、measure） |
| 改 GGS Bash 一行触发的重编 | 整个桌面 lib + 主程序 + 测试二进制 | 只有 `ggs-bash` crate 和它的二进制 |
| 改一个 scm 命令适配触发的重编 | 整个桌面 lib | 只有 app crate（约 1/9 的代码量）；若改的是 `ggs-git` 的逻辑，则 `ggs-git` + 直接依赖它的 crate + app |
| feature 形态 | 3 个开关 × 3 平台 | 0 个形态开关（只剩 `grammar-*` 能力开关） |
| 可在无 tauri 环境运行的 Rust 测试 | 几乎没有（`desktop` 关掉后大多数模块不编译） | 除 app crate 外全部 |
| rustc 并行度 | 关键路径上一个 83k 行的 crate 串行前端 | 约 17 个 crate，L1 层可并行编译 |

增量编译的收益来自两点：一是改动只让下游 crate 重编，上游和兄弟 crate 直接复用；二是
即便要重编，单个 crate 的前端（类型检查、借用检查）规模小得多。冷编译收益较小（总代码量
不变，crate 多了还有少量元数据开销），预期主要来自并行度。这是 P0/P2 要实测的重点。

---

## 4. Rust 目标结构

### 4.1 布局

`src-tauri/Cargo.toml` 同时是 workspace 根和 app package。这样 tauri CLI、
`tauri.conf.json`、`generate_context!()`、`[patch.crates-io]` 的 boa、`[profile.*]`
全都留在原处，不动任何工具链约定（`[patch]` 和 `[profile]` 只在 workspace 根生效，根没变）。
新 crate 放 `src-tauri/crates/`：

```text
src-tauri/
├── Cargo.toml              # [workspace] + [workspace.dependencies] + [workspace.lints] + app package
├── build.rs                # 只剩 tauri_build::build() 与 Windows manifest 依赖
├── src/                    # app：只剩认识 tauri 的东西
│   ├── main.rs
│   ├── lib.rs              # ≤ 200 行：run() = 解析命令行 → 分派 headless 模式 → 组装 → tauri::Builder
│   ├── cli.rs              # 子命令/帮助/--mcp/--measure/config 分派（现 lib.rs 的 parse_startup_actions 等）
│   ├── boot/
│   │   ├── context.rs      # BootContext、boot_context、boot_stage、stamp
│   │   ├── launch.rs       # launch_path_of、opened_paths、seed_launch_paths、handle_opened
│   │   ├── workspace.rs    # open_folder / open_workspace / close_folder / open_single_file
│   │   ├── services.rs     # 延迟服务、post_first_paint、start_root_services
│   │   └── dev_harness.rs  # GGS_DEV_HARNESS、keep_awake_for_probe_runs
│   ├── window/
│   │   ├── main_window.rs  # build_main_window、ensure_main_window、revalidate_assets
│   │   ├── macos.rs        # Dock 菜单（现 cmd_app::dock_menu）
│   │   └── linux.rs        # WebKit dmabuf 兼容
│   ├── commands/           # 每个领域一个文件，#[tauri::command] 薄适配
│   │   ├── mod.rs          # handlers() → generate_handler![...] 清单
│   │   ├── fs.rs  scm.rs  search.rs  symbols.rs  analysis.rs  fuzzy.rs  viewer.rs
│   │   ├── can.rs  ext.rs  ext_process.rs  ext_child.rs  gallery.rs  providers.rs
│   │   ├── mcp.rs  settings.rs  app.rs  assoc.rs  pty.rs  remote.rs
│   ├── events.rs           # tauri 实现的 EventSink / BatchSink
│   ├── state.rs            # 各领域状态的创建与 manage()
│   ├── wiring.rs           # 跨领域连线（spawn-env、watcher 订阅、provider 重启后端……）
│   ├── protocol.rs         # ggs:// 协议注册（逻辑在 ggs-ext::page）
│   ├── remote_host.rs      # 远程宿主（窗口、焦点模拟、relay webview）
│   ├── pty.rs  watcher.rs  assoc.rs  instance.rs  measure.rs
└── crates/
    ├── ggs-base/           # L0
    ├── ggs-proto/          # L0
    ├── ggs-remote-proto/   # L0（app 与 daemon 共用）
    ├── ggs-codec/          # L0
    ├── ggs-git/            # L1
    ├── ggs-shellenv/       # L1
    ├── ggs-fs/             # L1
    ├── ggs-text/           # L1
    ├── ggs-can/            # L1
    ├── ggs-index/          # L1
    ├── ggs-analysis/       # L1
    ├── ggs-mcp/            # L1
    ├── ggs-ext/            # L1
    ├── ggs-providers/      # L1
    ├── ggs-testkit/        # 仅 dev-dependency
    ├── ggs-bash/           # sidecar：lib + [[bin]] ggs-bash
    ├── ggs-node/           # sidecar：lib + [[bin]] ggs-node + build.rs（N-API 符号导出）+ prelude.js
    └── ggs-config/         # sidecar：[[bin]] ggs-config
```

### 4.2 crate 目录（逐个说明）

每个 crate 的条目包括：职责、来源、对外 API 草案、内部依赖、外部依赖、明确不允许的东西、
测试、预计规模。

#### L0 基础层（只依赖 crates.io，彼此不依赖）

**`ggs-base`** —— 所有 crate 共享的最小公共件

- 来源：`lib.rs` 的 `atomic_write`、`strip_jsonc`、`settings_file` / `keybindings_file`；
  `cmd_ext` 的 `percent_decode`、`extensions_home_dir`、`extensions_dir`；`cmd_fs` 的
  `backups_dir`、`session_log_file` 的路径部分；`can_log` 的 `read_line_bounded` /
  `LineRead`；`lib.rs` 的 `find_repo_root`、`is_repo_below`；`measure.rs` /
  `remote_host.rs` 的 `ScratchDir` / `ScratchFileGuard`。
- 对外 API 草案：
  - `paths::{ggs_home(), extensions_home(), extension_data(id), index_home(), logs_home(), backups_home(), cache_home()}`
    —— 全部尊重 `GGS_HOME`，**唯一**计算 `~/.ggs` 布局的地方；
  - `fsx::{atomic_write, percent_decode, read_line_bounded, LineRead, ScratchDir}`；
  - `jsonc::strip`；
  - `settings::{SettingsStore}` —— 读写 `~/.ggs/settings.json` / `keybindings.json`，
    写入在返回前落盘（修掉 1.4 的竞争的根）；提供 `get_str(key)` 供后端读设置；
  - `workspace::{WorkspaceRoots}` —— 打开的根列表、`resolve_repo(path)`（现 `AppState::resolve_repo`
    的确认逻辑）、`first_repo()`、`is_repo_below`、`find_repo_root`；
  - `cancel::{Generation}` —— 现 `cmd_search::SearchState` / `cmd_fs::TransferState` 共用的
    "取消代"模式（`next()`、`is_current(gen)`、`cancel()`）；
  - `sink::{EventSink, BatchSink}` —— 见 4.7。
- 外部依赖：`serde`、`serde_json`、`memchr`。
- 不允许：任何 I/O 线程池、任何网络、任何平台注册表访问。
- 测试：现 `atomic_write_tests`、`repo_root_tests` 与路径计算测试搬入。
- 规模：约 600–800 行。

**`ggs-proto`** —— `ggs-ext/1` 线协议

- 来源：`ext_protocol.rs` 全部（402 行）。
- 对外 API：消息类型、编解码、`serve_plugin`（每请求一线程的分派骨架）。
- 外部依赖：`serde`、`serde_json`。
- 使用者：`ggs-ext`（宿主侧）、`ggs-node`（插件侧）、app。
- 说明：今天 `ggs-node` 形态编译整个 lib 只是为了这 400 行和 node_runtime 本身。

**`ggs-remote-proto`** —— 远程控制通道消息

- 来源：`remote_host.rs` 中的控制通道消息类型（MessagePack 结构）；daemon 侧
  `extensions-src/ggs-remote/daemon` 中的同一份副本。
- 目的：今天 app 和 daemon "各留一份 + 共享测试向量对齐"（`tests/it/remote_control_vectors.rs`）；
  共享一个 crate 后向量测试变成该 crate 的单元测试，两边不可能再漂移。
- 外部依赖：`serde`、`serde_bytes`、`rmp-serde`。
- 约束：daemon 仍是独立 workspace，通过 path 依赖引用它（`path = "../../../src-tauri/crates/ggs-remote-proto"`）；
  该 crate 必须保持零平台依赖，以免把 app 的依赖带进插件 CI。

**`ggs-codec`** —— 纯 Rust 的摘要与归档

- 来源：`ggs_bash/hashes.rs`（MD5/SHA-1/SHA-256）、`ggs_bash/compress.rs`（DEFLATE 解码、
  gzip）、`ggs_bash/archive.rs`（USTAR、zip 读取 `zip_entry`）。
- 对外 API：`hash::{md5, sha1, sha256, Digest}`、`deflate::inflate`、`gzip::{decode, encode_stored}`、
  `tar::{read, write}`、`zip::{entry, list}`。
- 使用者：`ggs-bash`（全部）、`ggs-config`（`zip::entry`）、后续 `ggs-node`（ci-speed-plan P3：
  补 SHA-512 / HMAC / PBKDF2 后替换 `md-5`、`sha1`、`hmac`、`pbkdf2`）。
- 外部依赖：无。
- 测试：现 `hashes` / `compress` / `archive` 的测试与标准向量全部随迁。

#### L1 领域层（可依赖 L0 与白名单内的 L1）

**`ggs-git`** —— 唯一的 git CLI 运行器（原则 2 的新落点）

- 来源：`git.rs`（运行器、ref/hash 校验、`backend_env`）；`ggs_bash/pref.rs` 的
  `find_git_exe`、`find_git_bash`、`git_usr_bin_from` 等定位逻辑；`scm_ops.rs` 全部；
  `cmd_scm.rs` 中的状态解析（porcelain）、`file_log`、`blame` 解析、各写操作的参数构造；
  `cmd_fs.rs` 的 `revision_file_bytes`、`revision_file_text`、`repo_head`、
  `parse_status_branch`、`repo_submodules`、`repo_folder_name`。
- 模块划分：`locate`（std + `winreg`，无其它依赖）、`runner`、`status`、`log`、`blame`、
  `ops`（branch/remote/stash/tag/commit/push/fetch…）、`revision`、`gerrit`。
- 对外 API 草案：`Git::locate() -> GitInstall`、`Git::new(install, repo)`、
  `git.status() -> Status`、`git.log_follow(path)`、`git.blame(path)`、`git.show(rev, path) -> Vec<u8>`、
  `git.ops().*`、`OutputLog`（面板 Git 通道的记录，由 app 订阅并推给前端）。
- 网络：`scm_ops.rs:587` 用 `ureq` 下载 gerrit 的 commit-msg hook。拆分后 `ggs-git` 只提供
  `gerrit::install_hook(repo, bytes)`，下载放在 app 的适配层（app 本来就依赖 ureq）。
  这样 `ggs-git` 保持无网络、轻依赖，`ggs-bash` 依赖它的 `locate` 不会被拖入 TLS 栈。
- 外部依赖：`winreg`（仅 Windows）、`sha1`/`hex`（若 scm_ops 的指纹需要；可改用 `ggs-codec`）。
- 测试：`cmd_scm` / `scm_ops` / `git` 现有测试（scratch 仓库）搬入，依赖 `ggs-testkit`。
- 规模：约 2 500–3 000 行。

**`ggs-shellenv`** —— Terminal Shell 设置及其对外环境

- 来源：`ggs_bash/pref.rs` 除定位以外的部分：`ShellPreference`、`preference(home)`、
  `ensure_bash_exe(home, sidecar)`（`~/.ggs/shell/bash.exe` 副本）、`claude_shell_env(pref, bash)`。
- 依赖：`ggs-base`（设置读取）、`ggs-git`（`locate::find_git_bash`）。
- 使用者：app 的 `pty`、`ggs-providers`。
- 说明：这正是今天 app 为了 613 行而编整个 GGS Bash 的那部分。

**`ggs-fs`** —— 工作区文件服务

- 来源：`cmd_fs.rs` 的逻辑部分：目录列举与分页（`read_dir_sorted`）、`probe` /
  `head_has_long_lines`、分块读取、`patch_bytes`、写入与指纹、文件解码入口（调用
  `ggs-text::encoding`）、新建/重命名/删除（含 `trash`）、无覆盖复制引擎（`copy_into_paths`、
  `unique_target`、`copy_dir`）、导入导出引擎（`import_sources`、`export_path`、`tree_size`、
  `copy_file_streaming`）、`zip_tree` / `zip_tree_reporting`、上传约束
  （`canonicalize_lenient`、`upload_allowed`、`write_upload_chunk`、`upload_offset`）、
  备份（`backup_*_in`）、文件遍历 `walk_files` + `FileListCache` + `cached_file_list`。
- 依赖：`ggs-base`、`ggs-text`（仅 `encoding`）。
- 外部依赖：`ignore`、`rayon`、`trash`、`zip`。
- 说明：`walk_files` 是 Quick Open、全文搜索、符号索引、分析引擎共用的遍历——放在
  `ggs-fs` 而不是 `ggs-index`，因为分析引擎也需要它，而它不应该为此依赖搜索。
  排除策略"一张表"的约定保持不变。
- 不允许：`tauri::State`；传输取消改用 `ggs-base::cancel::Generation`；进度改用 `BatchSink`。

**`ggs-text`** —— 文本、编码与大文件视图引擎

- 来源：`encoding.rs`；`viewer/doc.rs`、`find.rs`、`indexed.rs`、`outline.rs`；
  `viewer/mod.rs` 的会话表与编辑/撤销/保存/高亮逻辑（去掉 48 处 tauri 引用）；
  `ext_grammar.rs`（TextMate → Sublime syntax，加入 syntect 集合）。
- 依赖：`ggs-base`（备份路径、原子写）。不依赖 `ggs-fs`：`viewer/mod.rs` 今天调用的
  `cmd_fs::probe` 与 `backup_write_into` 是纯函数，`probe` 下沉到 `ggs-text::probe`
  （`ggs-fs` 反过来复用它），备份写入经 `ggs-base::paths` + 本 crate 的 `backup` 模块。
- 外部依赖：`ropey`、`syntect`（`default-fancy`）、`fancy-regex`、`encoding_rs`、`memchr`、
  `rayon`、`plist`。
- 会话表：现在以 `AppState` / 全局表持有的打开文档，变为 `ViewerSessions` 类型，由 app 管理。
- 测试：viewer 与 encoding 现有测试；`examples/viewer_bench.rs` 迁入本 crate 的 `examples/`。

**`ggs-can`** —— CAN Trace Analyzer 引擎

- 来源：`can_log.rs`（5 153 行，拆成 `blf.rs`、`asc.rs`、`frames.rs`、`stats.rs`、
  `intervals.rs`、`convert.rs`、`session.rs`、`find.rs`）。
- 依赖：`ggs-base`（`read_line_bounded`）。
- 外部依赖：`flate2`（`zlib-rs`）、`memchr`、`rayon`（若统计并行）。
- 8 个命令（`can_log_stats`、`can_intervals`、`convert_can_log`、`can_log_open`、
  `can_log_frames`、`can_log_count`、`can_log_find`、`can_log_close`）留在 app 的
  `commands/can.rs`。
- 说明：全文搜索今天为了 `read_line_bounded` 依赖 CAN 解析器——下沉到 `ggs-base` 后断开。

**`ggs-index`** —— 搜索、符号与 Quick Open 打分

- 来源：`cmd_search.rs`（搜索与替换、内存索引回退、文件夹比较、字节比较）；
  `cmd_symbols.rs`（持久索引的状态、构建/恢复/重建、`symbol_lookup`、`symbol_references`）；
  `symbols/parse.rs`、`symbols/store.rs`（含 `.scm` 查询文件）；`cmd_fuzzy.rs`（服务端打分、
  路径补全）。
- 模块划分：`scan`（`build_matcher`、`read_searchable`、`scan_text`、`is_symbol_source`——
  今天 `cmd_symbols` 从 `cmd_search` 借的东西）、`search`、`replace`、`compare`（文件夹/字节）、
  `symbols::{parse, store, index}`、`fuzzy`。
- 打环：`search` 与 `symbols` 都只依赖 `scan`；`find_references` 由 `symbols::references_for`
  提供，`search` 不再反向调用。
- 依赖：`ggs-base`、`ggs-fs`（`walk_files`、`FileListCache`）、`ggs-text`（`encoding`）。
- 外部依赖：`regex`、`rayon`、`encoding_rs`、`sha1`/`hex`（store 指纹）、`tree-sitter` +
  9 个 `tree-sitter-*`。
- 特性：`grammar-*` 九个特性从 app 迁到这里，同时转发 `ggs-analysis` 中 big-code-analysis
  的同名语言特性（app 只做透传：`grammar-rust = ["ggs-index/grammar-rust", "ggs-analysis/grammar-rust"]`）。
- 测试：`tests/it/perf.rs`（合成仓库基准，`GGS_PERF_FILES`）迁入本 crate；它测的本来就是
  遍历/搜索/索引。
- 规模：约 5 000 行。

**`ggs-analysis`** —— Code Analysis 引擎

- 来源：`analysis/` 全部（`mod.rs`、`metrics.rs`、`deadcode.rs`、`security.rs`、`modules.rs`、
  `diagram.rs`、`imports.rs`、`bca.rs`）；`cmd_analysis.rs` 中的 `AnalysisIndex` 与流式报告
  生成逻辑。
- 依赖：`ggs-base`、`ggs-fs`（`walk_files`）、`ggs-index`（`scan::is_symbol_source`、
  `symbols::parse`）。
- 外部依赖：`big-code-analysis`（`default-features = false`）、`rayon`、`regex`。
- 说明：big-code-analysis 是 rust-version 1.94 下限的来源、28 个独占依赖、两个 C 语法编译
  的来源（ci-speed-plan P3）；隔离进一个 crate 后，它只在本 crate 及其下游（mcp、app）的
  依赖变化时参与重编，且可与 `ggs-text`、`ggs-can`、`ggs-ext` 并行编译。
- `examples/dump-diagram.rs`、`parse_bench.rs` 迁入本 crate（或 `ggs-index`，以其依赖为准）。

**`ggs-mcp`** —— `ggs --mcp` 服务

- 来源：`mcp.rs` 全部（服务循环、工具实现、握手、调用日志）。
- 依赖：`ggs-base`、`ggs-fs`、`ggs-index`、`ggs-analysis`。
- 不依赖 tauri：它本来就是无窗口模式。今天它通过 app 二进制的 `--mcp` 进入，拆分后入口
  仍在 app（`cli.rs` 分派到 `ggs_mcp::serve(repo)`），保持 `ggs --mcp <folder>` 的对外形态与
  Claude 集成写入的命令行不变。
- 两个命令（`mcp_log`、`mcp_tools`）留在 app 的 `commands/mcp.rs`。
- 后续可选：独立二进制 `ggs-mcp`，使 MCP 进程不加载 webview 相关的动态库。不在本计划范围，
  记录为后续选项。

**`ggs-ext`** —— 扩展平台的宿主侧

- 来源：`cmd_ext.rs`（安装/升级/卸载、`.vsix` 解包、`resolve_node_binaries`、内置包登记、
  `ggs://` 协议的文件服务与页面引导组装、`ext_fs` 约束、日志、存储路径、`ext_load_code`、
  `ext_node_env`）；`ext_process.rs`；`ext_routing.rs`；`ext_child.rs`；`ext_gallery.rs`；
  `ext_page_boot.js`（`include_str!` 随迁）。
- 模块划分：`store`（安装目录、manifest、内置包）、`vsix`（解包、JSONC manifest、
  `resolve_node_binaries`）、`page`（`ggs://` 响应、引导注入）、`fsapi`（`ext_fs` 的约束）、
  `log`、`process`（宿主进程、握手、`runCommand`、状态、spawn-env 源注册）、`routing`、
  `child`、`gallery`。
- 关键改造：
  - `ext_process::global()` → `ExtHost` 结构体（内部 `Arc`），由 app 创建并 `manage()`；
    `ggs-mcp`、`measure` 等无窗口路径需要时自行构造。`HOST_REQUEST_FRONTEND` 变成
    `ExtHost` 的字段。
  - 向前端发事件（`ext-host-request`、`ext-host-state`、`ext-backend-state`、
    `ext-backend-restarted`）改经 `EventSink`。
  - `revision_file_bytes` 改从 `ggs-git` 取，`percent_decode` / `extensions_home_dir` 从
    `ggs-base` 取——`cmd_fs ⇄ cmd_ext` 环消失。
  - 测试钩子 `pin_extensions_home_for_tests` → `ExtStore::at(dir)` 构造参数。
- 依赖：`ggs-base`、`ggs-proto`、`ggs-git`。
- 外部依赖：`zip`、`base64`、`ureq`（gallery，origin 约束逻辑随迁）、`serde_json`。
- 规模：约 7 000 行（最大的 L1 crate，P3 中分 3 个 PR 迁移）。

**`ggs-providers`** —— AI provider 桥

- 来源：`cmd_providers.rs` 的逻辑：存储（`~/.ggs/ai-providers.json`）、AES-256-GCM 封装
  （`~/.ggs/keys/`）、内置预设、每窗口的生效选择（`effective_choice`）、spawn env 构造
  （`backend_env`）、Claude 设置撤回（`withdraw_claude_provider_env` /
  `withdraw_provider_settings`）、MCP 注册（`apply_claude_mcp`）、连接测试与模型列表探测、
  用量统计（`provider_usage`）、cc-switch 导入。
- 模块划分：`store`、`seal`、`presets`、`choice`、`env`、`claude_settings`、`claude_mcp`、
  `probe`、`usage`、`ccswitch`。
- 关键改造：今天它直接调用 `ext_process::global()`、`ProcessInfo`、`ext_child_stop_for`、
  `resolve_engine_host` 来重启桥接的后端。拆分后 `ggs-providers` **不依赖 `ggs-ext`**：
  它只提供 `fn bridged_ext_ids() -> &[&str]` 与 `fn backend_env(...)`；"切换 provider 后重启
  桥接后端"这个跨领域动作移到 app 的 `wiring.rs`（组合根连线，原则 4）。
- 依赖：`ggs-base`、`ggs-shellenv`。
- 外部依赖：`aes-gcm`、`getrandom`、`ureq`、`base64`、`hex`。
- 测试：spawn-env 守卫测试、用量聚合测试、cc-switch 解析测试随迁；需要后端进程的重启测试
  留在 app。

**`ggs-testkit`** —— 测试支持（只做 dev-dependency）

- 来源：`test_support.rs`（scratch 仓库、隔离的 git 配置、临时 home）。
- 依赖：`ggs-base`、`ggs-git`（用运行器建仓库）；**不依赖 `ggs-ext`**——今天
  `test_support` 调 `cmd_ext::pin_extensions_home_for_tests` / `ext_process::global().stop_all()`，
  拆分后由需要的测试自己构造 `ExtStore::at(tmp)` 与 `ExtHost`。
- 外部依赖：`tempfile`。

#### sidecar（独立 package，互不依赖，永不依赖 app）

**`ggs-bash`**

- 来源：`ggs_bash/` 除 `hashes`、`compress`、`archive`（→ `ggs-codec`）与 `pref`
  （→ `ggs-git::locate` + `ggs-shellenv`）之外的全部；`bin/ggs_bash.rs`；
  `tests/it/ggs_bash_cli.rs`。
- 依赖：`ggs-codec`、`ggs-git`（仅 `locate`，用于 Git Bash `usr/bin` 回退与 `git.exe` 定位）。
- 外部依赖：无（Windows 下的 Win32 声明是手写的）。
- 拆分 `applets.rs`（9 527 行）：`applets/{mod.rs（注册表与分派）, text.rs, fs.rs, ls.rs,
  grep.rs, sed.rs, find.rs, sort_uniq.rs, digest.rs, archive.rs, convert.rs, term.rs, misc.rs}`，
  按 2026-10-14 parity batch 的分组。
- 测试：`ggs_bash` 单测中对 `crate::ext_process::resolve_engine_host("ggs-bash")` 的引用
  改为 `env!("CARGO_BIN_EXE_ggs-bash")`（集成测试）——这是 cargo 为同 package 二进制提供的
  标准方式，也消除了 shell 对扩展宿主的反向依赖。
- 只在 Windows 构建、打包、测试（owner 2026-10-14 的方向不变），但方式从"feature 门控"
  改为"只在 Windows 的 externalBin 与 CI job 中出现"（4.9）。

**`ggs-node`**

- 来源：`node_runtime/` 全部（含 `prelude.js`、`alloc.rs`、`napi_host.rs`）；
  `bin/ggs_node.rs`；`build.rs` 的 `export_napi_host_symbols`；`tests/it/node_runtime.rs`、
  `tests/it/vscode_shim_boa.rs`；`examples/boa_bench.rs`。
- 依赖：`ggs-proto`，后续 `ggs-codec`（P6）。
- 外部依赖：`boa_engine`（经根 `[patch]` 指向 `vendor/`）、`libloading`、`ureq`、`if-addrs`、
  `aes-gcm`、`pbkdf2`、`hmac`、`sha1`、`sha2`、`md-5`、`getrandom`、`base64`、`hex`、`bincode`。
- **必须**：bin 与 `build.rs` 同在本 package——`cargo:rustc-link-arg-bins` 只作用于同一
  package 的二进制，N-API 符号的 `/EXPORT:`（Windows）与 `-rdynamic`（Linux）不能从别的
  package 传过来。
- 构建：`cargo build --profile ggs-node -p ggs-node`（profile 仍在根 manifest）。

**`ggs-config`**

- 来源：`remote_config.rs`、`bin/ggs_config.rs`。
- 依赖：`ggs-base`、`ggs-codec`（`zip::entry`）、`ggs-remote-proto`（如需与 daemon 管理 API
  共享类型）。
- 外部依赖：`rpassword`（ci-speed-plan P3 的"低"优先级项可后续用 `ggs-bash` 的 raw mode
  替换，但那会让 config 依赖 bash；更好的是把关回显的十几行放进 `ggs-base::tty`）。
- 说明：AGENTS.md 中"`remote_config.rs` 是模块 19 命名接缝的唯一例外"的约定随文件迁移到
  本 crate，`check-seams.mjs` 的例外路径同步更新。
- `ggs config` 子命令仍由 app 的 `cli.rs` 分派——app 依赖 `ggs-config` 的 lib 部分
  （`ggs_config::run(args)`），这是 app → sidecar lib 的唯一一条边，且 `ggs-config` 很小、
  无平台依赖。

### 4.3 依赖图与规则

```text
L0   ggs-base   ggs-proto   ggs-remote-proto   ggs-codec        （只依赖 crates.io，彼此不依赖）

L1   ggs-git        → base
     ggs-shellenv   → base, git
     ggs-text       → base
     ggs-fs         → base, text
     ggs-can        → base
     ggs-index      → base, fs, text
     ggs-analysis   → base, fs, index
     ggs-mcp        → base, fs, index, analysis
     ggs-ext        → base, proto, git
     ggs-providers  → base, shellenv

dev  ggs-testkit    → base, git

bin  ggs-bash       → codec, git
     ggs-node       → proto, codec
     ggs-config     → base, codec, remote-proto

app  git-graph-studio → 以上全部（ggs-bash、ggs-node 除外）+ tauri 及其插件
```

硬性规则：

1. **只有 app 依赖 `tauri`、`tauri-plugin-*`、`webview2-com`、`objc2-app-kit`、
   `portable-pty`、`notify`、`interprocess`、`tokio`。**（后三者的使用点今天全在 app 侧文件。）
2. 同层边只允许上图列出的；新增边改白名单（`scripts/crate-graph.json`），并在 PR 描述里说明
   为什么不能通过组合根连线解决。
3. sidecar 永不依赖 app，互不依赖；app 只依赖 `ggs-config` 的 lib（见上）。
4. `git-graph-core` 不得出现在任何 manifest 或任何 `crates/*/src`、`src/` 源文件中
   （原 `build.rs` 的接缝检查，扩大扫描范围）。
5. 所有内部 crate 继承 `[workspace.lints]`（clippy `-D warnings` 的同一套规则）、
   `[workspace.package]` 的 `edition` / `rust-version` / `license`。
6. 每个 crate 根 `lib.rs` 以 `//!` 文档开头，写明职责、所属模块（模块图编号）、允许的依赖、
   保留的全局变量清单（原则 5）。

`scripts/check-crate-graph.mjs` 读取 `cargo metadata --format-version 1`（离线、毫秒级），
比对白名单；挂进 `check-seams.mjs`，因此 vitest global setup、`prepare.mjs`、Vite 构建都会
执行它（规格见附录 D）。

### 4.4 逐文件迁移

完整表见[附录 A](#附录-arust-逐文件迁移表)。原则：

- 先 `git mv` 整个文件到目标 crate（保历史），再在目标 crate 内拆分；不要一边移动一边改写。
- `#[tauri::command]` 函数在移动前先在原文件内拆成"适配函数 + 纯函数"两半（一个独立的
  小 PR），纯函数随文件下沉，适配函数移到 `src/commands/<domain>.rs`。
- 原路径不保留 re-export 垫片（垫片会让旧路径继续被新代码引用）；一个 PR 内改完所有引用。

### 4.5 跨模块引用的逐条处理

| 今天的引用 | 处理 |
| --- | --- |
| `cmd_fs → cmd_ext::percent_decode` | → `ggs_base::fsx::percent_decode` |
| `cmd_fs → cmd_ext::extensions_home_dir` | → `ggs_base::paths::extensions_home` |
| `cmd_ext → cmd_fs::revision_file_bytes` | → `ggs_git::revision::show` |
| `ext_process ⇄ cmd_ext` | 同在 `ggs-ext` 内部，成为 crate 内模块引用（允许，且 `store` 不引用 `process`） |
| `cmd_symbols → cmd_search::{build_matcher, read_searchable, scan_text, cached_symbols, is_symbol_source}` | → `ggs_index::scan::*`；`cached_symbols` → `ggs_index::symbols::cache` |
| `cmd_search → cmd_symbols::references_for` | → `ggs_index::symbols::references_for`（search 调 symbols，单向） |
| `cmd_search → can_log::read_line_bounded` | → `ggs_base::fsx::read_line_bounded` |
| `analysis → cmd_fs::walk_files` | → `ggs_fs::walk::walk_files` |
| `analysis → cmd_search::is_symbol_source` | → `ggs_index::scan::is_symbol_source` |
| `analysis → symbols::parse` | → `ggs_index::symbols::parse` |
| `viewer → cmd_fs::probe` | → `ggs_text::probe`（`ggs-fs` 复用） |
| `viewer → cmd_fs::{backups_dir, backup_write_into}` | → `ggs_base::paths::backups_home` + `ggs_text::backup` |
| `viewer → crate::AppState` | → `tauri::State<ViewerSessions>`，只在 app 的 `commands/viewer.rs` |
| `git → ggs_bash::pref::find_git_exe` | → `ggs_git::locate`（同 crate） |
| `pty → ggs_bash::pref::find_git_bash` | → `ggs_git::locate::find_git_bash` |
| `cmd_providers → ggs_bash::pref::*` | → `ggs_shellenv::*` |
| `cmd_providers → cmd_ext::{extensions_home_dir, extensions_dir, log_extensions}` | 路径 → `ggs_base::paths`；`log_extensions` 的调用移到 app `wiring.rs` |
| `cmd_providers → ext_process::{global, ProcessInfo, resolve_engine_host}`、`ext_child::ext_child_stop_for` | 整段"重启桥接后端"移到 app `wiring.rs::restart_bridged_backends(ext_host, providers)` |
| `remote_config → ggs_bash::archive::zip_entry` | → `ggs_codec::zip::entry` |
| `remote_host → cmd_app, cmd_ext, cmd_fs, ext_process, pty, ensure_main_window` | 都在 app 内，保留；但 `cmd_fs` / `cmd_ext` 的部分改为调用对应 crate |
| `measure → analysis, encoding, find_repo_root, git, viewer` | 改为调用 `ggs-analysis`、`ggs-text`、`ggs-base`、`ggs-git`；`measure` 留在 app |
| `test_support → cmd_ext, ext_process` | 删除；调用方测试自行构造 |
| `ggs_bash` 测试 `→ ext_process::resolve_engine_host` | → `env!("CARGO_BIN_EXE_ggs-bash")` |
| `node_runtime → ext_protocol` | → `ggs_proto` |
| `lib.rs::atomic_write`（被 `cmd_fs` 等使用） | → `ggs_base::fsx::atomic_write` |

### 4.6 拆掉 `AppState`

Tauri 允许 `manage()` 任意多个不同类型的状态，命令按需注入 `State<T>`。`AppState` 按字段拆：

| 今天的字段 | 新类型（所属 crate） | 注入它的命令 |
| --- | --- | --- |
| `repos`、`resolve_repo`、`first_repo`、`is_current` | `WorkspaceRoots`（`ggs-base`） | scm、fs、search、symbols、analysis |
| `single_file`、`startup_actions`、`startup_workspace`、boot-context-read 标志 | `LaunchState`（app `boot/`） | boot、fs（单文件模式判断） |
| `file_list_cache` | `FileListCache`（`ggs-fs`） | fs、fuzzy、search |
| `symbol_cache` | `SymbolCache`（`ggs-index`） | search、symbols |
| `search` | `Generation`（`ggs-base`），包一层 `SearchCancel` 新类型以免与 transfer 混淆 | search |
| `transfer` | `TransferCancel(Generation)` | fs |
| `symbol_index` | `SymbolIndex`（`ggs-index`） | symbols、watcher 连线 |
| `analysis_index` | `AnalysisIndex`（`ggs-analysis`） | analysis、watcher 连线 |
| `watcher` | `Watchers`（app） | boot |
| `deferred_services` | `DeferredServices`（app `boot/services.rs`） | boot |

收益：`cmd_scm` 的 40 处 `State<AppState>` 变成 `State<WorkspaceRoots>`，scm 的适配层只
认识它真正需要的东西；任何一个领域状态类型都可以在其 crate 里独立构造和测试。

### 4.7 事件与流的抽象

```rust
// ggs-base/src/sink.rs
/// 向前端推送一个具名事件（app 用 AppHandle::emit 实现；测试用 Vec 实现）。
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: serde_json::Value);
}

/// 流式批次（app 用 tauri::ipc::Channel 实现）。返回 false 表示接收方已经不在
/// （前端关闭、页面重载、取消），生产者应尽快停止。
pub trait BatchSink<T: serde::Serialize>: Send {
    fn send(&mut self, batch: T) -> bool;
}

/// 测试用实现。
pub struct VecSink<T>(pub Vec<T>);
```

```rust
// src-tauri/src/events.rs（app）
pub struct TauriEvents(tauri::AppHandle);
impl EventSink for TauriEvents { fn emit(&self, e: &str, p: Value) { let _ = self.0.emit(e, p); } }

pub struct ChannelSink<T>(tauri::ipc::Channel<T>);
impl<T: Serialize + Clone> BatchSink<T> for ChannelSink<T> {
    fn send(&mut self, b: T) -> bool { self.0.send(b).is_ok() }
}
```

`cmd_search.rs` 的流式模式（原则 4：首批 200 ms 内到达、可取消）保持不变，只是
`Channel` 换成 `BatchSink`、取消代换成 `ggs_base::cancel::Generation`。命令适配层只负责把
`Channel` 包成 `ChannelSink` 再调用下层函数。

### 4.8 全局单例的处理

P2 开始前用 `rg -n "static .*(OnceLock|Mutex|LazyLock|AtomicU|AtomicBool)" src-tauri/src`
导出全部 46 处，逐条归类：

| 类别 | 处理 | 例子 |
| --- | --- | --- |
| 进程唯一、只读 | 保留，写进 crate 文档的"全局清单" | 实例 id、启动时间戳 `boot_started` |
| 可替换为显式状态 | 移入所属类型，由 app `manage()` | `ext_process::global()`、`HOST_REQUEST_FRONTEND`、viewer 会话表 |
| 缓存 | 移入所属类型，必要时 `Arc` 共享给后台线程 | git 可执行文件定位缓存（可保留 `OnceLock`，进程唯一） |
| 测试专用开关 | 删除，改为构造参数 | `pin_extensions_home_for_tests` |

每替换一个单例是一个独立 PR，并必须让 `deferred_services_tests`、`open_folder_impl_tests`、
`workspace_tests` 等启动顺序测试保持全绿。

### 4.9 feature 与打包的简化

| 今天 | 之后 |
| --- | --- |
| `desktop` 特性：关掉时 lib 不含 tauri，供 sidecar 和部分测试使用 | 删除。app crate 永远带 tauri，其它 crate 永远不带 |
| `node-runtime` 特性 | 删除——它就是 `ggs-node` package |
| `ggs-bash` 特性 + `required-features` + `tauri.conf.json` 的 `build.features: ["ggs-bash"]` + macOS 签名 merge（`scripts/signing.mjs`）与 Linux 构建（容器与 `build-studio.sh`）用 `--config` 清空特性表 | 全部删除。ggs-bash 是独立 package，`tauri.windows.conf.json`（Tauri 自动合并的平台配置）的 `bundle.externalBin` 列出它；`prepare.mjs` 只在 Windows 上 `cargo build -p ggs-bash` |
| `ggs-config` 是 app 的第二个 `[[bin]]`，bundler 顺带打包 | 独立 package，经 `externalBin` 打包。当年"externalBin + crate 自带 bin 双装触发 ICE30"的顾虑随 MSI 的移除消失（Windows 只出 NSIS，2026-10-14），且拆分后也不存在"双份" |
| `grammar-*` 九个特性在 app | 搬到 `ggs-index` / `ggs-analysis`，app 透传，`default` 全开，语义不变 |
| `build.rs`：tauri 代码生成 + Windows manifest + N-API 符号导出 + `git-graph-core` 源码扫描 | app 的 `build.rs` 只剩前两项；N-API 导出随 `ggs-node`；源码扫描搬到 `check-crate-graph.mjs` |

externalBin 的命名约定（`<name>-<target-triple>[.exe]`，`prepare.mjs` 已有 `TRIPLES` 表）
对三个 sidecar 统一处理。macOS / Linux 的 `tauri.conf.json` 只列 `ggs-node` 与 `ggs-config`。

feature 形态从"3 个开关 × 3 平台"降到 0，"只在某个特性组合下才编不过"这一整类 bug 不再
可能出现；CI 也不再需要 `-- --skip ggs_bash`（Linux/macOS 不跑 `-p ggs-bash` 即可）。

### 4.10 测试的去向

| 今天 | 之后 |
| --- | --- |
| 各文件内 `#[cfg(test)]` | 随逻辑进入对应 crate；只测 tauri 适配的留在 app |
| `tests/it/main.rs`（一个集成测试二进制，五个子模块） | 拆散到各 crate 的 `tests/`，每个 crate 至多一个集成测试二进制（延续"5 合 1"的链接收益）：`node_runtime.rs`、`vscode_shim_boa.rs` → `crates/ggs-node/tests/it.rs`；`ggs_bash_cli.rs` → `crates/ggs-bash/tests/cli.rs`；`perf.rs` → `crates/ggs-index/tests/perf.rs`；`remote_control_vectors.rs` → `crates/ggs-remote-proto` 的单元测试 |
| `src/test_support.rs` | `crates/ggs-testkit` |
| `stage_bench.rs`（`cfg(all(test, feature = "desktop"))`） | 留 app，去掉 feature 门控 |
| `examples/*.rs` | `viewer_bench` → `ggs-text`；`boa_bench` → `ggs-node`；`parse_bench` → `ggs-index`；`dump-diagram` → `ggs-analysis` |
| CI 命令 `cargo test --all-features` | `cargo test --workspace --exclude ggs-bash`（Linux/macOS），Windows 加上 `-p ggs-bash`；clippy 同理 |

Linux 上大部分 crate 的测试不再需要 WebKitGTK——只有 app crate 需要。这让未来的
"逻辑测试 job"可以在最小镜像上跑（是否拆 job 交给 ci-speed-plan 决定）。

### 4.11 外部依赖的重新分配

用 `[workspace.dependencies]` 在根 manifest 统一声明版本与默认特性，各 crate
`dep = { workspace = true }` 引用。这样：

- 同一个依赖在整个 workspace 只有一个版本（今天它们在一个 manifest 里，自然只有一个；
  拆开后用 workspace 依赖防止版本分叉）；
- 我们自己的直接依赖可以在一个地方对齐到传递依赖已有的版本，减少重复（P6）：
  `getrandom` 0.2 → 与 tauri/daemon 一致的版本；`base64` 对齐；`sha1`/`sha2`/`hex` 视
  `ggs-codec` 替换情况决定是否保留。

| 外部 crate | 新归属 |
| --- | --- |
| tauri、tauri-plugin-dialog/opener/clipboard-manager、tauri-build | app |
| portable-pty、notify、interprocess、tokio、rmp-serde（宿主侧）、serde_bytes、webview2-com、windows-core、objc2*、winreg（assoc 部分） | app |
| ropey、syntect、fancy-regex、encoding_rs、plist（语法部分） | ggs-text |
| ignore、trash、zip | ggs-fs（zip 也在 ggs-ext） |
| regex、tree-sitter、tree-sitter-* | ggs-index（regex 也在 ggs-analysis） |
| big-code-analysis | ggs-analysis |
| flate2 | ggs-can |
| aes-gcm、getrandom | ggs-providers、ggs-node |
| ureq | ggs-ext（gallery）、ggs-providers、ggs-node、app（gerrit hook 下载） |
| boa_engine、libloading、if-addrs、bincode、pbkdf2、hmac、md-5 | ggs-node |
| rpassword | ggs-config |
| rayon | ggs-fs、ggs-text、ggs-index、ggs-analysis |
| memchr | ggs-base、ggs-text、ggs-can |
| serde、serde_json | 几乎全部 |
| tempfile（dev） | ggs-testkit 与需要的 crate 的 dev-dependencies |

---

## 5. TypeScript 目标结构

### 5.1 布局（按模块图收目录，`git mv` 保历史）

```text
src/
├── main.ts                       # 启动入口（不变）
├── vite-env.d.ts
├── platform/                     # 基础层：谁都能用，它不 import 任何上层
│   ├── ipc/                      # 按领域的类型化 invoke 封装，唯一允许 import @tauri-apps/api/core 的地方
│   │   ├── core.ts               # invoke/Channel/listen 的薄包装（远程别名仍在 vite 层生效）
│   │   ├── fs.ts  scm.ts  search.ts  symbols.ts  analysis.ts  viewer.ts  can.ts
│   │   ├── ext.ts  extProcess.ts  gallery.ts  providers.ts  mcp.ts  pty.ts
│   │   ├── app.ts  settings.ts  assoc.ts  remote.ts
│   ├── ui/                       # 现 ui.ts 拆开
│   │   ├── dom.ts                # el()
│   │   ├── codicon.ts  notify.ts  contextMenu.ts  quickInput.ts  progress.ts
│   │   └── index.ts              # 门面：re-export 以上（platform 是叶子，门面不会引入环）
│   ├── find/                     # findOptions.ts、findHistory.ts（编辑器与搜索共用）
│   ├── metrics/                  # themeMetrics.ts、uiMetrics.ts
│   ├── fileIcons.ts              # fileIcon / fileIconColor（从 editor.ts 提出，解环）
│   ├── extAssets.ts              # extFileDataUrl（从 extHost.ts 提出，解环）
│   ├── markdown.ts               # 编辑器预览与扩展 README 共用
│   ├── i18n.ts  settings.ts  state.ts  commands.ts  keybindings.ts  lazy.ts
│   ├── env.ts                    # isRemote()、formFactor()、frontendId()（远程实现经 hooks 注入）
│   └── hooks.ts                  # 扩展点注册表（5.5）
├── scroll/                       # 模块 7 的滚动模型（已是目录，保留原位，视为 platform 级）
├── features/
│   ├── explorer/                 # 模块 3
│   ├── quickOpen/                # 模块 4
│   ├── search/                   # 模块 5
│   ├── editor/                   # 模块 6
│   ├── viewers/                  # 模块 7（fastView、hexView、hexCompare）
│   ├── compare/                  # 模块 8
│   ├── scm/                      # 模块 9
│   ├── gitGraph/                 # 模块 10（前端侧几乎为空：Git Graph 是扩展页面；留目录承载将来的接缝）
│   ├── terminal/                 # 模块 11
│   ├── extensions/               # 模块 12
│   ├── providers/                # 模块 12 的 AI provider 桥（体量大，独立子目录）
│   ├── can/                      # 模块 13
│   ├── selftest/                 # 模块 14
│   ├── mcp/                      # 模块 16
│   ├── analysis/                 # 模块 17
│   └── ggsBash/                  # 模块 18（前端只有设置项；目录可为空，测试归属用）
│       每个模块：index.ts（对外唯一入口）+ types.ts（对外类型）+ 实现文件
├── workbench/                    # 模块 1 的组合根与外壳
│   ├── workbench.ts              # 拆分后只负责组装（≤ 600 行）
│   ├── layout.ts  menus.ts  boot.ts  lifecycle.ts
│   ├── titlebar.ts  statusbar.ts  panel.ts  settingsPanel.ts
│   └── shell.css
├── hosts/                        # 独立构建入口（各自打包，不进主 bundle）
│   ├── extHostBoot.ts            # 沙箱 frame 的启动
│   ├── nodeHost.ts  nodeHostEsm.ts  ggsVscodeShim.ts
│   ├── vscodeApi/                # 现 vscodeApi.ts 按命名空间拆分（5.7）
│   ├── nodeShims/                # 现 nodeShims.ts + nodeShims/*
│   ├── extModuleLoader.ts
│   └── vscodeNamespaceProbe.ts
└── remote/                       # 模块 19（位置不变；它是上层，可以依赖 platform/features，反之不行）
```

完整的逐文件表见[附录 B](#附录-btypescript-逐文件迁移表)。

### 5.2 依赖规则（扩展 `check-seams.mjs`，构建失败级别）

| # | 规则 | 说明 |
| - | ---- | ---- |
| R1 | `platform/`、`scroll/` 不 import `features/`、`workbench/`、`hosts/`、`remote/` | 基础层是叶子 |
| R2 | `features/a/**` 对 `features/b/**` 的 import 只能指向 `features/b/index.ts` 或 `features/b/types.ts` | 模块对外只有门面 |
| R3 | `features/**`、`workbench/**`、`hosts/**` 不得静态 import `remote/**` | 核心不认识远程 |
| R4 | 动态 `import('…/remote/…')` 只允许出现在 `remote/` 自身和 `platform/hooks.ts` 的远程安装点 | 远程代码按需加载 |
| R5 | 全仓静态 import 环 = 0（含 `import type`） | 类型环也是设计环 |
| R6 | 只有 `platform/ipc/**` 能 import `@tauri-apps/api/core`；`@tauri-apps/api/event` 只允许 `platform/ipc/**` 与 `workbench/**` | IPC 单一出处 |
| R7 | `hosts/**` 不 import `features/**`、`workbench/**`（它们运行在 frame / Node / Boa 里，没有工作台） | 运行环境隔离 |
| R8 | `__TAURI_INTERNALS__` 只在 `remote/tauriShim/`（已有规则，保留） | — |
| R9 | 现有接缝规则（不得出现 `graph_request`、`gitgraph/` 等）保留 | — |
| R10 | 单文件 > 1 500 行报警（不失败），清单写入检查输出 | 拆分待办 |

为了能**先上规则再改代码**，检查带一个只减不增的豁免清单 `scripts/seams-allowlist.json`：
P1 时把现有违例全部登记；之后每个 PR 只能删除条目，新增条目使检查失败。清单清零是 P5 的
验收条件。

### 5.3 功能模块的门面约定

```ts
// features/editor/index.ts —— 编辑器模块对外的全部
export { openEditor, closeEditorForPath, revealEditorForPath } from './open';
export type { EditorInput, EditorPlacement, DiffSide, DiffRequest } from './types';
export { registerEditorCommands } from './commands';
```

- 门面只 re-export，不含逻辑；
- `types.ts` 只有类型，任何模块都可以 `import type` 它而不产生运行时依赖；
- 模块内部文件之间自由引用；
- 跨模块的"动作"（打开、刷新、聚焦）首选命令 id（`commands.ts` 注册表），其次门面函数。

### 5.4 解开所有环（逐边）

| 边 | 处理 | 结果 |
| --- | --- | --- |
| `explorer → editor (fileIcon, fileIconColor)` | 两个函数移到 `platform/fileIcons.ts` | explorer 不再依赖 editor |
| `scm → editor (fileIcon, fileIconColor)` | 同上 | — |
| `editor / scm / treeView → extHost (extFileDataUrl)` | 移到 `platform/extAssets.ts`（它只是把扩展文件路径转成 `ggs://` URL） | 三条边消失 |
| `extHost → editor (type EditorPlacement)` | 类型移到 `features/editor/types.ts` | 仅类型、经门面 |
| `extHost → treeView (type SerializedTreeItem)` | `treeView.ts` 归入 `features/extensions/`，类型在模块内部 | 同模块内 |
| `editor → fileHistory (type BlameLine, FileHistoryView)` | `BlameLine` 移到 `features/scm/types.ts`；`FileHistoryView` 由 scm 模块经 hooks/命令向编辑器注册"历史视图"，编辑器不再 import 它 | — |
| `fileHistory → scm (type DiffRequest)` | `fileHistory.ts` 归入 `features/scm/`，同模块；`DiffRequest` 移到 `features/editor/types.ts`（diff 是编辑器的输入类型） | — |
| `scm → editor (type DiffSide)` | `DiffSide` 移到 `features/editor/types.ts` | 经门面 |
| `scm → explorer (type StatusMap)` | `StatusMap` 是 git 状态的形状，移到 `platform/ipc/scm.ts`（它就是 `scm_status` 的返回类型） | scm 与 explorer 都向下依赖 |
| `analysisPages ⇄ mcpPage` | `mcpPage.ts` 归 `features/mcp/`；分析工具注册表（`analysisTools.ts`）登记 MCP 页面的工厂（AGENTS.md 本就这样描述），`analysisPages` 不再 import `McpPage`；`AnalysisPageView` 类型移到 `features/analysis/types.ts` | — |
| `nodeShims ⇄ processSurfaces` | `Buffer`、`BufferFactory`、`ShimHost` 类型移到已有的 `nodeShims/shared.ts` | — |

做完后 Tarjan 检查应为零个强连通分量。

### 5.5 核心 → remote 的反转：扩展点目录

`platform/hooks.ts` 提供一个极小的、类型化的注册表：

```ts
// platform/hooks.ts
type HookMap = {
	editLock: EditLockPolicy;              // 默认：桌面不加锁
	navigation: NavigationPolicy;          // 默认：无全屏侧视图
	openThreshold: (desktopCut: number) => number; // 默认：恒等
	assetUrl: (url: string) => string;     // 默认：恒等
	session: SessionInfo;                  // 默认：{ remote: false, frontendId: 'main', frontendClass: 'desktop' }
	webviewStreams: WebviewStreamBridge | null; // 默认：null
	mirror: MirrorHostBridge | null;       // 默认：null（无人观看的桌面不付任何代价）
	workbenchSync: WorkbenchSyncInstaller | null;
	summaryReporter: (() => void) | null;
	transferWire: (() => Promise<TransferTransport>) | null;
};
export function hook<K extends keyof HookMap>(k: K): HookMap[K];
export function provideHook<K extends keyof HookMap>(k: K, v: HookMap[K]): void;
```

| 今天的 import | 扩展点 | 默认实现（桌面） | 远程实现的安装者 |
| --- | --- | --- | --- |
| `editLockDefault, registerEditLock`（editor、docEditView） | `editLock` | 不锁 | `remote/boot.ts` 安装 `remote/editLock` |
| `revealEditorPage`（editor） | `navigation.onEditorActivated` | 空操作 | `remote/nav` |
| `dismissFullScreenSideView, fullScreenSideViewOpen`（panel） | `navigation.sideView*` | 空操作 / false | `remote/nav` |
| `phoneShell`（workbench） | `navigation.phoneShell` | false | `remote/nav` |
| `windowedEditThreshold`（editor） | `openThreshold` | 恒等 | `remote/openThreshold` |
| `assetUrl`（extHost） | `assetUrl` | 恒等 | `remote/assetUrl` |
| `addressedHere, frontendClass, frontendId, remoteEnv`（extHost、transfer、workbench） | `session` | 桌面 | `remote/session` |
| `panelStream, viewStream, parseStream, setWebviewFrameSource`（extHost）与动态 `webviewCopy` | `webviewStreams` | null | `remote/mirror/*`（桌面也需要分享 webview 时由 `mirror` 安装器一并安装） |
| `installMirrorHost, mirrorViewersActive, mirrorViewersNow`（workbench、transfer） | `mirror` | 惰性安装器：首个 hello 到达时 `import('remote/mirror/hostStub')` | `workbench/boot.ts` 只调用 `hook('mirror')` |
| `installWorkbenchSync`（workbench） | `workbenchSync` | null（纯桌面无需同步）；有远程会话时安装 | `remote/workbenchSync` |
| `startSummaryReporter`（workbench） | `summaryReporter` | null | `remote/summary` |
| 动态 `remote/transfer`（transfer） | `transferWire` | null | `remote/transfer` |

关于"桌面也会用到的远程代码"：镜像宿主（`hostStub` / `host` / `recorder`）和操作同步在
桌面窗口里运行（桌面是被观看的一方）。它们不是"核心依赖 remote"，而是"桌面 bundle 可选地
加载 remote 的宿主侧"。实现方式：`main.ts`（入口，不属于任何层）调用
`installDesktopRemoteHooks()`（位于 `remote/desktopHooks.ts`），后者用 `provideHook` 注册
惰性加载器。这样核心文件里不再出现 `remote/` 路径，而桌面行为完全不变（`hostStub` 今天
也是在首个 hello 时才加载 `host`）。

### 5.6 IPC 契约

- 每个后端领域一个 `platform/ipc/<domain>.ts`，函数签名即契约，例如：

  ```ts
  // platform/ipc/scm.ts
  export type StatusMap = Record<string, FileStatus>;
  export const scmStatus = (repo: string) => invoke<ScmStatus>('scm_status', { repo });
  export const gitStage = (repo: string, paths: string[]) => invoke<void>('git_stage', { repo, paths });
  ```

- 46 个文件中散落的 `invoke('…')` 全部改调封装函数（按领域分 PR）。
- `tests/tauriMock.ts` 的脚本化后端保持按命令名工作，不受影响；新增一条 vitest：
  每个 `platform/ipc/*.ts` 导出的函数都能在 mock 下调用（防止拼写错误的命令名）。
- `scripts/check-ipc.mjs`（规格见附录 D）：
  - TS 侧命令名集合 = `platform/ipc/**` 中 `invoke('…')` 的字面量 ∪ `remote/pathGate.ts` 中的命令名；
  - Rust 侧集合 = `src-tauri/src/commands/mod.rs` 的 `generate_handler!` 清单（P4 之前是 `lib.rs`）；
  - TS 有 Rust 无 → 失败；Rust 有而 TS、pathGate、测试都没有 → 报警（死命令候选）；
  - `remote/pathGate.ts` 的 `REFUSED_COMMANDS` 等列表中的名字必须在 Rust 侧存在 → 失败。
- 不引入 tauri-specta 之类的生成器：它带来一条宏与依赖链，换来的类型同步对这个规模的项目，
  这一个脚本 + 手写签名就能覆盖主要风险（拼写与漂移）。

领域与命令清单见[附录 C](#附录-cipc-领域与命令清单)。

### 5.7 拆大文件

每个拆分是一个 PR，只移动代码、不改行为，相关测试文件不改断言。

| 文件 | 拆法（目标文件） |
| --- | --- |
| `vscodeApi.ts`（4 585） | `hosts/vscodeApi/` 下：`index.ts`（组装 `vscode` 命名空间对象）、`types/`（`Position`、`Range`、`Selection`、`Uri`、`SnippetString`、`CodeActionKind`、`Disposable`、`EventEmitter`…）、`commands.ts`、`window.ts`（消息、quick pick、进度、状态栏、输出通道、webview 面板/视图、终端）、`workspace.ts`（配置、fs、watcher、文本文档提供者、文件系统提供者）、`languages.ts`、`env.ts`、`registrations.ts`（批量注册 `__ggsFlushRegistrations`）、`inert.ts`（不支持面的惰性注册与日志） |
| `extHost.ts`（4 219） | `features/extensions/host/` 下：`index.ts`（宿主装配）、`frames.ts`（每扩展一个沙箱 frame）、`activation.ts`（activationEvents、隐式 onLanguage）、`dispatch.ts`（进程命令分派、`commands.registerBatch`）、`pages.ts`（`ggs://` 页面、单例页面）、`webviews.ts`（面板、视图、`localizeAssetRoots`）、`statusItems.ts`、`outputChannels.ts`、`treeViews.ts`、`hostRequests.ts`（`ggs.hostRequest` 服务）、`pushes.ts`（theme/workspace/fs/documentSaved 推送）、`builtinCommands.ts`（`vscode.diff`、`vscode.open`、`setContext`、`workbench.view.*`）、`fsProviders.ts`、`mementos.ts` |
| `editor.ts`（3 399） | `features/editor/` 下：`group.ts`（EditorGroup）、`tabs.ts`、`breadcrumbs.ts`、`inputs/`（`fileInput.ts`、`diffInput.ts`、`historyInput.ts`、`extPageInput.ts`、`contentInput.ts`）、`open.ts`（`openEditor` 门面）、`placement.ts`（`EditorPlacement` 的落点计算）、`dirty.ts`（保存/关闭确认） |
| `workbench.ts`（2 250） | `workbench/` 下：`workbench.ts`（组装）、`layout.ts`（活动栏、侧栏、面板、编辑区的 DOM 与尺寸）、`menus.ts`（`menus()` 与远程裁剪）、`boot.ts`（首帧、延迟服务、`post_first_paint`）、`lifecycle.ts`（打开/关闭文件夹、会话恢复、退出）、`dropTarget.ts`（窗口级拖放） |
| `scm.ts`（1 755） | `features/scm/` 下：`view.ts`（视图骨架）、`commitInput.ts`、`groups.ts`（Merge / Staged / Changes）、`rowActions.ts`、`menus.ts` |
| `nodeShims.ts`（1 694） | `hosts/nodeShims/` 下按 builtin：`path.ts`、`os.ts`、`events.ts`、`util.ts`、`fs.ts`、`buffer.ts`、`process.ts`、`index.ts`（模块表）；已存在的 `processSurfaces.ts`、`stream.ts`、`shared.ts` 保留 |
| `i18n.ts`（1 645） | 不拆逻辑；把字符串表移到 `platform/i18n/en.ts`、`platform/i18n/zh-cn.ts`，`i18n.ts` 只留 `t()` 与回退逻辑。可选：生成 `I18nKey` 字面量联合类型，让 `t('不存在的键')` 在 typecheck 时失败 |
| `hexView.ts`（1 415）、`editorArea.ts`（1 361） | 观察 R10 报警，P5 末评估；不强制 |

Rust 侧对应（P3 中随 crate 迁移进行）：`applets.rs` → `applets/*`（见 4.2 ggs-bash）；
`can_log.rs` → `ggs-can` 的 8 个文件；`cmd_ext.rs` → `ggs-ext` 的 `store/vsix/page/fsapi/log`；
`cmd_providers.rs` → `ggs-providers` 的 10 个文件；`lib.rs` → app 的 `cli/boot/window/commands`；
`viewer/mod.rs` → `ggs-text::viewer::{session, edit, highlight, save}` + app 适配；
`mcp.rs` → `ggs-mcp::{server, tools/*, log}`。

### 5.8 构建入口

| 入口 | 今天 | 之后 |
| --- | --- | --- |
| `index.html` → `src/main.ts` | 不变 | 不变 |
| `ext-host.html` → `src/extHostBoot.ts` | | → `src/hosts/extHostBoot.ts` |
| `relay.html` → `src/remote/relayMain.ts` | 不变 | 不变 |
| `remote.html` → `src/remote/boot.ts` | 不变 | 不变 |
| `prepare.mjs` / `scripts/build-node-host.mjs` 构建 `node-host.cjs`（`src/nodeHost.ts`）与 `vscode-shim.cjs`（`src/ggsVscodeShim.ts`） | | → `src/hosts/…`，脚本路径同步 |
| `vite.remote.config.ts` 的 `@tauri-apps/api` 别名 | 不变 | 不变（`platform/ipc/core.ts` 仍 import `@tauri-apps/api/core`，别名在 bundler 层替换） |

可选（以 P0 的 typecheck 时间决定）：按层的 `tsconfig` project references
（`platform` → `features` → `workbench` / `hosts` / `remote`），`tsc -b` 增量 typecheck；
层规则也会因 references 而被编译器强制。今天 `tsconfig.json` 只有 `"include": ["src"]`。

### 5.9 前端测试

- `tests/<module>.test.ts` 的命名与归属不变（AGENTS.md 约定），只改 import 路径。
- 每个 P5 的移动 PR 必须让 `npm test` 全绿且**不修改任何断言**；若必须改断言，说明这是
  行为变化，拆出去单独提交。
- `tests/uiSweep.test.ts`、`commandSweep.test.ts`、`themeContrast.themes.test.ts`、
  `selfTest.test.ts` 是结构重组的安全网：它们遍历所有命令和视图，任何漏注册都会在这里暴露。
- 新增：`tests/ipcContract.test.ts`（见 5.6）、`tests/hooks.test.ts`（每个扩展点的默认实现
  与远程实现都可安装、可替换）。

---

## 6. 模块清单机器化

AGENTS.md 的模块图是"每个文件恰属一个模块"的契约，但它是手写的长文，已经漂移（见 1.3）。
同时，各模块小节中混入了大量变更史（日期、事故复盘），使文件本身超过百 KB，难以作为"每次
改动都要查阅的地图"。

提案：

1. 新增 `modules.json`（仓库根），每个模块一条：

   ```json
   {
     "id": 9,
     "name": "Source Control",
     "mission": "Stage / commit / history / git commands",
     "ts": ["src/features/scm/"],
     "rust": ["src-tauri/crates/ggs-git/", "src-tauri/src/commands/scm.rs"],
     "tests": ["tests/scm.test.ts", "tests/fileHistory.test.ts"]
   }
   ```

2. `check-seams.mjs` 校验：`src/`、`src-tauri/src/`、`src-tauri/crates/*/src/` 下每个源文件
   **恰好**被一个模块的路径前缀覆盖；每个模块的测试文件存在。
3. AGENTS.md 的模块图改为引用目录与 crate（"模块 9：`src/features/scm/`、`ggs-git`、
   `commands/scm.rs`"），逐文件枚举交给 `modules.json`；各模块小节中的历史叙述迁移到
   `docs/history/<module>.md`（或保留在提交历史中），AGENTS.md 保留"现在是什么、为什么这样"。
   这一条涉及 owner 的文档习惯，**需要 owner 拍板**；不拍板也不影响前两条执行。
4. 模块自测（`selfTestSuites.ts`）的分组可以从 `modules.json` 读取名称与顺序，消除第三份
   模块列表。

---

## 7. 分阶段执行（PR 级清单）

通用要求（每个 PR）：

- 一个 PR 一件事；结构 PR 只移动 / 改 import / 提取函数，不改行为；
- 文件移动一律 `git mv`；
- 通过：`npm run typecheck`、`npm test`（含接缝检查）、`cargo test`（相应 crate 或 workspace）、
  `cargo clippy --workspace --all-targets -- -D warnings`；
- 触及启动、资源、IPC、打包、`prepare.mjs` 的 PR 跑一次 `npx tauri dev`；触及打包的 PR
  跑一次 `npx tauri build` 并核对安装目录；
- 同一个 PR 内更新 AGENTS.md 模块图（或 P6 之后的 `modules.json`）与必要时的开发计划 §3 路径；
- Conventional Commits，scope 用模块或 crate 名（`refactor(ggs-git): …`、`build(workspace): …`）。

### P0：基线（0.5–1 天）

| PR | 内容 | 验证 |
| --- | --- | --- |
| P0-1 | `scripts/measure-build.mjs`：冷编译（`cargo build --timings`）、四个增量场景（脚本自动 `touch`/追加注释再还原）、`cargo test --no-run`、`npm run typecheck`、`npm test` 时长、target 目录分项大小、四个产物的 `cargo tree -e normal` crate 数、`cargo tree -d` 重复数；写入 `metrics.json` 的 `build.*`；`--json` 输出供 PR 描述粘贴 | 本机跑两遍，数字稳定（波动 < 10%） |
| P0-2 | 查明 `src-tauri/target/`（9.7 GB）的写入者；若是 rust-analyzer，在 `.vscode/settings.json` 设 `rust-analyzer.cargo.targetDir` 指向 `target/studio/ra`（与构建分开，避免互相使锁/指纹失效）；README 补"磁盘维护"一节（`cargo sweep` 用法） | 清理后重新打开 IDE，目录不再出现 |

### P1：先上护栏（1–1.5 天）

| PR | 内容 | 验证 |
| --- | --- | --- |
| P1-1 | `check-seams.mjs` 增加 TS import 图分析：R1–R7、R10；现状违例全部写入 `seams-allowlist.json`；新增违例即失败 | 人为加一条 `editor → remote` import，检查失败；删掉后通过 |
| P1-2 | `scripts/check-ipc.mjs`（附录 D）；以当前 `lib.rs` 为 Rust 侧来源 | 当前状态通过（或把发现的不一致登记为待办并修正） |
| P1-3 | `scripts/check-crate-graph.mjs` 骨架：此时只有一个 crate，先实现"`git-graph-core` 不得出现"的源码扫描（从 `build.rs` 复制，`build.rs` 暂留）与白名单格式 | 人为在 `src/` 写入 `git_graph_core` 字样，检查失败 |
| P1-4 | `test_support` 加 `#[cfg(any(test, feature = "testkit"))]`；`cmd_ext` 的 `*_for_tests` 同样门控 | `cargo build --release` 产物中不再含这些符号（`cargo build` 通过即可证明门控生效） |

### P2：workspace、L0 与 sidecar（4–6 天，收益最大的阶段）

顺序按"依赖最少、收益最大"。每步结束复测 P0 的增量场景。

| PR | 内容 | 关键点 | 验证 |
| --- | --- | --- | --- |
| P2-1 | workspace 骨架：根 manifest 增加 `[workspace] members = ["crates/*"]`、`[workspace.package]`、`[workspace.dependencies]`（先把现有所有依赖原样搬进去，app 改为 `workspace = true` 引用）、`[workspace.lints]` | 行为零变化；`Cargo.lock` 不变或只有元数据变化 | 全套测试；`cargo tree` crate 数不变 |
| P2-2 | `ggs-base`：路径、`atomic_write`、`percent_decode`、`read_line_bounded`、`jsonc`、`WorkspaceRoots`、`Generation`、`sink` | 原调用点改引用；`cmd_fs ⇄ cmd_ext` 的两条 base 级边消失 | `cargo test -p ggs-base`；全套测试 |
| P2-3 | `ggs-proto`：`git mv ext_protocol.rs` | — | 全套测试 |
| P2-4 | `ggs-codec`：`git mv` hashes/compress/archive；`ggs_bash` 与 `remote_config` 改引用 | 测试向量随迁 | `cargo test -p ggs-codec` |
| P2-5 | `ggs-git`（一）：`locate`——从 `pref.rs` 移出 `find_git_exe`、`find_git_bash`、`git_usr_bin_from` 及注册表/安装根探测 | `git.rs`、`pty.rs`、`ggs_bash/exec.rs` 改引用 | 相应测试 |
| P2-6 | `ggs-git`（二）：`git.rs` 运行器、`backend_env`、ref/hash 校验 | 原则 2 的落点变化：同步修订开发计划 §3.2 与 AGENTS.md 不变量"writes never spawn git except …" 的路径 | 全套测试 |
| P2-7 | `ggs-shellenv`：`pref.rs` 剩余部分 | `cmd_providers`、`pty` 改引用；**此时 app 对 `ggs_bash` 的全部依赖只剩二进制本身** | 全套测试 |
| P2-8 | `ggs-bash` 独立 package：`git mv src/ggs_bash crates/ggs-bash/src`、`bin/ggs_bash.rs`、`tests/it/ggs_bash_cli.rs`；删除 `ggs-bash` 特性与 `required-features`；新增 `tauri.windows.conf.json` 的 `externalBin`；`prepare.mjs` 在 Windows 上构建并按 triple 命名复制；删除 `signing.mjs`、Linux 容器脚本、`build-studio.sh` 中清空特性表的 `--config` merge；CI 去掉 `-- --skip ggs_bash`、Windows job 加 `-p ggs-bash` | **桌面 crate 从此不编 28k 行 shell**；`ggs_bash` 测试对 `ext_process` 的引用改为 `CARGO_BIN_EXE_ggs-bash` | Windows：`npx tauri build`，核对 NSIS 安装目录有 `ggs-bash.exe`、终端默认 shell 与 claude 的 `CLAUDE_CODE_GIT_BASH_PATH` 副本正常；macOS/Linux：包内没有 ggs-bash；`scripts/probes/ggs-bash-parity-diff.sh` 通过 |
| P2-9 | `ggs-node` 独立 package：`git mv src/node_runtime`、`bin/ggs_node.rs`、`build.rs` 的 N-API 导出段、`tests/it/node_runtime.rs`、`vscode_shim_boa.rs`、`examples/boa_bench.rs`；删除 `node-runtime` 特性；`prepare.mjs` 的 `buildBackend` 改 `-p ggs-node`（不再 `--no-default-features`） | bin 与 build.rs 必须同 package | `cargo test -p ggs-node`；`scripts/probes/git-graph-live-check.mjs`（engine `.node` 在 ggs-node 下应答）；`claude-code-live-check.mjs` |
| P2-10 | `ggs-remote-proto`：从 `remote_host.rs` 提出控制消息；daemon 改 path 依赖并删除副本；`tests/it/remote_control_vectors.rs` 变为该 crate 单测 | daemon 仍是独立 workspace；该 crate 零平台依赖 | daemon `cargo test`；`remote-live-check.mjs` |
| P2-11 | `ggs-config` 独立 package；`externalBin` 增加 `ggs-config`；`cli.rs` 的 `ggs config` 分派改调 `ggs_config::run`；`check-seams.mjs` 例外路径更新 | PATH 上的 `ggs-config` 来自 externalBin | 三平台安装后 `ggs-config --help`、`ggs config --help` |
| P2-12 | `ggs-testkit`：`git mv test_support.rs`；去掉对 `cmd_ext` / `ext_process` 的调用，相关测试自行构造；删除 P1-4 加的 `testkit` 特性 | 生产代码中 `for_tests` 函数清零 | `rg "for_tests" src-tauri/src` 无结果 |
| P2-13 | 复测 P0 全部指标，结果写入本文档"实施状态"段 | — | — |

### P3：领域逻辑下沉（6–10 天）

先做抽象，再按"依赖少的先走"的顺序逐个领域迁移。每个领域内部的步骤固定：

1. 在原文件内把每个 `#[tauri::command]` 拆成"适配 + 纯函数"（PR-a，行为零变化）；
2. `git mv` 原文件到新 crate，适配函数移到 `src/commands/<domain>.rs`（PR-b）；
3. 在新 crate 内按 4.2 的模块划分拆文件（PR-c，可选，大文件必做）。

| PR | 内容 | 关键点 |
| --- | --- | --- |
| P3-1 | `ggs_base::sink` 落地；app 新增 `events.rs`；挑 `cmd_search` 的一个流式命令做样板 | 首批 200 ms 的性能测试保持通过 |
| P3-2 | `ggs-can`（a/b/c）：8 个命令适配；`can_log.rs` 拆 8 个文件 | `tests/canLog.test.ts` 与 `verify-can-scroll.mjs` |
| P3-3 | `ggs-text`（a/b/c）：`encoding.rs`、`viewer/*`、`ext_grammar.rs`；`ViewerSessions` 状态类型；`probe` 下沉 | `viewer_bench` 前后对比；`verify-indexed-view.mjs` |
| P3-4 | `ggs-fs`（a/b/c）：`cmd_fs.rs` 的逻辑；`TransferCancel`；`FileListCache`；revision/repo_head 部分移到 `ggs-git`；`remote_paths_policy` / `remote_ext_roots` / `session_log_file` 留 app | `cmd_fs.rs` 的 `transfer_tests` 随迁；dev harness 的 `?full=1` 传输检查 |
| P3-5 | `ggs-git`（三）：`cmd_scm.rs` 与 `scm_ops.rs` 的逻辑（status/log/blame/ops/gerrit）；gerrit hook 下载移到 app 适配 | 41 个 scm 命令适配；`git-graph-menus-live-check.mjs` |
| P3-6 | `ggs-index`（a/b/c）：`cmd_search`、`cmd_symbols`、`symbols/*`、`cmd_fuzzy`；`scan` 模块解环；`grammar-*` 特性迁移；`perf.rs` 迁移 | `perf.rs` 预算不放宽；`symbolIndex.test.ts`、`searchView.test.ts` |
| P3-7 | `ggs-analysis`：`analysis/*`、`cmd_analysis` 的 `AnalysisIndex` | `analysis.test.ts`；`dump-diagram` 输出与迁移前逐字节一致 |
| P3-8 | `ggs-mcp`：`mcp.rs`；`cli.rs` 分派 | `mcp.rs` 单测随迁；`claude_mcp_status`；手工 `ggs --mcp .` 握手 |
| P3-9 | `ggs-ext`（一）：`store`、`vsix`、`page`、`fsapi`、`log`（`cmd_ext.rs` 的逻辑）；`ExtStore::at(dir)` | `extensions.test.ts`；安装/升级/卸载的 Rust 测试 |
| P3-10 | `ggs-ext`（二）：`process`、`routing`、`child`；`global()` → `ExtHost`；`HOST_REQUEST_FRONTEND` → 字段；事件经 `EventSink` | 启动顺序测试；`claude-code-live-check.mjs`；远程 `remote-live-check.mjs`（路由） |
| P3-11 | `ggs-ext`（三）：`gallery` | 来源约束（origin confinement）的测试随迁 |
| P3-12 | `ggs-providers`：`cmd_providers.rs` 的逻辑；"重启桥接后端"移到 app `wiring.rs` | `providers.test.ts`；spawn-env 守卫测试；切换 provider 后后端重启的 dev harness 场景 |
| P3-13 | `AppState` 拆分（4.6），一次拆一个字段，最后删除 `AppState` | `deferred_services_tests`、`open_folder_impl_tests`、`workspace_tests` |
| P3-14 | 复测 P0 指标 | — |

P3 的 PR-a（拆适配与纯函数）可以先于对应 crate 的创建、并行地在多个领域进行。

### P4：app crate 瘦身（2–3 天）

| PR | 内容 |
| --- | --- |
| P4-1 | `lib.rs` 拆为 `cli.rs`、`boot/*`、`window/*`、`commands/mod.rs`（`generate_handler!` 清单）、`state.rs`、`wiring.rs`、`protocol.rs`；`lib.rs` ≤ 200 行 |
| P4-2 | 删除 `desktop` 特性；`default-run`、`[[bin]]` 只剩主程序；`build.rs` 只剩 tauri 代码生成与 manifest 依赖；`git-graph-core` 扫描完全交给 `check-crate-graph.mjs` |
| P4-3 | `check-crate-graph.mjs` 白名单与 4.3 完全一致，豁免清空；`check-ipc.mjs` 的 Rust 侧来源改为 `commands/mod.rs` |
| P4-4 | 开发计划 §3、AGENTS.md 不变量、README "Layout" 一节的路径全部更新 |

### P5：前端重组（6–9 天，可与 P3 并行）

| PR | 内容 | 关键点 |
| --- | --- | --- |
| P5-1 | `platform/`：移动 `i18n`、`settings`、`state`、`commands`、`keybindings`、`lazy`、`markdown`；`ui.ts` 拆为 `platform/ui/*` + 门面 | 55 个 `ui.ts` 引用方只改路径；门面保持原导出名 |
| P5-2 | `platform/fileIcons.ts`、`platform/extAssets.ts`、类型下沉（5.4）——**解开 6 文件大环** | Tarjan 检查：该 SCC 消失 |
| P5-3 | `platform/hooks.ts` + `remote/desktopHooks.ts`；16 处核心 → remote 改为 `hook()`（可拆 3 个 PR：editor/docEditView/panel；extHost；workbench/transfer） | `tests/remote*.test.ts`、`npm run test:e2e-remote`、`remote-sync-check.mjs` |
| P5-4 | `platform/ipc/*`：按领域逐个 PR 迁移 `invoke` 调用（fs、scm、search/symbols、viewer、can、ext、providers、其余） | `tests/ipcContract.test.ts`；`check-ipc.mjs` 的 TS 侧来源收敛到 `platform/ipc/` |
| P5-5 | `features/*` 逐模块 `git mv` + `index.ts` + `types.ts`：explorer、quickOpen、search、editor、viewers、compare、scm、terminal、extensions、providers、can、selftest、mcp、analysis（每个模块一个 PR） | 每个 PR 删除对应的豁免条目 |
| P5-6 | `workbench/`：移动 titlebar/statusbar/panel/settingsPanel/shell.css | — |
| P5-7 | `hosts/`：移动 nodeHost、nodeHostEsm、ggsVscodeShim、extHostBoot、extModuleLoader、vscodeApi、nodeShims、vscodeNamespaceProbe；同步 `ext-host.html`、`build-node-host.mjs`、`prepare.mjs`、`vite.config.ts` | `nodeHostEsm.test.ts`、`vscodeNamespaceProbe.test.ts`；`npx tauri dev` 下扩展激活 |
| P5-8 | 拆 `vscodeApi.ts` | `extensions.test.ts`（4 045 行，最强的安全网） |
| P5-9 | 拆 `extHost.ts` | 同上 + `claudeChatInject.test.ts` |
| P5-10 | 拆 `editor.ts` | `editor.test.ts`、`editorArea.test.ts`、`remoteWorkbenchSync.test.ts` |
| P5-11 | 拆 `workbench.ts` | `workbenchParts.test.ts`、`workbenchLifecycle.test.ts`、`uiSweep.test.ts` |
| P5-12 | 拆 `scm.ts`、`nodeShims.ts`、`i18n.ts`（字符串表外置；可选 `I18nKey` 类型） | — |
| P5-13 | 豁免清单清零；评估 tsconfig project references（以 P0 typecheck 时间为准） | — |

### P6：依赖、磁盘、清单（2–3 天，按实测取舍）

| PR | 内容 |
| --- | --- |
| P6-1 | `modules.json` + 覆盖性检查（第 6 节第 1、2 条）；自测分组改读它（第 4 条） |
| P6-2 | 对齐我们自己的直接依赖版本（`getrandom`、`base64` 等），`cargo tree -d` 数入 metrics |
| P6-3 | 与 ci-speed-plan P3 合流：`ggs-codec` 补 SHA-512 / HMAC / PBKDF2（标准测试向量先行），`ggs-node` 去掉 `md-5`、`sha1`、`hmac`、`pbkdf2` |
| P6-4 | 本地 dev profile 评估 `debug = "line-tables-only"`（CI 已是），以 P0 的 target 大小与 rebuild 时间决定；README 的磁盘维护建议定稿 |
| P6-5 | 评估 app / daemon / hub 共用一个 target 目录（共享 tokio / rustls / serde 的产物）：三个 workspace 的 `Cargo.lock` 解析结果、profile 是否一致决定复用率；只有 P0 指标证明有收益才做 |
| P6-6 | AGENTS.md 模块图改为目录 / crate 级引用（第 6 节第 3 条，需 owner 同意） |

### 工期与并行

| 阶段 | 工期 | 前置 |
| --- | --- | --- |
| P0 | 0.5–1 天 | — |
| P1 | 1–1.5 天 | P0 |
| P2 | 4–6 天 | P1 |
| P3 | 6–10 天 | P2（P3 的各 PR-a 可提前） |
| P4 | 2–3 天 | P3 |
| P5 | 6–9 天 | P1（与 P2–P4 并行） |
| P6 | 2–3 天 | P4、P5 |

合计约 22–33 个人日；P5 与 P2–P4 并行时墙钟约 15–22 天。任意阶段结束都是一个可发布、
比之前更好的状态——计划可以在任何阶段边界暂停。

---

## 8. 脚本、CI、打包、文档的同步改动

| 文件 | 改动 | 阶段 |
| --- | --- | --- |
| `src-tauri/Cargo.toml` | workspace、`[workspace.dependencies]`、`[workspace.lints]`；删除三个形态特性与三个附加 `[[bin]]`；`grammar-*` 透传 | P2-1、P2-8/9/11、P4-2 |
| `src-tauri/build.rs` | 移走 N-API 导出（→ `crates/ggs-node/build.rs`）与源码扫描（→ 脚本） | P2-9、P4-2 |
| `src-tauri/tauri.conf.json` | 删除 `build.features`；`externalBin` 加 `ggs-config` | P2-8、P2-11 |
| `src-tauri/tauri.windows.conf.json`（新） | `externalBin` 列 `ggs-node`、`ggs-bash`、`ggs-config`（JSON merge 对数组是整体替换，所以列全） | P2-8 |
| `scripts/prepare.mjs` | `buildBackend` 改 `-p <package>`；Windows 额外构建 ggs-bash；三个 sidecar 统一按 triple 命名复制；host 脚本路径 | P2-8/9/11、P5-7 |
| `scripts/signing.mjs` | 删除清空特性表的 merge | P2-8 |
| `scripts/docker/studio-linux-build.sh`、`scripts/build-studio.sh` | 删除 `--config` 特性清空 | P2-8 |
| `scripts/build-studio.bat` | ggs-bash 构建方式 | P2-8 |
| `scripts/check-seams.mjs` | 调用 TS 图检查、`check-ipc.mjs`、`check-crate-graph.mjs`；例外路径更新 | P1、P2-11 |
| `scripts/measure.mjs` | 合并 `measure-build.mjs` 的输出到 `metrics.json` | P0 |
| `scripts/build-node-host.mjs` | 入口路径 → `src/hosts/` | P5-7 |
| `vite.config.ts`、`ext-host.html` | 入口路径 | P5-7 |
| `.github/workflows/studio.yml` | `cargo test --workspace`（Windows 含 `-p ggs-bash`，其它平台 `--exclude ggs-bash`）；clippy 同理；去掉 `--skip ggs_bash`；rust-cache 的 `workspaces` 不变（target 目录不变） | P2-8 |
| `.github/workflows/release.yml` | 随 studio.yml；无独立改动 | — |
| `extensions-src/ggs-remote/daemon/Cargo.toml` | path 依赖 `ggs-remote-proto` | P2-10 |
| `src-tauri/nsis-hooks.nsh` | 若卸载逻辑按文件名清理 `ggs-bash.exe` / `ggs-config.exe`，核对 externalBin 的安装名一致 | P2-8、P2-11 |
| `docs/ggs-development-plan.md` §3 | 原则 2 / 5 / 7 的路径 | P2-6、P4-4 |
| `AGENTS.md` | 模块图路径、Quick start 命令（`cargo test --workspace`）、不变量路径、Testing 表 | 每个阶段 |
| `README.md` | Layout、构建说明、磁盘维护 | P2、P4、P6 |

---

## 9. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| tauri bundler 打包的二进制集合变化（ggs-bash / ggs-config 从"app 自带 bin"变成 externalBin） | 安装包缺文件、PATH 上没有 `ggs-config` | P2-8、P2-11 各跑一次 `npx tauri build`；核对 NSIS 安装目录、卸载钩子、`cmd_assoc::user_path_apply` 追加的 PATH；macOS / Linux 核对 ggs-bash 不在包里 |
| N-API 符号导出随 bin 搬家失效 | git-graph-rs 的 engine `.node` 加载失败，Git Graph 视图空白 | bin 与 build.rs 同在 `crates/ggs-node`；`node_runtime.rs` 中"addon 在 ggs-node 下应答"的集成测试与 `git-graph-live-check.mjs` 必须通过 |
| `ggs-node` profile（`panic = "unwind"`、`opt-level = 3`）在 workspace 中的行为 | sidecar 变成 abort 或变慢 | profile 仍在根 manifest；`-p ggs-node --profile ggs-node`；用 `boa_bench` 对比激活时间（claude-code 冷激活 0.79 s / 暖 0.41 s 的基线） |
| 显式状态替换全局单例时漏掉初始化顺序 | 启动时 panic 或服务没启动 | 一次只换一个单例；启动顺序测试全绿；`npx tauri dev`；dev harness `?full=1` |
| 事件名在 `EventSink` 化时拼错 | 前端收不到推送，只在运行时暴露 | 事件名集中为 `ggs-base::events` 常量（Rust）与 `platform/ipc/events.ts`（TS），`check-ipc.mjs` 一并核对 |
| 前端大规模 `git mv` 与并行开发冲突 | 合并冲突、丢改动 | 一个模块一个 PR，合并窗口短；先合 `platform/`，再逐个 `features/`；移动 PR 不夹带其它改动，冲突时可直接重做 |
| 远程 bundle（`vite.remote.config.ts`）的别名与 hooks 安装顺序 | 远程页面功能缺失（历史上发生过） | 触及 remote 的 PR 跑 `tests/remote*.test.ts`、`npm run test:e2e-remote`、`remote-live-check.mjs`、`remote-sync-check.mjs` |
| crate 数增加带来的冷编译元数据开销 | 冷编译不降反升 | P0/P2-13 实测；L0 crate 很小，开销可忽略；若某 crate 只有一个使用者且很小，可合并回去（白名单允许调整） |
| CI 缓存（`Cargo.lock` 位置不变，但产物路径变化） | 第一次 run 冷启动 | 预期内，与 ci-speed-plan 的 timings artifact 对照；之后暖缓存应更好（改动只失效部分 crate） |
| daemon 引用 app 树里的 `ggs-remote-proto` | 插件 CI 需要 checkout app 的路径 | daemon 与 app 同仓库，路径依赖可用；`ggs-remote-proto` 零平台依赖，不会把 WebKitGTK 带进插件 CI |
| AGENTS.md / 开发计划路径更新遗漏 | 文档误导后续改动 | 每阶段 PR 的 Definition of done 包含文档路径；P6-1 的 `modules.json` 覆盖性检查把漂移变成构建失败 |

---

## 10. 不做的事

- 不引入前端框架（原则 3）、不引入 IPC 代码生成器、不更换 Tauri / Boa / tree-sitter / syntect。
- 不在重组过程中改行为：每个移动 PR 只移动 + 改 import；行为修复单独提交、先写红灯测试。
- 不放宽任何 sweep / perf budget（`perf.rs`、`uiSweep`、`commandSweep`、`themeContrast`）
  来让重组通过。
- 不把 daemon / hub 并进 app 的 workspace（插件 CI 无 WebKitGTK 的约束仍在）。
- 不追求"每个文件一个 crate"：crate 的粒度以"有独立的依赖集合或独立的变化频率"为准，
  L1 层大约 10 个 crate 即可；更细的划分用 crate 内模块完成。
- 不在本计划内把 `ggs --mcp` 拆成独立二进制（记录为后续选项）。

---

## 11. 验收

- 第 3 节每项度量都有"之前 / 之后"的实测数字，写进对应 PR 的描述和 `metrics.json`。
- `check-crate-graph.mjs`、TS 分层/无环检查、`check-ipc.mjs` 在 CI 中为失败级别，豁免清单为空。
- `cargo tree -i tauri --workspace` 只出现 app。
- 除 app 外的所有 crate 可以 `cargo test -p <crate>` 在没有 WebKitGTK 的 Linux 上通过。
- 生产代码中没有 `for_tests`、没有 `pub mod test_support`、没有形态特性。
- TS：0 个强连通分量；`features/`、`workbench/`、`hosts/` 中 0 个 `remote/` 静态 import；
  0 个 `platform/ipc/` 之外的 `@tauri-apps/api/core` import。
- 每个源文件恰属一个模块（`modules.json` 覆盖性检查通过）；AGENTS.md 与新路径一致。
- 全套 Definition of done：`npm run typecheck`、`npm test`、`cargo test --workspace`
  （Windows 含 ggs-bash）、`cargo clippy --workspace --all-targets -- -D warnings`；触及启动/
  打包的阶段跑 `npx tauri dev` 与一次 `npx tauri build`。

---

## 附录 A：Rust 逐文件迁移表

路径相对 `src-tauri/src/`；"→ app" 表示留在 app crate（`src-tauri/src/` 下的新位置）。

| 今天 | 行数 | 去向 | 备注 |
| --- | ---: | --- | --- |
| `lib.rs` | 2 342 | → app：`lib.rs`（≤200）、`cli.rs`、`boot/{context,launch,workspace,services,dev_harness}.rs`、`window/{main_window,linux}.rs`、`commands/{mod,settings}.rs`、`state.rs`；`atomic_write`、`strip_jsonc`、`find_repo_root`、`is_repo_below`、设置/快捷键文件路径 → `ggs-base` | 内含 5 组测试随各自函数走 |
| `main.rs` | 11 | → app | 不变 |
| `bin/ggs_bash.rs` | 8 | → `crates/ggs-bash/src/main.rs` | |
| `bin/ggs_config.rs` | 12 | → `crates/ggs-config/src/main.rs` | |
| `bin/ggs_node.rs` | 19 | → `crates/ggs-node/src/main.rs` | 全局分配器声明随迁，去掉 `cfg(feature)` |
| `test_support.rs` | 153 | → `crates/ggs-testkit/src/lib.rs` | 去掉对 cmd_ext / ext_process 的调用 |
| `ext_protocol.rs` | 402 | → `crates/ggs-proto/src/lib.rs` | |
| `git.rs` | 418 | → `crates/ggs-git/src/{runner,validate,env}.rs` | 原则 2 的新落点 |
| `scm_ops.rs` | 1 112 | → `crates/ggs-git/src/ops/*.rs`、`gerrit.rs` | `ureq` 下载 → app `commands/scm.rs` |
| `cmd_scm.rs` | 733 | 逻辑 → `ggs-git::{status,log,blame}`；41 个命令 → app `commands/scm.rs` | `State<AppState>` → `State<WorkspaceRoots>` |
| `cmd_fs.rs` | 2 638 | 逻辑 → `ggs-fs::{dir,read,write,ops,copy,transfer,zip,upload,backup,walk}`；revision/repo_head/submodules → `ggs-git`；`probe` → `ggs-text`；其余命令 → app `commands/fs.rs`（34 个命令中的文件服务部分）；`remote_paths_policy`、`remote_ext_roots` → app `commands/remote.rs`；`session_log_file` → app | `transfer_tests` 随 `ggs-fs` |
| `cmd_fuzzy.rs` | 390 | → `ggs-index::fuzzy`；2 个命令 → app `commands/fuzzy.rs` | |
| `cmd_search.rs` | 1 558 | → `ggs-index::{scan,search,replace,compare,hexdiff}`；7 个命令 → app `commands/search.rs` | `SearchState` → `Generation` |
| `cmd_symbols.rs` | 735 | → `ggs-index::symbols::index`；5 个命令 → app `commands/symbols.rs` | |
| `symbols/mod.rs` | 9 | → `ggs-index::symbols` | |
| `symbols/parse.rs` | 1 177 | → `ggs-index::symbols::parse`（含 `.scm` 查询） | 9 处 `cfg(feature = "grammar-*")` 随迁 |
| `symbols/store.rs` | 1 239 | → `ggs-index::symbols::store` | |
| `analysis/mod.rs` | 808 | → `ggs-analysis::lib` + `callgraph.rs` | |
| `analysis/bca.rs` | 168 | → `ggs-analysis::bca` | big-code-analysis 唯一使用点 |
| `analysis/deadcode.rs` | 132 | → `ggs-analysis::deadcode` | |
| `analysis/diagram.rs` | 1 187 | → `ggs-analysis::diagram` | |
| `analysis/imports.rs` | 419 | → `ggs-analysis::imports` | |
| `analysis/metrics.rs` | 154 | → `ggs-analysis::metrics` | |
| `analysis/modules.rs` | 400 | → `ggs-analysis::modules` | |
| `analysis/security.rs` | 492 | → `ggs-analysis::security` | |
| `cmd_analysis.rs` | 705 | `AnalysisIndex` 与报告流 → `ggs-analysis::index`；8 个命令 → app `commands/analysis.rs` | |
| `mcp.rs` | 2 261 | → `ggs-mcp::{server,tools/*,log}`；2 个命令 → app `commands/mcp.rs` | |
| `encoding.rs` | 267 | → `ggs-text::encoding` | |
| `viewer/mod.rs` | 2 369 | → `ggs-text::viewer::{session,edit,highlight,save,symbols}`；14 个命令 → app `commands/viewer.rs` | 48 处 tauri 引用全部留在适配层 |
| `viewer/doc.rs` | 670 | → `ggs-text::viewer::doc` | |
| `viewer/find.rs` | 444 | → `ggs-text::viewer::find` | |
| `viewer/indexed.rs` | 881 | → `ggs-text::viewer::indexed`；4 个命令 → app | |
| `viewer/outline.rs` | 377 | → `ggs-text::viewer::outline` | |
| `ext_grammar.rs` | 433 | → `ggs-text::grammar` | |
| `can_log.rs` | 5 153 | → `ggs-can::{blf,asc,frames,stats,intervals,convert,session,find}`；8 个命令 → app `commands/can.rs`；`read_line_bounded` → `ggs-base` | |
| `cmd_ext.rs` | 4 825 | → `ggs-ext::{store,vsix,page,fsapi,log,loadcode,nodeenv}`；14 个命令 → app `commands/ext.rs`；`ggs://` 注册 → app `protocol.rs` | `pin_*_for_tests` 删除 |
| `ext_page_boot.js` | 95 | → `crates/ggs-ext/src/page_boot.js` | `include_str!` 路径随迁 |
| `ext_process.rs` | 1 568 | → `ggs-ext::process`；9 个命令 → app `commands/ext_process.rs` | `global()` → `ExtHost` |
| `ext_routing.rs` | 498 | → `ggs-ext::routing` | |
| `ext_child.rs` | 266 | → `ggs-ext::child`；6 个命令 → app `commands/ext_child.rs` | |
| `ext_gallery.rs` | 654 | → `ggs-ext::gallery`；5 个命令 → app `commands/gallery.rs` | |
| `cmd_providers.rs` | 4 046 | → `ggs-providers::{store,seal,presets,choice,env,claude_settings,claude_mcp,probe,usage,ccswitch}`；11 个命令 → app `commands/providers.rs`；重启后端 → app `wiring.rs` | |
| `cmd_app.rs` | 357 | → app `instance.rs`（`app_new_instance`）+ `window/macos.rs`（Dock 菜单） | |
| `cmd_assoc.rs` | 858 | → app `assoc.rs`；3 个命令 → app `commands/assoc.rs` | 依赖 winreg、plist，只在 app |
| `pty.rs` | 444 | → app `pty.rs`；6 个命令 → app `commands/pty.rs` | 改用 `ggs-git::locate`、`ggs-shellenv` |
| `watcher.rs` | 346 | → app `watcher.rs` | 订阅者经 `wiring.rs` 注册 |
| `remote_host.rs` | 1 208 | → app `remote_host.rs`；消息类型 → `ggs-remote-proto`；6 个命令 → app `commands/remote.rs` | |
| `remote_config.rs` | 369 | → `crates/ggs-config/src/lib.rs` | 命名接缝例外随迁 |
| `measure.rs` | 231 | → app `measure.rs` | 改调各 crate |
| `stage_bench.rs` | 139 | → app `stage_bench.rs` | 去掉 feature 门控 |
| `ggs_bash/hashes.rs` | 591 | → `ggs-codec::hash` | |
| `ggs_bash/compress.rs` | 410 | → `ggs-codec::{deflate,gzip}` | |
| `ggs_bash/archive.rs` | 627 | → `ggs-codec::{tar,zip}` | |
| `ggs_bash/pref.rs` | 613 | 定位 → `ggs-git::locate`；其余 → `ggs-shellenv` | |
| `ggs_bash/applets.rs` | 9 527 | → `ggs-bash::applets/{mod,text,fs,ls,grep,sed,find,sort_uniq,digest,archive,convert,term,misc}.rs` | |
| `ggs_bash/` 其余 15 个文件（`mod`、`exec`、`builtins`、`lex`、`parse`、`ast`、`expand`、`awk`、`arith`、`lineedit`、`sysinfo`、`regexlite`、`glob`、`localtime`、`msys`） | 约 15 900 | → `crates/ggs-bash/src/` 同名 | `mod.rs` → `lib.rs` + `repl.rs` |
| `node_runtime/` 全部 15 个文件（含 `prelude.js`、`builtins/*`） | 8 751 + 5 238 JS | → `crates/ggs-node/src/` 同名 | `mod.rs` → `lib.rs` |

## 附录 B：TypeScript 逐文件迁移表

路径相对 `src/`。

| 今天 | 行数 | 去向 |
| --- | ---: | --- |
| `main.ts` | 37 | 不变（增加 `installDesktopRemoteHooks()` 调用） |
| `vite-env.d.ts` | 21 | 不变 |
| `ui.ts` | 706 | `platform/ui/{dom,codicon,notify,contextMenu,quickInput,progress,index}.ts` |
| `i18n.ts` | 1 645 | `platform/i18n.ts` + `platform/i18n/{en,zh-cn}.ts` |
| `settings.ts` | 500 | `platform/settings.ts` |
| `state.ts` | 162 | `platform/state.ts` |
| `commands.ts` | 152 | `platform/commands.ts` |
| `keybindings.ts` | 175 | `platform/keybindings.ts` |
| `lazy.ts` | 61 | `platform/lazy.ts` |
| `markdown.ts` | 140 | `platform/markdown.ts` |
| `findOptions.ts` | 33 | `platform/find/findOptions.ts` |
| `findHistory.ts` | 112 | `platform/find/findHistory.ts` |
| `themeMetrics.ts` | 141 | `platform/metrics/themeMetrics.ts` |
| `uiMetrics.ts` | 163 | `platform/metrics/uiMetrics.ts` |
| （新） | — | `platform/fileIcons.ts`、`platform/extAssets.ts`、`platform/hooks.ts`、`platform/env.ts`、`platform/ipc/*` |
| `workbench.ts` | 2 250 | `workbench/{workbench,layout,menus,boot,lifecycle,dropTarget}.ts` |
| `titlebar.ts` | 166 | `workbench/titlebar.ts` |
| `statusbar.ts` | 373 | `workbench/statusbar.ts` |
| `panel.ts` | 263 | `workbench/panel.ts` |
| `settingsPanel.ts` | 261 | `workbench/settingsPanel.ts` |
| `shell.css` | 1 812 | `workbench/shell.css` |
| `explorer.ts` | 979 | `features/explorer/explorer.ts` |
| `transfer.ts` | 192 | `features/explorer/transfer.ts` |
| `filePicker.ts` | 148 | `features/quickOpen/filePicker.ts` |
| `fuzzy.ts` | 152 | `features/quickOpen/fuzzy.ts` |
| `searchView.ts` | 699 | `features/search/searchView.ts` |
| `callTree.ts` | 241 | `features/search/callTree.ts` |
| `contextView.ts` | 103 | `features/search/contextView.ts` |
| `symbolDbView.ts` | 248 | `features/search/symbolDbView.ts` |
| `editor.ts` | 3 399 | `features/editor/{group,tabs,breadcrumbs,open,placement,dirty}.ts` + `inputs/*` |
| `editorArea.ts` | 1 361 | `features/editor/editorArea.ts` |
| `textEditor.ts` | 312 | `features/editor/textEditor.ts` |
| `comments.ts` | 159 | `features/editor/comments.ts` |
| `docEditView.ts` | 984 | `features/editor/docEditView.ts` |
| `docFind.ts` | 389 | `features/editor/docFind.ts` |
| `editorExtras.ts` | 480 | `features/editor/editorExtras.ts` |
| `autocomplete.ts` | 210 | `features/editor/autocomplete.ts` |
| `snippetRegistry.ts` | 290 | `features/editor/snippetRegistry.ts` |
| `findWidget.ts` | 294 | `features/editor/findWidget.ts` |
| `bookmarks.ts` | 54 | `features/editor/bookmarks.ts` |
| `cmTheme.ts` | 37 | `features/editor/cmTheme.ts` |
| `editorCompletions.ts` | 40 | `features/editor/services/completions.ts`（今天不在模块图中） |
| `editorDecorations.ts` | 94 | `features/editor/services/decorations.ts`（同上） |
| `editorDecorationsView.ts` | 148 | `features/editor/services/decorationsView.ts`（同上） |
| `editorHovers.ts` | 73 | `features/editor/services/hovers.ts`（同上） |
| `editorProviderViews.ts` | 85 | `features/editor/services/providerViews.ts`（同上） |
| `editorDiagnostics.ts` | 66 | `features/editor/services/diagnostics.ts`（模块图记在 12，实为编辑器服务存储，归 6，由扩展平台写入） |
| `editorDiagnosticsView.ts` | 109 | `features/editor/services/diagnosticsView.ts` |
| `fastView.ts` | 559 | `features/viewers/fastView.ts` |
| `hexView.ts` | 1 415 | `features/viewers/hexView.ts` |
| `hexCompare.ts` | 750 | `features/viewers/hexCompare.ts` |
| `scroll/*`（5 个） | 609 | 不变（platform 级） |
| `folderCompare.ts` | 304 | `features/compare/folderCompare.ts` |
| `mergeEditor.ts` | 235 | `features/compare/mergeEditor.ts` |
| `scm.ts` | 1 755 | `features/scm/{view,commitInput,groups,rowActions,menus}.ts` |
| `gitCommands.ts` | 276 | `features/scm/gitCommands.ts` |
| `fileHistory.ts` | 113 | `features/scm/fileHistory.ts` |
| `terminal.ts` | 336 | `features/terminal/terminal.ts` |
| `extHost.ts` | 4 219 | `features/extensions/host/*`（5.7） |
| `extensionsPanel.ts` | 484 | `features/extensions/extensionsPanel.ts` |
| `contributions.ts` | 787 | `features/extensions/contributions.ts` |
| `treeView.ts` | 301 | `features/extensions/treeView.ts` |
| `extLog.ts` | 184 | `features/extensions/extLog.ts` |
| `claudeChatInject.ts` | 403 | `features/extensions/claudeChatInject.ts` |
| `aiProviders.ts` | 337 | `features/providers/aiProviders.ts` |
| `providersPage.ts` | 474 | `features/providers/providersPage.ts` |
| `providerUsageView.ts` | 656 | `features/providers/providerUsageView.ts` |
| `canLogView.ts` | 822 | `features/can/canLogView.ts` |
| `canRawView.ts` | 773 | `features/can/canRawView.ts` |
| `canChart.ts` | 232 | `features/can/canChart.ts` |
| `selftest.ts` | 143 | `features/selftest/selftest.ts` |
| `selfTestSuites.ts` | 629 | `features/selftest/selfTestSuites.ts` |
| `selfTestPage.ts` | 214 | `features/selftest/selfTestPage.ts` |
| `mcpPage.ts` | 190 | `features/mcp/mcpPage.ts` |
| `analysisView.ts` | 134 | `features/analysis/analysisView.ts` |
| `analysisTools.ts` | 64 | `features/analysis/analysisTools.ts` |
| `analysisPages.ts` | 1 041 | `features/analysis/analysisPages.ts` |
| `moduleDiagram.ts` | 760 | `features/analysis/moduleDiagram.ts` |
| `extHostBoot.ts` | 300 | `hosts/extHostBoot.ts` |
| `extModuleLoader.ts` | 344 | `hosts/extModuleLoader.ts` |
| `vscodeApi.ts` | 4 585 | `hosts/vscodeApi/*`（5.7） |
| `nodeShims.ts` + `nodeShims/*`（3 个） | 2 742 | `hosts/nodeShims/*` |
| `nodeHost.ts` | 356 | `hosts/nodeHost.ts` |
| `nodeHostEsm.ts` | 83 | `hosts/nodeHostEsm.ts` |
| `ggsVscodeShim.ts` | 155 | `hosts/ggsVscodeShim.ts` |
| `vscodeNamespaceProbe.ts` | 121 | `hosts/vscodeNamespaceProbe.ts`（今天不在模块图中） |
| `remote/**`（66 个） | — | 不移动；新增 `remote/desktopHooks.ts`；`remote/editLock`、`nav`、`openThreshold`、`assetUrl`、`session` 改为通过 `provideHook` 注册 |

## 附录 C：IPC 领域与命令清单

每个领域对应一个 `platform/ipc/<domain>.ts` 与一个 `src-tauri/src/commands/<domain>.rs`，
命令名保持不变（不改名，避免同时改两侧与远程 `pathGate.ts`）。

| 领域 | 后端 crate | 命令 |
| --- | --- | --- |
| `app` | app | `app_new_instance`、`open_devtools`、`boot_stage`、`boot_context`、`post_first_paint` |
| `workspace` | app + ggs-base | `open_folder`、`open_workspace`、`close_folder`、`open_single_file` |
| `settings` | ggs-base | `settings_read`、`settings_write`、`keybindings_read`、`keybindings_write` |
| `fs` | ggs-fs | `list_dir`、`list_dir_page`、`read_file`、`read_file_raw`、`file_probe`、`read_file_base64`、`read_file_chunk`、`patch_file`、`encodings`、`file_fingerprint`、`write_file`、`create_file`、`create_folder`、`rename_path`、`delete_path`、`copy_into`、`fs_transfer_cancel`、`fs_import`、`fs_export`、`list_files`、`backup_write`、`backup_clear`、`backup_list`、`backup_read`、`fs_write_chunk`、`fs_upload_offset`、`session_log_file` |
| `revision` | ggs-git | `read_file_at`、`materialize_revision_file`、`discard_temp_blob`、`repo_head`、`repo_submodules` |
| `scm` | ggs-git | `scm_status`、`file_log`、`scm_blame`、`git_init`、`git_stage`、`git_stage_all`、`git_unstage`、`git_unstage_all`、`git_commit`、`git_discard`、`git_discard_all`、`scm_branches`、`scm_remotes`、`scm_stashes`、`scm_tags`、`scm_pull`、`scm_push`、`scm_sync`、`scm_fetch`、`scm_checkout`、`scm_create_branch`、`scm_rename_branch`、`scm_delete_branch`、`scm_merge`、`scm_rebase`、`scm_add_remote`、`scm_delete_remote`、`scm_push_stash`、`scm_apply_stash`、`scm_pop_stash`、`scm_drop_stash`、`scm_add_tag`、`scm_delete_tag`、`scm_undo_last_commit`、`scm_amend_last_commit`、`scm_reset_to_remote`、`scm_clone`、`gerrit_install_hook`、`gerrit_push_ref`、`git_output_log`、`git_output_clear` |
| `search` | ggs-index | `search_workspace`、`search_cancel`、`replace_in_files`、`compare_dirs`、`workspace_symbols`、`find_references`、`hex_diff` |
| `symbols` | ggs-index | `symbols_status`、`symbols_rebuild`、`symbol_lookup`、`symbol_tree`、`symbol_references` |
| `fuzzy` | ggs-index | `fuzzy_files`、`path_completions` |
| `analysis` | ggs-analysis | `analysis_status`、`analysis_rebuild`、`analysis_module_graph`、`analysis_module_diagram`、`analysis_metrics`、`analysis_dead_code`、`analysis_security`、`analysis_import_graph` |
| `mcp` | ggs-mcp | `mcp_log`、`mcp_tools` |
| `viewer` | ggs-text | `viewer_open`、`viewer_lines`、`viewer_highlight`、`viewer_edit`、`viewer_save`、`viewer_reload`、`viewer_text`、`viewer_find`、`viewer_replace`、`viewer_backup`、`viewer_symbols`、`viewer_undo`、`viewer_redo`、`viewer_close`、`indexed_open`、`indexed_lines`、`indexed_find`、`indexed_close` |
| `can` | ggs-can | `can_log_stats`、`can_intervals`、`convert_can_log`、`can_log_open`、`can_log_frames`、`can_log_count`、`can_log_find`、`can_log_close` |
| `ext` | ggs-ext | `ext_list`、`ext_install_from_vsix`、`ext_install_bundled`、`ext_log_append`、`ext_log_path`、`ext_storage_paths`、`ext_uninstall`、`ext_read_file`、`ext_node_env`、`ext_load_code`、`ext_fs`、`ext_page_revision_bytes`、`ext_page_file_chunk`、`ext_read_file_base64` |
| `extProcess` | ggs-ext | `ext_process_start`、`ext_process_run`、`ext_process_host_respond`、`ext_process_invoke`、`ext_process_registrations`、`ext_process_push_event`、`ext_node_runtime`、`ext_process_stop`、`ext_process_status` |
| `extChild` | ggs-ext | `ext_child_spawn`、`ext_child_write`、`ext_child_end_stdin`、`ext_child_kill`、`ext_node_runtime_path`、`ext_child_stop_for` |
| `gallery` | ggs-ext | `ext_gallery_featured`、`ext_gallery_lookup`、`ext_gallery_search`、`ext_gallery_asset`、`ext_gallery_install` |
| `providers` | ggs-providers | `providers_shell_refresh`、`provider_list`、`provider_save`、`provider_delete`、`provider_activate`、`provider_fetch_models`、`provider_test_connection`、`provider_ccswitch_scan`、`provider_import_ccswitch`、`provider_usage`、`claude_mcp_status` |
| `pty` | app | `pty_create`、`pty_write`、`pty_resize`、`pty_list`、`pty_tail`、`pty_kill` |
| `assoc` | app | `assoc_list_defaults`、`assoc_apply`、`context_menu_apply` |
| `remote` | app | `remote_host_set_summary`、`remote_host_frontend_gone`、`remote_mirror_fit`、`remote_mirror_focus`、`remote_host_hide_main`、`remote_host_status`、`remote_paths_policy`、`remote_ext_roots` |

（以上合计与 `generate_handler!` 的 179 条注册一致性由 `check-ipc.mjs` 在 P1-2 首次核对，
任何差异作为待办登记。）

## 附录 D：检查脚本规格

### D.1 TS 导入图检查（`scripts/check-seams.mjs` 的新增部分）

```text
输入：src/**/*.ts
解析：静态 import / export … from / import type（正则足够：仓库无 require、无路径别名）；
      动态 import('…') 单独记录
产物：
  - 图 G（静态边，含 type-only）
  - 层函数 layer(path)：platform | scroll | features/<m> | workbench | hosts | remote | root
检查：
  R1  layer(a) ∈ {platform, scroll} 且 layer(b) ∉ {platform, scroll}          → 违例
  R2  a ∈ features/m1, b ∈ features/m2, m1≠m2, b ∉ {index.ts, types.ts}       → 违例
  R3  a ∈ {features, workbench, hosts}, b ∈ remote, 静态                       → 违例
  R4  动态 import 指向 remote，且 a ∉ remote ∪ {platform/hooks.ts}             → 违例
  R5  Tarjan SCC，size > 1                                                     → 违例（列出成员）
  R6  import '@tauri-apps/api/core' 且 a ∉ platform/ipc                        → 违例
  R7  a ∈ hosts, b ∈ {features, workbench}                                     → 违例
  R10 行数 > 1500                                                              → 报警
豁免：scripts/seams-allowlist.json = [{rule, from, to}]；
      违例 ∈ 豁免 → 通过；豁免中存在已不再发生的条目 → 失败（提示删除，保证只减不增）
性能：150 个文件，目标 < 200 ms（vitest global setup 每次都跑）
```

### D.2 `scripts/check-ipc.mjs`

```text
Rust 侧：读 src-tauri/src/commands/mod.rs（P4 前读 lib.rs）中 generate_handler![ … ] 的条目，
         取每条的最后一段标识符
TS 侧：  platform/ipc/**/*.ts 中 invoke(<…>)?('name' 的字面量（P5-4 前扫描全 src/）
         ∪ remote/pathGate.ts 中出现的命令名
         ∪ tests/**/*.ts 中 tauriMock 脚本化的命令名（只用于"死命令"判断）
失败：TS 用到而 Rust 未注册；pathGate 列出而 Rust 未注册
报警：Rust 注册而 TS/pathGate/tests 均未出现
事件：Rust 侧 ggs-base::events 常量 vs TS 侧 platform/ipc/events.ts，双向比对，不一致即失败
```

### D.3 `scripts/check-crate-graph.mjs`

```text
输入：cargo metadata --format-version 1 --no-deps（在 src-tauri/ 下，离线）
      + scripts/crate-graph.json（白名单：每个 workspace 成员允许的内部依赖、
        允许的"重依赖"列表、层号）
检查：
  1. 成员的内部依赖 ⊆ 白名单；
  2. 内部依赖的层号 ≤ 自身层号，同层边必须显式列出；
  3. tauri / tauri-plugin-* / webview2-com / objc2-app-kit / portable-pty / notify /
     interprocess 只出现在 app 的 dependencies；
  4. 任何 manifest 不得出现 git-graph-core；
  5. 扫描 src-tauri/src 与 src-tauri/crates/*/src 的源文件，不得出现 git_graph_core / git-graph-core
     （取代 build.rs 的扫描）；
  6. 每个成员 crate 的 lib.rs / main.rs 以 //! 文档开头。
性能：cargo metadata --no-deps 约 100 ms 量级
```

### D.4 `scripts/measure-build.mjs`

```text
步骤：
  1. cargo build（dev）--timings，记录墙钟；
  2. 对每个增量场景：在目标文件末尾追加一行注释 → cargo build → 记录 → cargo test --no-run →
     记录 → git checkout 恢复文件 → cargo build（回到干净状态，不计时）；
     场景：crates/ggs-bash/src/applets/*.rs（P2 前为 src/ggs_bash/applets.rs）、
           commands/scm.rs（P3 前为 src/cmd_scm.rs）、ggs-text 的 viewer/find.rs、app lib.rs；
  3. npm run typecheck、npm test 计时；
  4. du：target 目录的 deps / incremental / build 分项；
  5. cargo tree -e normal --prefix none -p <每个产物> | sort -u | wc -l；cargo tree -d 计数；
输出：metrics.json 的 build.{cold, incremental.*, typecheck, vitest, targetSize.*, crates.*, duplicates}
      与 --json 标准输出（贴进 PR 描述）
```

## 附录 E：Cargo.toml 草图

### E.1 根（`src-tauri/Cargo.toml`）

```toml
[workspace]
members = ["crates/*"]
resolver = "2"

[workspace.package]
edition = "2021"
rust-version = "1.94"
license = "MIT"
publish = false

[workspace.lints.clippy]
# 与今天 CI 的 -D warnings 等价的基线；具体条目沿用现状

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
memchr = "2"
rayon = "1"
regex = "1"
ropey = "1.6"
syntect = { version = "5", default-features = false, features = ["default-fancy"] }
fancy-regex = "0.16"
encoding_rs = "0.8"
plist = { version = "1", default-features = false, features = ["serde"] }
ignore = "0.4"
trash = "5"
zip = { version = "2", default-features = false, features = ["deflate", "deflate64"] }
flate2 = { version = "1", default-features = false, features = ["zlib-rs"] }
tree-sitter = "0.26"
big-code-analysis = { version = "2.2", default-features = false }
ureq = { version = "3", features = ["rustls"] }
aes-gcm = "0.10"
getrandom = "0.2"
base64 = "0.22"
hex = "0.4"
sha1 = "0.10"
sha2 = "0.10"
tempfile = "3"
# …其余依赖原样搬入
ggs-base = { path = "crates/ggs-base" }
ggs-proto = { path = "crates/ggs-proto" }
ggs-remote-proto = { path = "crates/ggs-remote-proto" }
ggs-codec = { path = "crates/ggs-codec" }
ggs-git = { path = "crates/ggs-git" }
ggs-shellenv = { path = "crates/ggs-shellenv" }
ggs-fs = { path = "crates/ggs-fs" }
ggs-text = { path = "crates/ggs-text" }
ggs-can = { path = "crates/ggs-can" }
ggs-index = { path = "crates/ggs-index" }
ggs-analysis = { path = "crates/ggs-analysis" }
ggs-mcp = { path = "crates/ggs-mcp" }
ggs-ext = { path = "crates/ggs-ext" }
ggs-providers = { path = "crates/ggs-providers" }
ggs-config = { path = "crates/ggs-config" }
ggs-testkit = { path = "crates/ggs-testkit" }

[patch.crates-io]          # 不变
boa_parser = { path = "vendor/boa-parser" }
boa_ast = { path = "vendor/boa-ast" }
boa_engine = { path = "vendor/boa-engine" }
boa_gc = { path = "vendor/boa-gc" }

[package]
name = "git-graph-studio"
version = "0.1.11"          # 三文件版本同步规则不变
edition.workspace = true
rust-version.workspace = true
license.workspace = true

[lib]
name = "git_graph_studio_lib"
path = "src/lib.rs"

[[bin]]
name = "git-graph-studio"
path = "src/main.rs"

[features]
default = ["all-grammars"]
all-grammars = ["grammar-rust", "grammar-python", "grammar-go", "grammar-javascript",
                "grammar-typescript", "grammar-java", "grammar-c", "grammar-cpp", "grammar-c-sharp"]
grammar-rust = ["ggs-index/grammar-rust", "ggs-analysis/grammar-rust"]
# … 其余八个同形

[dependencies]
tauri = { version = "2", features = ["devtools"] }
tauri-plugin-dialog = "2"
tauri-plugin-opener = "2"
tauri-plugin-clipboard-manager = "2"
portable-pty = "0.9"
notify = { version = "8", default-features = false, features = ["macos_fsevent"] }
interprocess = { version = "2.2", features = ["tokio"] }
tokio = { version = "1", features = ["io-util", "sync", "time", "rt"] }
rmp-serde = "1.3"
serde_bytes = "0.11"
ureq.workspace = true
serde.workspace = true
serde_json.workspace = true
ggs-base.workspace = true
ggs-git.workspace = true
ggs-shellenv.workspace = true
ggs-fs.workspace = true
ggs-text.workspace = true
ggs-can.workspace = true
ggs-index.workspace = true
ggs-analysis.workspace = true
ggs-mcp.workspace = true
ggs-ext.workspace = true
ggs-providers.workspace = true
ggs-remote-proto.workspace = true
ggs-config.workspace = true

[target.'cfg(windows)'.dependencies]
winreg = "0.52"
webview2-com = "0.38"
windows-core = "0.61"

[target.'cfg(target_os = "macos")'.dependencies]
objc2-foundation = { version = "0.3", features = ["NSProcessInfo", "NSString"] }
objc2 = "0.6"
objc2-app-kit = { version = "0.3", features = ["NSApplication", "NSMenu", "NSMenuItem"] }

[dev-dependencies]
ggs-testkit.workspace = true
tempfile.workspace = true

[build-dependencies]
tauri-build = "2"

[profile.dev]               # 以下 profile 原样保留
opt-level = 1
[profile.dev.package."*"]
debug = false
[profile.release]
opt-level = "z"
lto = "fat"
codegen-units = 1
panic = "abort"
strip = true
debug = false
[profile.ggs-node]
inherits = "release"
panic = "unwind"
opt-level = 3
```

### E.2 一个 L1 crate（`crates/ggs-index/Cargo.toml`）

```toml
[package]
name = "ggs-index"
version = "0.0.0"
edition.workspace = true
rust-version.workspace = true
license.workspace = true
publish.workspace = true

[lints]
workspace = true

[features]
grammar-rust = ["dep:tree-sitter-rust"]
# … 其余八个同形

[dependencies]
ggs-base.workspace = true
ggs-fs.workspace = true
ggs-text.workspace = true
serde.workspace = true
serde_json.workspace = true
regex.workspace = true
rayon.workspace = true
encoding_rs.workspace = true
sha1.workspace = true
hex.workspace = true
tree-sitter.workspace = true
tree-sitter-rust = { version = "0.24", optional = true }
# … 其余八个 grammar

[dev-dependencies]
ggs-testkit.workspace = true
tempfile.workspace = true
```

### E.3 sidecar（`crates/ggs-node/Cargo.toml`）

```toml
[package]
name = "ggs-node"
version = "0.0.0"
edition.workspace = true
rust-version.workspace = true
license.workspace = true
publish.workspace = true
build = "build.rs"          # N-API 符号导出：必须与 bin 同 package

[lints]
workspace = true

[[bin]]
name = "ggs-node"
path = "src/main.rs"

[dependencies]
ggs-proto.workspace = true
boa_engine = { version = "0.21", features = ["annex-b", "trace"] }   # 经根 [patch] 指向 vendor/
libloading = "0.8"
ureq.workspace = true
if-addrs = "0.13"
aes-gcm.workspace = true
pbkdf2 = "0.12"             # P6-3 后由 ggs-codec 取代
hmac = "0.12"               # 同上
md-5 = "0.10"               # 同上
sha1.workspace = true       # 同上
sha2.workspace = true
getrandom.workspace = true
base64.workspace = true
hex.workspace = true
bincode = "1.3"
serde.workspace = true
serde_json.workspace = true
```

构建命令：`cargo build --profile ggs-node -p ggs-node`（Windows 另有
`cargo build --release -p ggs-bash`）。
