# CI 提速与依赖精简计划

> 基线：[run 38501324240](https://github.com/neophack/git-graph-studio/actions/runs/38501324240)
> （Release，workflow_dispatch，2026-10-14，墙钟约 52 min）。
> 本文所有"预估"均需以 P0 的实测数据验收（AGENTS.md：数字，不是形容词）。
>
> **实施状态（2026-10-14，两轮）**：第一轮——P1 #1–#7、P0 的 timings 基础设施、
> P2 的 daemon 缓存退路、P3 的 bytemuck / num_enum / time-macros / npm codemirror。
> 第二轮——P2 的测试/打包并行拆分（prepare.mjs `--icons-only`）、5 个集成测试合并为
> `tests/it/main.rs`、boa 进缓存（rust-cache `cache-workspace-crates`）、tempfile 移到
> dev-dependencies（各条目后的 ✅/❌ 标记）；同日的 owner 方向补充——后端测试每平台
> 只跑一遍（rpm 与 deb 都是 Linux，原生 test-linux 一条腿覆盖，rpm 容器腿只打包）、
> macOS 补上后端测试（`test-macos`，此前从未跑过）、GGS Bash 成为仅 Windows 的
> 随包 sidecar（`ggs-bash` cargo 特性 + required-features 门控二进制，
> tauri.conf.json 的 `build.features` 在 Windows 侧打开、macOS 签名 merge 与 Linux
> 容器/本地构建的 `--config` merge 清空特性表，Linux/macOS 测试 `-- --skip ggs_bash`）。
> zip 特性精简被证伪退回：2.x 的 `deflate-flate2` 不激活 zip 自己的 optional flate2
> （那是 `deflate` 伞特性的 `flate2/rust_backend`），精简组合编不过；修复落在 zip
> 3.0.0（"Specify flate2 dependency of the deflate-flate2 feature"），升级是独立改动。
> 实测注意：桌面图里 `cookie`（经 tauri）也激活 time 的 `macros`、`serde_with → darling`
> 也拉 syn 3.x——time-macros 与单份 syn 的收益只落在 ggs-node sidecar 的图
> （bytemuck_derive / num_enum(+derive) / time-macros / zopfli / bumpalo 全部从
> sidecar 图消失；桌面 all-features 541 → 531，sidecar 235 → 233——tempfile 也移到了 dev-dependencies）。

## 1. 现状

### 1.1 关键路径

| Job | 耗时 | 主要构成 |
| --- | --- | --- |
| **Studio installers (windows-x64)** | **48 min** | prepare 581 s · test+lint 858 s · tauri build 434 s · **measure 911 s** |
| Studio installers (studio-linux-rpm) | 27 min | 容器 apt 重装 ~3 min · 冷编译 ~10 min（ggs-node 3m20 / daemon 1m52 / 主程序 4m37）· **rpm 打包 682 s** |
| Studio installers (studio-linux-x64) | 19 min | 原生 prepare 211 s · 原生 test+lint 227 s · 容器冷编译+打包 600 s |
| Studio installers (studio-darwin-arm64) | 14.5 min | build 642 s · measure 170 s |
| Studio tests / GGS Remote daemon ×3 / hub | ≤ 2.5 min | 不在关键路径 |

近期 push 到 main 的 Studio run：35–59 min，且多次被 `concurrency` 取消（取消的 run 不保存缓存）。

### 1.2 Windows job 内部时间线

| 时刻 | 事件 |
| --- | --- |
| 02:31:38 | rust-cache 恢复，`full match: true` |
| 02:36:57 | `ggs-node` profile 完成，4m54s（vendored boa 4 个 crate + app 重编） |
| 02:41:42 | ggs-remote daemon release 完成，4m23s（**253 个 crate 冷编译**） |
| 02:42:25 | clippy（dev check）41 s |
| 02:49:38 | test profile 编译完成，7m12s（boa 再编一次） |
| 02:50:24 → 02:55:58 | `tests/perf.rs` 333 s（Linux 同测试 3.3 s） |
| 02:56:06 → 03:03:15 | `tauri build`：主程序 release 4m15s + MSI/NSIS |
| 03:03:26 → 03:18:26 | **boot-bench 挂满 15 min 超时，"recorded as absent"** |

## 2. 根因（按浪费分钟数排序）

1. **Windows boot-bench 挂到 15 min 超时**（`scripts/measure.mjs` 的 `BOOT_TIMEOUT_MS = 15 * 60 * 1000`），没有产出任何数据；macOS 上同一步 170 s，Linux 14 s。
2. **Windows `perf.rs` 333 s，Linux 3.3 s**（同为 `GGS_PERF_FILES=20000`）。推测原因：`tempfile::tempdir()` 落在 C: 的 `%TEMP%`，被 Defender 实时扫描。尚未验证。
3. **rpm 打包 682 s，deb 3 s**。`tauri.conf.json` 没有 `bundle.linux.rpm.compression`，用的是 bundler 默认的高压缩级别。tauri-cli 2.11.4 的 schema 支持 `RpmCompression`（gzip / zstd / xz / bzip2 / none + level）。
4. **ggs-remote daemon 每个 installer job 都冷编译**（release，fat LTO）。prepare.mjs 调 `extensions-src/ggs-remote/build.mjs`，target 目录是 `target/studio/ggs-remote`，studio job 的 rust-cache 只映射了 `src-tauri -> ../target/studio/cargo`。Windows 4m23s，Linux 1m24–1m52（×3：deb 原生 + 两个容器），macOS 约 2m30s。
5. **vendored boa（boa_gc / boa_interner / boa_ast / boa_parser / boa_engine）每次 run、每个 profile 都重编**。缓存是 `full match`，但 rust-cache 不保留 path 依赖的产物，所以 ggs-node profile 和 test profile 各编一遍 boa_engine。
6. **Actions 缓存 12.1 GB，超过 10 GB 上限，一直在被淘汰**。两个容器腿都 `Cache not found`（`~/.ggs-linux-cache`），buildx 的 gha 缓存也没了（rpm 腿 apt/dnf 层重装约 3 min）。大头是 dev/test 的完整 debuginfo：windows 约 1.5 GB/份，linux-native 约 1.2 GB/份，而且同一前缀留着 2–3 个旧版本。
7. **测试和打包在同一个 job 里串行**：prepare → clippy → test → `tauri build` → measure，墙钟是各段之和。测试阶段的 `prepare.mjs --build` 还会编 ggs-node 和 daemon 的 release，可测试只需要 icons（`generate_context!()`）。deb 腿在宿主机上编的这些产物全部浪费，容器里又从头编一遍。
8. **测试编译慢**：`[profile.dev] opt-level = 1` 加完整 debuginfo，MSVC 生成 PDB 慢；`tests/` 下 5 个集成测试二进制各自链接一遍整个 lib。
9. **Rust 版本没有锁定**（`dtolnay/rust-toolchain@stable`）。每次 stable 升级都让 5+ 份缓存同时失效，还会冒出新 lint 打断 `-D warnings`（7c4227d：clippy 1.97）。

## 3. 计划

### P0：测量基线（半天）

- [x] CI 加 `cargo build --timings`（Windows job：`cargo test --all-features --timings`
      （dev/test 编译）+ `tauri build` 前一次 `cargo build --release --timings`（release
      编译，产物被 tauri build 复用，暖缓存下近零成本）；deb 原生腿同样加 test timings），
      `cargo-timings/*.html` 以 `if: always()` artifact 上传（studio-windows-timings /
      studio-linux-native-timings）——测试失败时正是需要数字的时候。已落地，基线数字待
      下一个 run 采集。
- [ ] 记录基线：每个 job、每个步骤的耗时，`cargo tree` 的 crate 数
      （all-features 实测 541（本机口径，P3 落地后 531）/ node-runtime sidecar 233）。

### P1：只改配置的快速收益（1–2 天）

| # | 改动 | 文件 | 预估节省 |
| - | ---- | ---- | --- |
| 1 | ✅ boot-bench 单次运行设超时（boot-bench.mjs 每次启动本就有 30 s 硬超时；挂 15 min 的真凶是它 run 之间的 `waitForQuietMachine`（最长 30 min）），总时长上限 15 min→3 min；所有 measure 步骤 `continue-on-error: true`（metrics artifact 改 `if-no-files-found: warn`）；单独排查 Windows 为什么等不到 `graph first page` | `scripts/measure.mjs`、`studio.yml` | Windows −12 min，macOS −2 min |
| 2 | ✅ `bundle.linux.rpm.compression: { "type": "zstd", "level": 10 }`（tauri-utils 2.9.3 已支持该字段，zstd 的 level 是 i32）；包体积对比待 release run 验证后可再调 gzip/级别 | `src-tauri/tauri.conf.json` | rpm −10 min |
| 3 | ✅ Windows 测试前设 `TMP`/`TEMP=$RUNNER_TEMP`（D:，job 级 env），并 `Add-MpPreference -ExclusionPath` 工作区、RUNNER_TEMP、`~/.cargo`、`~/.rustup`（尽力而为，失败不阻断）。**不放宽 perf budget** | `studio.yml` | Windows −5 min |
| 4 | ✅ CI 全局 `CARGO_PROFILE_DEV_DEBUG=line-tables-only`（studio.yml env）；依赖 `debug=0` 放在 `src-tauri/Cargo.toml` 的 `[profile.dev.package."*"]`（GitHub env 键无法表达 `"*"`，manifest 是唯一可靠落点，本地同样受益）；Windows 测试步骤 `RUSTFLAGS=-Clinker=rust-lld`（仅测试步骤，release 保持 link.exe） | `studio.yml`、`src-tauri/Cargo.toml` | 测试编译 −30–40%（预估），缓存体积约减半 |
| 5 | ✅ 所有 rust-cache（studio 三平台 + daemon + hub）加 `save-if: github.ref == 'refs/heads/main'`；PR 仍恢复 main 的缓存 | `studio.yml` | 容器腿 −5 min |
| 6 | ✅ 根目录 `rust-toolchain.toml` 锁 1.97.1；CI 的 `dtolnay/rust-toolchain@stable` 全部改 `@1.97.1`（该 action 以 ref 决定安装的工具链，不读 toolchain 文件——ref 与文件不一致会让 rustup 在运行时再装一份）；Linux 容器显式 `RUSTUP_TOOLCHAIN=stable`（镜像的 RUSTUP_HOME 不在缓存卷，按文件走等于每 run 重下 300 MB）。升级时两处 ref 与文件一起改 | `rust-toolchain.toml`、两个 workflow、`studio-linux-build.sh` | 避免一次性全量冷启动和 lint 突然失败 |
| 7 | ✅ `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` | `studio.yml` | main 不再浪费被取消的半截 run |

### P2：流水线结构调整（3–5 天）

- [x] **测试和打包拆成并行 job**（2026-10-14 落地）。`test-windows` / `test-linux` 跑
      clippy 和 `cargo test`（`--icons-only` 的 prepare：`generate_context!()` 嵌入的窗口
      图标是测试编译唯一的 prepare 产物）；原 `studio-windows` / `studio-linux` 只打包
      （不再等测试，deb 腿的宿主机原生编译整体移除）。release.yml 经 workflow_call
      调用整个 studio.yml，发布步骤仍以全部 job 通过为前提——"测试不过不发布"不变，
      墙钟从相加变成取最大值。注意：拆分后测试/安装包 job 各自持有独立 rust-cache key
      （dev 半边 / release 半边，`*-test` / `*-build` 新键一次性冷启动后互相不背死重）；
      main 推送上测试失败时安装包 job 仍会跑完（浪费一次构建算力，换取墙钟）。
- [ ] **daemon 每个 OS 只编一次。** 主路径：`remote-daemon-test` 顺便产出 release 二进制
      作为 artifact，installer job 下载后用 packer 已有的 `--skip-cargo` 复用（注意会引入
      `needs: remote-daemon-test` 的 DAG 等待；拆分后 Windows/macOS 已由下面的退路覆盖，
      剩余收益主要在两个容器腿，值不值一次 DAG 等待要看下一个 run 的实测）。
      ✅ 退路已落地：Windows 与 macOS job 的 rust-cache `workspaces` 加了
      `extensions-src/ggs-remote/daemon -> ../../../target/studio/ggs-remote`（首次 run 仍
      冷编，之后增量）；deb 腿不加——它的 target/studio/ggs-remote 被宿主 prepare 与容器
      双写，一份缓存伺候不了两个编译器（拆分后宿主侧已移走，容器侧复用重新变得可行，
      但需要 build.mjs 尊重 CARGO_TARGET_DIR，留作主路径的一部分）。
- [x] **让 boa 能进缓存**（方案二）：相关 rust-cache 加
      `cache-workspace-crates: true`——rust-cache 默认清洗本地（path/workspace）crate 的
      产物，这正是 boa 每次 "full match" 仍全量重编的原因；该输入让它保留本地 crate。
      是否足够以下一个 run 的 "full match" 后 boa 不重编为准（不够再试
      `cache-all-crates`）。方案一（fork 仓库 + git 依赖）仍留作后手。
- [ ] **rpm 并入 ubuntu:22.04 容器**（`tauri build --bundles deb,rpm`），删掉 fedora:38
      那条腿。依据：glibc 2.35 编出的二进制能在 2.37+ 上运行，rpm 的 Requires 来自配置，
      与构建机无关。**需要 owner 拍板**（fedora:38 是有意选的），并在 Fedora 38 和
      openSUSE Leap 15.6 上实装验证。
- [ ] builder 镜像推到 GHCR（`ghcr.io/neophack/ggs-linux-builder:<base>`），只在
      Dockerfile 变化时重建，不再占 Actions 缓存。
- [x] 5 个集成测试合并为 `tests/it/main.rs` + 子模块（`git mv` 保留历史；模块各自
      `#![cfg]` 门控，`vscode_shim_boa` 由此补上了缺失的 `node-runtime` 门——此前普通
      `cargo test`（默认特性）在该文件上编不过）。从 5 次链接减到 1 次；单套过滤用
      `cargo test --test it <module>::`。
- [ ] （可选，暂缓）非 release 的 main 构建用 `CARGO_PROFILE_RELEASE_LTO=thin`、
      `CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16`；release.yml 保持 fat LTO。**与 #5 的
      save-if 相互作用不利**：main 存下的 thin 产物会被 release tag run 恢复，fat LTO 的
      指纹对不上 → release run 全量重编 release（今天它复用 main 的 fat 产物近乎暖启动）。
      除非 release run 恢复独立缓存键，否则是净损失，暂缓。

**预估结果**：release 约 52 min → 约 18–20 min；push 到 main 约 35–59 min → 约 15 min。

### P3：依赖精简与自研替代

统计口径：Windows 主机，`cargo tree -e normal --all-features`；"独占"指只经由这一个直接依赖引入的 crate 数。

| 直接依赖 | 子树 / 独占 |
| --- | --- |
| tauri | 178 / 97 |
| boa_engine | 123 / 71 |
| big-code-analysis | 66 / 28 |
| aes-gcm / portable-pty / ureq | 18 / 11 · 22 / 11 · 20 / 11 |
| tauri-plugin-clipboard-manager / trash | 22 / 9 · 14 / 9 |

#### 替代清单

| 优先级 | 依赖 | 替代方案 | 能去掉的 crate | 工作量 / 风险 |
| ------- | -------- | ---------- | -------------- | ------------- |
| **高** ✅ | vendored boa 的 `bytemuck` derive（只在 `src/builtins/typed_array/element/mod.rs` 用到一次） | 已改为手写 `unsafe impl Zeroable/NoUninit/AnyBitPattern`（GGS-patch 标注），`features = ["derive"]` 已去掉 | bytemuck_derive（实测：桌面与 sidecar 图都已消失。syn 3.x **留下**——桌面经 tauri 的 `serde_with → darling`，sidecar 经 boa 自己的 icu 栈 `displaydoc`，与本项无关） | 很小 |
| **高** ✅ | boa 的 `num_enum`（只在 `src/symbol.rs` 用到一次） | 已手写 `TryFrom<u8>` / `From<WellKnown> for u8` | num_enum、num_enum_derive（proc-macro-crate / toml_edit 桌面图里仍被 tauri 栈使用，sidecar 图里随之消失） | 很小 |
| 高 ✅ | boa 的 `time` `macros` 特性（只在 `builtins/date/utils.rs` 用到） | 已改为 `OnceLock` + `time::format_description::parse` 对同一描述串的一次性运行时解析（宏只是该解析器的编译期运行，语义不可能漂移）；`vscode_shim_boa.rs` 加了 Date.parse 红灯测试 | time-macros：**sidecar 图里消失；桌面图里仍在**——`cookie`（经 tauri）也激活 `macros`，本项只省 sidecar | 小 |
| 高 ❌（证伪） | `zip` 的 `deflate` 特性（= `deflate-zopfli` + `deflate-flate2`） | 2.x 的 `deflate-flate2` 不激活 zip 自己的 optional flate2 依赖（只有 `deflate` 伞里的 `flate2/rust_backend` 会），精简组合 `E0433` 编不过；zip 3.0.0（2025-05）才修（"Specify flate2 dependency of the deflate-flate2 feature"，并有 `deflate-flate2-zlib-rs`）。**先升 zip 到 3/4.x 再做** | zopfli、bumpalo（升级后可得） | 只改配置（前提：升级） |
| 中 | `tauri-plugin-clipboard-manager`（只用到文本读写） | 自写 `clipboard_read_text` / `clipboard_write_text` 命令：Win32、NSPasteboard（objc2-app-kit 已在树里）、GTK；前端 10 处 import 和 remote tauriShim 跟着改 | 9 个：arboard、image、png 0.18、moxcms、pxfm、clipboard-win… | 中 |
| 中 | `trash` | Windows 用 `IFileOperation` / `SHFileOperationW`（复用 windows 0.61），macOS 用 `NSFileManager trashItemAtURL`，Linux 按 FreeDesktop Trash 规范实现 | 整套 windows 0.62（8 个，Windows 上编译最慢的那类） | 中，Linux 跨设备移动是风险点 |
| 中 | `md-5`、`sha1`、`hmac`、`pbkdf2`、`hex` | 复用 `ggs_bash/hashes.rs`（已有 MD5 / SHA-1 / SHA-256），补 SHA-512、HMAC、PBKDF2，用测试向量把关 | 5 个，主要让 ggs-node sidecar 受益（tauri 仍会带 sha2 0.10） | 小到中 |
| 低 | `rpassword` | 复用 `ggs_bash/lineedit.rs` 的 raw mode 关回显 | rpassword、rtoolbox | 小 |
| 低 ✅ | 普通依赖里的 `tempfile` | 运行时其实有两处（计划低估了）：`measure.rs` 的大文件探针和 `remote_host.rs` 的下载临时文件。两处各换成 ~15 行的手写 helper（ScratchDir / ScratchFileGuard，drop 时清理），`tempfile` 移到 `[dev-dependencies]` | sidecar 与主程序不再链接 tempfile 及其 fastrand/getrandom | 小 |
| 低 | `if-addrs` | 直接调 GetAdaptersAddresses / getifaddrs | windows-targets 0.52 重复 | 小，收益也小 |
| 后续 | `portable-pty` | 自写 ConPTY 和 openpty | 11 个：winapi、nix 0.28、serial2、shared_library、winreg 0.10… | 大，ConPTY 的坑多 |
| 后续，看 P0 数据 | `big-code-analysis` | 在现有 `symbols/parse.rs` 的 tree-sitter 层上自己实现 4 个指标（认知复杂度、Halstead、LSOC、MI） | 28 个（csv、petgraph、crossbeam、sha2 0.11/digest 0.11/hmac 0.13 重复栈）+ 两个 C 语法编译；还能降低 1.94 的 rust-version 下限 | 大，9 种语言各要一张规则表 |
| npm ✅ | `codemirror` 元包 | `src/`、`tests/`、`dev/` 里没有任何 import（已 grep 验证），直接删，lockfile 同步 | 1 个（已删） | 很小 |

#### 不建议自研

tauri、boa、ureq / rustls / ring（TLS）、aes-gcm（AEAD 不应该手写）、syntect / regex / fancy-regex、tree-sitter、notify、ignore、encoding_rs、rayon、tokio、interprocess、serde / serde_json。

## 4. 验收

- 每个 P1/P2 改动附上前后对比的 run 链接和步骤耗时。
- 依赖改动附 `cargo tree` 的 crate 数变化和 `--timings` 前后对比。
- 替换依赖先写红灯测试：hash 用标准测试向量；trash、clipboard、pty 各自补 Rust 测试，jsdom 覆盖不到的补 `dev/dev-harness.html` 场景。
- 按 AGENTS.md 的 Definition of done 执行：`npm run typecheck`、`npm test`、`cargo test --all-features`、`cargo clippy --all-targets --all-features -- -D warnings`。涉及 `prepare.mjs` 或 `tauri.conf.json` 的改动要过一遍 `npx tauri dev`。
- rpm 合并必须在目标发行版上实装验证后才能删掉 fedora:38 腿。

## 5. 执行顺序

1. P1 #1–#3：半天，release 预估缩短约 25 min。
2. P0 测量：给后续改动建立基线。
3. P1 #4–#7。
4. P2：并行拆分、daemon artifact。
5. P3 高优先级：boa 的 bytemuck、num_enum、time，zip 特性。
6. P2 其余，以及 P3 中优先级。
7. P3 后续项，视 P0 数据决定。
