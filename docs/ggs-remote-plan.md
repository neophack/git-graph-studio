# GGS Remote 远程访问插件 — 详细开发计划

> 状态：**已实现（框架与功能，2026-10-11）**——守护进程、应用侧宿主与 Relay、远程前端（垫片/传输/响应式外壳）、插件包、Hub 中继（§20）与守护进程的 Hub 客户端均已落地；守护进程与 Hub 各自的 `cargo test`、`tests/hub_link.rs` 的两 crate 端到端（登录、隧道上的 WS 会话、改密 1 s 内 4401、断开后离线页）、`tests/remote*.test.ts` 与 CI 作业（`remote-daemon-test` 三平台、`remote-hub-test`）全绿。尚未做：三平台托盘手测、真机（iOS/Android）清单、可选的端到端加密 M10（Playwright 的三引擎矩阵与截图基线已落地：`tests/e2e/remote/` 六个 spec + `playwright.remote.config.ts`，Chromium/Firefox/WebKit，`npm run test:e2e-remote`）。已知取舍：Hub 侧在隧道断开时关闭浏览器 WS（4503 `pc-offline`）而不是挂住等待（§20.4 的 `pc-reconnecting` 通知），断线恢复由守护进程的 120 s 恢复窗口在重连后接续；TLS 客户端信任用 webpki-roots 静态根 + `fp=` 指纹固定，未用 rustls-platform-verifier。
> 范围：新插件 `ggs-remote` 及它需要的应用侧通用宿主能力。**不基于、不复用 Claude Remote（`extensions-src/claude-remote/`）**，两者互不依赖。
> 约束来源：`docs/ggs-development-plan.md` §3（架构原则）、`AGENTS.md`（模块图、接缝规则、完成定义、代码风格）。
> 修订（2026-10-11，评审后补充）：§6.1 一消息多帧与 §6.4 上行合帧；§7.4 防火墙指引与多 OS 用户端口取舍；§7.6 配对页密码解锁（R19）；§7.7 会话周期重验；§7.8 下载控制消息 `FetchFile`；§7.9 托盘语言与扫码窗口；§7.12 进程自愈与关机退出；§8.6 终端 resize 与并发编辑；§10.2 PWA manifest；§16 日志脱敏；§17–§19 对应测试、任务与风险。
> 修订（2026-10-11，第二次）：R20/R21 远程实例生命周期管理与内容摘要——两级心跳与 `unresponsive` 标记、`INSTANCE_CLOSE`/`INSTANCE_RESTART` 帧、`Ping`/`Pong`/`CloseBlocked`/`Summary` 控制消息、窗口选择页摘要卡片（§6.2、§7.8、§8.1、§13、§18 M3.5）。
> 修订（2026-10-11，实测修复）：两个中断级缺陷与手机端补全——(1) §14.2 的 `install` 现在先问运行中守护进程的版本（admin API），同版本或更新绝不关停：此前全新 home 里插件激活会把在跑的守护进程杀掉约 20 s 换一份字节相同的副本，期间打开的页面什么都加载不出来（资源管理器、文件内容、SCM 全空，`client::tests::a_running_same_version_daemon_survives_install` 回归）；(2) §12.2 的令牌路径 HTML 改写同时折叠根绝对 `/assets/…` 引用——扩展宿主帧的文档（`ext-host.html`）是应用资产，主构建把它的哈希脚本拼成根绝对路径，不改写就落到守护进程根上 404，任何帧宿主插件在远程端都激活不了；(3) §11.3 手机档补齐：文件默认只读 + 解锁条（`src/remote/editLock.ts`，Compartment 原位重配置，注意 `EditorState.readOnly` 的 facet 合并先到先得、锁必须放在扩展列表最前）、侧边栏左缘滑动返回、快速输入全屏化；(4) §10.3 资源管理器远程分页落地（`list_dir_page` + "加载更多"行，`explorer.ts`）。
> 修订（2026-10-11，第三次，实测修复）：§11.2 手机页面栈落地（`src/remote/nav.ts`）——全屏侧边栏是覆盖层，编辑器激活（`editor.ts` 的 activate）与面板显示（`panel.ts` 的 show）都会先收起它（经 `workbench.toggleSidebar` 命令），被覆盖的面板再点终端标签是"现出"而非"藏起"（toggle 的 covered 分支）；修复前手机端点文件、点终端都打开在覆盖层之下，看起来毫无反应（`tests/remoteResponsive.test.ts` 的 phone page stack 组回归）。
> 修订（2026-10-11，第四次）：§11.2 紧凑顶栏落地（`src/remote/phoneMenu.ts`）——左上角 ☰ 打开完整菜单（动作表一级是菜单名、二级是条目，启用态打开时计算；`TitleBar.menuDefinitions()` 为取数口），手机档隐藏 logo 与菜单栏，命令中心改为弹性占位。注意手机页面的可见版本跟随应用内嵌的 remote 构建（dev 由 prepare.mjs 产出 `target/studio/dist/remote/`，打包随 `tauri build`），且 Service Worker 对 remote.html 缓存优先、后台刷新——新版本第二次访问才现身。
> 修订（2026-10-12，手机端重新设计）：§11.2 手机档从“缩小的桌面”改为一套 App 外壳，由同一个页面模型（`src/remote/pages.ts`）驱动——顶部 App 栏（`appBar.ts`：☰ 抽屉、页面标题与副标题、页面自己的操作表）、底部导航（`bottomTabs.ts`：文件 · 编辑器 · 变更 · 各插件页面，最多五个，点了必定显示该页、再点为“重选”）、导航抽屉（`navDrawer.ts`，取代 `phoneMenu.ts`：全部页面、转到文件、命令面板、窗口、传输、完整菜单、省流与设置）、编辑器页（`editorSwitcher.ts`：标签条隐藏，已打开编辑器与编辑器操作改为底部表单，无文件时显示空状态）、键盘上方编辑键行（`editorAccessory.ts`）、统一的底部表单（`actionSheet.ts`：把手、标题、返回级、下拉关闭）与手机返回键关闭浮层（`backStack.ts`）。插件页面按通用规则发现（视图容器取自隐藏的活动栏，Git Graph 类取自 `scm/title` 的 navigation 项），不出现插件 id。终端改为全屏页面；页面栈导航中编辑器激活同时收起终端页。
> 修订（2026-10-12，多用户实测与 Hub 收口）：(1) §20.5 的两种链接形态修复——规范链接 `publicBase`（带尾斜杠）此前落到 Hub 路由之外答裸 404，手剥尾斜杠的 `/u/<uuid>` 撞上双参数提取器答 500；现在两种形态都以空 rest 进入 `entry`，由 PC 按自己的 `/` 应答（登录或窗口页的重定向），`hub/tests/tunnel.rs` 的 `the_link_shapes_a_browser_opens_reach_the_pc` 与离线页四形态断言回归；(2) 多用户活体探针 `scripts/probes/remote-hub-multi-check.mjs`：一个真 Hub + 两台守护进程（独立 home）+ 两个 `--remote-host` 实例 + 同一浏览器用户经 `/u/<uuid>/` 双登录——并行会话、Cookie `Path` 隔离、Storage 前缀隔离、改密只踢一方（83 ms 内 401 + WS 4401）、限速隔离、跨 PC Cookie 拒绝、外部 Origin 由 PC 侧关 4403、编码路径穿越拒绝、离线页逐字节一致，55 项检查；(3) §20.6 的跨 PC 缓存记录为**有意偏差**：缓存键含 `/w/<inst>/`，两台 PC 的实例 id 必不相同 → 计划中的"公开构建产物跨 PC 共享"实际是每 PC 各自缓存——共享会让任一接入 PC 的守护进程有能力给其他 PC 的哈希资产投毒，按 PC 隔离以极小的带宽代价消掉该面；(4) §7.6 的 Cookie `Secure` 已改为跟随浏览器协议（同日修复）：Hub 转发时打 `x-forwarded-proto`（`trust_proxy` 时透传前置反代的值，否则按自身 `tls.mode` 推导，浏览器的同名头不在转发白名单、无法伪造），守护进程据此并按自身 TLS 模式决定 `Secure`——修复前 `tls = none` 且无 TLS 前置、经非 loopback 地址访问时浏览器静默丢弃会话 Cookie（登录返回成功但永不保持），修复后纯 HTTP 也能登录（会话明文是该模式自身的属性）；`hub/tests/tunnel.rs` 的 `the_forwarded_proto_follows_the_front_proxy_when_trusted` 与 `daemon/tests/hub_link.rs` 的 `a_plain_http_hub_login_sets_a_cookie_the_browser_keeps` 回归；(5) §15.6/§20.13 M9.9 补齐：`release.yml` 新增 `hub-image` 作业，打 tag 时经 `hub/Dockerfile` 构建 `ghcr.io/<owner>/ggs-remote-hub:<版本>`（amd64+arm64，门禁随 studio.yml 的 remote-hub-test）。
> 修订（2026-10-12，测试缺口收口）：§17.1/§20.12 中"已实现未测"的项落地——(1) `tests/hub_link.rs` 新增 `a_restarted_hub_is_rejoined_with_the_same_link`：以最小假 Hub（测试内 tokio-tungstenite，逐代可真正掐断——进程内 `axum::serve` 中止后已接受连接仍存活，演不了 Hub 重启）验证守护进程掉线退避后自动重握手、uuid 与链接逐字节不变；(2) `tests/integration.rs` 新增配对解锁流（锁定态无链接/二维码 403、错密码 401、重复错密码 429、正确解锁后 SVG 可见、伪造 unlock 拒绝）；(3) 新增实例生命周期两测：`unresponsive` 标记的 WINDOWS 推送与恢复（配 `registry.rs` 的 Heartbeat 单元测：ping 周期、两次未答判超、Pong 治愈），close-blocked 脏文件清单与 force 杀注册 pid（一次性子进程扮演）+ 事后 4410；(4) §20.8 新增 `handshake_rate` 配置（默认 10/min/IP，0 = 不限）：压测与单地址大车队需要，默认值不变即原防踩踏语义；(5) `scripts/probes/hub-load.mjs` 落地 §20.12 压测行。
> 修订（2026-10-12，操作体验）：(1) §9.2 的横幅现在覆盖链路本身——Transport 新增 `onOffline`/`onOnline` 钩子（断线即报、重连后 4 s 致意，帧照常排队），boot 接线到 `remote.banner.offline`/`reconnected`（此前断线期间工作台看起来只是冻住）；(2) §20.5 的离线页改为脚本软轮询（15 s 节奏不变以避开离线探测预算、visibilitychange 即时一查、PC 上线的下一轮整体跳转；非 JS 环境 meta refresh 兜底；页面文字逐字节恒定），HTTP 层不再下发 `refresh` 头；(3) `playwright.remote.config.ts` 按 `executablePath` 探测加入 Firefox/WebKit 项目——缺引擎的机器只跑 chromium，不再成片启动失败。
> 修订（2026-10-12，手机端设置页重设计）：§11.3 的“设置页单列”落地为专属全屏页面（`src/remote/settingsPage.ts`）——桌面设置对话框是 720 px 双栏窗口，170 px 分类栏在 390 px 屏上把行挤成 130 px 竖条，完全不可读；新页面为单列全屏：分类作下钻行（每级自右滑入、表头带返回步，手机返回键逐级弹出、最后关页——backStack 的单条历史项按级重新武装），布尔为行内开关、枚举/主题/语言从底部表单选择、数字在表单里 − 值 + 步进（按设置自身步长取整、夹取上下界）、文件关联目录为独立一级（后端 `assoc_list_defaults` 目录）、文本/JSON 扩展设置在表单里编辑（非法 JSON 拒收并提示）；根级搜索横跨全部类别与扩展声明；省流模式归入“远程访问”分类。数据源与桌面完全同源：`SETTING_DEFS` + `updateSetting`、扩展声明经 `saveExtSetting`，枚举写入统一走 `settings.ts` 的 `applyEnumSetting`（桌面对话框同样改走它）。抽屉的设置行与手机档的 `workbench.openSettings`（命令面板、扩展的 `workbench.action.openSettings`）都路由到该页（`installPhoneSettingsEntry`，离开手机档恢复桌面原命令）；`tests/remoteResponsive.test.ts` 的 settings page 组七用例回归，截图基线 `scripts/probes/remote-phone-shots.mjs` 增 11–13 三张。
> 修订（2026-10-12，计划收口第三轮）：(1) §17.3 的远程垫片轮落地——`tests/remoteRound.ts` 把 tauriMock 的 invoke 引到真垫片链（tauriShim `invoke` → Transport → 帧编解码 → RelayEngine → 同一套脚本 handler），mock `Channel` 带 `toJSON` 流标记（`__GGS_CHAN__:<stream>`，relay 侧 revive，事件双向流动）；commandSweep 全命令在 tablet 标记下重跑 + phone 冒烟，uiSweep 整组在远程垫片下重跑（SCM/diff 断言改为轮询——wire 的往返让落点晚一拍；SCM 列表顺序在远程下不保证，按行名点击）；richHandlers 补 `list_dir_page`（远程资源管理器分页路径）。(2) §17.1 INSTANCE_RESTART 成功路径：`a_restart_kills_relaunches_and_waits_for_the_registration`——被注册 pid 终止、按注册的 LaunchSpec 重拉本测试二进制（`--exact restart_child_role --ignored` 的子角色，经 GGS_REMOTE_HOME 找到控制端点注册）、SPAWNED 应答新实例 id、WINDOWS 推送换人。(3) §7.10 idle_exit 单测两条（空闲计时先布防、到点才问退；有会话不问；0 分钟关闭）。(4) §17.4 三引擎矩阵：`playwright.remote.config.ts` 增加 Firefox/WebKit 项目；**发现并实测确认**——WebKit/Safari 不给 plain-HTTP localhost 豁免，`Secure` 会话 Cookie 被丢弃（登录永远回登录页）→ e2e fixture 全面改为 TLS 守护进程（`self-signed` + `ignoreHTTPSErrors`，即产品出厂形态），三引擎全绿；`visual-baseline.spec.ts` 按引擎×桌面/手机截登录页与离线页存 `target/studio/remote-e2e-shots/`（不提交像素基线——DOM 断言承载正确性，截图作肉眼比对记录）。
> 修订（2026-10-12，远程原理改为副本，§22）：按所有者要求（“整个 GGS 都在 PC 上跑，远程网页只是一个副本显示，核心逻辑在 PC 上”）——远程页默认不再在浏览器里运行工作台，而是 PC 桌面窗口（可隐藏）的实时 DOM 副本；输入回传 PC 重放。浏览器刷新、关闭不再重启任何东西：Claude Code 的对话页面常驻 PC 窗口，关掉网页后对话继续，下次打开看到的就是正在工作的 Claude。手机观看时隐藏的 PC 窗口按手机尺寸重排并换上手机外壳，副本 1:1。旧的浏览器端工作台保留为 `?frontend=1`。
> 修订（2026-10-12，公开端口静默）：按所有者要求（“如果不是 /u/uuid 访问，不要返回任何东西，就像没开这个端口一样”；“链接对才返回内容；判别不是 uuid 也要返回端口关闭”——同日所有者撤回了“端口扫描时也要端口关闭”的 TCP 层诉求，`listen` 保持 `0.0.0.0:8443` 默认）——§20.5 的公开表面收口为“只有链接形态对才有内容”：`/u/<合法 uuid>/…` 与 PC 自身的 `/tunnel`（仅放行 WebSocket 握手形态——守护进程的连法；对它的普通 HTTP 探测也静默）之外，任何请求**不写一个字节直接断开连接**（`hub/src/gate.rs`：tower 服务返回 `Silent` 错误，hyper 在服务应答 `Ok` 之前不写任何响应，故连接以“端口没开”的形态关闭）。uuid 的**形态判别也在门口**：`/u/` 后的段必须是 `identity::valid_uuid` 的小写带连字符 v8 形态（真实链接的固定拼写；大写、版本位错、百分号编码、`not-a-uuid` 一类都不是链接），否则同样零字节断开；形态合法但未知/离线的 uuid 照旧答同一个离线页（两态一致，PC 睡醒的自动重连 UX 保留，Hub 仍无从泄露哪些 uuid 存在）。`/healthz` 移到 `metrics_listen` 运营口（与 `/metrics` 同口，默认关闭）；`/` 的可选说明页（`landing_page` 配置）整体删除。部署面的同样收口：`deploy/Caddyfile` 只代理 `/u/*` 与 `/tunnel`，其余 `abort`（Caddy 直接关闭连接，不答 502）。物理边界如实记录：TCP 层的 SYN 应答无法隐藏（否则浏览器也连不上，SYN 扫描必见 open）；TLS 模式下 TLS 握手本身仍会完成（证书可见）；静默指 HTTP 层不产生任何响应字节——`nmap` 等探测拿不到任何服务指纹。`hub/tests/tunnel.rs` 的 `paths_outside_the_links_answer_nothing`（含畸形 uuid 各形态）与 fixture 改走 `gated()`（与 `serve` 同栈）回归，`gate.rs` 内含放行判定单测；探针 `remote-hub-multi-check.mjs` 的 healthz 检查改走 metrics 口、新增公开口静默与畸形 uuid 零字节检查。
> 修订（2026-10-13，实测修复）：§7.8 下载的大文件夹 zip 失败链——实例先整树打包、首片 `FileReply` 迟迟不发，守护进程对首片的 30 s 等待（`FETCH_TIMEOUT`）先到点，浏览器拿到 504 后（手动重试或自动续传）对**同一个一次性 URL** 再请求，票据已随首次请求消耗 → 404，Chrome 显示“未发现文件”。修复：实例在打包**前**先发一个空的首片（携带 zip 名、`total: 0`、`done: false`），响应头立即到达浏览器（下载条即刻出现，打包多久都不受 30 s 限制——守护进程对流式后续片本就无超时）；打包在头片之后失败时发 `status: 500` 的收尾片，守护进程将其转为**中止响应体**（`Err` 项结束流，连接断开），截断的压缩包永远不会以“完整文件”的形态落地。`daemon/tests/integration.rs` 的 `a_download_ticket_streams_the_file_once`（文件流、一次性语义、实例 404 转达、心跳首片 + 延迟字节、流中 500 中止五场景）与活体探针 `remote-live-check.mjs`（文件逐字节 + 文件夹 zip 的 PK 头）回归。

## 目录

0. [目标](#0-目标)
1. [需求与验收口径](#1-需求与验收口径)
2. [现状：决定架构的事实](#2-现状决定架构的事实)
3. [总体架构](#3-总体架构)
4. [技术选型与依赖清单](#4-技术选型与依赖清单)
5. [目录与文件结构](#5-目录与文件结构)
6. [通信协议 ggs-remote/1](#6-通信协议-ggs-remote1)
7. [守护进程 ggs-remote 详细设计](#7-守护进程-ggs-remote-详细设计)
8. [应用侧：remote_host 与 Relay](#8-应用侧remote_host-与-relay)
9. [远程前端：构建、垫片、传输](#9-远程前端构建垫片传输)
10. [按需加载与流量控制](#10-按需加载与流量控制)
11. [响应式外壳与逐功能适配](#11-响应式外壳与逐功能适配)
12. [插件在远程端](#12-插件在远程端)
13. [多窗口与新开窗口](#13-多窗口与新开窗口)
14. [插件包 ggs-remote](#14-插件包-ggs-remote)
15. [构建、打包、签名与 CI](#15-构建打包签名与-ci)
16. [安全设计与审查清单](#16-安全设计与审查清单)
17. [测试方案](#17-测试方案)
18. [开发任务拆分（里程碑 → 任务）](#18-开发任务拆分里程碑--任务)
19. [风险与对策](#19-风险与对策)
20. [多用户：自建中继服务器 Hub](#20-多用户自建中继服务器-hub)
21. [待确认问题](#21-待确认问题)
22. [副本模式：PC 是唯一前端](#22-副本模式pc-是唯一前端)

---

## 0. 目标

在一台 PC 上常驻一个**极低内存的托盘后台服务**，通过**一个固定访问链接 + 密码**，让手机或其他电脑的浏览器以**异步、按需加载**的方式完整使用该 PC 上 Git Graph Studio（GGS）的全部功能：文件管理、编辑器、源代码管理、Git Graph、终端、代码分析、CAN 分析和所有已安装插件。浏览器与 PC 之间用 **WebSocket 二进制帧**通信；一台 PC 可开多个 GGS 窗口，远程端可选择要接入的窗口，也可新开窗口。

**多用户**（§20）：可自己部署一台中继服务器 `ggs-remote-hub`，**不需要用户账号**——ggs-remote 填上服务器地址连上就能用。每台 PC 有自己的专属链接（路径方式，UUID 对应 PC，如 `https://remote.example.com/u/3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3/`）；PC 主动出站连接服务器，NAT 后也能用。局域网直连模式保留。

## 1. 需求与验收口径

| # | 需求 | 验收口径 | 落地章节 |
| - | ---- | -------- | -------- |
| R1 | 有服务器端 | 独立后台进程 `ggs-remote`（Rust），HTTPS + WSS 单端口 | §7 |
| R2 | 远程使用 GGS 全部功能 | 第 11.3 节功能矩阵逐项通过；`commandSweep` 在远程垫片下全绿 | §9、§11 |
| R3 | 异步、按需加载，控制流量 | 冷启动到工作台可交互 ≤ 1.5 MB（br 后）；二次访问 ≤ 50 KB；单次文件打开 ≤ 可见区域 ± 2 屏 | §10 |
| R4 | 手机 + PC 网页适配屏幕 | 三档断点 × 触控/键鼠；Playwright 设备仿真截图基线 | §11 |
| R5 | 密码访问 | Argon2id；登录限速与锁定 | §7.6 |
| R6 | WS 二进制通信 | 所有 RPC、流、事件走 `ggs-remote/1` 二进制帧 | §6 |
| R7 | 一台 PC 多窗口 | 每个 GGS 实例注册，远程端实时列表 | §13 |
| R8 | 一台 PC 一个链接 | 固定端口与路径；窗口选择在登录之后（Hub 模式下即该用户的专属链接） | §7.4、§20.5 |
| R9 | 改密码后远程须重登 | 凭据纪元 `epoch+1` → 该用户所有 WS 收到 4401 关闭 → 跳登录（≤ 1 s）；其他用户不受影响 | §7.6、§20.2 |
| R10 | 远程选择窗口 | 窗口选择页 + 工作台内窗口切换器 | §13 |
| R11 | 多系统托盘、极低内存 | Win/macOS/Linux；空闲 RSS ≤ 12 MB（Linux）/ ≤ 15 MB（Win/macOS） | §7.9 |
| R12 | 远程开窗口时可新开窗口 | `SPAWN` 帧 → 守护进程拉起新实例 | §13 |
| R13 | 所有插件正常 | git-graph-rs、claude-code 远程 live check 全通过 | §12 |
| R14 | 终端、文件管理、代码分析等适配手机和 PC | §11.3 逐视图方案 | §11 |
| R15 | 不同浏览器 | Chrome/Edge ≥ 100、Safari/iOS ≥ 16.4、Firefox ≥ 115、Samsung Internet ≥ 20 | §11.5 |
| R16 | 支持多用户，自建服务器，无需账号 | 自己部署的 Hub 同时服务多台 PC；ggs-remote 填服务器地址即可连上使用；Hub 无账号、无数据库；PC 之间会话、Cookie、缓存、流量隔离 | §20 |
| R17 | 每个用户一台 PC | 身份 = PC 的设备密钥；一把密钥只能有一条在线隧道 | §20.1、§20.4 |
| R18 | 不同用户链接不同 | 路径方式 `https://<域名>/u/<uuid>/`，uuid 由该 PC 设备公钥推导，一一对应、稳定不变 | §20.1、§20.5 |
| R19 | 扫码窗口密码解锁 | 托盘打开的配对页需输入访问密码（Argon2id 本机校验）后才显示二维码与地址列表；插件页二维码同一机制 | §7.6、§7.9、§14.3 |
| R20 | 远程实例生命周期管理 | 实例卡死（进程或界面无响应）可被检测；远程可关闭、重启、新开实例；有未保存文件先拒绝并列出清单，确认后才强杀 | §7.8、§13 |
| R21 | 远程查看各实例内容 | 窗口选择页与切换器显示每个实例的内容摘要（打开的编辑器与活动文件、终端数、未保存数、SCM 变更数）与状态徽标，不接入即可见 | §7.8、§8.1、§13 |

## 2. 现状：决定架构的事实

以下事实均已在代码中核对（2026-10-11）：

1. **前端与后端之间只有一条缝：`@tauri-apps/api`。** `src/` 中 40 个文件 import 了它：`api/core`（36 处，`invoke`、`Channel`）、`api/event`（8）、`api/window`（2，`titlebar.ts`、`workbench.ts`）、`api/webview`（1，拖放）、`plugin-clipboard-manager`（9）、`plugin-dialog`（5）、`plugin-opener`（5）、`api/app`（1，`getVersion`）。唯一绕过它的地方是 `src/extHost.ts:234/254` 读取 `__TAURI_INTERNALS__.convertFileSrc` 生成 `ggs://` URL。测试已证明这条缝可整体替换（`tests/tauriMock.ts`）。
   → **远程浏览器运行同一份前端，只把这条缝换成 WebSocket 传输**，所有功能都不必逐个改写。
2. **后端约 180 个 `#[tauri::command]`**（`lib.rs:1696` `generate_handler!`），参数混有 `State`、`AppHandle`、`Window`、`Channel`，没有脱离 webview 的分发表。二进制结果已在用（`cmd_fs::read_file_raw` 返回 `tauri::ipc::Response`）。
3. **多窗口 = 多进程。** `cmd_app::app_new_instance` → `spawn_new_instance` → `instance_argv(new_instance_plan(exe), folder)`（macOS 打包后为 `open -n <bundle> --args <path>`，其他平台直接执行 exe）。每个实例各有后端与插件后端（`GGS_INSTANCE_ID`）。
4. **前端资源嵌入可执行文件**（Tauri embedded assets，经 `app.asset_resolver()` 读取）；插件文件由 `ggs` 协议提供：`register_uri_scheme_protocol("ggs", |ctx, req| cmd_ext::serve_ext_asset(&req, &ctx.app_handle().asset_resolver()))`（`lib.rs:1540`）。**这个函数可以直接复用**来给远程端提供插件文件。
5. **事件基本是广播。** 例如终端输出 `event_app.emit("studio://pty-output-{id}", …)`（`pty.rs:110`）、Git 输出 `studio://git-output`。广播事件 Relay 天然能收到。插件宿主请求走 `ext-host-request` 事件（`ext_process.rs:42`），**多前端时会被重复应答**，必须修改（§8.6）。
6. **重计算都在后端，且已流式、窗口化。** 资源管理器按目录 `list_dir`，`read_file_chunk(path, offset, len)` 分块读，Fast Viewer、Hex、窗口化编辑器只取可见行，搜索、索引、对比经 `Channel` 分批推送。这是按需加载、控制流量的基础，远程方案要保持而不是破坏它。
7. **能力文件只授权 `main` 窗口**（`src-tauri/capabilities/default.json`）。新 webview 要有自己的能力文件。
8. **现有依赖可复用**：`if-addrs`（LAN 地址）、`ureq`/rustls（已把 ring 带进依赖树）、`zip`、`flate2`、`sha2`、`getrandom`、`base64`、`serde_json`。

## 3. 总体架构

```text
 手机 / PC 浏览器                                 PC（同一操作系统用户）
┌──────────────────────────┐    HTTPS + WSS    ┌──────────────────────────────────────────────┐
│ 登录页 / 窗口选择页        │◄────────────────►│ ggs-remote 守护进程（Rust，托盘，无 webview）   │
│  （守护进程内嵌，< 30 KB）  │   单端口 47615    │  axum + rustls + tokio(current_thread)        │
│ remote.html 工作台         │   单一链接        │  · auth：Argon2id、会话、epoch、限速           │
│  = 同一份 GGS 前端         │                   │  · assets：br 压缩缓存（内存 LRU + 磁盘）       │
│  + tauriShim（WS 传输）    │                   │  · router：帧路由、流控、会话恢复环形缓冲        │
│  + responsive 外壳         │                   │  · registry：注册表、SPAWN/关闭/重启、两级心跳  │
│  + sw.js（离线缓存）       │                   │  · admin API（仅 loopback，给插件页用）         │
└──────────────────────────┘                   └───────┬─────────────────────────┬─────────────┘
                                   本地控制通道（interprocess：│                         │ loopback WS /relay
                                   Win 命名管道 / Unix UDS）    │                         │（一次性令牌）
                                   注册、资源读取、attach      │                         │
                                                  ┌───────────┴──────────┐   创建   ┌────┴──────────────────────┐
                                                  │ GGS 实例 A（Tauri）    │────────►│ Relay webview（隐藏窗口）    │
                                                  │ src-tauri/remote_host │          │ relay.html：真 invoke /      │
                                                  │ · 注册 / 心跳 / 标题   │          │ Channel / listen，帧转发     │
                                                  │ · 资源：asset_resolver │          │ 仅在有远程会话时存在          │
                                                  │ · 插件文件：serve_ext_ │          └───────────────────────────┘
                                                  │   asset               │
                                                  └──────────────────────┘
                                                   GGS 实例 B、C …（每个窗口一个进程，同上）
```

### 3.1 组成部分

| 部分 | 位置 | 语言 | 职责 |
| ---- | ---- | ---- | ---- |
| 守护进程 `ggs-remote` | `extensions-src/ggs-remote/daemon/`（独立 Cargo crate，**不是**应用 workspace 成员，应用二进制不链接它） | Rust | 托盘、自启、HTTPS/WSS、认证、实例注册表、资源代理与缓存、帧路由、流控、拉起实例、本机管理 API |
| 插件包 `ggs-remote` | `extensions-src/ggs-remote/` | JS（在 ggs-node 上运行） | GGS 内的“远程访问”页面与命令；安装、升级、启停守护进程 |
| 中继服务器 `ggs-remote-hub`（可选，自建，多用户） | `extensions-src/ggs-remote/hub/`（独立 crate，不进 VSIX，发布为二进制与容器镜像） | Rust | 无账号无数据库的中继：PC 出站隧道、按 `/u/<uuid>/` 转发 HTTP/WS（§20） |
| 应用侧通用远程宿主 | `src-tauri/src/remote_host.rs`、`src/remote/`、`remote.html`、`relay.html`、`vite.remote.config.ts` | Rust + TS | 实例注册、资源与插件文件读取、按需创建 Relay、远程前端构建与垫片、响应式外壳 |

> **接缝规则**：应用代码只认识平台协议 `ggs-remote/1` 和固定的本地控制端点名，不出现任何插件 id；守护进程也不 import 应用的任何 crate。`scripts/check-seams.mjs` 新增两条规则（§15.4）。

### 3.2 为什么用 Relay webview，而不是 Rust 命令分发表

| 方案 | 做法 | 优点 | 缺点 | 结论 |
| ---- | ---- | ---- | ---- | ---- |
| **A. Relay webview** | 远程接入时，实例创建隐藏 webview `remote-relay`，页内用真 `@tauri-apps/api` 执行远程端发来的 invoke、Channel、listen，经 loopback WS 回传 | 180 个命令、所有 Channel、事件**零逐命令适配**；行为与桌面完全一致；随版本自动同步 | 接入期间多一个 webview 进程（约 40–90 MB） | **M1 采用** |
| B. Rust 分发表 | 宏生成 `remote_dispatch(cmd, json)` 直接调用命令函数 | 无额外 webview | 180 个命令逐个处理 `State`、`Window`、`Channel` 参数，持续维护，风险高 | M8 评估，仅用于不可见实例 |
| C. 像素流远程桌面 | 截屏 + 输入回放 | 实现简单 | 流量大、手机不可用、无法适配屏幕 | 否决 |

Relay 生命周期：首个远程会话 `ATTACH` 时创建；最后一个会话离开后再等 60 s 才销毁（手机切后台、短暂断网时可直接复用）。每个实例最多一个 Relay，多个远程会话共用，用帧头里的 `session` 字段分流。

### 3.3 一个实例、多个前端

远程端是该实例的另一个前端，与桌面窗口**共享**后端状态（打开的文件夹、符号索引、终端、插件后端），**各自**拥有 UI 状态（标签页、布局、滚动位置）。这与 VS Code 一个工作区开两个窗口的语义一致。需要修正的后端行为在 §8.6 列出。

### 3.4 关键时序

**登录并进入工作台：**

```text
浏览器            守护进程                      实例 A(Rust)            Relay(webview)
  │ GET /                │                            │                        │
  │◄── login.html ───────│                            │                        │
  │ POST /api/login ────►│ argon2 校验，建会话          │                        │
  │◄── Set-Cookie ───────│                            │                        │
  │ GET /windows ───────►│ 读注册表                    │                        │
  │◄── picker.html + 列表 │                            │                        │
  │ GET /w/A/v/0.2.0/remote.html                       │                        │
  │                      │── FETCH asset ────────────►│ asset_resolver.get()   │
  │◄── html（br，缓存）────│◄── 字节 ───────────────────│                        │
  │ WSS /ws ────────────►│ 校验 Cookie + Origin        │                        │
  │ HELLO / ATTACH(A) ──►│── ATTACH(session=7) ──────►│ 无 Relay → 创建         │
  │                      │                            │── 构建隐藏 webview ────►│
  │                      │◄────────── loopback WS /relay（一次性令牌）───────────│
  │◄── ATTACHED ─────────│                            │                        │
  │ INVOKE list_dir ────►│── 加 session=7 转发 ──────────────────────────────────►│ invoke('list_dir')
  │◄── RESULT ───────────│◄──────────────────────────────────────────────────────│
```

**改密码：**

```text
本机托盘/插件页/远程设置页 ─► 守护进程 auth.set_password()
  → 写 auth.json（新哈希，epoch=N+1）→ 清空会话表 → 轮换 ggs 资源令牌
  → 对每个在线 WS：发送 CLOSE{4401,"credentials-changed"} 并关闭
  → 浏览器 transport 收到 4401 → 清本地状态 → location = /login?reason=password-changed
```

---

## 4. 技术选型与依赖清单

> 版本号为**下限**。实施时用 `cargo add` / `npm i` 取当时的最新兼容版本，并锁在 `Cargo.lock` / `package-lock.json`。选择原则：纯 Rust 优先（原则 1）、不引入前端框架（原则 3）、守护进程体积和内存最小。

### 4.1 守护进程（`extensions-src/ggs-remote/daemon/Cargo.toml`）

| 用途 | crate | 版本 | 选择理由 / 备注 |
| ---- | ----- | ---- | --------------- |
| 异步运行时 | `tokio` | 1.4x | 只开 `rt`、`net`、`time`、`sync`、`macros`、`io-util`、`fs`、`process`、`signal`；用 **current_thread** 运行时，省线程栈内存 |
| HTTP 框架 + WS | `axum` | 0.8 | 开 `ws`、`http1`、`tokio`、`query`、`json`；内部用 hyper 1 与 tokio-tungstenite，WS 直接得到 `Message::Binary` |
| TLS 服务 | `axum-server` | 0.7 | `tls-rustls-no-provider`，配合下行的 rustls |
| TLS | `rustls` | 0.23 | `ring` provider（ring 已经通过应用的 ureq 进入依赖树）；只开 TLS 1.2/1.3 |
| 证书生成 | `rcgen` | 0.13 | 自签 CA + 服务器证书，SAN 写入所有 LAN IP、主机名、`<host>.local` |
| 密码哈希 | `argon2` | 0.5 | Argon2id，m=19456 KiB、t=2、p=1（OWASP 推荐基线） |
| 随机数 | `getrandom` | 0.3 | 会话令牌 32 字节、nonce、资源令牌 |
| 常量时间比较 | `subtle` | 2.6 | 令牌、CSRF nonce 比较 |
| 摘要 | `sha2` | 0.10 | 令牌只存 SHA-256；资源内容哈希 |
| 编码 | `base64` | 0.22 | URL-safe 令牌 |
| 序列化 | `serde` 1、`serde_json` 1、`rmp-serde` 1.3 | — | JSON 配置文件；MessagePack 控制帧 |
| 压缩（资源） | `brotli` | 8 | 纯 Rust；首次请求以 quality 9 压缩，按内容哈希缓存 |
| 压缩（帧） | `flate2` | 1 | `rust_backend`（miniz_oxide，纯 Rust）；deflate-raw，与浏览器 `CompressionStream('deflate-raw')` 互通 |
| MIME | `mime_guess` | 2 | 资源 Content-Type |
| 本地 IPC | `interprocess` | 2.2 | `tokio` 特性；`local_socket` 同时覆盖 Windows 命名管道和 Unix 域套接字 |
| 托盘（Win/macOS） | `tray-icon` | 0.21 | 系统原生托盘；菜单用其 re-export 的 `muda` |
| 事件循环（Win/macOS） | `tao` | 0.34 | 托盘需要主线程消息循环（Win32 消息泵 / NSApplication）；tao 不带 webview，只多约 1–2 MB |
| 托盘（Linux） | `ksni` | 0.3 | 纯 Rust StatusNotifierItem（D-Bus），**不依赖 GTK / libappindicator** |
| 托盘图标解码 | `png` | 0.17 | 启动时把内嵌 PNG 解成 RGBA（不引入 `image` 这类大库） |
| 开机自启 | `auto-launch` | 0.5 | Win `HKCU\…\Run`；macOS LaunchAgent；Linux `~/.config/autostart/*.desktop` |
| LAN 地址 | `if-addrs` | 0.13 | 与应用相同版本 |
| mDNS（可选特性 `mdns`） | `mdns-sd` | 0.13 | 广播 `_ggs-remote._tcp` 和 `<host>.local`；默认开启，可在配置中关闭 |
| 二维码 | `qrcode` | 0.14 | 只渲染 SVG（关掉 `image` 特性），给本机配对页用 |
| HTTP 日期 | `httpdate` | 1 | `Last-Modified` / `Expires` |
| 日志 | `tracing` 0.1 + `tracing-subscriber` 0.3 | — | `fmt` 输出到 `~/.ggs/logs/remote.log`，按 1 MB 轮换（自写，十几行） |
| 单例锁 | 标准库 `File::try_lock` | Rust ≥ 1.89 | 仓库 MSRV 1.94，无需第三方 |
| 开发依赖 | `tokio-tungstenite` 0.26（客户端）、`hyper-util` 0.1（客户端）、`tempfile` 3 | — | 集成测试 |

**明确不用**：`actix-web`（多线程运行时、内存高）、`warp`（停滞）、`openssl`（C 依赖）、`image`（体积大）、`tauri`（守护进程不能带 webview）、`systray` 系列旧库（已停止维护）。

**Release profile**（守护进程自己的 `Cargo.toml`）：

```toml
[profile.release]
opt-level = "s"        # 体积优先，内存与启动更省
lto = "fat"
codegen-units = 1
panic = "abort"        # 守护进程不跑第三方代码，abort 即可
strip = true
```

### 4.2 应用后端（`src-tauri/Cargo.toml`，`desktop` 特性下新增）

| 用途 | crate | 版本 | 备注 |
| ---- | ----- | ---- | ---- |
| 控制通道客户端 | `interprocess` | 2.2 | `tokio` 特性，运行在 `tauri::async_runtime` 上 |
| 控制帧编码 | `rmp-serde` | 1.3 | 与守护进程同一套消息定义（结构体复制在两边，用测试向量对齐，不共享 crate，以保持两边解耦） |
| 其他 | 复用现有 `tauri`、`serde`、`getrandom`、`sha2` | — | 无新增 UI 依赖 |

### 4.3 前端（`package.json`）

| 用途 | 包 | 版本 | 备注 |
| ---- | -- | ---- | ---- |
| 控制帧编码 | `@msgpack/msgpack` | ^3.1 | ESM、可 tree-shake，gzip 后约 10 KB；只进远程构建和 Relay |
| 端到端测试 | `@playwright/test`（devDependency） | ^1.5x | Chromium / WebKit / Firefox + 设备仿真；本仓库容器里用预装 Chromium（`executablePath: '/opt/pw-browsers/chromium'`） |
| 其他 | 无 | — | 不引入框架、手势库（hammer.js 已停更）、workbox（Service Worker 手写约 150 行）、pako（用浏览器原生 `CompressionStream`） |

浏览器原生 API：`WebSocket`（`binaryType = 'arraybuffer'`）、`CompressionStream/DecompressionStream('deflate-raw')`、`ServiceWorker` + `CacheStorage`、`visualViewport`、Pointer Events、`navigator.clipboard`、`ResizeObserver`、CSS 容器查询（Safari 16+）。

### 4.4 插件包（ggs-node 上的 JS）

不需要 npm 依赖。用 ggs-node 内置的 `http`（访问守护进程本机管理 API）、`fs`、`child_process`（启动守护进程）、`os`、`crypto`。页面是 webview panel，二维码 SVG 由守护进程生成。

---

## 5. 目录与文件结构

```text
extensions-src/ggs-remote/                      # 插件包（VSIX 源）
├── package.json                                # 清单：命令、配置、视图、平台目标
├── extension.js                                # 插件后端（ggs-node）：守护进程安装/启停、管理 API 客户端
├── lib/
│   ├── daemon.js                               # 定位/复制/升级/启动守护进程二进制
│   └── admin.js                                # 本机管理 API 客户端（loopback HTTP + admin token）
├── media/page/
│   ├── index.html                              # “远程访问”页面（CSP 严格）
│   ├── page.js                                 # 状态、链接、二维码、设备、改密、证书下载
│   └── page.css
├── build.mjs                                   # 按平台打 VSIX：cargo build → 拷贝二进制 → 写 zip
├── README.md
├── test/                                       # 插件自身测试（vitest 跑）
└── daemon/                                     # 守护进程 crate
    ├── Cargo.toml
    ├── build.rs                                # 生成内嵌 web 资源清单（含 sha256，用作 ETag）
    ├── assets/icons/{idle,listening,active}.png
    ├── web/                                    # 守护进程自带的极小页面（无构建步骤，ES2021）
    │   ├── login.html / login.js
    │   ├── picker.html / picker.js             # 窗口选择页（含“最近打开的文件夹”历史路径列表）
    │   ├── pair.html / pair.js                 # 仅 loopback：密码解锁（R19）、二维码、证书下载、改密
    │   ├── style.css                           # 共用样式，VS Code 风格（2026-10-12 重写：扁平紧凑、深浅色、手机到桌面）
    │   └── i18n.js                             # zh-cn / en
    └── src/
        ├── main.rs                             # 参数解析、单例锁、启动 tokio 线程与托盘主循环
        ├── config.rs                           # ~/.ggs/remote/config.json
        ├── paths.rs                            # ~/.ggs/remote 目录布局
        ├── auth.rs                             # Argon2id、epoch、改密
        ├── session.rs                          # 会话表、设备列表、踢下线
        ├── ratelimit.rs                        # 每 IP 指数退避 + 全局上限
        ├── recent.rs                           # 最近打开的文件夹历史（recent.json，随 WINDOWS 下发）
        ├── tls.rs                              # CA/服务器证书生成、加载、续期
        ├── http/
        │   ├── mod.rs                          # axum Router 组装、中间件（安全头、认证）
        │   ├── pages.rs                        # /、/login、/windows、/pair
        │   ├── api.rs                          # /api/login|logout|session|password|devices
        │   ├── assets.rs                       # /w/:inst/v/:ver/*、/w/:inst/ggs/:tok/*、上传下载
        │   └── admin.rs                        # /admin/*（loopback + admin token）
        ├── ws/
        │   ├── mod.rs                          # /ws 升级、连接任务（读/写双任务）
        │   ├── frame.rs                        # 帧头编解码、分片、压缩
        │   ├── msg.rs                          # 控制消息结构体（MessagePack）
        │   ├── flow.rs                         # 信用窗口
        │   └── resume.rs                       # 会话恢复环形缓冲
        ├── router.rs                           # 浏览器会话 ↔ 实例 Relay 的帧路由
        ├── registry.rs                         # 实例注册表、状态推送、SPAWN、空闲回收
        ├── control.rs                          # 本地控制通道服务端（interprocess）
        ├── relay_link.rs                       # /relay loopback WS：Relay 接入
        ├── cache.rs                            # 资源 br 缓存（内存 LRU + 磁盘）
        ├── spawn.rs                            # 拉起 GGS 实例
        ├── autostart.rs                        # auto-launch 封装
        ├── mdns.rs                             # mDNS（cfg feature）
        ├── tray/
        │   ├── mod.rs                          # 托盘抽象：状态、菜单项、事件
        │   ├── native.rs                       # Win/macOS：tray-icon + tao
        │   └── linux.rs                        # ksni
        └── log.rs                              # tracing 初始化、轮换

src-tauri/
├── src/remote_host.rs                          # 新：注册、控制通道客户端、资源服务、Relay 生命周期、--remote-host
├── capabilities/remote-relay.json              # 新：Relay webview 的权限

src/remote/                                     # 新：远程前端（模块 19）
├── tauriShim/
│   ├── core.ts                                 # invoke、Channel、convertFileSrc 替身
│   ├── event.ts                                # listen、once、emit
│   ├── window.ts                               # getCurrentWindow 替身
│   ├── webview.ts                              # getCurrentWebview 替身（拖放 → 上传）
│   ├── app.ts                                  # getVersion
│   ├── dialog.ts                               # 远程文件选择器 + 上传/下载
│   ├── clipboard.ts                            # navigator.clipboard + 兜底
│   ├── opener.ts                               # 新标签页 / 下载
│   └── internals.ts                            # 安装 window.__TAURI_INTERNALS__ 兼容对象
├── transport.ts                                # WS 连接、帧编解码、流控、恢复、重连
├── frame.ts                                    # 帧头与类型常量（与 daemon/src/ws/frame.rs 对齐）
├── boot.ts                                     # remote.html 入口：建连、ATTACH、再加载 main.ts
├── relay.ts                                    # relay.html 入口：真 Tauri API ↔ WS
├── responsive.ts                               # 档位检测、外壳布局切换
├── gestures.ts                                 # 长按、双指缩放、滑动返回（Pointer Events）
├── actionSheet.ts                              # 手机端底部动作表（替代右键菜单）
├── bottomTabs.ts                               # 手机端底部标签栏
├── windowSwitcher.ts                           # 工作台内窗口切换
├── remoteFilePicker.ts                         # 浏览 PC 文件系统的选择器
├── transfer.ts                                 # 分块上传、下载
├── terminalKeys.ts                             # 终端扩展按键行
├── dataSaver.ts                                # 省流模式
├── sw.ts                                       # Service Worker（单独构建为 sw.js）
└── remote.css                                  # 远程外壳样式（主题变量）

remote.html                                     # 新：远程工作台入口
relay.html                                      # 新：Relay 入口
vite.remote.config.ts                           # 新：远程构建（alias + base './'）
tests/remote.test.ts                            # 新：垫片、传输、帧
tests/remoteResponsive.test.ts                  # 新：外壳档位、动作表、手势
tests/e2e/remote/*.spec.ts                      # 新：Playwright
scripts/probes/remote-live-check.mjs            # 新：tauri dev + 守护进程 + Playwright
scripts/probes/remote-traffic.mjs               # 新：标准动作集流量
scripts/probes/remote-memory.mjs                # 新：守护进程 / Relay RSS
```

---

## 6. 通信协议 `ggs-remote/1`

### 6.1 帧头（所有链路通用：浏览器↔守护进程、守护进程↔Relay）

每个 WS **binary message** 就是一帧，字段小端：

```text
偏移  大小  字段        说明
0     1     type       帧类型（§6.2）
1     1     flags      bit0 COMPRESSED(deflate-raw) bit1 FIN bit2..3 编码(0=RAW 1=JSON 2=MSGPACK)
                       bit4 ERROR（RESULT 失败） bit5 MORE（分片未完）
2     2     reserved   0
4     4     session    浏览器链路恒为 0；Relay 链路为守护进程分配的会话号
8     4     stream     调用 id / Channel id / 订阅 id / 资源请求 id（发起方分配）
12    4     seq        发送方单调递增序号（恢复与确认用）
16    4     len        payload 字节数（压缩后）
20    len   payload
```

- **stream id 分配**：浏览器发起的用奇数，服务器发起的用偶数，不会冲突；守护进程转发到 Relay 时保持原值，靠 `session` 区分来源。
- **分片**：payload 超过 1 MB 时按 1 MB 切片，除最后一片外都置 `MORE`；接收方按 `(session, stream)` 拼接。
- **一消息多帧**：一个 WS binary message 也可携带多个完整帧（依次编码；接收方循环解码直到缓冲耗尽）。仅发送方合帧时使用——高频小帧（终端按键等）在 16 ms 窗口内合并为一个 message（§6.4），减少消息数与协议栈开销。
- **压缩**：发送方在 `len > 1024` 且内容可压缩（JSON、MSGPACK、`text/*` RAW）时压缩；`HELLO` 协商后才启用。

### 6.2 帧类型

| 值 | 名称 | 方向 | 编码 | payload |
| -- | ---- | ---- | ---- | ------- |
| 0x01 | `HELLO` | C→S | MSGPACK | `{proto:1, client:"web", ver, caps:{deflate, sw, clipboard}, formFactor, dataSaver, resume?:{sid, lastSeq}, csrf}` |
| 0x02 | `HELLO_ACK` | S→C | MSGPACK | `{sid, serverTime, heartbeatMs:20000, maxFrame:1048576, credit:1048576, resumed:bool}` |
| 0x03 | `WINDOWS` | S→C | MSGPACK | `{instances:[InstanceInfo]}`（全量，变化时推送） |
| 0x04 | `ATTACH` | C→S | MSGPACK | `{instance}` |
| 0x05 | `ATTACHED` | S→C | MSGPACK | `{instance, version, assetBase:"/w/<id>/v/<ver>/", ggsBase:"/w/<id>/ggs/<tok>/", frontendId}` |
| 0x06 | `DETACH` | C→S | — | 空 |
| 0x07 | `SPAWN` | C→S | MSGPACK | `{folder?, visible:bool}` → 回 `WINDOWS` + `SPAWNED{instance}` |
| 0x08 | `SESSION_END` | S→Relay | — | 守护进程通知 Relay：该 `session` 已结束（登出、踢下线、恢复超时），清理其订阅与 Channel |
| 0x0A | `INSTANCE_CLOSE` | C→S | MSGPACK | `{instance, force}` → 优雅退出；实例有未保存文件时回 `NOTICE{kind:"close-blocked", dirty:[…]}` 并保持原状；`force` 由守护进程直接终止该 pid |
| 0x0B | `INSTANCE_RESTART` | C→S | MSGPACK | `{instance}` → 终止该 pid → 按注册时的 `LaunchSpec`+`folders` 重新拉起 → `WINDOWS` + 远程自动接入（同 SPAWN 路径） |
| 0x10 | `INVOKE` | C→S | JSON 或 RAW | JSON：`{"c":"list_dir","a":{…},"h":{…}}`；RAW 时命令名放在 MSGPACK 前缀（§6.3） |
| 0x11 | `RESULT` | S→C | JSON 或 RAW | 成功：返回值；`ERROR` 位：`{"message":…}` |
| 0x12 | `CANCEL` | C→S | — | 取消该 stream 的调用或 Channel |
| 0x20 | `CHAN_DATA` | S→C | JSON 或 RAW | 一条 Channel 消息 |
| 0x21 | `CHAN_CLOSE` | 双向 | — | Channel 结束 / 前端丢弃 |
| 0x30 | `LISTEN` | C→S | MSGPACK | `{event, target?}`，stream = 订阅 id |
| 0x31 | `UNLISTEN` | C→S | — | stream = 订阅 id |
| 0x32 | `EVENT` | S→C | JSON | `{event, id, payload}` |
| 0x33 | `EMIT` | C→S | JSON | `{event, payload, target?}` |
| 0x40 | `FETCH` | C→S | MSGPACK | `{url, range?:[start,end]}`（WS 内取资源，供 HTTP 不便的场景） |
| 0x41 | `FETCH_DATA` | S→C | RAW | 分片；首片前置 MSGPACK 头 `{status, type, size}` |
| 0x42 | `UPLOAD` | C→S | RAW | 首片 MSGPACK 头 `{path, size, sha256, offset}`；之后 256 KB 一片 |
| 0x43 | `UPLOAD_ACK` | S→C | MSGPACK | `{offset}`（断点续传用） |
| 0x50 | `CREDIT` | 双向 | MSGPACK | `{bytes, ackSeq}` |
| 0x51 | `PING` / 0x52 `PONG` | 双向 | — | 心跳 20 s；`PONG` 带 `ackSeq` |
| 0x60 | `NOTICE` | S→C | MSGPACK | `{kind:"instance-exited"|"relay-restarted"|"server-stopping"|"version-changed"|"close-blocked", …}` |
| 0x7F | `CLOSE` | S→C | MSGPACK | `{code, reason}`，随后关闭 WS（WS close code 同值） |

关闭码：`4401` 凭据变更 / 踢下线（reason：`credentials-changed`、`revoked`、`expired`）；`4403` Origin 或 CSRF 不符；`4409` 协议或实例版本不符；`4429` 限流；`4410` 实例已退出。

### 6.3 invoke 的编码

Tauri 的 `invoke(cmd, args, options)` 有两种 body：JSON 对象，或 `ArrayBuffer`/`Uint8Array` 加 headers。

- **JSON 参数**（绝大多数）：`flags.enc = JSON`，payload = `{"c":cmd,"a":args,"h":headers?}` 的 UTF-8。**Relay 端原样 `JSON.parse` 后交给真 invoke，不做二次编码**，守护进程只看帧头，不解析 payload。
- **二进制参数**：`flags.enc = RAW`，payload = `u16 头长 + MSGPACK{c, h} + 原始字节`。
- **Channel 参数**：垫片的 `Channel` 实现 `toJSON()` 返回 `"__GGS_CHAN__:<streamId>"`。Relay 在调用前遍历参数（深度 ≤ 4），把这种字符串替换为真 `new Channel()`，其 `onmessage` 用 `CHAN_DATA(stream=<streamId>)` 回传。Channel 消息是 `ArrayBuffer` 时（Tauri 2 的 Raw 消息）走 RAW 编码。
- **结果**：真 invoke 返回 `ArrayBuffer` 时 RESULT 为 RAW，否则 `JSON.stringify` 后发送。异常时置 `ERROR` 位，payload 为 `{"message": String(err)}`，垫片抛出与桌面相同的字符串（后端命令返回 `Result<T, String>`，桌面端拿到的也是字符串）。
- **取消**：`CANCEL(stream)` → Relay 对该 stream 下的 Channel 停止转发；对已有取消机制的后端命令（搜索、索引等使用“取消代际”），由前端自身逻辑像桌面一样调用对应的 cancel 命令，协议层不额外做语义取消。

### 6.4 流控

Tauri 的 Channel 由后端推送，无法反压到后端。因此流控分两段：

1. **守护进程 → 浏览器：信用窗口。** 每个连接初始信用 1 MB（`HELLO_ACK.credit`）。浏览器每处理掉 256 KB 发一次 `CREDIT{bytes}`。信用耗尽时，守护进程停止读取该会话来自 Relay 的帧（在 Relay 链路上按会话排队）。
2. **Relay 内：** 每个会话的待发队列上限 32 MB。超过时：
   - 终端输出：合并为“已截断 N 字节”标记，并把截断点之后的最近 64 KB 保留下来（保证屏幕最终正确）；
   - 其他 Channel：发 `NOTICE{kind:"overflow", stream}`，前端的对应视图走自己的“重新加载”路径（与桌面断流重试相同）。
3. **合并：** Relay 对 `studio://pty-output-*` 事件按 16 ms 合帧；`FsChange` 类事件按 100 ms 合并去重。
4. **上行合帧（终端输入）**：按键这类高频小 `INVOKE` 由 `transport.ts` 在 16 ms 窗口内合并为一个 WS message（§6.1 一消息多帧），Relay 侧解码后逐帧执行。合帧减少的是消息数；单次按键的回显延迟仍等于链路 RTT（Hub 模式两跳）——已知取舍（§19），需要更低延迟时再评估本地回显。
5. **拉取型数据（FETCH、文件块读取）** 天然受请求驱动，不需要额外处理。

### 6.5 会话恢复（手机切后台、换网络）

- 守护进程为每个浏览器会话保留最近 **1 MB 或 2000 帧**的下行帧（环形缓冲，`ws/resume.rs`），以 `seq` 标号；浏览器在 `PONG`、`CREDIT` 里带 `ackSeq`，守护进程据此丢弃已确认部分。
- 断线后会话保留 **120 s**（期间 Relay 侧订阅、Channel 不关闭，下行帧继续进缓冲）。
- 浏览器重连发 `HELLO{resume:{sid,lastSeq}}`：缓冲完整则补发 `lastSeq+1` 之后的帧并回 `resumed:true`；缓冲溢出或已过期则回 `resumed:false`，前端执行“软重载”（保留标签页列表与打开的文件路径，重新拉数据）。
- 断线期间未完成的 `INVOKE`：结果若已进入缓冲则随补发到达；否则前端在 `resumed:false` 时以 `"connection lost"` 拒绝这些 Promise。

### 6.6 版本与兼容

- `proto` 主版本不同 → `CLOSE 4409`。
- 远程前端资源路径带实例版本 `/w/<id>/v/<ver>/`，实例升级后旧标签页收到 `NOTICE{version-changed}` 并提示刷新。
- 帧类型只增不改；未知类型的帧接收方忽略（前向兼容）。

### 6.7 两端同一套实现约束

`daemon/src/ws/frame.rs` 与 `src/remote/frame.ts` 用同一组**测试向量**（`extensions-src/ggs-remote/daemon/tests/vectors/*.bin` + `*.json` 描述）验证：头编码、分片、压缩、MSGPACK 控制消息。`src-tauri/src/remote_host.rs` 的控制消息同理（`vectors/control/*`）。

---

## 7. 守护进程 `ggs-remote` 详细设计

### 7.1 启动流程（`main.rs`）

```rust
fn main() -> ExitCode {
    let args = cli::parse();                     // 手写解析：run | status | stop | set-password | print-link
    let paths = paths::Paths::resolve()?;        // ~/.ggs/remote
    let _lock = match single_instance(&paths) {  // std::fs::File::try_lock()
        Ok(l) => l,
        Err(_) => return forward_to_running(&args), // 已在运行：把 CLI 动作转给它（admin API）
    };
    log::init(&paths)?;
    let cfg = config::load_or_init(&paths)?;     // 首次：生成端口、admin token、TLS
    let (tray_tx, tray_rx) = std::sync::mpsc::channel(); // 托盘 → 服务的事件
    let (state_tx, state_rx) = tokio::sync::watch::channel(TrayState::Idle); // 服务 → 托盘图标

    // tokio 运行在后台线程（current_thread）；主线程留给托盘消息循环（macOS 必须在主线程）
    let server = std::thread::Builder::new().name("ggs-remote-io".into())
        .stack_size(1 << 20)
        .spawn(move || {
            tokio::runtime::Builder::new_current_thread().enable_all().build()?
                .block_on(server::run(cfg, paths, tray_rx, state_tx))
        })?;

    #[cfg(any(windows, target_os = "macos"))] tray::native::run(state_rx, tray_tx); // 阻塞，退出即结束进程
    #[cfg(target_os = "linux")]               tray::linux::run(state_rx, tray_tx);  // ksni 自带线程；无托盘则 park
    server.join().ok();
    ExitCode::SUCCESS
}
```

- `server::run` 内部：加载 TLS → 绑定 `0.0.0.0:<port>`（或配置的地址）→ 绑定 loopback 端口（`/relay`、`/admin`、`/pair`，**与对外端口分开**，只监听 `127.0.0.1` 随机端口，写入 `~/.ggs/remote/loopback.json`）→ 启动控制通道服务端 → 启动 mDNS → 进入 `select!` 主循环（托盘事件、关停信号）。
- `forward_to_running`：读 `loopback.json` 和 `admin.token`，调用运行中实例的 `/admin/*`。这样 `ggs-remote set-password`、`ggs-remote print-link` 在任何情况下都有效。

### 7.2 磁盘布局（`~/.ggs/remote/`）

| 文件 | 权限 | 内容 |
| ---- | ---- | ---- |
| `config.json` | 0600 | `{port, bind, tls:{mode:"self-signed"|"custom"|"none", certPath?, keyPath?}, mdns, autostart, spawnVisible, folderInput, idleExitMinutes, trustProxy, dataSaverDefault}` |
| `auth.json` | 0600 | `{hash:"$argon2id$…", epoch, updatedAt}` |
| `sessions.json` | 0600 | `[{tokenHash, epoch, device, ua, ip, created, lastSeen, remember}]`（重启后会话仍有效） |
| `admin.token` | 0600 | 32 字节随机，loopback 管理 API 用 |
| `loopback.json` | 0600 | `{port, pid}` |
| `tls/ca.pem`、`tls/ca.key`、`tls/server.pem`、`tls/server.key` | key 0600 | 自签证书；服务器证书 397 天，到期前 30 天或 LAN 地址变化时自动重签（CA 不变，手机无需重装） |
| `cache/` | 0700 | br 资源缓存，按 sha256 命名，上限 64 MB，LRU 清理 |
| `bin/ggs-remote(.exe)` | 0755 | 由插件安装的守护进程本体 |
| `daemon.lock` | — | 单例锁 |
| `control.sock`（Unix） | 0600 | 控制通道；Windows 为命名管道 `\\.\pipe\ggs-remote-<sha256(用户名)[..12]>`，DACL 只允许当前用户 |

Windows 权限：用 `icacls` 等效 API 不现实，`auth.json`、`admin.token` 放在 `%USERPROFILE%\.ggs\remote`，该目录默认只有当前用户和管理员可读，满足要求；在文档中注明。

### 7.3 HTTP 路由（`http/mod.rs`）

| 方法 路径 | 监听 | 认证 | 说明 |
| --------- | ---- | ---- | ---- |
| `GET /` | 对外 | — | 已登录 → 302 `/windows`；否则 302 `/login` |
| `GET /login`、`/login.js`、`/style.css`、`/i18n.js` | 对外 | — | 内嵌小页面（`include_bytes!`，构建时预压缩 br） |
| `GET /lang.js` | 对外 + loopback | — | 页面语言：`window.ggsLang`，取自 `~/.ggs/settings.json`（`locale`/`displayLanguage`），未设置时为空串（页面回退浏览器语言）；`no-store`，豁免暂停/无密码守卫（2026-10-12） |
| `POST /api/login` | 对外 | 限速 | `{password, device, remember}` → Set-Cookie |
| `POST /api/logout` | 对外 | 会话 | 删除会话 |
| `GET /api/session` | 对外 | 会话 | `{device, expires, csrf}`（csrf 供 WS HELLO 用） |
| `POST /api/password` | 对外 | 会话 + 旧密码 | 改密（§7.6） |
| `GET /api/devices`、`DELETE /api/devices/:id` | 对外 | 会话 | 设备列表、踢下线 |
| `GET /windows`、`/picker.js` | 对外 | 会话 | 窗口选择页 |
| `GET /w/:inst/v/:ver/*path` | 对外 | 会话 | 远程前端资源（§10.2），`immutable` 缓存 |
| `GET /w/:inst/ggs/:tok/*path` | 对外 | 资源令牌 | 插件文件（§12.2），沙箱 iframe 无 Cookie，所以用路径令牌 |
| `GET /w/:inst/download?path=&zip=` | 对外 | 会话 + 一次性下载票据 | 文件或文件夹（zip 流）下载 |
| `GET /ws` | 对外 | 会话 + Origin | 升级为 WS |
| `GET /sw.js` | 对外 | — | Service Worker（作用域 `/`） |
| `GET /ca.crt`、`/ca.mobileconfig` | 对外 | — | 只含公钥证书，可公开 |
| `GET /relay` | loopback | 一次性令牌 | Relay 接入 |
| `GET /pair` | loopback | `?t=` 一次性票据 | 本机配对页（扫码窗口）：输入访问密码解锁（R19）后才显示二维码与地址列表 |
| `POST /pair/unlock` | loopback | 一次性票据 | `{password}` → Argon2id 校验 → 解锁令牌（内存 5 min、仅 loopback；失败计入 §7.6 限速） |
| `POST /pair/hub/connect`、`/pair/hub/disconnect` | loopback | 一次性票据 | 配对页的中继服务器表单（2026-10-12）：`{url, joinKey?}`（url 也可为整条连接串）保存 / 忘记中继；与 `/admin/hub/*` 同一逻辑，票据即本机凭据（与首次设密同一凭证）；`GET /pair/state` 的 `hub.settings` 带回已存地址供表单回填 |
| `GET /admin/*` | loopback | admin token | 管理 API；`/admin/qr` 需另附解锁令牌（R19） |

中间件（顺序）：请求体上限（API 64 KB，上传走 WS）→ 安全响应头 → 认证提取（`Cookie: ggsr=<token>` → 查会话 → 校验 epoch、过期）→ 路由。

安全响应头：

```text
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
                         img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; worker-src 'self' blob:;
                         frame-ancestors 'none'; base-uri 'none'; form-action 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=()
Cross-Origin-Opener-Policy: same-origin
Strict-Transport-Security: max-age=31536000   （仅自带证书模式）
```

（`style-src 'unsafe-inline'` 是因为 CodeMirror 与现有视图用内联 style；工作台 CSP 的具体值以桌面 `tauri.conf.json` 的 CSP 为基础调整，M1 中逐项核对。）

### 7.4 一个链接

- 默认端口 **47615**，首次运行写入配置；端口被占用时提示并在托盘显示错误，不自动换端口（换端口会让链接变化，违反 R8）。
- 链接：`https://<首选 LAN IP>:47615/`。首选 IP 规则：有默认路由的网卡上的私有 IPv4 优先，其次 `<hostname>.local`。配对页同时列出所有地址（`if-addrs`），每个地址一个二维码。
- 外网访问：不内置穿透。支持两种部署：
  1. 隧道 / 反代终结 TLS：`tls.mode = "none"` + `bind = 127.0.0.1` + `trustProxy = true`，只信任 loopback 来源的 `X-Forwarded-For/Proto/Host`；`/ws` 的 Origin 校验改为对 `X-Forwarded-Host`。
  2. Tailscale：`tailscale cert` 产出的证书配置成 `custom` 模式，链接为 `https://<machine>.<tailnet>.ts.net:47615/`。

- **防火墙**：Windows 首次绑定 `0.0.0.0` 会弹防火墙授权框，拒绝则局域网不可达且守护进程无感知。对策：守护进程记录最近一次非本机连接时间，配对页与插件页显示“最近外来访问：从未 / n 分钟前”；从未有外来访问时给出放行指引（Windows 允许 `ggs-remote.exe` 专用网络；macOS 系统防火墙）。不自动加规则（需管理员权限）。
- **同一 PC 多个操作系统用户**：单例锁与配置在各用户的 `~/.ggs/` 下，但 LAN 端口只有一个——第二个用户的守护进程绑定失败时托盘显示“端口 47615 已被本机其他用户的 ggs-remote 占用”，该用户走 Hub 模式（uuid 各异，互不影响）。明确取舍，不做端口偏移（违反 R8 的“一个链接”）。

### 7.5 TLS（`tls.rs`）

- 首次运行：`rcgen` 生成 ECDSA P-256 CA（有效期 10 年，`CN=GGS Remote Local CA <hostname>`）和服务器证书（397 天，SAN：所有 LAN IP、`localhost`、`127.0.0.1`、主机名、`<hostname>.local`）。
- **地址变化时自动重签**：每 60 s 用 `if-addrs` 检查一次地址集合，变化则用同一 CA 重签服务器证书，并通过 `axum_server::tls_rustls::RustlsConfig::reload_from_pem` 热更新，不断开现有连接。
- 证书安装：
  - iOS：`/ca.mobileconfig`（`com.apple.security.root` payload），装好后在“设置 → 通用 → 关于本机 → 证书信任设置”中开启，配对页给出图文步骤；
  - Android：`/ca.crt`，在“安装证书 → CA 证书”中安装；
  - 桌面浏览器：`/ca.crt` 导入系统钥匙串或证书存储。
- 不安装 CA 也能用（手动越过警告），但浏览器不认为是安全上下文时，Service Worker 和剪贴板 API 不可用，按 §11.5 降级。

### 7.6 认证与会话（`auth.rs`、`session.rs`、`ratelimit.rs`）

```rust
pub struct AuthFile { hash: String, epoch: u64, updated_at: u64 }

pub struct Session {
    token_hash: [u8; 32],   // SHA-256(token)，明文令牌只出现在 Set-Cookie 里
    epoch: u64,             // 签发时的凭据纪元
    device: String,         // 用户填写或从 UA 推断：“iPhone Safari”
    ua: String, ip: IpAddr,
    created: u64, last_seen: u64,
    remember: bool,         // true：30 天绝对过期；false：12 小时滑动过期
    csrf: [u8; 16],         // WS HELLO 校验用
}

impl Auth {
    /// Argon2id 校验放到 spawn_blocking，避免阻塞 current_thread 运行时（单次约 30–60 ms）。
    pub async fn verify(&self, password: &str) -> bool;
    /// 改密：校验强度 → 新哈希 → epoch+1 → 原子写 auth.json（写临时文件再 rename）
    /// → sessions.clear() → 资源令牌轮换 → broadcast(Kick{code:4401, reason:"credentials-changed"})
    pub async fn set_password(&self, new: &str) -> Result<(), AuthError>;
}
```

- **首次设置密码只能在本机完成**：托盘“设置密码…”打开 loopback `/pair` 页面，或在插件页设置，或用 CLI `ggs-remote set-password`。未设置密码时对外端口只返回“请在 PC 上设置密码”。
- **密码规则**：≥ 8 个字符；拒绝常见弱口令（内置前 1 万个常见密码的 SHA-1 前缀表，约 40 KB，`include_bytes!`）。
- **登录**：成功后 `Set-Cookie: ggsr=<base64url(32B)>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=…`——`Secure` 跟随浏览器实际使用的协议（2026-10-12 修复）：直连看本守护进程的 TLS 模式，经 Hub 看其转发的 `x-forwarded-proto`（Hub 按自身 `tls.mode` 推导，`trust_proxy` 时以前置反代的值为准）。纯 HTTP 访问不再带 `Secure`——否则浏览器静默丢弃该 Cookie，登录返回成功却永不保持。
- **限速**（`ratelimit.rs`）：按 IP 计失败次数，第 5 次起锁定 `60 s × 2^(n-5)`，上限 1 h；全局每分钟失败 30 次后，所有登录统一延迟 2 s。成功登录清零该 IP 计数。锁定状态只保存在内存。
- **改密后重登（R9）**：
  1. 任意入口调用 `set_password`；远程入口要求当前密码，本机入口（admin）不要求；
  2. `epoch+1`，清空会话表并落盘；
  3. 通过 `tokio::sync::broadcast` 通知所有 WS 连接任务 → 发送 `CLOSE{4401,"credentials-changed"}` → 关闭；
  4. 浏览器 `transport.ts` 处理 4401：注销 Service Worker 中的私有缓存（API 响应，资源缓存保留）、清 sessionStorage → `location.replace('/login?reason=password-changed')`；
  5. 登录页根据 `reason` 显示“密码已更新，请重新登录”。
- **踢下线**：删除单个会话 + 向该会话的连接发 4401 `revoked`。“全部下线”保持密码不变，只把 `epoch+1`。
- **配对页解锁（R19）**：`/pair` 与插件页显示二维码、地址列表前须输入访问密码——`POST /pair/unlock`（配对页）或 `POST /admin/unlock`（插件页代理）本机 Argon2id 校验，错误同样计入限速。解锁令牌只存内存、5 分钟过期、仅在 loopback 有效；密码未设置时配对页先引导设置，首次设置成功即视为已解锁；配对页的改密区域在解锁之后。配对页的设密与解锁两屏同样带中继服务器表单（2026-10-12：托盘打开的页面也是"密码设置处即服务器设置处"——`POST /pair/hub/connect` 凭一次性票据即可保存，密码未落定前由守护进程持有（NoPassword），密码落定即自动连接）。

### 7.7 WS 连接任务（`ws/mod.rs`）

```rust
async fn on_upgrade(ws: WebSocket, ctx: ConnCtx) {
    let (mut sink, mut stream) = ws.split();
    let (out_tx, mut out_rx) = mpsc::channel::<Frame>(256);     // 有界：配合信用
    let writer = tokio::spawn(async move {                      // 写任务：序号、压缩、恢复缓冲
        while let Some(f) = out_rx.recv().await { /* resume.push(&f); sink.send(Binary(f.encode())) */ }
    });
    // 读任务：首帧必须是 HELLO（5 s 超时），校验 csrf；之后按 type 分发
    while let Some(Ok(Message::Binary(buf))) = stream.next().await {
        let f = Frame::decode(&buf)?;                            // 长度、分片上限校验
        match f.ty {
            ATTACH => router.attach(&ctx, f).await,             // 会话绑定实例，必要时让实例创建 Relay
            INVOKE | CANCEL | LISTEN | UNLISTEN | EMIT | CHAN_CLOSE | FETCH | UPLOAD
                   => router.to_relay(&ctx, f).await,           // 只改写 session 字段，原样转发
            CREDIT => flow.grant(&ctx, f),
            PING   => out_tx.send(Frame::pong(resume.acked())).await,
            SPAWN  => registry.spawn(&ctx, f).await,
            INSTANCE_CLOSE | INSTANCE_RESTART => registry.lifecycle(&ctx, f).await,
            _ => {}                                             // 未知类型忽略
        }
    }
    router.detach(&ctx).await; writer.abort();
}
```

- 守护进程对 `INVOKE` 等帧**只看帧头，不解析 payload**：内存和 CPU 都与业务无关，这也是守护进程能保持极低内存的原因。
- 单连接上限：同时在途 `INVOKE` 1024 个，`LISTEN` 4096 个，超过回 `ERROR`。
- **会话周期重验**：连接任务每 60 s 复查会话有效性（自然过期、epoch 变更）——失效即 `CLOSE{4401,"expired"}`；踢下线与改密是即时推送，此项兜住长连接上的令牌到期。
- 每个会话最多同时接入一个实例；切换窗口时先 `DETACH` 再 `ATTACH`。

### 7.8 实例注册表与路由（`registry.rs`、`router.rs`、`control.rs`、`relay_link.rs`）

控制通道消息（MessagePack，长度前缀 `u32` + body）：

```rust
// 实例 → 守护进程
enum FromInstance {
    Register { instance_id: String, pid: u32, version: String, title: String,
               folders: Vec<String>, visible: bool, remote_host: bool,
               launch: LaunchSpec /* 来自 cmd_app::instance_argv，用于 SPAWN 时拉起同一个 GGS */ },
    Update   { title: Option<String>, folders: Option<Vec<String>>, visible: Option<bool>, busy: Option<Busy>,
               summary: Option<Summary> /* R21：打开的编辑器、活动文件、终端数、SCM 变更数 */ },
    Pong     { nonce: u64 },              // 心跳应答（两级心跳，见下）
    CloseBlocked { dirty: Vec<String> },  // 对 Quit 的应答：有未保存文件，列出路径，等待 force
    AssetReply { req: u32, status: u16, content_type: String, etag: String, body: Vec<u8> }, // 分片
    FileReply  { req: u32, status: u16, total: u64, chunk: Vec<u8>, done: bool },            // 下载分片
    RelayReady { token_used: bool },
    Bye,
}
// 守护进程 → 实例
enum ToInstance {
    Welcome { daemon_version: String, relay_url: String /* ws://127.0.0.1:<lp>/relay */ },
    FetchAsset { req: u32, kind: AssetKind /* App | Ext */, path: String },
    FetchFile { req: u32, path: String, zip: bool },   // 下载（/w/:inst/download）：单文件或实例侧流式 zip
    EnsureRelay { token: String },    // 一次性令牌，60 s 过期
    DropRelay,                        // 无会话 60 s 后
    Ping { nonce: u64 },              // 心跳：每 15 s，10 s 未回 Pong 连续 2 次 → state = "unresponsive"
    Show,                             // 托盘“在桌面显示”
    Quit,                             // 优雅退出：空闲回收或远程 INSTANCE_CLOSE；有未保存文件回 CloseBlocked
}
```

- **实例信息**（`WINDOWS` 推送给浏览器）：`{id, title, folders, version, visible, remoteSessions, startedAt, busy:{terminals, dirty}, state, lastSeen, summary:{tabs:[{path, dirty, active}], terminals, scmChanges}}`。`state` 取 `ok | unresponsive`——**两级心跳**：控制通道 `Ping` 判进程存活（Rust 侧应答，UI 卡死不影响）；有远程会话时守护进程再对 Relay 链路发 WS `PING` 判界面存活（Relay webview 卡死则不应答）。任一级连续 2 次超时即标记，随 `WINDOWS` 推送，窗口选择页与切换器显示徽标；恢复应答则自动摘除。
- **路由表**：`HashMap<SessionId, InstanceId>` + 每个实例一个 `RelayLink`（loopback WS 的发送端）。浏览器帧 → 改写 `session` → `RelayLink.send`；Relay 帧 → 按 `session` 找浏览器连接的 `out_tx`。
- **Relay 链路**：`/relay?t=<token>` 握手，令牌与 `EnsureRelay` 签发的一致且未用过；一个实例只接受一个 Relay 链路。链路断开 → 对该实例的所有会话发 `NOTICE{relay-restarted}`，并重新 `EnsureRelay`。
- **实例消失**（控制通道断开且 pid 不存在）：从注册表删除，对接入它的会话发 `CLOSE 4410` → 浏览器回到窗口选择页。
- **远程实例管理（R20）**：`INSTANCE_CLOSE` / `INSTANCE_RESTART` 的执行方在守护进程。优雅关闭经 `Quit`——实例有未保存文件回 `CloseBlocked{dirty}`，守护进程转发为 `NOTICE{kind:"close-blocked"}`，远程确认后 `force` 直接终止 pid（先决条件：控制通道仍归属该 pid，防 pid 复用误杀）。重启 = 终止 + 按注册时的 `LaunchSpec` 与 `folders` 重新拉起 + 等 `Register`（超时 30 s）+ 推 `WINDOWS`；被关闭实例上的远程会话收 `CLOSE 4410`，新实例注册后按 SPAWN 的路径自动接入。卡死实例（两级心跳超时）正是重启的主场景——控制通道在、应答不在时也能杀。
- **下载的数据通路**：`GET /w/:inst/download` 的字节经 `FetchFile` → `FileReply` 分片回传。实例侧路径约束与 `ext_fs` 同一策略——只允许已打开的工作区文件夹、插件安装与存储目录（规范化后拒绝 `..` 与逃逸）；`zip` 在实例侧先整树打进临时文件（zip writer 需要 seek）再流式回传——**打包前先发一个空的首片**（2026-10-13：响应头即刻到达浏览器，打包时长不受守护进程首片 30 s 等待限制；打包失败发流中 `status: 500` 收尾片，守护进程转为中止响应体，截断的压缩包不会以完整文件落地）。一次性下载票据（60 s、一次性）由守护进程签发，防跨站直链。

### 7.9 托盘（`tray/`）与内存

托盘状态：`Stopped`（灰）、`Listening`（蓝）、`Active(n)`（绿点 + 提示“n 个远程设备”）、`Error(msg)`（红）。

菜单：

```text
GGS Remote — 监听中 (https://192.168.1.20:47615/)
──────────────
复制访问链接
显示配对二维码…             → 默认浏览器打开扫码窗口（loopback 配对页，先输访问密码，R19）
修改密码…                   → 同上，定位到改密区域
已连接设备 (2)            ▸  iPhone Safari（14:02）  ▸ 断开
                              全部断开
──────────────
打开 Git Graph Studio        → 若有实例则 Show 最近的；否则按记录的 LaunchSpec 拉起
暂停远程访问 ✓
开机启动 ✓
──────────────
退出
```

- **Windows/macOS**：`tao::event_loop::EventLoopBuilder::with_user_event()` 在主线程运行；`tray_icon::TrayIconBuilder` 创建图标；菜单事件通过 `MenuEvent::receiver()` 转成 `std::sync::mpsc` 发给 tokio 线程；状态变化通过 `EventLoopProxy::send_event` 回到主线程更新图标。macOS 启动时设置 `ActivationPolicy::Accessory`（不出现在 Dock），打包为 `GGS Remote.app`，`Info.plist` 里 `LSUIElement = true`。
- **Linux**：`ksni::TrayMethods::spawn`（tokio 特性）。D-Bus 上没有 `StatusNotifierWatcher`（如未装 AppIndicator 扩展的 GNOME）时记录日志，进入无托盘模式，管理只能通过 GGS 插件页或 CLI。
- **扫码窗口（R19）**：“显示配对二维码…”经一次性票据打开 loopback 配对页（`https://127.0.0.1:<lp>/pair?t=…`，默认浏览器）；页面先要求输入访问密码（§7.6 配对页解锁），解锁成功才渲染各 LAN 地址的二维码与 Hub 链接（Hub 在线时其链接与二维码居首，2026-10-12），5 分钟后重新上锁。页面常设中继服务器卡片（设密屏、解锁屏、解锁后都在）：地址/连接串 + 可选服务器口令、连接状态行（未配置/已保存待设密/连接中/在线/被拒/被顶替）与断开按钮（§7.6）。
- **菜单语言**：读 `~/.ggs/settings.json` 的 `locale`（应用实际写入的键；`displayLanguage` 作为旧写法兼容），en / zh-cn；两个托盘后端每秒轮询菜单模型并在签名变化时重建，应用切语言后秒级跟随。
- **平台细节（M6 手测清单）**：explorer.exe 崩溃重启后按 `TaskbarCreated` 重新注册图标；系统关机/注销（`WM_ENDSESSION` / macOS 会话结束）时事件循环干净退出，避免 `sessions.json`、`daemon.lock` 写坏；Windows 托盘 tooltip ≤ 127 字符；macOS 图标提供模板版本（黑白两套，菜单栏深浅自适应）。
- **内存措施**：tokio current_thread；I/O 线程栈 1 MB；资源缓存默认放磁盘，内存 LRU 只放最近 16 MB；不在内存里保留实例资源的原文；空闲时 `malloc_trim(0)`（Linux glibc，每 5 分钟）；Windows 上定期 `SetProcessWorkingSetSize(-1,-1)` 不做（会造成页面抖动），只依赖不常驻大块内存。**M7 用 `scripts/probes/remote-memory.mjs` 测量**，未达标再考虑 `mimalloc` 等措施。

### 7.10 拉起实例（`spawn.rs`）

- 用最近注册的实例提供的 `LaunchSpec { program, args_prefix }`（就是 `cmd_app::instance_argv` 的结果，macOS 打包后为 `open -n <bundle> --args`），追加 `--remote-host`（不可见时）和文件夹路径。
- 从未有实例注册过时：读配置 `ggsExe`（插件激活时写入）。
- 拉起后等待 `Register`（超时 30 s），然后推 `WINDOWS` 和 `SPAWNED`。
- 空闲回收：守护进程拉起的不可见实例，在无远程会话、`busy.terminals == 0`、`busy.dirty == 0` 持续 `idleExitMinutes`（默认 10）后发 `Quit`。

### 7.11 本机管理 API（`http/admin.rs`，仅 loopback + `Authorization: Bearer <admin.token>`）

| 方法 路径 | 说明 |
| --------- | ---- |
| `GET /admin/status` | `{running, paused, link, addresses[], port, tls:{mode, caFingerprint}, sessions, instances, version, rss}` |
| `POST /admin/password` | `{password}`，本机设置或修改，无需旧密码 |
| `POST /admin/pause`、`/admin/resume` | 暂停或恢复对外监听 |
| `GET /admin/devices`、`DELETE /admin/devices/:id`、`POST /admin/signout-all` | 设备管理 |
| `GET /admin/qr?addr=` | 二维码 SVG（需附配对解锁令牌，R19） |
| `PUT /admin/config` | 修改端口、绑定、TLS 模式、mDNS、自启、spawnVisible（端口变化需重启监听） |
| `POST /admin/pair-ticket` | 签发 `/pair` 一次性票据（托盘与插件页打开浏览器用） |
| `POST /admin/unlock` | `{password}` → Argon2id 校验 → 解锁令牌（R19；错误计入限速） |
| `POST /admin/shutdown` | 优雅退出（升级用） |

### 7.12 进程自愈与关机退出

Release profile 是 `panic = "abort"`（§4.1）：守护进程一旦 panic 退出，自启项要到下次登录才拉起，期间手机只能看到“PC 不在线”。按平台补自愈：

| 平台 | 机制 |
| ---- | ---- |
| macOS | LaunchAgent `KeepAlive=true`（崩溃后约 10 s 重启；系统按 `ThrottleInterval` 节流） |
| Windows | 计划任务：登录启动 + 失败后 30 s 重启（`schtasks /Create /SC ONLOGON` 加重启策略）；不做 Windows 服务——服务在会话 0，没有托盘 |
| Linux | `~/.config/autostart/*.desktop` 无自带重启；提供 systemd 用户单元示例（`Restart=on-failure`），不强制 |

兜底：GGS 插件激活时 `ensureRunning()`（§14.2），下一次打开 GGS 一定拉起。单例锁（§7.1）保证任何路径的重启不出现双实例；`sessions.json` 在登录/登出时原子落盘，重启后会话不丢。

---

## 8. 应用侧：`remote_host` 与 Relay

### 8.1 `src-tauri/src/remote_host.rs`

职责：控制通道客户端、资源服务、Relay 生命周期、`--remote-host` 启动模式。它不 import 任何插件相关代码，只认 `ggs-remote/1` 的控制消息。

```rust
//! Remote Access host surface (module 19): registers this instance with whatever local daemon
//! listens on the ggs-remote/1 control endpoint, serves the remote workbench's assets and the
//! installed packages' files to it, and creates the hidden Relay webview while remote sessions
//! are attached. Names no plugin; an absent daemon costs one reconnect attempt per 30 s.

pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if let Ok(conn) = connect_control().await {        // interprocess::local_socket::tokio
                let _ = session(&app, conn).await;             // 断开后返回
            }
            sleep(Duration::from_secs(30)).await;
        }
    });
}

async fn session(app: &AppHandle, conn: LocalSocketStream) -> io::Result<()> {
    send(&conn, FromInstance::Register { /* instance_id = GGS_INSTANCE_ID, launch = cmd_app::launch_spec() */ }).await?;
    loop {
        match recv(&conn).await? {
            ToInstance::FetchAsset { req, kind: AssetKind::App, path } => {
                // 只允许远程构建目录与 sw.js：dist/remote/**
                let asset = app.asset_resolver().get(format!("remote/{path}"));
                reply_asset(&conn, req, asset).await?;
            }
            ToInstance::FetchAsset { req, kind: AssetKind::Ext, path } => {
                // 复用 ggs 协议的同一个函数，确保路径约束完全一致
                let resp = cmd_ext::serve_ext_asset(&synth_request(&path), &app.asset_resolver());
                reply_http(&conn, req, resp).await?;
            }
            ToInstance::EnsureRelay { token } => ensure_relay(app, &token)?,
            ToInstance::DropRelay => drop_relay(app),
            ToInstance::Show => show_main_window(app),
            ToInstance::Ping { nonce } => send(&conn, FromInstance::Pong { nonce }).await?,
            ToInstance::Quit => quit_with_dirty_check(app, &conn).await?, // dirty 非空回 CloseBlocked，force 的二次 Quit 才退出
            _ => {}
        }
    }
}

fn ensure_relay(app: &AppHandle, token: &str) -> tauri::Result<()> {
    if app.get_webview_window(RELAY_LABEL).is_some() { return Ok(()); }
    tauri::WebviewWindowBuilder::new(app, RELAY_LABEL, tauri::WebviewUrl::App("relay.html".into()))
        .visible(false)
        .skip_taskbar(true)
        .focused(false)
        .inner_size(1.0, 1.0)
        // 令牌经初始化脚本注入，不出现在 URL（避免进入历史或日志）
        .initialization_script(&format!("window.__GGS_RELAY__={};", serde_json::json!({ "url": relay_url, "token": token })))
        .build()?;
    Ok(())
}
```

- **标题与文件夹变化**：在 `open_folder` / `close_folder` 和窗口标题设置处调用 `remote_host::update(...)`（一个非阻塞的 `mpsc` 发送；守护进程不在时直接丢弃）。
- **busy 与内容摘要（R21）**：`pty.rs` 的会话数、前端上报的未保存数与打开内容——新增一个命令 `remote_host_set_summary({tabs, activeTab, terminals, dirty, scmChanges})`，编辑器标签/活动文件变化、终端增减、SCM 状态变化时非阻塞发送（节流 500 ms，守护进程不在时丢弃）；窗口选择页与切换器据此显示每个实例的内容。

### 8.2 `--remote-host` 启动模式

`lib.rs` 的 `setup` 里：

```rust
let remote_host_only = std::env::args().any(|a| a == "--remote-host");
if !remote_host_only {
    /* 现有逻辑：从配置构建 main 窗口 */
} else {
    #[cfg(target_os = "macos")] app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}
remote_host::start(app.handle());
```

- 托盘 `Show` 或远程选择“在桌面显示”时才构建 `main` 窗口（逻辑与现有 setup 相同，抽成 `build_main_window(app)` 复用），并恢复 `ActivationPolicy::Regular`。
- 没有 `main` 窗口时，`lib.rs` 中依赖 `main` 的逻辑（如 `handle_opened`）改为在缺失时先 `build_main_window`。

### 8.3 Relay 页面（`relay.html` + `src/remote/relay.ts`，主构建的一部分，用**真** Tauri API）

```ts
// Relay: executes a remote frontend's invoke / Channel / listen calls with the real Tauri API
// and forwards the results over the loopback ggs-remote/1 link. One per instance, hidden.
import { invoke, Channel } from '@tauri-apps/api/core';
import { listen, emit, type UnlistenFn } from '@tauri-apps/api/event';
import { decodeFrame, encodeFrame, T, Enc } from './frame';

const { url, token } = (window as unknown as { __GGS_RELAY__: { url: string; token: string } }).__GGS_RELAY__;
const ws = new WebSocket(`${url}?t=${encodeURIComponent(token)}`);
ws.binaryType = 'arraybuffer';
const listeners = new Map<string, UnlistenFn>();       // `${session}:${stream}` → unlisten
const channels = new Map<string, Channel<unknown>>();   // `${session}:${stream}` → 真 Channel

ws.onmessage = async (ev) => {
	const f = decodeFrame(ev.data as ArrayBuffer);
	switch (f.type) {
		case T.INVOKE: return runInvoke(f);
		case T.LISTEN: return addListener(f);
		case T.UNLISTEN: return dropListener(f);
		case T.EMIT: return relayEmit(f);
		case T.CANCEL: case T.CHAN_CLOSE: return dropChannel(f);
		case T.FETCH: return relayFetch(f);              // 读本 webview 同源资源（极少用）
		case T.UPLOAD: return relayUpload(f);            // → invoke('write_file_chunk', …)
		case T.SESSION_END: return dropSession(f.session);// 守护进程通知会话结束：清理该会话所有订阅与 Channel
	}
};

async function runInvoke(f: Frame) {
	const { c, a, h } = f.json<{ c: string; a?: Record<string, unknown>; h?: Record<string, string> }>();
	const args = reviveChannels(f.session, a);              // "__GGS_CHAN__:<id>" → new Channel()
	try {
		const out = await invoke(c, args, h ? { headers: h } : undefined);
		send(out instanceof ArrayBuffer ? encodeFrame(T.RESULT, f.session, f.stream, Enc.RAW, out)
		                                : encodeFrame(T.RESULT, f.session, f.stream, Enc.JSON, JSON.stringify(out ?? null)));
	} catch (err) {
		send(encodeFrame(T.RESULT, f.session, f.stream, Enc.JSON, JSON.stringify({ message: String(err) }), FLAG_ERROR));
	}
}
```

- 发送队列：每会话一个队列，按 §6.4 的规则合并和截断；`ws.bufferedAmount > 8 MB` 时暂停发送。
- 终端输出事件合帧：同一 `studio://pty-output-*` 订阅 16 ms 内的多条 payload 拼成一条。
- Relay 自身 bundle 很小（`frame.ts` + `@msgpack/msgpack` + Tauri api），首屏无关。

### 8.4 能力文件 `src-tauri/capabilities/remote-relay.json`

```json
{
	"$schema": "../gen/schemas/desktop-schema.json",
	"identifier": "remote-relay",
	"description": "The hidden Relay webview of Remote Access: core IPC only (invoke, Channel, events). Window controls, dialogs, clipboard and opener are served by the remote browser itself, never here.",
	"windows": ["remote-relay"],
	"permissions": ["core:default"]
}
```

应用自己的命令（`generate_handler!`）在 Tauri 2 中不受能力文件中插件权限的限制，Relay 可调用全部应用命令，与 `main` 一致；dialog、clipboard、opener 插件权限不授予 Relay。

### 8.5 远程前端资源进入应用包

- `vite.remote.config.ts` 输出到 `target/studio/dist/remote/`，与主构建同在 `frontendDist` 下，被 Tauri 一起嵌入；`remote_host` 只允许读取 `remote/` 前缀。
- `relay.html` 是主构建的第三个入口（与 `index.html`、`ext-host.html` 并列）。
- `AGENTS.md` 的不变式“`vite build` 只打包 `index.html` 和 `ext-host.html`”改为同时列出 `relay.html` 和远程构建。

### 8.6 一个实例、多个前端：需要的后端修改

| # | 位置 | 现状 | 修改 |
| - | ---- | ---- | ---- |
| 1 | `ext_process.rs` `HOST_REQUEST_EVENT` | 广播给所有 webview，桌面与 Relay 都会应答 | 请求带 `frontend`：由某个前端的调用触发的，`emit_to(label)` 投给该前端；无归属的投给“主前端”（`main` 可见时为 `main`，否则为 `remote-relay`）；应答处理保留“首个生效” |
| 2 | 所有 `emit_to("main", …)` 与针对 `main` 窗口的逻辑（共 13 处 emit，逐个审计） | 只投 `main` | 改为投给相关前端，或同时投 `main` 与 `remote-relay` |
| 3 | `workbench.ts` 的关闭确认、拖放 | 依赖窗口 | 远程端由垫片替代（§9.3），后端无须改 |
| 4 | 前端标识 | 无 | Relay 在每个 `INVOKE` 的 headers 里附带 `x-ggs-frontend: remote/<session>`，需要区分前端的命令（例如 `ext_*` 的宿主请求来源）从 `tauri::ipc::Request` 的 headers 读取 |
| 5 | 终端共享 | 终端按前端创建 | 新增 `pty_list`（若无）与“接入现有终端”：订阅已存在的 `studio://pty-output-{id}`，新增 `pty_tail(id, bytes)` 读最近 64 KB 回放；新增 `pty_resize(id, cols, rows)`——接入方视口与创建方不同时按接入方调整（与 VS Code 共享终端一致，桌面侧同步变形；只读接入作为可选项），新开终端按发起前端视口创建 |
| 6 | 帧宿主插件的 `globalState` 写入 | 单前端 | 维持“后写覆盖”（与 VS Code 多窗口一致），文档说明 |
| 7 | 同一文件双前端并发编辑 | 无协调 | 后写覆盖 + watcher 推送对端刷新（与 VS Code 同工作区开两窗口一致），文档明确，不做合并 |

---

## 9. 远程前端：构建、垫片、传输

### 9.1 构建（`vite.remote.config.ts`）

```ts
// The remote workbench build: the same frontend, its Tauri seam aliased onto the WebSocket shim.
import { defineConfig, mergeConfig } from 'vite';
import { resolve } from 'node:path';
import base from './vite.config';

const shim = (name: string) => resolve(__dirname, 'src/remote/tauriShim', name);

export default mergeConfig(base, defineConfig({
	base: './',                                        // 资源以相对路径引用，挂在 /w/<id>/v/<ver>/ 下
	resolve: {
		alias: [
			{ find: /^@tauri-apps\/api\/core$/, replacement: shim('core.ts') },
			{ find: /^@tauri-apps\/api\/event$/, replacement: shim('event.ts') },
			{ find: /^@tauri-apps\/api\/window$/, replacement: shim('window.ts') },
			{ find: /^@tauri-apps\/api\/webview$/, replacement: shim('webview.ts') },
			{ find: /^@tauri-apps\/api\/app$/, replacement: shim('app.ts') },
			{ find: /^@tauri-apps\/plugin-dialog$/, replacement: shim('dialog.ts') },
			{ find: /^@tauri-apps\/plugin-clipboard-manager$/, replacement: shim('clipboard.ts') },
			{ find: /^@tauri-apps\/plugin-opener$/, replacement: shim('opener.ts') }
		]
	},
	build: {
		outDir: resolve(__dirname, 'target/studio/dist/remote'),
		target: ['es2021', 'safari16', 'firefox115', 'chrome100'],
		rollupOptions: {
			input: {
				remote: resolve(__dirname, 'remote.html'),
				extHost: resolve(__dirname, 'ext-host.html'),
				sw: resolve(__dirname, 'src/remote/sw.ts')
			},
			output: { entryFileNames: (c) => (c.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js') }
		}
	}
}));
```

- `prepare.mjs` 在主构建之后执行远程构建（`--build` 时两者都跑）；`tauri dev` 下远程构建以 `vite build --watch` 方式跑，开发时可直接用。
- 远程构建同样产出 `first-paint.json`（复用 `firstPaintPlugin`，根换成 `remote` 入口），`measure.mjs` 记录到 `metrics.json` 的 `remote.firstPaint`。

### 9.2 `remote.html` 与启动（`src/remote/boot.ts`）

```text
1. 显示与桌面相同的启动遮罩（不出现空白页）
2. 从 URL 解析 instance；读 /api/session 拿 csrf
3. transport.connect() → HELLO → ATTACH(instance) → 等 ATTACHED
4. internals.install(attached)：安装 window.__TAURI_INTERNALS__（convertFileSrc 等）
5. responsive.init()：确定档位，给 <html> 设 data-form-factor
6. navigator.serviceWorker.register('/sw.js')（安全上下文时）
7. await import('../main')  → 正常的工作台启动流程
```

### 9.3 垫片逐个模块

| 模块 | 实现 |
| ---- | ---- |
| `core.ts` | `invoke(cmd, args, opts)` → `transport.call(...)` 返回 Promise；`class Channel<T>`：构造时 `transport.allocStream()`，`toJSON()` 返回 `"__GGS_CHAN__:<id>"`，`onmessage` setter 注册到 `transport.channels`；`convertFileSrc(path, protocol)`：`ggs` → `${ggsBase}${encodeURIComponent(path)}`，`asset` → 下载 URL；`isTauri()` 返回 `true`（让工作台走完整路径）；`transformCallback` 等内部函数按 `@tauri-apps/api` 的导出清单逐一提供，未用到的抛出明确错误 |
| `event.ts` | `listen(event, handler, opts)` → `LISTEN`，返回 `UnlistenFn`；`once` 基于 `listen`；`emit`、`emitTo` → `EMIT`；`TauriEvent` 常量照抄 |
| `window.ts` | `getCurrentWindow()` 返回对象：`setTitle` → `document.title`；`close` → 回窗口选择页（有未保存内容时先走工作台已有的确认流程）；`minimize` 无操作；`toggleMaximize` → Fullscreen API；`startDragging` 无操作；`onCloseRequested` → `beforeunload`；`isMaximized` 等返回合理默认值 |
| `webview.ts` | `getCurrentWebview().onDragDropEvent(cb)` → 监听 `dragover`/`drop`：把拖入的文件先上传到当前文件夹（或拖放目标目录），再按桌面格式回调 `{type:'drop', paths:[…PC 上的路径]}` |
| `app.ts` | `getVersion()` → `ATTACHED.version` |
| `dialog.ts` | `open({directory, multiple, filters, defaultPath})` → `remoteFilePicker`（基于 `list_dir`，浏览 PC 文件系统，带“从本设备上传到此处”按钮）；`save()` → 选择器的保存模式；`message/ask/confirm` → `ui.ts` 的对话框 |
| `clipboard.ts` | `writeText` → `navigator.clipboard.writeText`，不可用时用隐藏 textarea + `execCommand('copy')`；`readText` → `navigator.clipboard.readText`，不可用时弹出输入框让用户粘贴 |
| `opener.ts` | `openUrl` → `window.open(url, '_blank', 'noopener')`；`openPath(path)` → 下载；`revealItemInDir` → 远程文件选择器定位到该项 |
| `internals.ts` | 安装 `window.__TAURI_INTERNALS__ = { convertFileSrc, invoke, transformCallback, metadata }`，让 `extHost.ts` 的现有逻辑原样可用；同时满足 §15.4 的新接缝规则 |

### 9.4 传输层（`src/remote/transport.ts`）

```ts
// The remote workbench's one connection: ggs-remote/1 frames over a binary WebSocket, with
// credit-based flow control, heartbeat, and resume after a dropped network.
export class Transport {
	private ws?: WebSocket;
	private nextStream = 1;                                 // 浏览器发起：奇数
	private pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>();
	readonly channels = new Map<number, (msg: unknown) => void>();
	readonly listeners = new Map<number, (ev: unknown) => void>();
	private lastSeq = 0; private consumed = 0; private sid?: string;

	async connect(): Promise<void> { /* new WebSocket(wss://host/ws)；binaryType='arraybuffer'；HELLO；等 HELLO_ACK */ }
	call(cmd: string, args: unknown, headers?: Record<string, string>): Promise<unknown> { /* INVOKE */ }
	allocStream(): number { const id = this.nextStream; this.nextStream += 2; return id; }

	private onFrame(f: Frame) {
		this.lastSeq = f.seq;
		this.consumed += f.len;
		if (this.consumed >= 262144) { this.send(credit(this.consumed, this.lastSeq)); this.consumed = 0; }
		// RESULT → pending；CHAN_DATA → channels；EVENT → listeners；WINDOWS/NOTICE → 外壳；CLOSE → handleClose
	}
	private handleClose(code: number) {
		if (code === 4401) return goLogin('password-changed');
		if (code === 4410) return goPicker('instance-exited');
		this.reconnect();                                     // 指数退避 0.5 s → 8 s，HELLO.resume
	}
}
```

- **压缩**：`DecompressionStream('deflate-raw')` 是异步流式的，帧按顺序处理时用一个串行 Promise 队列，保证 `seq` 顺序不乱；小帧（未压缩）走同步快速路径。
- **页面可见性**：`visibilitychange` 为 hidden 时降低心跳到 60 s（iOS 无论如何会挂起，靠恢复机制）；回到前台立即 `PING`，超时 3 s 就重连。

---

## 10. 按需加载与流量控制

### 10.1 分层加载

| 阶段 | 内容 | 目标大小（br） | 来源 |
| ---- | ---- | -------------- | ---- |
| 1 登录页 | `login.html/js` + `style.css` + `i18n.js` | < 20 KB | 守护进程内嵌，构建时预压缩 |
| 2 窗口选择页 | `picker.html/js` | < 10 KB 增量 | 守护进程内嵌 |
| 3 工作台首屏 | `remote` 入口 + 工作台块 + 主题 CSS + codicon 字体 | ≤ 1.2 MB | 实例资源，经守护进程缓存 |
| 4 按需块 | xterm、mermaid/ELK、CodeMirror 语言包、合并视图、CAN 视图、分析页、设置页 | 按用到的才下 | 同上 |
| 5 数据 | 目录、文件窗口、搜索批次、事件 | 按视口 | WS |

### 10.2 资源服务与缓存（`daemon/src/cache.rs`、`http/assets.rs`）

```text
GET /w/A/v/0.2.0/assets/workbench-3f9a.js
  ├─ 内存 LRU 命中（key = inst版本 + path）→ 直接返回
  ├─ 磁盘缓存命中 cache/<sha256>.br → 读文件返回
  └─ 未命中 → 控制通道 FetchAsset(App, path) → 实例 asset_resolver
            → 计算 sha256 → brotli q9 压缩（spawn_blocking）→ 写磁盘缓存 → 返回
响应头：Content-Encoding: br（客户端不支持 br 时现场解压，返回 identity）
        Cache-Control: public, max-age=31536000, immutable   （带 hash 的文件名）
        Cache-Control: no-cache + ETag                         （remote.html、sw.js）
```

- 版本号进路径，因此同一个 PC 上新旧版本实例共存时互不影响；守护进程在实例版本变化时清理旧版本的内存缓存条目。
- **Service Worker（`sw.ts`）**：install 时只预缓存 `remote.html` 和首屏块列表（由构建产出的 `precache.json` 给出）；fetch 策略：`/assets/*` cache-first；`/w/*/ggs/*` stale-while-revalidate；`/api/*`、`/ws` 不经过 SW。新版本激活后删除旧版本缓存。二次访问只有 `remote.html` 的 304 校验和 WS 握手。
- **PWA manifest**：`manifest.webmanifest`（名称、192/512 图标、`display: standalone`、`theme_color` / `background_color` 取主题变量），“添加到主屏幕”后无浏览器框架；与 `sw.js` 一样带 `basePath` 提供（Hub 模式 `start_url` 相对化）。iOS 真机验证 standalone 形态下 `--vvh`、safe-area 与键盘行为（§17.5）。

### 10.3 数据按需取（远程模式默认值，`remote.*` 设置可改）

| 场景 | 现有机制 | 远程模式下的调整 |
| ---- | -------- | ---------------- |
| 资源管理器 | `list_dir` 按目录取 | 单目录超过 2000 项时分页（新增可选参数 `offset/limit`，不传则行为不变） |
| 打开文本文件 | `read_file` 整读；大文件走窗口化 | 远程阈值 512 KB（`remote.windowedOpenBytes`），超过即用 `docEditView` 只取可见行 ± 2 屏 |
| 二进制 / 超大文件 | Hex、Fast Viewer、`read_file_chunk` 分页 | 不变 |
| 图片预览 | 整图 | 新增 `fs_image_thumb(path, maxEdge)`（后端缩放，纯 Rust：`image` 不引入，用 `png`/`jpeg-decoder`+`zune` 系列小 crate，M7 中评估），原图按需下载 |
| 搜索 | Channel 流式 | 远程默认先显示 500 条，“加载更多”继续消费 |
| Git Graph | 插件引擎按区间分页 | 不变 |
| 终端接入 | — | 只回放最近 64 KB（`pty_tail`） |
| 代码分析报告 | 流式 | 表格按页渲染；MCP 风格 `limit/offset` |
| watcher 事件 | 去抖批次 | Relay 侧 100 ms 合并；省流模式 1 s |
| 插件图标、README 图片 | base64 data URL | 远程模式改为 URL 懒加载（`loading="lazy"`） |

### 10.4 省流模式（`src/remote/dataSaver.ts`，设置 `remote.dataSaver`）

开启时：关闭小地图、粘性滚动、悬停预取、Markdown 远程图片、插件图标；终端合帧 50 ms；watcher 1 s；搜索每批 100 条。`navigator.connection.saveData` 为真或 `effectiveType` 为 `2g/3g` 时提示开启。

### 10.5 流量度量

- 传输层按帧类型累计上下行字节，在远程设置页显示“本次会话：↑x KB ↓y MB”。
- `scripts/probes/remote-traffic.mjs`：Playwright 跑标准动作集（登录 → 选窗口 → 打开仓库 → 打开 5 个文件 → 搜索 → 打开 Git Graph → 开终端执行 `git log -20` → 打开模块分析），记录冷启动与二次访问的字节数到 `metrics.json.remote.traffic`。遵守原则 6：**只度量，不设构建门禁**，§1 的数字是目标，不在 CI 中卡死。

---

## 11. 响应式外壳与逐功能适配

### 11.1 档位与检测（`src/remote/responsive.ts`）

```ts
type FormFactor = 'phone' | 'tablet' | 'desktop';
// 宽度断点 + 指针类型：600 / 1024；pointer:coarse 决定触控交互，与宽度独立
// <html data-form-factor="phone" data-pointer="coarse">；ResizeObserver 监听，横竖屏切换即时生效
```

- CSS 写在 `src/remote/remote.css` 与各视图自己的 CSS 中，用 `:root[data-form-factor=phone] …` 选择器和容器查询（`container-type: inline-size` 放在侧边栏、编辑区上），颜色全部用主题变量。
- 视口：`<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">`；`env(safe-area-inset-*)` 处理刘海与底部手势条。
- 虚拟键盘：`visualViewport.resize` 时设置 `--vvh` 变量，编辑区与终端高度用它计算（iOS 不支持 `interactive-widget` 时的兜底）。

### 11.2 外壳布局

| 区域 | 桌面网页（> 1024） | 平板（600–1024） | 手机（< 600） |
| ---- | ------------------ | ---------------- | ------------- |
| 标题栏 | 网页标题栏：菜单 + 命令中心 + 窗口切换器，无窗口控制按钮 | 菜单收进 ☰ | App 栏（`appBar.ts`）：☰ 打开导航抽屉（`navDrawer.ts`：全部页面、转到文件、命令面板、窗口、传输、完整菜单、省流、设置）；中间是页面标题 + 副标题（编辑器：文件名 + 所在目录，点击打开“已打开的编辑器”；变更：分支 + 变更数）；右侧是本页操作（转到文件、编辑器/仓库/终端的操作表） |
| 活动栏 | 左侧竖栏 | 左侧竖栏 | 底部导航（`bottomTabs.ts`）：文件 · 编辑器 · 变更 · 各插件页面（Git Graph 类的 `scm/title` 启动项、Claude Code 类的视图容器），最多五个，空位补终端、搜索；点了必定显示该页（不再切换隐藏），再点为重选；徽标显示已打开编辑器数（有未保存时变色）与变更数；键盘弹出时让位 |
| 侧边栏 | 可拖动宽度 | 覆盖式抽屉 | 全屏页面（标题只有名字的行隐藏，由 App 栏代替），右滑返回（`gestures.ts`）；编辑器激活或面板显示先收起它——页面栈导航（`nav.ts`） |
| 编辑区 | 分屏网格 | 最多 2 组 | 单组（只显示获得焦点的组）；标签条与面包屑隐藏，改为 App 栏标题 + “已打开的编辑器”表单 + 编辑器操作表（`editorSwitcher.ts`）；无文件时显示空状态；文件默认只读，App 栏的锁按钮点一下解锁、再点一下锁定（`editLock.ts`，取代原先占一行的解锁条）；解锁后键盘上方有编辑键行（`editorAccessory.ts`） |
| 面板（终端/输出） | 底部 | 底部 | 全屏页面（终端、输出、上下文分段），终端视图底部是扩展按键行；编辑器激活时收起（`nav.ts` 的 `revealEditorPage`）；被全屏侧边栏盖住时 toggle 是现出而非藏起（`panel.ts`） |
| 状态栏 | 完整 | 精简 | 隐藏，关键项（分支、变更数）进 App 栏副标题与导航徽标 |
| 右键菜单 | 右键 | 长按 500 ms | 长按（轻触觉反馈）→ 底部表单（`actionSheet.ts`，复用 `ui.ts` 的菜单数据结构；把手下拉关闭，子菜单带返回级；手机返回键关闭浮层——`backStack.ts`） |
| 悬停提示 | hover | 长按 | 长按 |
| 快捷键 | 全部 | 外接键盘全部 | 命令面板代替；常用操作有显式按钮 |

实现约束：手写 DOM + `ui.ts` 原语（原则 3）。`ui.ts` 的菜单渲染走一个可替换的 presenter（`setMenuPresenter`，`actionSheet.ts` 安装）：`contextMenu()` 与 `showMenuBelow()` 两个入口都先问它，`data-pointer=coarse` 且为手机档时渲染为动作表（2026-10-13 补齐 `showMenuBelow()`——此前 "More Actions…" 一类锚点菜单仍落桌面浮动面板，子菜单在手机上左右级联），调用方不用改。触控目标 ≥ 44 × 44 px。所有新增文字走 `t(key)`（`src/i18n.ts`，en / zh-cn）。

### 11.3 逐功能适配（R14）

| 功能（模块） | 适配内容 | 涉及文件 |
| ------------ | -------- | -------- |
| 文件资源管理器（3） | 行高 44 px；长按菜单；新建/重命名用底部输入框；**上传**（多文件、文件夹 `webkitdirectory`、拖放；`transfer.ts` 256 KB 分片 + 断点续传）；**下载**（单文件直接下，多选/文件夹由后端流式 zip：新增 `fs_zip_stream(paths, channel)`，复用 `zip` crate）；Git 状态颜色保留 | `explorer.ts`、`transfer.ts`、`cmd_fs.rs` |
| Quick Open / 搜索（4、5） | 手机全屏输入页,自带 ‹ 返回头(2026-10-16:全屏下点外永远点不中、手机无 Esc——返回头即 `finish(null)`,系统返回键经 `quickInputBack.ts` 作顶层 closer 先剥它;桌面卡片隐藏该行) ;结果虚拟列表；符号跳转、调用树、上下文窗口以页面栈导航 | `filePicker.ts`、`searchView.ts`、`callTree.ts`、`contextView.ts`、`quickInput.ts`、`quickInputBack.ts` |
| 编辑器（6） | CodeMirror 6 原生支持触屏选择；键盘出现时用 `--vvh` 收缩；编辑工具条（撤销、重做、查找、保存、Tab、缩进、注释）；查找替换改为顶部单行 | `textEditor.ts`、`findWidget.ts`、`editor.ts` |
| 大文件查看器（7） | `src/scroll/` 自绘滚动：在 `input.ts` 增加触摸拖动与惯性（Pointer Events + 速度衰减）；滚动条触控热区 24 px | `scroll/input.ts`、`scroll/scrollbar.ts` |
| 对比与合并（8） | 手机档左右对比自动改为行内 diff（`@codemirror/merge` 的 `unifiedMergeView`）；三方合并按冲突块卡片逐个处理 | `editor.ts`、`mergeEditor.ts` |
| 源代码管理（9） | 暂存/取消暂存/放弃按钮常显（不靠 hover）；提交框固定在顶部；时间线分页 | `scm.ts`、`fileHistory.ts` |
| Git Graph（10，插件页） | 插件页面原样运行在沙箱 iframe 中；宿主在 iframe 外包一层可双指缩放、平移的容器；不改插件内部 | `extHost.ts` |
| 终端（11） | xterm 5；手机加扩展按键行（`terminalKeys.ts`：Esc、Tab、Ctrl、Alt、↑↓←→、`|`、`~`、`/`、`-`、Home、End，Ctrl/Alt 为粘滞键）；双指缩放字号；可接入桌面已有终端（`pty_tail` 回放）；断线恢复按 `seq` 补齐 | `terminal.ts`、`terminalKeys.ts` |
| 插件平台（12） | 见 §12 | `extHost.ts` |
| CAN 分析（13） | SVG 图表双指缩放；原始帧表横向滚动、列可隐藏 | `canChart.ts`、`canRawView.ts` |
| 自测（14） | 新增 “Remote Access” 组：结构检查在桌面跑，传输检查只在远程端跑 | `selfTestSuites.ts` |
| 代码分析（17） | 模块图：`moduleDiagram.ts` 已有平移缩放，补 Pointer Events 双指缩放、点选代替悬停；报告表格在手机档变卡片列表；Import Graph 分页 | `moduleDiagram.ts`、`analysisPages.ts` |
| 设置 / 命令系统（2） | 手机档设置是专属全屏页面（`settingsPage.ts`，2026-10-12 落地）：单列、分类下钻（逐级滑入、返回步、手机返回键逐级弹出），布尔为行内开关、选择类走底部表单、数字走 − 值 + 步进表单、文件关联与文本/JSON 扩展设置各有一级/一表单，根级搜索横跨全部类别——与桌面对话框共用同一设置注册表；抽屉与 `workbench.openSettings` 在手机档都路由到该页。远程端的 `remote.*` 设置（省流）归入页面的“远程访问”分类 | `settingsPage.ts`、`settings.ts`、`settingsPanel.ts` |

### 11.4 手势（`src/remote/gestures.ts`）

用 Pointer Events 自写，不引入库：`longPress(el, cb, 500ms, 移动容差 10px)`、`pinch(el, onScale)`（两个 pointer 的距离比）、`swipeBack(el, cb)`（从左边缘 24 px 内开始的右滑超过 80 px）。所有手势在 `touch-action` 上声明，避免与浏览器默认滚动冲突。

### 11.5 浏览器兼容（R15）

- 构建目标 `es2021 / safari16 / firefox115 / chrome100`。
- **按能力探测降级，不判断 UA**：

| 能力 | 不可用时 |
| ---- | -------- |
| `CompressionStream('deflate-raw')` | HELLO 中不声明，服务器不压缩帧 |
| Service Worker（非安全上下文） | 只用 HTTP 缓存 |
| `navigator.clipboard` | 复制用 `execCommand`；粘贴改为弹出输入框 |
| 容器查询 | 退回媒体查询（只影响少数布局细节） |
| `visualViewport` | 用 `window.innerHeight` |
| iOS 后台 WS | 靠 §6.5 会话恢复 |

- **测试矩阵**：Playwright 的 Chromium、WebKit、Firefox × 设备（iPhone 15、Pixel 8、iPad Pro 11、1920×1080 桌面）。Samsung Internet 手测。

---

## 12. 插件在远程端（R13）

### 12.1 各形态

| 插件形态 | 远程端行为 |
| -------- | ---------- |
| 进程后端（ggs-node / 原生 / real-Node） | 在 PC 实例中运行，与桌面共享；命令、webview 消息经 Relay 转发；`ggs.hostRequest` 按 §8.6 #1 路由 |
| 帧宿主插件（沙箱 iframe） | 在远程浏览器中运行一份（与 VS Code 每窗口一个扩展宿主相同）；`ext_load_code`、`ext_fs` 等都是普通 INVOKE |
| webview 页面 / 视图 | iframe 的 `ggs://` 资源经 `convertFileSrc` 映射到 `/w/<inst>/ggs/<tok>/…` |
| 插件子进程（`ext_child`） | 在 PC 上执行，输出经 Channel 回流 |
| 插件打开外部链接或文件 | 走 `opener.ts` 替代 |
| 插件自己开的本机 HTTP 服务 | 不代理（安全原因），文档说明 |

### 12.2 沙箱 iframe 的资源令牌

扩展 iframe 是 `sandbox` 且**没有** `allow-same-origin`，文档处于 opaque origin，浏览器不会给它的子资源请求带 `SameSite=Strict` 的 Cookie。因此插件文件路径带**资源令牌**：

- `ggsBase = /w/<inst>/ggs/<tok>/`，`tok` = base64url(HMAC-SHA256(serverSecret, sessionId ‖ instance ‖ epoch))[..22]；
- 守护进程校验令牌对应一个有效会话；改密、踢下线、会话过期后令牌立即失效；
- 这些路径返回 `Access-Control-Allow-Origin: *`（只对令牌路径开放，令牌本身就是凭据），以便 opaque origin 下的 module script 能加载；
- 返回的 HTML 保持 `cmd_ext::serve_ext_asset` 注入的页面引导脚本不变；CSP 中的 `ggs:` 源由守护进程替换为当前令牌前缀（只对 `text/html` 做字符串替换）。

### 12.3 验证

- `scripts/probes/remote-live-check.mjs` 复用 `git-graph-live-check.mjs`、`git-graph-menus-live-check.mjs`、`claude-code-live-check.mjs` 的检查清单，在远程端执行：命令列表、菜单项、Git Graph 视图渲染、claude-code 聊天页挂载。
- `full=1` 开发 harness 增加 `?remote=1` 模式：在远程前端里跑同一套自测。

---

## 13. 多窗口与新开窗口

- **注册**：每个 GGS 实例启动后 `remote_host::start` 连接控制通道并 `Register`；标题、文件夹变化时 `Update`；守护进程实时推 `WINDOWS`。
- **选择窗口（R10）**：登录后进入 `/windows`（守护进程内嵌页面，卡片列表：标题、文件夹、是否桌面可见、远程会话数、运行时长、状态徽标与**内容摘要**——R21：打开的编辑器与活动文件、终端数、未保存数、SCM 变更数，卡片展开可见完整文件列表。卡片即“每个 GGS 的内容”预览；不做像素缩略图，§3.2 已否决像素流，接入后看到的就是全部）。只有一个实例时可设置“自动进入”。标题行右侧是“退出登录”；标题下方的“输入要打开的文件夹路径”行（可经 `folderInput` 配置关闭）输入路径即 `SPAWN` 该文件夹；独立的“新窗口”按钮已删（2026-10-12，主人的要求：没有用处）。工作台标题栏有窗口切换器（`windowSwitcher.ts`，同样带摘要与徽标），切换 = `DETACH` + 跳转到另一个实例的 `remote.html`（两个实例版本可能不同，所以整页加载而不是热切换）。
- **新开窗口（R12）**：远程端“文件 → 新窗口”或“在新窗口中打开文件夹…”（文件夹用远程文件选择器挑）→ `SPAWN{folder, visible}`：
  - `remote.spawnVisible = false`（默认）：`ggs --remote-host <folder>`，不建桌面窗口，只在远程接入时建 Relay，比完整工作台少一个可见渲染进程；托盘“已连接设备”旁的窗口列表可“在桌面显示”；
  - `true`：正常可见窗口。
  - 实例注册完成后，远程端自动接入新窗口。
- **最近打开的文件夹（2026-10-12，主人的要求：增加历史路径、可选择打开）**：守护进程把每个窗口注册/更新时带的文件夹记入历史（`src/recent.rs`：最近在前、去重、上限 12，持久化为 `~/.ggs/remote/recent.json`），随每条 `WINDOWS` 帧下发（`recentFolders`）。窗口选择页的“最近打开的文件夹”列表逐行展示，点“打开”即重开该文件夹——已在某窗口中打开的直接进入那个窗口，否则 `SPAWN` 一个新的；已在运行的路径带“已打开”徽标。手机上不必再手输路径。
- **远程实例管理（R20）**：卡片与切换器提供“关闭 / 重启 / 新开”操作。“关闭”走优雅退出——实例有未保存文件时弹 `close-blocked` 清单（来自摘要与 `CloseBlocked`），确认后才强杀；“重启”用于卡死（`state = unresponsive` 徽标提示，两级心跳判定见 §7.8）——终止后按原 `LaunchSpec` 与文件夹拉起，注册完成自动接入，原会话收 4410 回选择页再被带回；“新开”即 SPAWN（R12）。
- **空闲回收**：见 §7.10。
- **没有任何 GGS 在运行**：窗口列表为空，页面以路径输入行与最近文件夹列表供拉起（2026-10-12 随独立"新窗口"按钮的删除而改——按钮没有用处；2026-10-16 恢复的路径输入行是远程侧唯一的 spawn 入口，见 remote-client-plan.md 顶部落地记录；`ggsExe` 仍是 `SPAWN` 落到的可执行文件）。
- **桌面“文件 → 新窗口”** 仍走 `app_new_instance`，新实例自动注册，远程列表实时出现。

---

## 14. 插件包 `ggs-remote`

### 14.1 `package.json`（要点）

```jsonc
{
	"name": "ggs-remote",
	"displayName": "GGS Remote",
	"publisher": "ggs",
	"version": "0.1.0",
	"engines": { "vscode": "^1.80.0" },
	"main": "./extension.js",
	"activationEvents": ["onStartupFinished"],
	"contributes": {
		"commands": [
			{ "command": "ggsRemote.showPage", "title": "Remote Access: Open", "category": "GGS Remote" },
			{ "command": "ggsRemote.copyLink", "title": "Remote Access: Copy Link" },
			{ "command": "ggsRemote.changePassword", "title": "Remote Access: Change Password" },
			{ "command": "ggsRemote.signOutAll", "title": "Remote Access: Sign Out All Devices" },
			{ "command": "ggsRemote.toggle", "title": "Remote Access: Start / Pause" }
		],
		"configuration": {
			"title": "GGS Remote",
			"properties": {
				"ggsRemote.port": { "type": "number", "default": 47615 },
				"ggsRemote.bind": { "type": "string", "default": "0.0.0.0" },
				"ggsRemote.tlsMode": { "type": "string", "enum": ["self-signed", "custom", "none"], "default": "self-signed" },
				"ggsRemote.autostart": { "type": "boolean", "default": true },
				"ggsRemote.spawnVisible": { "type": "boolean", "default": false },
				"ggsRemote.mdns": { "type": "boolean", "default": true }
			}
		}
	}
}
```

（ggs-node 运行 `main` 需要后端：插件包含原生二进制，按 `resolve_node_binaries` 的规则会派生 `node` 后端，满足要求。）

### 14.2 `extension.js` 流程

```text
activate(context):
  1. daemon.ensureInstalled(context.extensionPath)
       包内 bin/<platform>/ggs-remote → ~/.ggs/remote/bin/ggs-remote
       版本比较：bin 旁的 VERSION 文件；新版本 → POST /admin/shutdown → 等锁释放 → 替换 → 启动
  2. daemon.ensureRunning()：读 loopback.json 探测；不在则 child_process.spawn(detached, stdio:'ignore').unref()
  3. 写 ggsExe（当前 GGS 路径，由宿主环境变量提供）到 config（PUT /admin/config）
  4. 注册命令；配置变化 → PUT /admin/config
  5. showPage：createWebviewPanel → page.js 通过 postMessage 请求 status/qr/devices，extension.js 代理到 /admin/*
deactivate(): 不停守护进程（它要常驻）
卸载：VS Code 风格的 uninstall 钩子不存在 → 插件提供“Remote Access: Uninstall Background Service”命令；
      另外守护进程每次启动检查插件目录是否还在，插件已卸载超过 1 天则移除自启项并退出（保留 auth.json）
```

### 14.3 “远程访问”页面

状态（运行/暂停、端口、TLS 模式、CA 指纹、最近外来访问时间与防火墙指引）、每个 LAN 地址的链接与二维码、复制按钮、设置/修改密码、设备列表与断开、全部断开、证书下载与安装说明（iOS/Android/桌面）、开机启动开关、“在新窗口打开的远程窗口是否在桌面显示”开关、“窗口页显示路径输入框”开关（`folderInput`，默认开）。**二维码与地址列表的显示在解锁之后**（R19：`POST /admin/unlock`，与托盘打开的配对页同一机制与令牌）。**设置密码与解锁两屏都带中继服务器配置**（服务器地址/连接串 + 可选服务器口令；2026-10-12，主人的要求：密码设置处即服务器设置处）——密码未设置时先保存的服务器由守护进程持有（NoPassword），密码落定即自动连接。**中继设置并在线时，`status_json` 的 `links` 只含它的 `/u/<uuid>/` 链接——页面上（扩展页与配对页）只显示它的二维码，局域网的隐藏**（2026-10-12，主人的要求；服务器已配置但未在线时没有中继链接可显，局域网二维码作为回退保留）；证书下载锚点固定在 LAN 链接（`lanLinks`）上，不跟着排位走。样式用主题变量，文字中英双语。

---

## 15. 构建、打包、签名与 CI

### 15.1 守护进程构建

```sh
# extensions-src/ggs-remote/build.mjs 调用
cargo build --manifest-path extensions-src/ggs-remote/daemon/Cargo.toml --release \
  --target <triple> --target-dir target/studio/ggs-remote
```

| VSIX 平台目标 | Rust target |
| ------------- | ----------- |
| `win32-x64` | `x86_64-pc-windows-msvc` |
| `win32-arm64` | `aarch64-pc-windows-msvc` |
| `darwin-arm64` | `aarch64-apple-darwin` |
| `darwin-x64` | `x86_64-apple-darwin` |
| `linux-x64` | `x86_64-unknown-linux-gnu`（在 `ubuntu:22.04` 底线容器中构建，glibc 2.35） |
| `linux-arm64` | `aarch64-unknown-linux-gnu` |

- macOS：`build.mjs` 生成 `GGS Remote.app/Contents/{MacOS/ggs-remote, Info.plist(LSUIElement, CFBundleIdentifier=dev.ggs.remote), Resources/icon.icns}`；LaunchAgent 指向 `.app` 内的二进制。
- 预期体积：约 3–5 MB（strip + lto + opt-level s）。

### 15.2 VSIX 打包

`build.mjs`：编译守护进程 → 拷贝到 `bin/<platform>/` → 写 `VERSION` → 用与 claude-remote 无关的、自己的最小 zip 写入（或 Node 的 `zlib` + 手写 OPC 结构，约 100 行）生成 `ggs-remote-<platform>-<ver>.vsix` → 自检（`[Content_Types].xml`、`extension.vsixmanifest`、`package.json`）。

### 15.3 随安装包分发

`scripts/prepare.mjs` 新增开关 `GGS_BUNDLE_GGS_REMOTE`（默认 1，本地源码，离线可打包）：调用 `extensions-src/ggs-remote/build.mjs --out target/studio/extensions/`，只构建当前平台。首启由 `cmd_ext::install_missing_bundled` 安装（与现有内置包机制相同）。

### 15.4 接缝检查（`scripts/check-seams.mjs`）新增规则

1. `src/` 中除 `src/remote/tauriShim/` 外，不得出现 `__TAURI_INTERNALS__` 和 `window.__TAURI__`（`extHost.ts` 的两处收敛为 `src/remote/tauriShim/internals.ts` 也提供的同名帮助函数 `assetUrl()`，桌面构建里该函数直接读真 internals）。
2. `src/`、`src-tauri/src/` 中不得出现插件 id `ggs-remote`、`ggsRemote`（应用只认协议，不认插件）。唯一例外 `src-tauri/src/remote_config.rs`：`ggs-config` 命令行（2026-10-13，应用侧的免窗口配置入口）的职责就是按名找到并驱动守护进程二进制（`ggs-remote(.exe)`、随安装包分发的 `ggs-remote.vsix`），这一处允许点名；除此之外任何源文件仍是零引用。

### 15.5 签名

- Windows：守护进程 exe 与应用使用同一 Authenticode 证书（`scripts/signing.mjs` 的流程，对 VSIX 内的二进制单独签名后再打包）。
- macOS：`GGS Remote.app` 用 Developer ID 签名并公证；无证书时 ad-hoc 签名（与应用相同的降级路径）。
- Linux：不签名，SHA256SUMS 覆盖。

### 15.6 CI（`.github/workflows/studio.yml`）

| 作业 | 触发 | 内容 |
| ---- | ---- | ---- |
| `remote-daemon-test` | PR + main | `cargo fmt --check`、`cargo clippy -D warnings`、`cargo test`（守护进程 crate，Linux/Windows/macOS 矩阵） |
| `frontend` | PR + main | 现有 typecheck + vitest，新增 `tests/remote*.test.ts`；新增远程构建 `vite build -c vite.remote.config.ts` |
| `remote-e2e` | main | 构建应用（debug）+ 守护进程，`tauri` 无头运行 Linux（xvfb），Playwright Chromium/WebKit/Firefox 跑 `tests/e2e/remote/` |
| 安装包 | main | 各平台安装包内带对应平台的 ggs-remote VSIX |

---

## 16. 安全设计与审查清单

按 OWASP ASVS 5.0 的相关章节逐项自查（M8 输出审查记录）：

| 领域 | 措施 |
| ---- | ---- |
| 身份验证 | Argon2id；弱口令表；首次设置仅本机；限速与锁定；登录失败日志 |
| 会话 | 256 位随机令牌，只存哈希；HttpOnly/SameSite=Strict（https 下加 `Secure`，跟随浏览器协议）；滑动过期；epoch 失效；登出与踢下线 |
| CSRF / CSWSH | Cookie 为 Strict；`/ws` 校验 `Origin` == 本站；HELLO 中带会话 csrf；所有改状态的 API 要求 `Content-Type: application/json`（阻止简单表单提交） |
| 传输 | 默认 TLS 1.2/1.3；HTTP 模式只能绑定 loopback |
| 访问控制 | 实例资源只读 `remote/` 前缀；插件文件复用 `serve_ext_asset` 的目录约束；下载需一次性票据，`FetchFile` 路径约束与 `ext_fs` 同一策略（打开的文件夹 + 插件目录）；资源令牌与会话绑定；配对/插件页二维码须密码解锁（R19） |
| 输入校验 | 帧长度上限、分片总长上限（256 MB）、在途调用上限、MSGPACK 深度上限；HTTP 体上限 |
| 路径穿越 | `/w/:inst/v/:ver/*path` 与 `/ggs/*path` 规范化后拒绝 `..`、绝对路径、反斜杠、NUL |
| 本机接口 | `/admin`、`/relay`、`/pair` 只在 `127.0.0.1` 监听；admin token 文件 0600；Relay 令牌一次性、60 s 过期；控制通道套接字 0600 / 管道 DACL 仅当前用户 |
| 实例管理 | 关闭/重启走已认证会话；未保存文件先拒绝并列出清单，确认后才强杀；守护进程只终止注册表中控制通道仍归属的 pid（防 pid 复用误杀）；重启入口明示“未保存的修改将丢失” |
| 拒绝服务 | 每 IP 连接数上限 16；慢速读超时（握手 10 s、HELLO 5 s）；会话恢复缓冲上限；全局内存水位告警 |
| 日志 | 记录登录成功/失败、改密、踢下线、实例拉起；不记录密码、令牌、文件内容；访问日志中 `/w/<inst>/ggs/<tok>/…` 的 tok 脱敏（等价会话凭据，只留前 6 位） |
| 能力说明 | 文档明确：远程用户拥有与本机用户相同的权限（终端可执行任意命令），只能把密码给可信的人 |

---

## 17. 测试方案

### 17.1 守护进程（Rust，`cargo test`）

| 测试 | 内容 |
| ---- | ---- |
| `frame.rs` 单元 | 头编解码、分片拼接、压缩往返、非法长度拒绝、测试向量 |
| `auth.rs` 单元 | 哈希与校验、弱口令拒绝、epoch 递增、原子写 |
| `ratelimit.rs` 单元 | 退避时序（使用 `tokio::time::pause`） |
| `resume.rs` 单元 | 环形缓冲、ackSeq 丢弃、溢出判定 |
| `tests/http.rs` 集成 | 起完整服务（临时 `~/.ggs` 目录、自签证书）；未登录访问每个路由；登录；Cookie 属性；路径穿越；配对解锁（错误密码限速、解锁后二维码可见、令牌 5 min 过期） |
| `tests/ws.rs` 集成 | tokio-tungstenite 客户端：HELLO、错误 Origin 4403、**改密 → 1 s 内收到 4401**、踢下线、会话恢复 |
| `tests/registry.rs` 集成 | 假实例（interprocess 客户端）：注册、`WINDOWS` 推送、SPAWN 等待注册、实例退出 4410；两级心跳超时 → `unresponsive`（停止应答 Ping）；`INSTANCE_CLOSE` 未保存回 `close-blocked`、`force` 终止；`INSTANCE_RESTART` 终止后重拉并等注册、远程会话自动接入 |
| `tests/relay.rs` 集成 | 假 Relay：INVOKE 透传、session 改写、信用耗尽暂停、Relay 断开重建 |

### 17.2 应用后端（`cargo test --all-features`）

- `remote_host.rs`：控制消息测试向量；资源路径限定在 `remote/`；`FetchFile` 路径约束（打开的文件夹与插件目录内允许、逃逸拒绝）；`launch_spec()` 与 `cmd_app::instance_argv` 一致；`Ping`→`Pong` 往返；`Quit` 的未保存检查（dirty 非空回 `CloseBlocked`，force 才退出）；`remote_host_set_summary` 的内容与节流。
- `ext_process.rs`：宿主请求按 frontend 路由（有归属 / 无归属 / main 不可见）。
- `pty.rs`：`pty_tail` 只返回最近 N 字节；`pty_resize` 生效。
- `cmd_fs.rs`：`write_file_chunk` 断点续传与 sha256 校验、`fs_zip_stream`、`list_dir` 分页。

### 17.3 前端（vitest，jsdom）

| 文件 | 内容 |
| ---- | ---- |
| `tests/remote.test.ts` | 用假 WebSocket（测试内实现，记录发送的帧）驱动垫片：invoke JSON/RAW、Channel 占位与 `CHAN_DATA` 回调、listen/unlisten、错误映射、4401 跳登录、4410 回选择页、重连与 resume；帧测试向量 |
| `tests/remote.test.ts`（续） | **一致性**：同一段工作台操作在 `tauriMock` 下记录的 invoke 序列，与在垫片下转出的 INVOKE 序列相同 |
| `tests/remoteResponsive.test.ts` | 档位切换；手机档 `contextMenu` 渲染为动作表；底部标签栏；终端扩展按键（Ctrl 粘滞产生 `\x03`）；长按、双指缩放手势 |
| 现有 `commandSweep.test.ts`、`uiSweep.test.ts` | 增加一轮在远程垫片 + 三个档位下运行 |

### 17.4 端到端（Playwright，`tests/e2e/remote/`）

`login.spec.ts`（登录、锁定、改密后重登）、`windows.spec.ts`（选择、切换、新开窗口、内容摘要、关闭与重启、卡死徽标）、`explorer.spec.ts`（浏览、上传、下载、重命名）、`editor.spec.ts`（打开、编辑、保存、大文件窗口化）、`terminal.spec.ts`（开终端、扩展按键、断网恢复：`context.setOffline(true/false)`）、`scm.spec.ts`、`gitgraph.spec.ts`、`analysis.spec.ts`、`extensions.spec.ts`。每个用例在 Chromium/WebKit/Firefox × 手机/平板/桌面运行，保存截图基线。

### 17.5 探针（不进 CI 门禁）

`remote-live-check.mjs`（tauri dev + 守护进程 + 插件检查清单）、`remote-traffic.mjs`（流量）、`remote-memory.mjs`（守护进程空闲/有会话 RSS、Relay RSS），结果写入 `metrics.json.remote`。三平台冒烟（托盘、扫码解锁、explorer 重启图标重建、关机干净退出、防火墙首绑、崩溃自动重启）与 iOS 真机手测（证书安装、PWA standalone、键盘）进发布清单，不在 CI。

---

## 18. 开发任务拆分（里程碑 → 任务）

每个任务结束都满足 `AGENTS.md` 的完成定义：`npm run typecheck`、`npm test`、后端改动时 `cargo test --all-features` 与 `clippy -D warnings`、模块图更新、i18n。任务编号用于提交信息与 PR 标题。

### M0 技术验证（1 周）

| 任务 | 内容 | 完成标准 |
| ---- | ---- | -------- |
| M0.1 | 在 `lib.rs` 临时加 `WebviewWindowBuilder(...).visible(false)` 加载最小 relay 页，页内 `invoke('list_dir')`、建 `Channel` 跑一次 `search`、`listen('studio://git-output')` | 三类调用在隐藏 webview 中可用（Win/macOS/Linux 各验证一次；macOS 注意隐藏窗口定时器节流） |
| M0.2 | relay 页连接本地 Node 写的 WS 测试服务器，浏览器端用最小垫片调 `list_dir` | 浏览器拿到正确结果 |
| M0.3 | `asset_resolver().get("remote/…")` 能读到第二套 Vite 产物；`serve_ext_asset` 用合成请求调用 | 两者返回正确字节 |
| M0.4 | 测 Relay webview 内存（三平台）、tray-icon+tao 空闲 RSS、ksni 空闲 RSS | 数据写进本文 §19 并据此确认或调整方案 |

### M1 协议与远程前端（2 周）

| 任务 | 内容 | 涉及 |
| ---- | ---- | ---- |
| M1.1 | 帧格式：`frame.ts` 与 `frame.rs`，测试向量目录 | `src/remote/frame.ts`、`daemon/src/ws/frame.rs`、`daemon/tests/vectors/` |
| M1.2 | 垫片 `core/event/app/internals`，`vite.remote.config.ts`，`remote.html`，`boot.ts` | `src/remote/` |
| M1.3 | `extHost.ts` 两处 `__TAURI_INTERNALS__` 收敛到 `assetUrl()`；接缝规则 1 | `extHost.ts`、`check-seams.mjs` |
| M1.4 | `transport.ts`：调用、Channel、事件、压缩、信用、心跳、上行合帧（§6.4） | `src/remote/transport.ts` |
| M1.5 | `relay.html` + `relay.ts`：执行与回传、合帧、队列上限 | 主构建第三入口 |
| M1.6 | 守护进程骨架：axum（先不开 TLS）、`/ws`、`/relay`、路由表、资源代理（无缓存） | `daemon/src/` |
| M1.7 | `remote_host.rs`：控制通道、Register、FetchAsset、EnsureRelay；`remote-relay.json` | `src-tauri/` |
| M1.8 | 垫片 `window/webview/dialog/clipboard/opener`，远程文件选择器（只读浏览） | `src/remote/` |
| 验收 | 桌面浏览器访问 loopback：打开文件夹、编辑保存、搜索、开终端 | `tests/remote.test.ts` 绿 |

### M2 守护进程：认证、TLS、单链接（2 周）

| 任务 | 内容 |
| ---- | ---- |
| M2.1 | `paths/config`、单例锁、CLI（`status/stop/set-password/print-link`）、`forward_to_running` |
| M2.2 | `tls.rs`：CA/服务器证书、地址变化重签与热更新、`/ca.crt`、`/ca.mobileconfig` |
| M2.3 | `auth.rs`、`session.rs`、`ratelimit.rs`；`/api/*`；Cookie；首次设置仅本机 |
| M2.4 | 改密 epoch → 4401 广播；踢下线；全部下线 |
| M2.5 | 登录页、窗口选择页、配对页（密码解锁、二维码、证书下载；`daemon/web/`，build.rs 预压缩与 ETag） |
| M2.6 | 本机管理 API `/admin/*`、二维码 SVG、`/pair/unlock` 与 `/admin/unlock`（R19） |
| 验收 | `tests/ws.rs` 改密 1 s 内断开；暴力登录锁定；手机通过 LAN IP 登录（手测） |

### M3 多窗口与新开窗口（1 周）

| 任务 | 内容 |
| ---- | ---- |
| M3.1 | 注册表实时推送；`Update`（标题、文件夹、busy、内容摘要）在 `open_folder/close_folder`、标签与 SCM 变化等处触发 |
| M3.2 | `--remote-host` 模式：`build_main_window` 抽取，Accessory 策略，`Show` |
| M3.3 | `SPAWN` + `LaunchSpec`；等待注册；空闲回收 |
| M3.4 | `windowSwitcher.ts`；4410 处理 |
| M3.5 | 实例生命周期（R20）：两级心跳与 `unresponsive` 标记；`INSTANCE_CLOSE`（close-blocked 流程、force）；`INSTANCE_RESTART`（终止 → `LaunchSpec` 重拉 → 自动接入）；窗口选择页与切换器的内容摘要卡片（R21） |
| 验收 | 远程新开窗口 → 列表出现 → 自动接入；桌面新开窗口 → 远程实时可见；不可见实例空闲 10 min 退出；假卡死（停止应答心跳）→ 徽标出现 → 远程重启 → 自动接入新实例；有未保存文件时关闭被拒绝并列出清单 |

### M4 多前端后端修正与插件（2 周）

| 任务 | 内容 |
| ---- | ---- |
| M4.1 | `x-ggs-frontend` 头；`ext_process` 宿主请求路由 |
| M4.2 | 审计 13 处 emit，修改需要定向的 |
| M4.3 | 资源令牌、opaque origin 的 CORS、HTML 中 CSP 源替换 |
| M4.4 | `pty_tail`、`pty_resize`、接入共享终端 |
| M4.5 | `remote-live-check.mjs`：git-graph-rs 与 claude-code 清单 |
| 验收 | 两个插件的远程检查全部通过；桌面与远程同时使用无重复应答 |

### M5 响应式与触控（3 周）

| 任务 | 内容 |
| ---- | ---- |
| M5.1 | `responsive.ts`、`remote.css`、viewport 与安全区、`--vvh`、PWA manifest |
| M5.2 | `bottomTabs.ts`、侧边栏抽屉/全屏页、面板三档抽屉、手机顶栏 |
| M5.3 | `gestures.ts`、`actionSheet.ts`、`ui.ts` 菜单分支 |
| M5.4 | 资源管理器上传下载（`transfer.ts`、`write_file_chunk`、`fs_zip_stream`） |
| M5.5 | 编辑器工具条、查找替换紧凑版、行内 diff、合并卡片 |
| M5.6 | 终端扩展按键行与字号缩放 |
| M5.7 | 大文件视图触摸滚动；CAN、模块图、Git Graph 容器双指缩放；分析报告卡片化 |
| M5.8 | Playwright 设备矩阵截图基线；uiSweep 三档 |
| 验收 | §11.3 表格逐项手测 + e2e 通过 |

### M6 托盘、自启与插件包（1.5 周）

| 任务 | 内容 |
| ---- | ---- |
| M6.1 | `tray/native.rs`（Win/macOS）、`tray/linux.rs`（ksni）、图标三态、菜单 |
| M6.2 | `autostart.rs`（KeepAlive / 计划任务重启，§7.12）；macOS `.app` 包装 |
| M6.3 | 插件 `extension.js`、`lib/daemon.js`（安装/升级/启动）、`lib/admin.js` |
| M6.4 | “远程访问”页面 |
| M6.5 | `build.mjs` 多平台 VSIX；`prepare.mjs` 开关；CI 作业 |
| 验收 | 三平台手测清单（安装 → 自启 → 托盘 → 扫码解锁 → 改密 → 升级 → 卸载；explorer 重启图标重建、关机干净退出、防火墙首绑指引、崩溃自动重启）；空闲 RSS 达标 |

### M7 流量与性能（1.5 周）

| 任务 | 内容 |
| ---- | ---- |
| M7.1 | `cache.rs` br 缓存（内存 LRU + 磁盘）；`sw.ts` 与 `precache.json` |
| M7.2 | 远程阈值设置（窗口化打开、搜索批次、目录分页）；`dataSaver.ts` |
| M7.3 | 图片缩略图命令（评估纯 Rust 解码 crate 的体积后决定） |
| M7.4 | `remote-traffic.mjs`、`remote-memory.mjs`，写 `metrics.json.remote` |
| 验收 | 记录的数字达到 §1 目标；未达到的项列出原因与后续措施 |

### M8 加固（1.5 周）

| 任务 | 内容 |
| ---- | ---- |
| M8.1 | §16 清单逐项审查并记录 |
| M8.2 | 协议 fuzz（`cargo fuzz` 对 `Frame::decode` 与 MSGPACK 控制消息） |
| M8.3 | 浏览器矩阵回归、Samsung Internet 与 iOS 真机手测（证书安装、PWA standalone） |
| M8.4 | 评估方案 B（Rust 分发表）用于不可见实例，给出内存对比与是否实施的结论 |

**合计约 15.5 周（单人）；加上 Hub 中继（M9，§20.13）约 18 周。** M1–M3 完成后即可得到可用的 PC 网页版本；M5 完成后手机可用。

---

## 19. 风险与对策

| 风险 | 影响 | 对策 |
| ---- | ---- | ---- |
| Relay webview 内存（Windows WebView2 约 60–90 MB） | 接入期间实例内存上升 | 仅接入期间存在、多会话复用、60 s 延迟销毁；M8 评估方案 B |
| macOS 隐藏的 WKWebView 定时器被节流 | Relay 合帧定时器变慢 | 合帧改为“首条消息后 `queueMicrotask` + 尺寸阈值”，不依赖长定时器；必要时沿用 `keep_awake_for_probe_runs` 的做法 |
| Tauri 版本升级改变 Channel 的序列化细节 | `__GGS_CHAN__` 替换失效 | Relay 不依赖 Tauri 内部格式（只认自己的占位字符串）；垫片的 `Channel` 只实现前端用到的公开 API；升级时跑 `tests/remote.test.ts` 一致性测试 |
| 自签证书体验差 | 手机警告、非安全上下文 | 配对页一键下载 CA 与图文步骤；支持自带证书；降级路径完整 |
| 多前端下插件行为差异 | 弹窗、宿主请求重复 | §8.6 路由规则 + 两个主力插件的远程检查 |
| Linux 托盘碎片化 | GNOME 默认无托盘 | ksni + 无托盘模式 + CLI + 插件页管理 |
| 公网暴露 | 被扫描、爆破 | 默认只在 LAN；限速锁定；推荐隧道 + 自带证书；日志审计 |
| 版本不一致 | 前后端协议不符 | 资源路径带版本；HELLO 校验；4409 强制刷新 |
| Hub 能看到明文流量 | 部署方可读取经过的内容 | 服务器自己部署；Hub 不存任何持久数据；可选 M10 端到端加密 |
| 不设 joinKey 的 Hub 被陌生人当中继 | 带宽被占用 | 建议公网部署时设置 joinKey；在线隧道数、会话数、流量上限 |
| 所有流量经过 Hub | 服务器带宽成本、延迟增加 | 公共不可变资源在 Hub 跨用户缓存；每用户配额；局域网内仍可用直连链接 |
| 远程用户权限等同本机 | 密码泄露的后果严重 | 文档与配对页明确提示；设备列表与一键全部下线；可暂停远程访问 |
| 终端输入延迟 = 链路 RTT（Hub 模式两跳） | 打字回显发粘 | 上行 16 ms 合帧（§6.4）；文档明示预期；需要更低延迟时再评估本地回显 |
| 守护进程 panic 退出 | 手机侧“PC 不在线”直到重启 | 平台自愈（§7.12）+ 插件 `ensureRunning` 兜底 |
| Windows 防火墙拒绝放行 | 局域网不可达且无感知 | 配对页/插件页显示最近外来访问时间与放行指引（§7.4） |
| 同一 PC 多 OS 用户 | 第二个守护进程绑不上 47615 | 明确取舍：该用户走 Hub 模式（§7.4） |
| 手机接入桌面终端尺寸不同 | 全屏应用（vim/htop）错乱 | `pty_resize` 按接入方视口（§8.6 #5） |
| 强杀/重启丢失未保存内容 | 用户工作损失 | 优雅关闭优先 + `close-blocked` 清单确认；重启入口明示“未保存的修改将丢失” |
| 心跳误报（实例忙而非死） | 误标 unresponsive | 两级心跳（控制通道 + Relay UI）；连续 2 次超时才标记；标记只提示不自动杀，恢复即摘除 |
| pid 复用导致误杀 | 杀错进程 | 只终止注册表中控制通道仍归属的 pid（§7.8） |

## 20. 多用户：自建中继服务器 Hub

> 需求（2026-10-11 追加并确定）：
> - 服务器**自己部署**；
> - **不需要用户账号**：ggs-remote 守护进程填上服务器地址、连上就能用；
> - 链接用**路径方式**，`/u/<uuid>/`，一个 UUID 对应一个用户；
> - 每个用户（即每台 PC）一个链接，不同 PC 的链接不同。
>
> 由此得到的设计：**Hub 是一个无状态中继**。没有注册、没有管理员建账号、没有绑定码、没有数据库。每台 PC 的身份就是它自己生成的设备密钥，链接里的 UUID 由设备公钥推导出来。远程访问密码仍在各自 PC 上设置和校验（R5、R9 不变）。局域网直连模式（§3–§13）保留，两种模式可以同时开启。

### 20.1 部署模式与链接

| 模式 | 链接 | 适用 | 谁验证密码 |
| ---- | ---- | ---- | ---------- |
| **局域网直连**（§7） | `https://192.168.1.20:47615/` | 同一局域网 | PC 守护进程 |
| **Hub 中继** | `https://remote.example.com/u/<uuid>/`，例如 `https://remote.example.com/u/3f9c2a6e-8b1d-8c7a-9e45-2d6f0b8a71c3/` | 外网访问、PC 在 NAT 后、多人各自使用自己的 PC | PC 守护进程（Hub 只转发） |

- **一台 PC = 一个设备密钥 = 一个 UUID = 一个链接。** 这里的“用户”就是“一台 PC 的主人”；Hub 上不存在用户这个概念。
- **UUID 的来源**：守护进程首次启用 Hub 时生成 Ed25519 设备密钥（`~/.ggs/remote/hub/device.key`，0600）。
  `uuid = UUIDv8( SHA-256("ggs-remote-uuid/1" ‖ 公钥)[0..16] )`——取哈希前 16 字节，按 RFC 9562 设置版本位（8）和变体位（`10`），共 122 位来自哈希。同一把密钥永远得到同一个 UUID，链接稳定；Hub 不需要保存任何映射。
- UUID 统一为小写带连字符的 36 字符（v8 形态）；`/u/` 后的段不是这个形态（畸形、大写、版本位错）就在门口零字节断开，`/u/` 之外的路径同样**不答**——如同此端口未开（§20.5 静默门）；形态合法的 uuid 才可能有内容。
- UUID 无法猜测，别人不能遍历出有哪些 PC；但**链接不是凭据**，进入仍需该 PC 设置的密码。
- **更换链接**：在 PC 的插件页点“更换链接” → 守护进程生成新的设备密钥 → 新 UUID → 重连 Hub。旧链接立即答离线页（与任何未知链接不可区分），旧链接上的会话全部断开（4401 `link-changed`）。
- **换电脑**：新电脑会得到新链接。想保留原链接，可以把 `device.key` 从旧电脑拷到新电脑（插件页提供“导出 / 导入设备密钥”，导出文件用访问密码加密：Argon2id 派生密钥 + XChaCha20-Poly1305）。同一把密钥同时在两台 PC 上连 Hub 时，后连上的生效，先前的收到 `T_REPLACED` 并停止重连，插件页提示。
- 一台 PC 上多个操作系统用户：各自的守护进程各有密钥，各有链接。
- 只需要一个域名和一张普通证书。

### 20.2 架构

```text
 张三的手机 ──https://remote.example.com/u/3f9c…/─┐
 李四的电脑 ──https://remote.example.com/u/a71e…/─┤
                                                 ▼
                     ┌───────────────────────────────────────────────┐
                     │ ggs-remote-hub（Rust，自建 Linux 服务器 / Docker）│
                     │  · 无数据库、无账号：内存里只有 uuid → 在线隧道    │
                     │  · /u/<uuid>/… → 找到隧道 → 转发（剥掉前缀）      │
                     │  · /tunnel：PC 出站连接，Ed25519 证明 uuid 归属   │
                     │  · 可选“服务器口令”joinKey，限制谁能连上来         │
                     │  · 公共不可变资源跨 PC 缓存（只限应用自身资源）     │
                     └──────┬─────────────────────────────┬──────────┘
                  出站 WSS 隧道（PC 主动连）           出站 WSS 隧道
                            ▼                              ▼
                 张三的 PC：ggs-remote 守护进程       李四的 PC：ggs-remote 守护进程
                 （§7 的认证、会话、路由、Relay 不变）   （同左）
                            ▼                              ▼
                      GGS 实例 …                      GGS 实例 …
```

关键设计决定：

1. **PC 主动出站连接 Hub**：PC 在 NAT、防火墙、运营商内网后都能用，不需要端口映射。
2. **身份 = 密钥，不是账号**：Hub 只验证“这条隧道的持有者拥有与 UUID 对应的私钥”，因此无需注册、无需管理员、无需数据库。Hub 重启后什么都不丢——PC 自动重连，链接不变。
3. **Hub 只转发，不认证用户**：访问密码、会话令牌、改密踢下线都在 PC 守护进程（§7.6），与局域网模式是**同一份代码**。张三改密只影响张三的链接。
4. **守护进程两种模式复用同一个 axum `Router` 和同一套连接处理**：本地监听器直接交给 `Router`；隧道把 Hub 转来的请求合成 `http::Request` 后经 `tower::Service::call` 交给它。WS 会话面向 `trait Conn` 编写（§7.7），本地 WS 与隧道会话各实现一份。
5. **Hub 能看到明文流量**（TLS 在 Hub 终结）。因为服务器是自己部署的，这在可接受范围内；需要防范服务器本身时，开启可选的端到端加密 M10（§20.11）。

### 20.3 连接流程（无账号）

```text
部署者：启动 Hub（docker compose up -d），得到服务器地址 https://remote.example.com
        （可选：hub.toml 里设置 joinKey，只有知道口令的 PC 才能连）

PC 主人：GGS → “远程访问”页面 → 模式“通过服务器访问”
        → 填服务器地址（以及 joinKey，如果服务器设置了）→ 点“连接”
守护进程：
  1. 首次：生成 Ed25519 设备密钥，算出 uuid
  2. wss://remote.example.com/tunnel → T_HELLO{pubkey, joinKey?} → T_CHALLENGE{nonce}
     → T_AUTH{sig} → T_READY{publicBase:"https://remote.example.com/u/<uuid>/"}
  3. 插件页显示专属链接与二维码；托盘菜单“复制服务器链接”
  4. 如果还没设置访问密码，插件页要求先在本机设置（未设置密码时守护进程拒绝连接 Hub）；
     服务器地址可以在设置密码的同一屏先保存——守护进程持有它停在 NoPassword，密码落定
     那一刻被唤醒连接（`set_password` 通知隧道循环，2026-10-12）
之后：开机自启的守护进程自动重连 Hub，链接始终不变。
```

服务器地址也可以写成一个可粘贴的连接串：`ggsr1:https://remote.example.com[#<joinKey>][;fp=<证书指纹>]`（指纹只在 Hub 用自签证书时需要）。部署者把这一串发给要使用的人即可。

### 20.4 隧道协议（Hub ↔ 守护进程）

一条出站 WSS：`wss://remote.example.com/tunnel`。复用 §6.1 的 20 字节帧头，`session` 字段是 Hub 给每个浏览器连接（或 HTTP 请求）分配的编号。隧道专用帧：

| 值 | 名称 | 方向 | payload |
| -- | ---- | ---- | ------- |
| 0x80 | `T_HELLO` | PC→Hub | MSGPACK `{pubkey: 32B, joinKey?, daemonVersion, proto:1}` |
| 0x81 | `T_CHALLENGE` | Hub→PC | `{nonce: 32B}` |
| 0x82 | `T_AUTH` | PC→Hub | `{sig: Ed25519("ggs-hub-auth/1" ‖ nonce ‖ hubHost)}` |
| 0x83 | `T_READY` | Hub→PC | `{uuid, publicBase, basePath:"/u/<uuid>/", limits:{sessions, bytesPerDay?}}`（uuid 由 Hub 从公钥独立算出，PC 核对一致） |
| 0x84 | `CONN_OPEN` | Hub→PC | `{session, kind:"ws"\|"http", ip, ua, basePath}` |
| 0x85 | `CONN_CLOSE` | 双向 | `{session, code, reason}`；PC 发出即要求 Hub 关闭该浏览器连接（改密 4401、踢下线都走这里） |
| 0x86 | `HTTP_REQ` | Hub→PC | 首片 MSGPACK `{method, path, query, headers}`，之后 RAW 请求体分片，`FIN` 结束 |
| 0x87 | `HTTP_RES` | PC→Hub | 首片 `{status, headers}`，之后 RAW 响应体分片（支持流式下载） |
| 0x88 | `T_PING` / `T_PONG` | 双向 | 25 s；连续 3 次无响应则重连 |
| 0x89 | `T_REJECTED` | Hub→PC | `{reason:"join-key"\|"capacity"\|"version"\|"banned"}`，随后关闭；PC 在插件页显示原因 |
| 0x8A | `T_REPLACED` | Hub→PC | 同一 uuid 的另一条隧道已连上，本隧道被替换；PC 停止自动重连并提示 |

- 浏览器会话在隧道上的帧就是 §6.2 的普通帧（`session` 非零），守护进程交给与本地 WS 相同的处理逻辑。
- **流控**：`CREDIT` 帧带 `session`，按会话计信用；隧道整体 8 MB 发送缓冲上限，超出时暂停读取信用最少的会话。
- **重连**：指数退避 1 s → 60 s（±20% 抖动）。隧道恢复后，仍在 120 s 恢复窗口内的浏览器会话按 §6.5 续上（断开期间 Hub 保持浏览器 WS，并发 `NOTICE{kind:"pc-reconnecting"}`）。
- **Hub 证书校验**：默认用系统根证书（`rustls-platform-verifier`）；自签证书的 Hub 用连接串里的 `fp=` 指纹固定。

### 20.5 路径处理

Hub 收到 `/u/<uuid>/<rest>`：查内存表 `uuid → 隧道`，剥掉前缀，把 `/<rest>` 转给 PC，并带 `basePath = "/u/<uuid>/"`。守护进程据此：

- 内嵌页面（登录、窗口选择）在 `<head>` 写入 `<base href="{basePath}">`，页面内链接全部相对；
- `Set-Cookie` 的 `Path=basePath`，不设 `Domain`，Cookie 名 `ggsr`——不同 PC 的 Cookie 互不覆盖，同一浏览器可同时登录多台 PC；
- `ATTACHED.assetBase = /u/<uuid>/w/<inst>/v/<ver>/`，`ggsBase = /u/<uuid>/w/<inst>/ggs/<tok>/`；
- Service Worker 从 `{basePath}sw.js` 注册，作用域即 `basePath`；
- `transport.ts` 用 `new URL('ws', document.baseURI)` 得到 `wss://remote.example.com/u/<uuid>/ws`；
- 远程构建本来就是 `base: './'`（§9.1），远程前端不需要为路径方式额外改动。

局域网直连时 `basePath = "/"`，代码路径相同；已连 Hub 的 PC 在局域网直连时也接受 `/u/<自己的 uuid>/` 前缀，同一个书签在家和在外都能用（只是主机名不同）。

链接的两种裸形态——`/u/<uuid>/`（`publicBase` 的原文，带尾斜杠）与 `/u/<uuid>`（手剥斜杠）——都按空 rest 进入同一处理，由 PC 按自己的 `/` 应答（未登录重定向登录页、已登录重定向窗口页，Location 带 basePath）。`{*rest}` 不匹配空 rest，两种形态在路由表上单列（`hub/src/lib.rs`）。

Hub 的路径（§20.5 的静默门，2026-10-12 按所有者要求收口：“如果不是 /u/uuid 访问，不要返回任何东西，就像没开这个端口一样”）：

| 路径 | 说明 |
| ---- | ---- |
| `/u/<uuid>/…` | 浏览器入口——唯一的公开表面 |
| `/tunnel` | PC 隧道；只放行 WebSocket 握手形态（守护进程的连法），对它的普通 HTTP 请求也静默 |
| `/metrics`、`/healthz` | 运营口，只在配置的 `metrics_listen` 上（默认关闭） |
| 其他一切 | **零字节断开连接**，如同此端口未开 |

没有管理后台。`/u/` 后的段**形态合法**是得到任何内容的前提：形态错误的 uuid（畸形、大写、版本位错、百分号编码——一切不是真实链接的拼写）在静默门口即断开，与任何扫描路径无异。形态合法的 uuid 里，不在线与从未出现过两种情况返回**同一个**“此链接对应的 PC 当前不在线”页面（Hub 内嵌，< 10 KB；脚本软轮询 15 s——非 JS 环境退化 meta refresh——PC 上线的下一轮即整体跳转，轮询节奏不动用离线探测预算，页面文字逐字节恒定以保两态一致）——Hub 本来就不知道哪些 uuid“存在”，也就无从泄露。

静默的实现（`hub/src/gate.rs`）：`serve` 跑的是路由外包一层的 tower 服务，不在放行名单里的请求以 `Silent` 错误应答——hyper 只在服务返回 `Ok` 后才写响应字节，`Err` 即关闭连接、一个字节都不发；对扫描器而言这个端口上没有任何 HTTP 服务。放行名单就两条：`/u/<合法 uuid>/…`（`identity::valid_uuid` 的小写 v8 形态，任意方法——形态之后的未知/离线是两态一致离线页的事，不是门的事）与 `/tunnel` 的 WebSocket 握手。物理边界如实记录：TCP 层的 SYN 应答无法隐藏（否则浏览器也连不上，SYN 扫描必见 open）；TLS 模式下 TLS 握手本身仍会完成（证书可见）；静默指 HTTP 层不产生任何响应字节——`nmap` 等探测拿不到任何服务指纹。前置 Caddy 的部署由 `deploy/Caddyfile` 配合——只代理 `/u/*` 与 `/tunnel`，其余 `abort`（Caddy 关闭连接而不答 502）。

### 20.6 安全

| 威胁 | 措施 |
| ---- | ---- |
| 冒充别人的 PC（抢占 uuid） | uuid 由公钥哈希决定，接入时必须用对应私钥签 Hub 的一次性挑战（绑定 Hub 主机名，防跨服务器重放）；没有私钥就拿不到这个 uuid |
| 不相干的人把你的服务器当免费中继 | 可选 `joinKey`（服务器口令，常量时间比较）；`maxTunnels` 在线 PC 上限；每条隧道并发会话上限（默认 8）与可选的每日流量上限；`T_HELLO` 每 IP 限速 |
| 把中继当免费网页托管（挂自己的黄色/暴力/任意站点） | 四层（2026-10-12）：**访客上限**——`visitors_per_day_per_tunnel`（默认 32，0 = 关），个人链接的观众是个位数、被当公开网站分享的链接是成百上千个独立 IP，计数挂在 uuid 上（重连不清零），超出即 429；**请求速率**——`http_rate`（默认 600 次/分钟/IP，0 = 关），会话上限只限并发不限速率；**审计**——`audit_log`（默认空 = 关），每个隧道生死、浏览器会话开关、被代理应答**头**一行 JSON（无请求体、无 Cookie、路径中的包令牌脱敏为前 6 位，§16 的同一形状），运营者应对投诉与取证的那条痕；**黑名单**——`blocklist`（默认空 = 关），一文件一行一个 uuid（`#` 注释），30 s 重读一次并在每次握手时检查，被列 PC 的隧道被摘下（浏览器看到的与离线页无差别）且下次握手被 `banned` 拒绝。公网部署另见 §20.6 末的运营提示：joinKey 当邀请制用、日志留存遵循所在司法辖区 |
| 浏览器端爆破某台 PC 的密码 | PC 守护进程限速（§7.6）按真实 IP：Hub 在 `CONN_OPEN`/`HTTP_REQ` 里带客户端 IP；Hub 另有每 IP、每 uuid 的登录入口限速（10 次/分钟） |
| 枚举链接 | 122 位哈希，无法遍历；畸形 uuid 在门口即静默（与任何扫描路径无异），形态合法的未知/离线链接返回同一页面；每 IP 访问不在线链接超过 100 次/10 分钟则临时封禁 |
| 链接泄露 | 链接不是凭据，仍需密码；可“更换链接” |
| 设备私钥泄露 | 等于链接被别人接管（对方仍不知道访问密码，但可以冒充你的 PC 骗取密码）。私钥文件 0600；导出文件必须加密；插件页“更换链接”立即作废旧密钥 |
| Hub 被攻破 | 可读写经过的流量。缓解：自己部署；Hub 不存密码、会话、任何持久数据；可选 M10 端到端加密 |
| 资源跨 PC 缓存泄露 | 只缓存**应用自身**的带哈希不可变资源（`/v/<ver>/assets/*`，各 PC 相同的公开构建产物），键为（版本、路径、sha256）；插件文件、API、下载永不跨 PC 缓存 |
| 放弃中的请求占满会话槽（DoS） | 2026-10-12 修复：HTTP 请求从入表到应答头之间被浏览器放弃（连接断开、handler 被取消）时，会话条目曾经无人回收——8 个幽灵即可让默认隧道永久 429。现在 `SessionSlot`（http_proxy.rs）持有所有权、随 drop 无论怎样离开都回收，`to_conn` 的失败投递同样移除死条目；应答头另有 30 s 超时（挂死的 PC 答案是 504 而非无限悬挂） |

#### 20.6.1 路径方式下的浏览器侧隔离

所有 PC 的链接共享 `https://remote.example.com` 这一个源。浏览器按源隔离的东西需要应用层自己分开：

| 资源 | 措施 |
| ---- | ---- |
| Cookie | `Path=/u/<uuid>/` + `HttpOnly`，页面脚本读不到任何 Cookie；不同 PC 互不覆盖 |
| localStorage / sessionStorage | 远程构建的 `boot.ts` 在加载工作台之前安装**带前缀的 Storage 包装**（键名前加 `u:<uuid>:`）；`src/state.ts` 改为经 `storage()` 帮助函数访问；接缝检查新增规则：`src/` 中除 `state.ts` 与 `src/remote/` 外不得直接使用 `localStorage` |
| IndexedDB / Cache Storage | 名称带 uuid 前缀；Service Worker 只操作自己前缀的缓存 |
| Service Worker | 每个 PC 一个，作用域 `/u/<uuid>/` |
| 插件页面 | 本来就是无 `allow-same-origin` 的沙箱 iframe，碰不到该源的存储和 Cookie |
| 同源脚本的跨 PC 请求 | 严格 CSP（§7.3）；守护进程对改状态的请求校验 `Sec-Fetch-Site: same-origin`，且请求头 `X-GGS-Base` 必须等于自己的 `basePath`（transport 自动附带） |
| 退出登录 | 只清除该 uuid 前缀下的 Storage、IndexedDB、缓存 |

剩余风险只在“工作台自身出现 XSS”这一前提下存在，由 CSP 与请求头校验收窄。

### 20.7 Hub 的技术选型

| 用途 | crate | 版本 | 说明 |
| ---- | ----- | ---- | ---- |
| 运行时 | `tokio` | 1.4x | 多线程运行时（服务器端多 PC 并发） |
| HTTP / WS | `axum` | 0.8 | 与守护进程相同 |
| TLS | `rustls` 0.23 + `axum-server` 0.7 | — | 单域名单证书；也可关闭 TLS 交给前置 Caddy |
| 自动证书（可选） | `instant-acme` | 0.7 | Let's Encrypt HTTP-01；不用时由 Caddy 签发或加载证书文件 |
| 设备认证 | `ed25519-dalek` | 2 | 校验挑战签名；守护进程端用同一 crate 生成密钥、签名 |
| uuid 推导与格式化 | `sha2` 0.10 + `uuid` 1 | — | `Uuid::new_v8(bytes)`；守护进程与 Hub 同一算法，用测试向量对齐 |
| 常量时间比较 | `subtle` | 2.6 | joinKey |
| 配置 | `serde` + `toml` 0.8 | — | `hub.toml` |
| 指标（可选） | `metrics` 0.24 + `metrics-exporter-prometheus` 0.16 | — | 在线 PC 数、会话数、流量、隧道延迟 |
| 日志 | `tracing` + `tracing-subscriber`（JSON） | — | 不记录 uuid 之外的任何身份信息，不记录内容 |

守护进程端新增：`ed25519-dalek` 2、`tokio-tungstenite` 0.26（`rustls` 特性，隧道客户端）、`rustls-platform-verifier` 0.5、`uuid` 1、`chacha20poly1305` 0.10（设备密钥导出加密）。

**不需要**：数据库、账号体系、管理后台、TOTP、邮件。

### 20.8 目录结构

```text
extensions-src/ggs-remote/hub/                # 不进 VSIX；发布为静态二进制与容器镜像
├── Cargo.toml
├── Dockerfile                                # rust:alpine 构建 musl 静态二进制 → FROM scratch
├── deploy/
│   ├── docker-compose.yml                    # hub（+ 可选 caddy）
│   ├── Caddyfile                             # remote.example.com 自动证书、反代到 hub
│   └── hub.example.toml
├── web/offline.html                          # “PC 不在线”页面
└── src/
    ├── main.rs                               # 读配置、监听、优雅退出
    ├── config.rs                             # hub.toml
    ├── identity.rs                           # 公钥 → uuid、挑战签名校验
    ├── tunnel.rs                             # /tunnel：握手、内存表 uuid → 隧道、替换、心跳
    ├── front.rs                              # /u/<uuid>/：解析、剥前缀、查表
    ├── http_proxy.rs                         # HTTP 请求 ↔ HTTP_REQ/HTTP_RES（SessionSlot 会话槽所有权、应答头 30 s 超时）
    ├── ws_bridge.rs                          # 浏览器 WS ↔ 隧道会话（只改写 session）
    ├── cache.rs                              # 跨 PC 共享的公开不可变资源缓存（内存 LRU + 可选磁盘）
    ├── audit.rs                              # 运营者审计日志（JSON 行：隧道/会话/应答头，令牌脱敏）
    ├── blocklist.rs                          # uuid 黑名单文件（30 s 重读 + 每次握手检查）
    ├── limits.rs                             # joinKey、maxTunnels、每 IP / 每 uuid 限速、封禁
    └── metrics.rs

extensions-src/ggs-remote/daemon/src/         # 守护进程新增
├── conn.rs                                   # trait Conn：本地 WS 与隧道会话的共同抽象
└── hub/
    ├── mod.rs                                # 配置（url、joinKey、指纹）、状态：未配置 / 连接中 / 在线 / 被拒绝 / 被替换
    ├── identity.rs                           # 设备密钥生成、uuid 推导、导出/导入（加密）、更换链接
    ├── link.rs                               # 隧道：握手、重连、帧收发、按会话流控
    └── session.rs                            # 隧道会话实现 Conn；HTTP_REQ → Router
```

`hub.example.toml`：

```toml
listen = "0.0.0.0:8443"
public_url = "https://remote.example.com"   # 用于拼 publicBase、挑战绑定的主机名
tls = { mode = "acme", email = "ops@example.com" }  # 或 { mode = "files", cert = "...", key = "..." } 或 { mode = "none" }（前置 Caddy）
trust_proxy = ["127.0.0.1/32"]              # tls=none 时，只信任这些地址的 X-Forwarded-*
handshake_rate = 10                         # /tunnel 每 IP 每分钟握手数；0 = 不限（压测/私有大车队）
http_rate = 600                             # 每 IP 每分钟被代理的 HTTP 请求数；0 = 不限
visitors_per_day_per_tunnel = 32            # 每链接每日独立访客 IP 上限（挂在 uuid 上，重连不清零）；0 = 不限
audit_log = ""                              # 审计日志路径（JSON 行：隧道/会话/应答头，令牌脱敏）；空 = 关
blocklist = ""                              # uuid 黑名单文件（一行一个，30 s 重读，被列即摘线+拒连）；空 = 关
join_key = ""                               # 空 = 任何 ggs-remote 都能连；非空 = 需要口令
max_tunnels = 200
sessions_per_tunnel = 8
bytes_per_day_per_tunnel = 0                # 0 = 不限
asset_cache_mb = 256
metrics_listen = ""                         # 运营口（/metrics 与 /healthz）；空 = 关闭
```

### 20.9 部署

```yaml
# deploy/docker-compose.yml
services:
  hub:
    image: ghcr.io/<owner>/ggs-remote-hub:<ver>
    restart: unless-stopped
    ports: ["443:8443", "80:8080"]           # 80 只用于 ACME HTTP-01
    volumes: ["./hub.toml:/etc/ggs-hub/hub.toml:ro", "./acme:/var/lib/ggs-hub/acme"]
```

- DNS 一条 `remote.example.com` 记录即可；也可以直接用 IP + 自签证书（连接串带 `fp=` 指纹）。
- 不用 Docker 时，`ggs-remote-hub --config hub.toml` 直接运行（单个静态二进制，附 systemd 单元示例）。
- **独立安装包（2026-10-12 落地）**：发布页随每个版本携带三件——Windows 的 `ggs-remote-hub-<版本>-windows-x64.zip`（解压即用）、`ggs-remote-hub_<版本>_amd64.deb`（musl 静态二进制 + 加固 systemd 单元 [DynamicUser、ProtectSystem=strict] + 示例配置以 conffile 落位 `/etc/ggs-hub/hub.toml`——`dpkg -i` 后 `systemctl enable --now` 开箱即跑，升级保留本地改动）、以及给非 Debian 系的 `x86_64-musl.tar.gz`；本地可用 `bash hub/deploy/build-deb.sh` 自行打包 deb + tarball、`hub/deploy/build-zip.bat` 自行打包 Windows zip（两者均可用 `PREBUILT`/`VERSION` 注入），`release.yml` 的 `hub-packages` 作业在打 tag 时构建并纳入 `SHA256SUMS` 与 GPG 签名。deb 布局已在真实 Ubuntu 24.04 上安装/卸载验证。
- 资源估算：每条在线隧道约 64 KB 内存；1 核 1 GB 的服务器可承载数百台在线 PC，瓶颈是带宽（所有远程流量都经过 Hub）。
- Hub **没有需要备份的数据**：换服务器只需让域名指向新机器，各 PC 自动重连，链接不变。

### 20.10 对已有部分的改动

| 部分 | 改动 |
| ---- | ---- |
| 守护进程 §7.1 | `server::run` 在配置了 Hub 时启动 `hub::link` |
| 守护进程 §7.7 | 连接处理面向 `trait Conn { send, close, meta }`；本地 WS、隧道会话各一个实现 |
| 守护进程 §7.6 | 限速、会话记录用 `ConnMeta.client_ip`（隧道下来自 Hub）；Cookie `Path=basePath`；改状态请求校验 `X-GGS-Base` |
| 守护进程 §7.2 | 新增 `~/.ggs/remote/hub/`：`device.key`（0600）、`hub.json`（url、joinKey、指纹） |
| 守护进程 §7.11 | 管理 API 新增 `/admin/hub/connect`、`/admin/hub/disconnect`、`/admin/hub/status`、`/admin/hub/relink`、`/admin/hub/export-key`、`/admin/hub/import-key` |
| 守护进程 §7.9 | 托盘显示“服务器：在线 / 重连中 / 被拒绝”，菜单增加“复制服务器链接” |
| 远程前端 §9 | 地址全部相对 `document.baseURI`；处理 `NOTICE{pc-reconnecting}`（横幅提示，不跳转）；Storage 前缀包装 |
| 插件 §14 | 配置新增 `ggsRemote.mode`（`lan` / `hub` / `both`，默认 `lan`）、`ggsRemote.hubUrl`、`ggsRemote.hubJoinKey`；页面新增“通过服务器访问”：填服务器地址或粘贴连接串、连接/断开、专属链接与二维码、更换链接、导出/导入设备密钥、隧道状态 |
| 安全 §16 | 增加 §20.6 的条目 |
| 构建 §15 | Hub 的 CI：`cargo test`、clippy、musl 静态构建；打 tag 时推送容器镜像到 GHCR 并附二进制到 Release |

### 20.11 可选：端到端加密（M10）—— 密码学核心已落地（2026-10-12）

目标不变：即使 Hub 被攻破也看不到文件内容和访问密码。设计从 OPAQUE+WASM 落地为等效但轻得多的组合（无 WASM、无新前端加密框架）：

| 件 | 选择 | 说明 |
| -- | ---- | ---- |
| 静态身份 | X25519 静态密钥（`~/.ggs/remote/e2e.key`，0600） | 公钥随 `GET api/e2e-params` 发布，**由设备 Ed25519 密钥签名**（域 `ggs-remote-e2e/1` ‖ x_pub）——浏览器先验 `uuid_for(ed_pub)` 等于链接里的 uuid 再验签名，Hub 换钥需要造出哈希到该 uuid 的密钥；LAN 直连时由 TLS 承担 |
| 密钥协商 | 浏览器每次会话/连接的临时 X25519 | `shared = X25519(eph, static)` → `HKDF-SHA512(salt = 双方公钥, info = ggs-remote-e2e/1)`（RFC 5869，两侧同十六行） |
| AEAD | AES-256-GCM，12 字节随机 nonce | 浏览器 WebCrypto（零依赖）、PC RustCrypto `aes-gcm`；标准 wire 格式逐字节兼容 |
| 密码通道 | `api/e2e-login`：POST `secretbox(password)` | 明文密码不再过 Hub；离线猜字典需 PC 静态私钥（截获的密文验不了猜测）；PC 侧照旧 Argon2id 校验 |
| 帧封装 | 外层 20 字节头照旧（Hub 的会话改写只碰它），置 `FLAG_ENCRYPTED(0x40)`，载荷 = `nonce(12) ‖ GCM(完整原帧)` | Hub 对内层一无所知，纯搬运密文 |

已交付（`daemon/src/e2e.rs` + `src/remote/e2e.ts` + `daemon/tests/vectors/e2e.json`）：双侧实现、跨实现向量互证（uuid 推导、参数验签与替换拒绝、密钥推导、开封/封出逐字节相同、信封往返）——`tests/remote.test.ts` 三条向量测试 + daemon 单测全绿。

**剩余接线（下一轮）**：`api/e2e-params`/`api/e2e-login` 路由与登录页改造（`daemon/web/login.js` 引入 tweetnacl）、WS 侧 HELLO 携带协商与会话绑定（cookie 被抢也无法伪造密文）、daemon 双接收路径（`ws/socket.rs` 与 `hub/session.rs`）的信封拆装与强制、`e2e` 配置开关与插件页切换、Hub 禁用跨 PC 资源缓存的密文路径、e2e 探针断言"Hub 视角全密文"。原 OPAQUE 方案的离线字典抗性差异记录为取舍：OPAQUE 下攻击者需注册记录，本设计下需 DH 私钥——对 Hub 威胁模型等效。

### 20.12 测试

| 层 | 测试 |
| -- | ---- |
| uuid 推导 | 守护进程与 Hub 用同一组测试向量（公钥 → uuid），含版本位、变体位 |
| Hub 单元 | 路径解析（大小写、格式错误、不在线统一处理）、挑战签名校验（错误签名、重放、换主机名）、joinKey、限速与封禁 |
| Hub 集成（`hub/tests/`） | 起 Hub + 两个假 PC：各自链接只到达各自 PC；改密只断开该 PC 的浏览器会话（4401 经 `CONN_CLOSE`）；同一密钥第二次连接 → 旧隧道收到 `T_REPLACED`；joinKey 错误 → `T_REJECTED`；Hub 重启后 PC 自动重连、链接不变；跨 PC 缓存只命中公开资源 |
| 守护进程 | `hub::link` 重连退避、隧道恢复后浏览器会话续上、`trait Conn` 两种实现跑同一组 WS 测试、更换链接后旧链接失效、密钥导出导入往返 |
| 端到端（Playwright） | `hub.spec.ts`：容器内真 Hub + 两个守护进程 + 一个浏览器同时登录两个链接（Cookie、localStorage、Service Worker 互不影响；A 的 Cookie 访问 B 的路径被拒）、改密重登、更换链接后旧链接显示“不在线”页 |
| 压测 | `scripts/probes/hub-load.mjs`（已落地）：N 个假 PC（真 Ed25519 握手）+ M 个浏览器 WS 会话，记录 Hub 内存/CPU 到 `metrics.json` 的 `remote.hubLoad`；压测配置 `handshake_rate = 0` |

### 20.13 里程碑（追加到 §18）

| 里程碑 | 任务 | 完成标准 | 估时 |
| ------ | ---- | -------- | ---- |
| **M9 Hub 中继** | M9.1 Hub 骨架、配置、TLS/ACME；M9.2 设备身份（密钥、uuid 推导、测试向量）与隧道握手；M9.3 HTTP 与 WS 经隧道转发、按会话流控、重连与会话续传；M9.4 守护进程 `trait Conn` 重构与 `hub/` 模块；M9.5 `/u/<uuid>/` 路径处理、Storage 前缀包装、“不在线”页面；M9.6 joinKey、限额、限速；M9.7 公共资源缓存；M9.8 插件页“通过服务器访问”、更换链接、密钥导出导入；M9.9 Docker 镜像、部署文档、CI | §20.12 全部通过；两台 PC 通过同一 Hub 被同时访问互不影响；Hub 重启后链接不变 | 2.5 周 |
| M10 端到端加密（可选） | OPAQUE + AEAD、WASM 构建、加密资源加载 | Hub 端抓包看不到明文 | 2 周 |

M9 依赖 M2（认证）和 M3（多窗口），可与 M5（响应式）并行。加上 M9，总估时约 18 周（不含可选的 M10）。

## 21. 待确认问题

1. 远程端是否需要同步桌面窗口的标签页和布局？（本计划默认不同步，只共享后端状态。）
2. 远程新开的窗口默认是否在桌面显示？（本计划默认不显示，可设置。）
3. 多用户已按“自建中继服务器、无账号、每台 PC 一个 `/u/<uuid>/` 链接”设计（§20）。每台 PC 是否还需要只读密码？（本计划为单密码、全部权限。）
4. ~~链接方式~~：已确定为路径方式，`/u/<uuid>/`，UUID 对应用户（§20.1、§20.5）。
5. 默认端口 47615 是否可以？
6. 服务器自己部署（已确定）。是否需要端到端加密 M10？公网部署时 joinKey 默认留空（任何 ggs-remote 都能连）还是首次启动自动生成一个？（本计划默认留空，文档建议公网设置。）

## 22. 副本模式：PC 是唯一前端

### 22.1 为什么改

§3.3 的“一个实例、多个前端”让远程浏览器运行一整份工作台：浏览器刷新等于前端重启，扩展 webview 页面（Claude Code 的对话页）的状态全在页面 JS 里，随标签页一起消失。Claude Code 的页面按 `retainContextWhenHidden: true` 设计，页面不会重载、也无法重新接上正在运行的 CLI 通道——刷新后旧通道成了孤儿，新页面是一张空白对话。所有者的要求是：整个 GGS 在 PC 上运行，远程只是副本。

### 22.2 结构

| 部分 | 位置 | 职责 |
| ---- | ---- | ---- |
| 录制 | `src/remote/mirror/recorder.ts`（PC 窗口内） | 节点编号；快照；MutationObserver → 操作批（add/rm/attr/text）；轮询表单值、滚动、CSSOM 规则、adoptedStyleSheets、视口；同源 iframe（扩展 webview 页）递归；URL 规范化为 app/ggs 令牌；脚本内容、事件属性、CSP meta 不过线；光标与焦点是显示状态而非 DOM（2026-10-13，所有者反馈“Claude 在 PC 上选中输入框有光标和红色边沿，远程没有”）：光标经 caret 操作过线，焦点链（沿 activeElement 逐文档深入，含 `:focus-visible` 位）经 focus 操作过线，`focusin/focusout` 触发即时批；快照携带两者的当前值——它们只在变化时作为操作过线，后来挂载（或重新快照）的观看者若不随快照拿到，副本就永远停在“无光标无焦点”，直到 PC 侧下一次变化 |
| 重放 | `replay.ts`（PC） | 按目标框架自己的构造器派发 pointer/mouse/wheel/keyboard/input 事件，补齐合成事件没有的默认动作（按下聚焦、滚轮滚动、编辑键）；合成指针 id 的 pointer capture 由补丁接管 |
| 主机 | `host.ts` + `hostStub.ts`（PC） | 观看者表（10 s hello、35 s 遗忘）；首个 hello 才加载录制器；最后一个观看者离开即停；焦点模拟、隐藏窗口尺寸适配 |
| 观看 | `viewer.ts` + `viewerInput.ts` + `viewerBoot.ts`（浏览器） | 无脚本沙箱 iframe 中重建副本并缩放适配；序号缺口请求重新快照；鼠标、触摸（点按、拖动滚动、长按菜单、双指缩放留给浏览器）、隐藏文本框承接键盘/IME/手机软键盘；聚焦编辑框的光标作为 caret 操作过线（控件选区，或 contenteditable 的锚点——文本节点按字符偏移、元素按子索引，空编辑框锚在自身），副本按自身布局画闪烁竖条，且键盘 proxy 骑到光标处（换算到本页视口坐标）——IME 候选框锚定 proxy，跟随输入位置而非藏匿角落（2026-10-13）；焦点链经标记类解析进副本自己的显示（2026-10-13，所有者方向：**不额外画光标和边框，镜像把状态解析对内容显示**）：焦点元素带 `mirror-focus`（PC 匹配 `:focus-visible` 再加 `mirror-focus-visible`）、其祖先带 `mirror-focus-within`，副本每个样式表里带 `:focus*` 的规则都在紧邻原位插入伪类换成标记类的同款规则（CSSOM 邻位插入，等特异性时保持表内顺序）——Claude 输入框的红边由 Claude 自己的 `:focus-within` CSS 画出来，副本不添加任何视觉；每批操作后重放标记（页面重写 class 属性不会抹掉） |
| 手机 | `phoneShell.ts`（PC） | 窗口宽度 < 600（只可能来自手机观看者的适配）时 PC 窗口换上手机外壳（shell.ts + remote.css，指针按 coarse）；回到桌面尺寸即恢复 |

通道：PC → 浏览器为应用事件 `studio://mirror-down`（Relay 转发给监听的会话，`to` 字段区分快照接收者）；浏览器 → PC 为 `studio://mirror-up`，`emitTo('main')`。

### 22.3 PC 侧配套

- `--remote-host` 实例建隐藏窗口（不再“无窗口”）；托盘/远程的 Show 先恢复桌面尺寸再显示。
- 有观看者或为远程主机实例时，关闭窗口只隐藏（`remote_host_hide_main`）。
- 有观看者时 `remote_mirror_focus` 经 WebView2 DevTools 协议开 `Emulation.setFocusEmulationEnabled`，隐藏窗口的页面仍按“有焦点”工作。
- 隐藏窗口照常渲染（Claude 的流式文字靠 requestAnimationFrame）：Tauri 隐藏窗口不会把 WebView2 设为不可见，实测（2026-10-12）rAF 与 10 ms 计时器全速、`visibilityState` 为 visible。**不得**使用自定义 `additionalBrowserArgs`：同一用户数据目录下应用的所有实例共用一个 WebView2 浏览器进程，参数与已运行实例不同的实例根本建不出 webview（实测：装机版在运行时，带参数的调试实例连主窗口与 Relay 都无法创建）。macOS 另设 `backgroundThrottling: disabled`。
- 守护进程 idle exit 的 `Quit` 带 `idle: true`，实例拒绝；默认 `idleExitMinutes` 改为 0。
- 守护进程 app 资源路由新增 `main/…`：只放行桌面构建的 css/字体/图片，供副本渲染。

### 22.4 已知取舍

- 副本按 PC 布局显示（手机除外），字体差异会带来少量排版漂移；输入以“目标节点 + 相对位置 + 文本插入点”定位，不依赖像素一致。
- canvas 内容、blob: 图片、PC 原生对话框（打开文件夹等）不进副本；PC 剪贴板操作在 PC 上，浏览器复制走 `copy` 请求 PC 选区。
- 多个观看者共享同一个 PC 界面（同一焦点、同一滚动），这是副本的本义。
- 旧的浏览器端工作台（§9）保留为 `?frontend=1`，不再是默认。

### 22.5 一个窗口，不同界面

修订（2026-10-12，所有者要求“允许本地使用 PC 界面、远程使用手机界面，支持不同界面使用”）：PC 窗口只有一棵 DOM，同一时刻只能穿一种界面，由窗口的“主人”决定——PC 屏幕上显示着窗口时是本地用户（桌面界面），否则是第一个观看者。界面与主人不同的页面不再看副本，而是运行自己的工作台（§9 的浏览器端前端，手机上即手机外壳）：

- 手机连接时窗口在 PC 屏幕上可见（WINDOWS 的 `visible`）→ 直接启动独立手机工作台；正在看副本的手机遇到窗口被显示（托盘点开）→ 切换过去。
- 观看者按到达顺序排队，只有第一个决定窗口尺寸（此前每个 hello 都改尺寸，两个观看者会来回拉扯）；形态不同（手机/桌面）的后来者收到 `own` 消息转入独立工作台；主人离开后由下一位接管尺寸。
- 显式选择：副本栏的“独立界面”按钮与 `?frontend=1`；独立工作台里的“PC 窗口实时画面”命令（抽屉行）与 `?mirror=1` 回到副本。切换写进 URL，刷新不反弹。
- 托盘新增“窗口”子菜单：列出本机全部实例（后台运行的标注“后台”，附远程会话数），点击即发送 `Show` 在 PC 上显示该窗口——本地打开的窗口与远程驱动的窗口都在其中。

### 22.6 独立界面里的扩展页面：PC 上一份，两端同显

问题（2026-10-12，所有者反馈“remote 的 claude 对话时，另一端没有更新显示”）：独立工作台是第二个前端，而后端扩展的 webview 请求按“最后一个 resolve/发消息的前端”路由——Claude Code 的会话状态（channel、流式 io_message）只存在于收到消息的那个页面里，另一端的聊天页就此冻结；面板（Claude 默认在编辑器标签里打开）更是只出现在创建它的一端。消息层面广播救不了：对话状态在页面里，后加入的页面不认识别人的 channel。

做法：每个 webview 只活在 PC 窗口里一份，其他前端看它的副本。

- 路由（`ext_routing.rs`）：所有 `webview.*` / `webviewView.*` 宿主请求一律发往 `main`（`WEBVIEW_HOME`）；原来的属主表、面板迁移（`ext-webview-move`）与会话结束释放一并删除。面板的创建 / 改标题 / reveal / 销毁作为状态镜像（`ext-host-state`，带 `caller`——哪个前端的点击引起的）；PC 用户关掉标签时由 `ext_process_push_event` 看到的 `webviewDisposed` 补发一条销毁镜像；日志回放带上存活面板的创建参数，后连上的页面也能打开它们的副本。
- PC 端（`webviewShare.ts`）：远程页面 hello 时带上流名（`view:<viewId>` / `panel:<extId>#<panelId>`），宿主为该流建一个以该 iframe 文档为根的录制器与输入回放（复用 §22 的 `recorder.ts` / `replay.ts`）；iframe 换文档（setHtml）或换元素（侧栏重建）即重启录制并给每个观看者重发快照；从未显示过的视图会被立即 resolve。`webviewFrames.ts` 是桌面扩展宿主注册的帧查找表。
- 远程端（`webviewCopy.ts`）：独立工作台里后端扩展的视图窗格 / 面板标签不再自建 iframe、不再 resolve，而是挂一个流式副本——按窗格自身尺寸排版（手机按手机宽度读聊天，不是缩放的 PC 侧栏），本地滚动，处于底部的滚动区随内容增长自动贴底；点按与键入回放进 PC 的同一页面。副本标签的关闭经 §22.7 的 `closeTab` 消息同步（2026-10-12，所有者反馈“手机端关闭 claude / git graph 页面，本地端没更新”：此前副本关闭只关本端）——手机关副本，PC 的真实面板随之关闭并向扩展送达 dispose；本端点击引起的面板创建 / reveal 把副本标签切到前台（现在是任何一端的都切）。
- 结果：PC 上提问，手机副本实时流式显示；手机上提问，PC 上同一个聊天页实时显示——两端看的是同一个会话。代价：多人通过 Hub 时共享同一个 Git Graph / Claude 面板（与副本模式一致），不再各开各的。
- 修正（2026-10-12，所有者反馈“claude 对话页面一个打开，另一个没有同步打开，git graph 页面也是”）：镜像的 `webview.create` / `webview.reveal` 不再区分“是不是本端的点击”——任何一端打开或聚焦面板，另一端的副本标签就在前台打开（`create[4]` 恒为 false，reveal 不再按 caller 过滤）。旧策略“非本端点击只开后台标签”让另一端的副本藏在当前页面后面，看起来就是“没有同步打开”。
- 修正（2026-10-12，所有者反馈“远程切到手机使用时 git graph rs 底部空白”）：git-graph-rs 是虚拟列表——只渲染 PC 视口加缓冲的行，其余提交用空白占位行撑起滚动高度。其一，贴底扫描原本把副本里*所有*可滚动元素都登记为“贴底”并拽到各自最底部：列表副本被拽进底部占位行里，表头以下全空，上滚一秒内又被拽回——现在只登记已处于自身末端的滚动区（聊天照旧贴底，列表留在 PC 的偏移处）。其二，副本的本地滚动不上报、PC 端就不重渲染虚拟窗口，滚过已渲染窗口就是空白——现在副本把各滚动区的位置按滚动区间的**比例**上报（`k:'scroll'`，副本按另一宽度排版，像素不可比），PC 把同一滚动区放到相同比例处，页面自身的滚动处理器就地重渲染窗口，行流回副本。


### 22.7 跨前端操作同步：PC 界面与手机界面一一对应

问题（2026-10-12，所有者反馈“本地是 PC 界面、远程是手机界面时操作不同步，打开对应的页面另一边没有同步”）：§22.5 让 PC 穿桌面界面、手机穿自己的手机工作台后，两个前端各自持有自己的标签页与视图——PC 打开的文件在手机上不存在，反之亦然。同步像素（把副本嵌进独立界面）违背 §22.5 的初衷；同步的是**操作**。

做法：两端跑的是同一份工作台代码（`src/workbench.ts`），所以一个模块服务两边（`src/remote/workbenchSync.ts`，`installWorkbenchSync` 在构造器接线、`boot()` 完成后 `start()`）。每个用户操作作为一条 `studio://workbench-sync` 应用事件跨前端：

- 消息只有七种：`open`（路径 + 行列锚点）、`close`（路径）、`active`（路径）、`view`（视图 id，含扩展容器）、`closeTab`（扩展页标签 id，2026-10-12 补：面板的标签 id `webview:<extId>:<panelId>` 在每个前端相同——PC 的真实标签与手机的副本标签——任一端关闭即处处关闭，PC 的关闭经自身 disposer 送达扩展，后端的 dispose 镜像再清掉其余副本；扩展页的**打开**仍归 §22.6 的 create 镜像，不经此通道）。2026-10-12 再补两种（所有者反馈“claude 和 git graph 的页面打开关闭、聚焦，另一边没有同步”）：`activeTab`（扩展页标签 id 获得焦点——PC 点 Git Graph / Claude 标签，手机翻到同一页，反之亦然；面板 create 自身的激活不算切换，否则两端同时前台打开时会互相回声、抢走用户刚点的标签；`revealById` 同时聚焦标签所在编辑组）与 `sidebar`（侧栏隐藏——PC 再点一次 Claude 活动项或 Ctrl+B 收起侧栏，手机离开 Claude 侧栏页回到编辑器；只有并排布局的工作台播报，手机上关闭侧栏页是导航——每次点文件都会关——不得让 PC 布局跟着闪；重新显示侧栏按 `view` 播报）。路径与 id 而已——无内容、无 DOM，每条序列化后远小于 200 字节；接收端通过自己的编辑区打开文档（本来就要付的那一次文件读取）。副本模式的页面不跑工作台、不订阅此事件，Relay 对它一个字节都不转发。
- 桌面端经真实 Tauri 广播发出（Relay 只转发给订阅了的会话）；手机工作台经同一 `@tauri-apps/api/event` 垫片（WebSocket）发出。每条消息带发送者的前端 id，各端忽略自己的回声。
- 本地操作走包装（openFile 门面、onTabsChange/onActiveChange 钩子、showView），远端操作走**原生函数**并预标记 `announced` 集合（“对面已知我打开了什么”）：回声永远不会重播，而远端操作进行中落下的本地变更照样跨过去——不乒乓、不吞操作。用户拒绝的关闭（脏文件弹窗点了取消）让两端收敛到“保持打开”；远端打开失败就地回滚标记。
- 静默期：`boot()` 完成前不收发（开机的视图接线是内务，手机页刷新不得把 PC 的侧栏拽走）；会话恢复（session restore）重建本端自己的标签页期间 `localOnly(true)` 暂停播报——恢复的标签是本端的会话，不是该让对面镜像的操作。`editorArea.ts` 新增 `closeFilePath` / `revealFilePath`（`EditorGroup.editorForPath`）作为按路径落地的入口。

结果：PC 上打开 `notes.txt`，手机的编辑器页打开同一个文件并成为当前标签（行列锚点一同跳转）；手机上切到 Changes 页，PC 侧栏切到 Source Control；任一端关标签、切标签，另一端照做。流量的上限就是操作的条数——每条一个小 JSON。

扩展页面的“打开”是同一诉求的另外两条路，各归其位：**Claude 的侧栏对话视图**是 `view` 消息——PC 点 Claude 活动项、手机点 Claude 底部标签都走 `showView('ext-container:…')`，同步后另一端的容器上屏、其 webview 视图窗格挂出流式副本（§22.6）；**Git Graph 这类面板页**（`window.createWebviewPanel` 的编辑器标签）本来就有状态镜像，修正后的策略（见 §22.6 末条）让另一端的副本标签在前台打开，手机侧随激活自动翻到编辑器页（`activate()` 一向调 `revealEditorPage()`）。

**实测**（`scripts/probes/remote-sync-check.mjs`，2026-10-12）：dev harness 与 dev/remote-phone.html 作为同浏览器里的两个真实前端（`dev/dev-events.js` 用 BroadcastChannel 扮演 Relay），按钮矩阵 11 步全部双向对应——活动视图（Search / Explorer / Source Control / Extensions）、手机底部标签（Files / Changes）、两端文件树行、标签切换、标签关闭——整场同步 13 条消息共 1.2 KB（平均 96 B/条）；同会话用真实 `DomRecorder` 实测 DOM 副本方案需快照 208 KB + 变更批次 122 KB = 330 KB。操作同步是副本方案的 **1/272**，远低于所有者 1/10 的流量要求。


### 22.8 线上经济：副本流量降到 1/10（2026-10-13）

所有者的方向（"减少远程同步显示带来的流量消耗，要做到 1/10……动画是页面本身绘制的，就不需要同步，把核心重要的数据和操作做同步"）：副本是一张画片，不是渲染器——**中途状态不是信息，落定状态和核心内容才是**。四个杠杆（`recorder.ts`，均可经 `{ legacy: true }` 关闭作 A/B）：

| 杠杆 | 做法 | 谁受益 |
| ---- | ---- | ---- |
| 字符串增量 | `text` / `attr` / `val` / `css` / `adopted` 操作携带对"观看者持有的上一值"的编辑（`stringDelta`：公共前后缀裁剪，`新值 = base.slice(0,p) + v + base.slice(base.length-s)`；不划算或短于 48 字符则发全量）。录制器为每个文本节点 / 属性 / 控件值 / 样式表维护已发基线（快照与 add 序列化时一并播种）；观看者（`viewer.ts`）镜像同一基线——增量对不上基线即抛错触发 resnap，宁可重来不可悄然分叉 | Claude 流式回复（token 追加只过 token，不是整段话再发一遍）、CodeMirror 的 style-mod 规则表、commit 输入框长文本 |
| 动画采样 | 脚本逐帧重写的属性（observer 回调时计时：连续两次间隔 < 100 ms 记一次 rapid，rapid ≥ 2 即动画运行中）在运行期间按 ~1 Hz 采样（`ATTR_ANIM_MS = 1000`），动画停止后**落定值必定上线**（settle 定时器兜底）；属性改走又改回（同批净空）干脆不过线。页面的 CSS 关键帧动画本就不产生 DOM 变更，从来免费 | 进度条、JS 补间、拖拽预览这类逐帧 style 重写 |
| 风暴折叠 | 一批待发记录的**节点 churn**（childList 的 added+removed 之和——整窗 innerHTML 替换只是一条记录）≥ 24 即重渲染风暴：中途渲染扣留至多 `STORM_HOLD_MS = 600 ms`，一批落定——扣留期内加了又删的行从未序列化，天然消失 | git-graph-rs 的虚拟列表滚动（快速滚动整窗替换）、CodeMirror 大文件视口翻页 |
| 节奏分档 | 安静期第一批仍 50 ms 起发（`FLUSH_MS`）；**连续**背景流量（上一批非空）合批到 `STREAM_FLUSH_MS = 500 ms`——每消息的帧头 + 事件信封开销(~100 B)远大于一条增量的载荷，2 Hz 足够一张画片刷新。回放的输入仍每条立即冲刷（`host.ts` 在每条输入消息后 `flush()`），交互手感不降档 | 一切连续流（聊天流式、终端面板、页面自己的定时器刷新） |

配套：帧压缩阈值 1024 → **256**（`frame.ts` / daemon `ws/frame.rs` 同步改，两侧同一测试向量不受影响）——DOM JSON 小到 300 B 也能压 4–8 倍，镜像批次正是这种小帧。

**实测**（`tests/remoteTraffic.test.ts`，同一 recorder/viewer 对，legacy 开关 A/B，线上模型 = 每批一条 EVENT 帧、按各自时代的阈值 deflate + 帧头/信封开销）：

| 场景 | legacy | economy | 倍数 |
| ---- | ------ | ------- | ---- |
| Claude 式流式聊天（12 s / 360 token，段落增长） | 76.7 KB | 7.0 KB | **11.0×** |
| git-graph 式虚拟列表快速滚动（2 s / 40 次整窗替换） | 86.8 KB | 6.8 KB | **12.7×** |
| JS 逐帧动画（4 元素 5 s，transform 重写） | 63.9 KB | 2.2 KB | **28.8×** |
| 三者综合 | 82.8 KB | 4.2 KB | **19.6×** |

每个场景结束时副本与 PC 的 DOM 逐一相等——省的是线，不是内容。已知取舍：滚动风暴期间副本按 ≤600 ms 一拍落定（快速划过本来就看不清中间帧）；动画运行中 ~1 Hz 采样、停止即落定；连续流式 2 Hz 成段出现；单次属性翻转与交互路径（输入、点击回放的落点重排）不节流、不降档。

## 23. 安全沙箱：远程会话只驱动被操作系统隔离的窗口

2026-10-12（所有者的方向："remote 增加权限设置，增加安全沙箱功能，ggs 运行在沙箱里面，不能获取 ~/.ggs 的内容，所有文件在沙箱里，claude 只能访问沙箱里的文件内容，沙箱可以设置访问内网权限，访问外网权限……不要自己实现沙箱，要使用开源跨平台的沙箱方案"）。沙箱**不自研**：执行引擎是微软的开源 [mxc](https://github.com/microsoft/mxc)（Microsoft eXecution Container，MIT，GitHub Copilot 本地沙箱的 GA 引擎；Rust crate `mxc-sdk` 直接连进 daemon）——策略驱动的操作系统原生进程隔离（Windows ProcessContainer / Linux bubblewrap / macOS Seatbelt），作用于被包裹进程**及其整棵子树**。选型时对比过 Anthropic 的 sandbox-runtime（srt）：npm-only、Windows 需一次性管理员安装且以另一个用户运行、Linux 上网络命名空间整体移除 + AF_UNIX 默认封锁——无法包裹一个 GUI 工作台；mxc 在三平台上都无需每次提权。

### 23.1 策略模型（daemon 只出策略，不自己强制）

| 面 | 做法 |
| ---- | ---- |
| 文件系统 | deny-by-default。沙箱根（默认 `~/.ggs/remote/sandbox`，可配）是实例的全部世界：根内读写；真实 `~/.ggs`（设置、AI 供应商密钥、Claude 状态、扩展库）与主目录其余部分、磁盘其余位置**不可读**。除程序自身安装目录（只读执行）外不授任何系统目录——Windows 的系统目录与 Program Files 自带 ALL APPLICATION PACKAGES 读 ACE，AppContainer 令牌直接读得到（mxc 自己的授权过滤会跳过它们；显式授予反而要求用户没有的 write-DACL，实测 2026-10-12） |
| 网络 | 三档单选：`off`（默认拒绝，什么都不通）/ `intranet`（私网段：10/8、172.16/12、192.168/16、100.64/10、169.254/16、127/8）/ `internet`（全通）。沙箱自身的回环在每档都通——智能体的本地服务器不受影响（实测：断网档下 bind+connect 127.0.0.1 正常）。macOS 的 Seatbelt 只有开关没有 CIDR，Windows 的 AppContainer 层拒绝 CIDR 规则（mxc 会以 `policy_validation` 拒绝它无法忠实执行的策略）——这两类主机上 `intranet` 降级为 `off`，状态 JSON 里 `degraded: true`，页面如实标注 |
| 状态重定位 | 实例的 `GGS_HOME` 指向 `<root>/home`：设置、扩展、供应商密钥、Claude 状态从空白开始，全部落在沙箱里；`HOME`/`USERPROFILE`/`TEMP`/`TMP`、`WEBVIEW2_USER_DATA_FOLDER`、`XDG_*` 一并重定位。控制通道走专用沙箱端点（env `GGS_REMOTE_CONTROL`） |
| UI | `ui.disable: false`——工作台要建窗口画 webview；剪贴板与输入注入保持默认拒绝 |

### 23.2 控制通道：第二条端点 + 一次性令牌

沙箱实例的令牌（Windows AppContainer）打不开默认 DACL 的主控制管道（实测 os error 5）。做法：

- 主端点一切不变（桌面实例照旧，无令牌）。
- 新增**沙箱端点**（`daemon/src/sandbox.rs::control_endpoint`：Windows 是名字带 `ggsr1-sbx-` 前缀的第二个管道，经 GGS 补丁的 `../vendor/interprocess` 以 SDDL `D:P(A;;GA;;;S-1-15-2-1)(A;;GA;;;OW)` 创建——ALL APPLICATION PACKAGES 可连、属主全权、其他人一概不行；Unix 是 `<root>/sandbox-sock/control.sock`，目录 0700、策略单独授予 rw）。daemon 每次 spawn 生成 32 字节一次性令牌（env `GGS_REMOTE_CONTROL_TOKEN`），Register 带上、daemon 验后即焚——端点 DACL 放宽了，注册仍只有 daemon 自己发出去的实例能完成（实测：无令牌被拒、有效令牌得 Welcome、重放被拒）。
- `Register` 增 `sandboxed` / `controlToken` 两字段（serde default，向前兼容；两侧向量 `tests/vectors/control.json` 已同步）。app 侧 `remote_host.rs` 优先读 env `GGS_REMOTE_CONTROL`（重定位后的 `GGS_HOME` 推导不出真端点，daemon 显式下发）。

### 23.3 权限面（谁能看到什么）

- 沙箱开启时，WINDOWS 只列 `sandboxed` 实例，recent 只留沙箱根内的路径；直接 ATTACH 桌面实例按 INSTANCE_GONE 回（拿到密码的人不能绕过沙箱去连主窗口）。SPAWN 的目录必须在沙箱根内，空则默认 `<root>/workspace`。
- **只有远程会话触发的 SPAWN 走沙箱**：托盘与管理 API 代表 PC 跟前的用户，开的是全信任窗口（沙箱开启时它们不出现在远程列表里）。重启沙箱实例仍走沙箱。
- 配置（`config.json` 的 `sandbox` 段，页面与 `PUT /admin/config` 同一通道）：`enabled`、`network`、`root`。状态 JSON 带 `sandbox` 段：所配、所能（`supported`/`backend`/`tier`/`intranetSupported`/`degraded`）。默认关闭——关着时一切与从前一致。
- 窗口页（picker）：沙箱开启时路径输入框隐藏（根外的路径本来就打不开），新增"打开沙箱窗口"按钮（空沙箱的唯一入口）；沙箱窗口带"沙箱中"徽标。Remote 页新增"安全沙箱"区块：开关、网络三档（此电脑不支持的档位禁用并标注）、根目录设置、后端/层级与如实说明。

### 23.4 实现位置

- `daemon/src/sandbox.rs`：支持探测（`platform_support`/`available_backends`/intranet 可达性）、`plan`（root + 有效网络档，含降级）、目录校验（lenient canonicalize 前缀）、`launch`（argv → mxc 引用规则序列化（`mxc_common::cmdline`，Windows CreateProcess / POSIX shell 各按其规）、env 重定位、fs/net/ui 策略、`v1::spawn` + 后台收割）、令牌发放/核销、沙箱端点绑定与 serve、状态 JSON。
- `lifecycle.rs::spawn/restart` 路由（`via_remote`）；`control.rs::serve_instance` 带 `sandbox_channel`；`registry`/`ws::msg` 的 `sandboxed` 贯通；`server.rs` 开机按配置起沙箱端点；`http/api.rs` 会话 extras 带沙箱事实给 picker。
- macOS 的 `open -n <bundle> --args` 启动形态在沙箱内换成 bundle 自身的可执行文件（`resolve_program`）——`open` 会把启动递回沙箱外。
- 依赖与补丁：daemon 直接依赖 `mxc-sdk = "1.0"`；`[patch.crates-io] interprocess = { path = "../vendor/interprocess" }`（Boa 的 vendoring 先例：仅新增 `ListenerOptions::security_descriptor_sddl` 一个方法，其余不动；另删了一行本地工具链不认识的 lint 名）。

### 23.5 实测（本机 Windows 11，AppContainer 层）

- 默认拒绝读沙箱外文件 ✓；断网档 ✓；`egress.default=Allow` 即 internet 档 ✓；AppContainer 层拒绝 CIDR 规则（`policy_validation`）✓；沙箱内 bind+connect 自身回环 ✓；带 AAP ACE 的管道可连可交换字节 ✓（默认 DACL 拒绝 ✓）；`sandbox::launch` 端到端 ✓（`cargo test --test integration sandbox_launch -- --ignored`，CI 中忽略——需要宿主沙箱）。
- **如实残余**（页面上同样写着）：环境变量被继承（隔离的是文件与网络，不是环境）；构建工具（npm、cargo…）按所选网络档联网；沙箱窗口的设置/扩展/AI 供应商从空白开始，须在沙箱内配置；非内核强制的文档说明——OS 沙箱由 mxc 的各平台后端执行，Windows 的 AppContainer 层是其"降级层"（PSEC/BaseContainer 层的机器获得同策略的更强执行）。


### 23.6 安全审计（2026-10-13）与修复

三个方向的定向审计（daemon 攻击面 / 公网 Hub / app 侧与网页）后的修复，全部有测试：

**app 侧（远程会话的文件边界）**
- **Relay invoke 门禁**（`src/remote/pathGate.ts` + `relay.ts`）：远程会话的路径类 invoke（读写、搜索、比较、viewer、file_log/repo 等）只能落在**打开的文件夹**（+ 单文件启动）内；`open_folder`/`open_workspace` 直接拒绝（打开新目录是 picker 的沙箱 SPAWN 的事）。roots 经新命令 `remote_paths_policy` 由 Relay 本地取（带 3 s 缓存，仅门禁命令才取）。修复的攻击链：伪造 workbenchSync `open` + 未设防的 `read_file` → 读取 `~/.ggs/keys/ai-providers.key` 与密封的 API key → 离线解密全部供应商密钥。
  唯一的例外是 `ext_fs`：它还可以落在扩展平台自己的三块区域（`remote_ext_roots`：已装包的文件 `~/.ggs/extensions`、扩展存储 `~/.ggs/extension-data`、扩展日志 `~/.ggs/logs/extensions`）——与后端 `ext_fs` 契约放行的 roots 一致（扩展宿主本就把它们作为调用的 roots 传入）；扩展激活时读自己安装目录里的文件（Python 复制 `pythonrc.py` 是第一例）是正常流量而非越界，此前这类激活在浏览器会话里全部失败。`~/.ggs` 的其余部分（设置、密钥、Claude 状态）仍在边界之外，且该例外只扩 `ext_fs` 一个命令。
- **规范形复检**（2026-10-15，§23.4 词法门禁的符号链接缺口）：上面的比较全是词法的，而读写本身跟随符号链接与 junction——仓库里一个指向 `~/.ggs`（provider 密钥库、设置）的链接能通过词法检查，读取却落在界外。修复：每个被门禁的 invoke 在词法通过后做第二道规范形复检（`gateInvokeCanonical`）——参数**连同策略 roots** 一起经新命令 `remote_canonical_paths` 解析（`ggs-fs` 的 `canonical_display`：`fs::canonicalize` 的规范形剥掉 Windows `\\?\` 前缀；lenient 行走，未创建文件的符号链接**祖先**同样解析到真实目标），包含关系按规范形对规范形比较（经 junction 打开的工作区仍包含其成员的规范形）。命令的答案只发给边界自身区域内的路径（打开的文件夹、单文件启动、扩展三区域）——它永远不是全盘的存在性探测器；规范化失败即拒绝（fail-closed）。`null` 形（边界外的探测、完全不可解析）保留词法答案。PC 端 workbenchSync 接收侧的远程 open 也经同一命令复检（`installWorkbenchSync` 的 `canonicalPath`）；上传（`upload_allowed`）与下载（`download_allowed`）两条路原本就在服务端规范化，不变。
- **事件桥白名单与身份盖章**：`relayEmit` 只放行 `studio://mirror-up` 与 `studio://workbench-sync`，`from`/`by` 一律盖成 relay 的 `remote/<session>`（会话不能冒充 `main` 或彼此），目标恒为 `main`。
- **workbenchSync 接收侧**：远端来源的 `open`/`active` 限在打开文件夹内（`Workbench.openFolders()` ← `Explorer.roots()`）。
- **镜像副本的外域 URL 丢弃**（`protocol.ts`）：副本只加载 app/ggs 令牌根与 `data:`/`blob:`——PC 页面里的外来 http(s) URL 不再是手机端的外泄/追踪通道。

**daemon**
- 沙箱边界覆盖 `INSTANCE_CLOSE`/`INSTANCE_RESTART`（此前只有 ATTACH 有守卫——远程可强杀/重启桌面窗口）。
- Argon2 验证并发信号量（2×核数）：并发的垃圾登录不再能把内存打到 ~4 GB。
- `/sw.js` 会话门禁：未认证的 LAN 对端不能再让 daemon 为它缓冲+压缩实例资产。
- 资产缓存键带实例 id（同版本重装的实例不再共享/污染条目）。
- `client_ip`：XFF 取**最右**一跳（可信代理追加的那个），经隧道来的登录全部落一个"tunnel"桶——恶意 Hub 不能再铸造每请求一个的限流桶。
- 沙箱 spawn 令牌 5 分钟过期；容器名不再嵌 daemon HMAC 密钥切片。
- Register/Update 字段上限（title/version/folders/launch/summary）；设备名剥控制字符（日志伪造）；`hub.settings`（含 joinKey）挪到解锁之后（无密码状态除外——配对页需要预填）。

**Hub（公网面）**
- **跨 PC 资产缓存投毒修复**：缓存键带上链接 id——任何持键者的 daemon 不再把同源脚本喂给其他 PC 的浏览器（此前的跨 PC 去重是整条链里唯一能伤到别人的写放大）。
- **每 IP 控制在两种前置拓扑下的修复**：XFF 右取 + 新配置 `trusted_proxies`（CIDR 列表，docker-compose 里 Caddy 在独立容器、对端是网桥地址的场景）；`/tunnel` 握手限流同样代理感知（此前整个机队+攻击者共享一个桶，可饿死真实 PC）。
- 空 `join_key` + 公网监听 → 启动时大声告警。
- 监听层：HTTP/1 头读取 30 s 超时（slowloris）+ 1024 并发请求工作上限；代理体 30 s 空闲间隔超时（此前头部超时后涓流体能永久占住 8 个会话槽之一）。
- PC 侧响应头清洗：丢弃其 `content-length`/`content-encoding`，重复头首个胜出。

### 23.7 信任模型声明（如实）

**Hub 是全信任组件。** e2e.rs 的端到端加密设计（登录密码经 secretbox、帧加密）**未接线**——通过 Hub 的全部流量（含登录密码与会话 cookie）对 Hub 明文可见，恶意/被入侵的 Hub 可以以手机身份发任意已认证请求。Ed25519/uuid 身份只防"密钥替换"，不防上述任何一条。在 e2e 接线之前，部署 Hub 即等于信任 Hub 的运营者；文档与页面按此陈述。LAN 直连不经 Hub，不受影响。终端（PTY）与镜像模式本身是"密码持有者可做本机用户可做之事"的产品语义——对它的强化边界就是 §23 的 OS 沙箱。
