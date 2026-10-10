# Claude Remote 2.0 计划：官方 Remote Control 接入 + 自建中继服务器

状态：已实施（P1–P6，2026-10-11）· 基于 `Anthropic.claude-code-2.1.296` 的逆向分析 —— 每个新版 claude-code 用 `scripts/probes/claude-rc-surface.mjs` 复查 §1.3/§1.4；实机项（P0 的官方手机端 prompt 是否出现在 io_message、P5/P5b 的 claude.ai 账号与真机验证）按 §8 待做
范围：重写 `extensions-src/claude-remote/`（插件），新建 `claude-remote-server/`（Rust 独立中继服务器），
以及 Git Graph Studio 宿主侧的少量配套能力（模块 12）。

---

## 0. 结论先行

1. **自建服务器无法直接"转发" CLI 内部 `/remote-control` 的流量。** 2.1.296 把 CLI 的所有远程传输都钉死在
   Anthropic 的端点上（证据见 §1.3）：bridge 的 base URL 来自 OAuth 配置（`api.anthropic.com`），
   覆盖变量 `CLAUDE_BRIDGE_BASE_URL` / `CLAUDE_BRIDGE_OAUTH_TOKEN` 在公开构建里被编译成空函数，
   `CLAUDE_CODE_CUSTOM_OAUTH_URL` 只接受白名单（FedStart），`--sdk-url` / `CLAUDE_CODE_REMOTE_SDK_URL`
   只接受白名单主机且必须 `wss/https`；Channels（MCP 推送）在第三方模型上被禁用。
   改二进制或 TLS 中间人都不可取（每个版本都会失效、破坏签名、违反条款），本计划不采用。
2. **兼容性最高的可行做法**：自建模式不去冒充 Anthropic 的 bridge，而是接入 **与 bridge 转发的完全相同的
   SDK 消息流**（stream-json 的 `SDKMessage` + `control_request/response`）：
   - 在 Git Graph Studio 中：宿主已经中继 Claude Code 扩展 ↔ 其 webview 的全部消息
     （`io_message` 携带 CLI 原样的 SDK 消息、`tool_permission_request`、`channelRemoteControlState`），
     在这里加一个"只读旁路 + 受控驱动"服务即可做到同进程、同会话、实时、带权限卡片。
   - 在 VS Code / 无标签页时：插件自己当 SDK 宿主（`--input-format stream-json --output-format stream-json
     --permission-prompt-tool stdio --resume <id>`），这正是扩展本身和 CLI 对话所用的协议。
   - 手机端渲染的是 **原始 SDK 消息**，与 claude.ai/code 的 RC 会话语义一致；新版本新增的消息类型可优雅降级。
3. **官方 RC 模式**：通过扩展自身的 webview 协议请求 `toggle_remote_control`（与点击面板上的 RC 胶囊完全等价），
   读取 `channelRemoteControlState.connectUrl` 生成二维码。只有 claude.ai 订阅登录 + 第一方模型时可用；
   第三方模型强制使用自建服务器。
4. **官方 RC 镜像（不影响官方开关）**：官方 RC 开着时，插件把同一会话的 RC 通信内容只读旁路一份，
   端到端加密后发往自建服务器（§2.2）。插件从不发送 `toggle_remote_control`、不写 CLI 的 stdin、不改
   `remoteControlAtStartup`，只观察状态。镜像的是 bridge 实际承载的 SDK 消息（已核实：bridge 出站是
   `worker/events` 的 `{payload: SDKMessage}`，入站是 user 消息、`control_request`、`control_response`、
   `control_cancel_request`），不是 bridge 的 HTTPS 原始字节——OAuth token、work secret、environment id 永不经过插件。
5. **服务器按 PC 划分**：一台 PC = 一个用户 ID + 一个二维码，该 PC 上所有窗口共享；服务器多用户；
   重置密钥使所有已配对手机失效，需要重新扫码或使用新链接；可选额外登录密码；内容端到端加密，服务器只做路由。

---

## 1. claude-code 2.1.296 Remote Control 分析

### 1.1 三层结构

```text
 webview (index.js)  ──postMessage──>  extension.js  ──stdio stream-json──>  claude.exe (Bun 打包)
   RC 胶囊 / 状态             toggleRemoteControl(channelId)        control_request{subtype:"remote_control"}
                                                                     └─ bridge ─HTTPS/WS─> api.anthropic.com
                                                                                         └─ claude.ai/code / Claude App
```

| 层 | 关键点 | 位置（2.1.296） |
| --- | --- | --- |
| webview → 扩展 | `{type:"request", channelId, request:{type:"toggle_remote_control", enable}}` | `webview/index.js` |
| 扩展状态推送 | `request.state.channelRemoteControlState = {status: connecting\|connected\|disconnected\|error, sessionUrl, connectUrl, bridgeEpoch, error}`，以及 `channelRemoteControlAvailable` | `extension.js` `toggleRemoteControl` / `pushChannelStateUpdate` |
| 扩展 → CLI | `control_request {subtype:"remote_control", enabled, name?, reattach_session_id?, keep_session_on_exit?, work_secret?}`，响应 `{session_url, connect_url, bridge_epoch, bridge_session_id}` | `extension.js` `enableRemoteControl` |
| 启动即开 | Claude 设置 `remoteControlAtStartup`（"Remote Control for all sessions"），扩展另有 `remote_control_auto_enable / auto_on_by_default` 配置 | `claude-code-settings.schema.json` |
| CLI bridge | `POST /v1/environments/bridge` 注册环境 → `GET /v1/environments/{id}/work/poll` → `ack / heartbeat / stop`；会话走 `/v1/sessions/*` 与 `/v1/code/sessions/{id}/worker/*`（v2：SSE 读 + POST 写） | `claude.exe` 内嵌 chunk `[bridge:api]` |

### 1.2 官方 RC 的可用条件（CLI 自己判定）

`iV()`：第一方 API（非第三方 base URL）且 claude.ai OAuth；`Cst()`：再加 rollout 门 `tengu_ccr_bridge`
或订阅类型 ∈ `pro / max / team / enterprise`；策略 `disableRemoteControl: true` 可关闭。
不可用原因：`not_signed_in / api_key_auth / no_profile_scope / not_in_rollout`。
**结论**：Git Graph Studio 的 AI Provider 桥一旦切到 DeepSeek / GLM / Kimi / 自定义网关，官方 RC 必然不可用；
插件应读取 CLI 自己给出的 `channelRemoteControlAvailable`，而不是自己猜。

### 1.3 为什么不能把 CLI 的 RC 指向自建服务器（逐项证据）

| 尝试 | 2.1.296 的实际行为 |
| --- | --- |
| `CLAUDE_BRIDGE_BASE_URL` / `CLAUDE_BRIDGE_OAUTH_TOKEN` | `function zce(){return}` / `function jN(){return}` —— 内部构建专用，公开构建被剪掉；`BD(){return zce()??dn().BASE_API_URL}` |
| `CLAUDE_CODE_CUSTOM_OAUTH_URL` | `dn()` 中 `if(!aBe.includes(e)) throw "not an approved endpoint"`，白名单只有 FedStart |
| `--sdk-url` / `CLAUDE_CODE_REMOTE_SDK_URL` | `hdt()`：主机不在白名单 → `not_allowlisted`；白名单主机也只接受 `wss:`/`https:` |
| settings.json 的 `env` 注入 | 上述变量全部在设置 env 的剔除集合里，只能来自进程环境（而进程环境也被上面几条拦死） |
| Channels（`claude/channel` + `claude/channel/permission`） | "channels are not available on third-party providers"；还受 `channelsEnabled` 组织策略约束 |

> 这些标记应在每个新版本上自动复查（§8 的 `claude-rc-surface` 探针）。若未来某版本开放了 bridge base URL，
> 可追加"方案 B：Rust 服务器实现 environments/work API"，届时 CLI 原生 RC 可直接接入自建服务器。

### 1.4 自建模式要接入的那条流

扩展把 CLI 的每条 stdout SDK 消息原样转给 webview：`{type:"io_message", channelId, message, done}`；
权限询问为 `{type:"tool_permission_request", toolName, inputs, suggestions, …}`（带 requestId 的请求）；
webview 发回 `io_message`（用户输入）、`interrupt_claude`、`request{set_model | set_permission_mode | toggle_remote_control}`。
Git Graph Studio 的 `extHost.ts` 已在中继这两个方向（`webview.postMessage` / `__ggsWebview` 消息），
并已通过 `update_session_state` 维护 panel ↔ sessionId 映射（`webviewSessions`）。

---

## 2. 总体架构

```text
┌──────────── PC（一个用户 ID / 一个二维码）────────────┐
│ 窗口 1 (GGS)          窗口 2 (GGS)        窗口 3 (VS Code) │
│ claude-remote 插件    claude-remote 插件   claude-remote 插件│
│  ├ 源: 宿主旁路(tap)   ├ 源: 宿主旁路       ├ 源: 自建 SDK 宿主 │
│  └ 中继客户端 ─┐       └ 中继客户端 ─┐      └ 中继客户端 ─┐    │
└────────────────┼─────────────────────┼─────────────────────┼───┘
                 │   E2E 密文帧（服务器不可读）               │
           ┌─────▼──────────────────────────────────────────▼─────┐
           │  claude-remote-server (Rust)：多用户、按 PC 分组、路由 │
           │  注册 / 配对 / 重置 / 密码 / 设备 / 在线状态 / 限流      │
           └─────▲──────────────────────────────────────────────────┘
                 │ WSS
           手机浏览器 PWA（服务器托管）：PC → 窗口 → 会话 → 对话

官方模式（claude.ai 登录 + 第一方模型）：插件请求 toggle_remote_control → 显示 connectUrl 二维码
                                         → 手机用 Claude App / claude.ai 控制（流量不经过自建服务器）
```

### 2.1 模式选择（设置 `claudeRemote.mode`）

| 值 | 行为 |
| --- | --- |
| `auto`（默认） | CLI 报告 `remoteControlAvailable !== false` → 官方 RC；否则 → 自建服务器（已配置时） |
| `official` | 只用官方 RC；不可用时面板显示 CLI 给出的原因，并提示切换 |
| `selfHosted` | 只用自建服务器（官方模型也可以选它） |

第三方模型时官方选项置灰并注明"第三方模型只能使用自建服务器"。两种模式可以并存于不同会话：
官方 RC 走 CLI 自己的 bridge，自建模式只读旁路 + 驱动 UI，互不干扰。

### 2.2 官方 RC 镜像（`claudeRemote.mirrorOfficial`）

与 §2.1 的模式正交：官方 RC 照常工作，镜像额外把内容送到自建服务器。

```text
claude.exe ──bridge(HTTPS)──> api.anthropic.com ──> Claude App / claude.ai     （官方路径，完全不动）
    │ stdout SDK 消息（与 bridge 承载的内容相同）
    ▼
extension.js ──io_message / tool_permission_request / channelRemoteControlState──> webview
                         │ GGS 宿主中继处只读旁路（ggs.claudeTap，§6）
                         ▼
               claude-remote 插件 ──E2E 密文──> claude-remote-server ──> 自建手机端
```

| 设置值 | 行为 |
| --- | --- |
| `off` | 不镜像 |
| `whenConnected`（默认） | 某会话的 `channelRemoteControlState.status` 变为 `connected` 时开始镜像，`disconnected`/`error` 时停止 |
| `always` | 不论官方 RC 是否打开都镜像（等同于自建模式的只读观看） |

**不影响官方开关的硬性规则**（代码与测试都要守住）：

1. 镜像路径只读：不合成任何 webview → 扩展的请求（尤其是 `toggle_remote_control`），不写 CLI stdin，
   不改 Claude 设置文件；官方 RC 的开/关、重连、`bridgeEpoch` 变化只被观察。
2. 旁路在宿主中继里同步复制、异步发送：复制后立即把原消息照常交给 webview；插件或服务器慢、断线、崩溃都不能
   延迟或丢弃原消息（有界缓冲，满了丢镜像侧并标记 `gap`，由 JSONL 回填补齐）。
3. 镜像侧的控制默认关闭（`claudeRemote.mirrorControl: false`）。打开后，自建手机端的指令只走桌面标签页 UI
   （与本地用户亲手操作等价），官方 RC 客户端看到的就是"本机用户"的输入；权限请求先答者生效，CLI 会向另一端
   发 `control_cancel_request`，两端都正确收尾。
4. 清洗：只转发 SDK 消息、权限请求/取消、RC 状态中的 `status / sessionUrl / bridgeEpoch`；`connectUrl`
   （可直接接入官方会话的链接）默认不转发（`claudeRemote.mirrorConnectUrl: false`）。

**内容来源与补齐**：实时内容取自旁路的 `io_message`；会话 JSONL（`sessions.js` 的增量尾读）做断点补齐和去重
（按消息 `uuid`）。官方手机端发来的 prompt 是否会出现在扩展的 SDK 流里，静态分析不能确定（P0 实测项）；
无论是否出现，CLI 都会写入 JSONL，镜像都能拿到，最坏只是延迟一个轮询周期。

**VS Code**：没有宿主中继可旁路，也读不到官方 RC 状态（webview 的 `remoteControlTranscriptSaysActive`
看的是它自己插入的合成消息，不在 JSONL 里），所以只支持 `always`，内容来自 JSONL 增量尾读（无流式增量、无挂起的权限卡）。

**否决方案：本地 HTTPS 中间人代理**（`HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` 截取 bridge 原始流量）：
要让整个 CLI 信任本地 CA，会接触 OAuth token 与 work secret，每次传输层改动都会失效，而得到的内容与旁路的 SDK
消息相同。不采用。

---

## 3. Rust 中继服务器 `claude-remote-server`

### 3.1 工程位置与技术栈

- 新的独立 Cargo 工程 `claude-remote-server/`（不加入 `src-tauri` crate，应用二进制永不链接它）；
  `.cargo/config.toml` 的 `target-dir` 指向 `../target/studio/claude-remote-server`（生成物不进源码树）。
- 纯 Rust 依赖：`tokio`、`axum`（含 ws）、`tower-http`（静态资源、压缩、body 限制）、`serde/serde_json`、
  `redb`（嵌入式存储）、`argon2`、`sha2`/`hmac`/`hkdf`、`rand`、`base64`、`rust-embed`（内嵌手机端）、
  `tracing`、`clap`、`toml`。TLS 推荐放在反向代理（Caddy/nginx）后；可选 feature `tls`（rustls）直出。
- 产物：单一静态二进制（Linux musl x64/arm64、Windows、macOS）+ Docker 镜像 + systemd 单元示例。

### 3.2 数据模型

| 实体 | 字段 | 说明 |
| --- | --- | --- |
| User（= 一台 PC） | `user_id`(`u_` + 26 位 base32)、`agent_secret_hash`、`pair_epoch`、`pair_verifier`、`password_hash?`、`disabled`、`created/last_seen` | 一台 PC 一个用户 ID，所有窗口共用 |
| Device（手机） | `device_id`、`user_id`、`token_hash`、`epoch`、`name`、`created/last_seen` | `epoch` 落后于用户的 `pair_epoch` 即失效 |
| Window（内存态） | `window_id`、`user_id`、连接句柄、`meta_ct`（加密的工作区名等） | 在线状态，不落盘 |
| Invite（可选） | 注册令牌 | `registration = "token"` 时需要 |

服务器 **不存储任何会话内容**；内容全部是端到端密文帧。

### 3.3 密钥与配对

- PC 首次注册时生成 32 字节配对密钥 `K`；HKDF-SHA256 派生：
  `k_auth = HKDF(K, "crr1/auth")`（配对证明）、`k_e2e = HKDF(K, "crr1/e2e")`（内容加密）。
- 服务器只保存 `pair_verifier = SHA-256(k_auth)` 和 `pair_epoch`，拿不到 `K`/`k_e2e`。
- 二维码 / 链接：`https://<server>/c/<user_id>#<base64url(K)>.<epoch>` —— 密钥在 URL fragment 中，
  浏览器不会发给服务器。
- 手机配对：`POST /api/v1/pair/challenge {user_id}` → `{nonce, epoch, password_required}`；
  `POST /api/v1/pair {user_id, epoch, proof = HMAC(k_auth, nonce‖user_id‖epoch), password?, device_name}`
  → `{device_id, device_token}`。nonce 一次性、60 秒过期。
- **额外登录密码**（可选）：PC 端命令设置，经 TLS 发给服务器，服务器以 Argon2id 存储；设置后配对与每次
  设备登录都要求密码。密码不参与 E2E 密钥（服务器侧门禁），失败按用户 + IP 指数退避锁定。
- **重置密钥**：PC 生成新 `K'` → `PUT /api/v1/me/pairing {verifier', expect_epoch}` → `pair_epoch += 1`，
  该用户所有设备 token 作废，在线手机收到 `4401 rekeyed` 后断开；该 PC 其他在线窗口收到 `epoch_changed`，
  从共享身份存储重新加载 `K'`。旧链接/旧二维码立即失效，必须重新扫码或打开新链接。

### 3.4 接口

| 方 | 接口 | 用途 |
| --- | --- | --- |
| PC | `POST /api/v1/register {registration_token?}` | 返回 `user_id + agent_secret` |
| PC（Bearer agent_secret） | `PUT /me/pairing`、`PUT/DELETE /me/password`、`GET /me/devices`、`DELETE /me/devices/{id}`、`POST /me/rotate-agent-secret`、`DELETE /me` | 重置、密码、设备管理、注销 |
| PC | `GET /ws/agent`（WebSocket）或 `GET /api/v1/agent/poll` + `POST /api/v1/agent/send`（长轮询回退） | 窗口在线与帧收发 |
| 手机 | `GET /c/{user_id}` | 托管手机端页面 |
| 手机 | `POST /pair/challenge`、`POST /pair`、`POST /login`（密码时） | 配对与登录 |
| 手机 | `GET /ws/device` | 在线窗口列表 + 帧收发 |
| 运维 | `/healthz`；CLI：`serve`、`user list/disable/delete`、`invite create`、`gc` | |

长轮询回退是必要的：ggs-node 目前没有 `tls.connect`、没有 WebSocket 客户端（只有 HTTP(S) `fetch` 和服务端 upgrade），
所以 GGS 中的插件第一版走 HTTPS 长轮询；VS Code（真 Node）走 WebSocket。

### 3.5 路由帧

外层（服务器可见）：`{v:1, kind:"frame", from, to: window_id | device_id | "*", seq, ct}`；
内层 `ct = AES-256-GCM(k_e2e, nonce96, plaintext, AAD = "crr1|user_id|epoch|from|to|seq")`。
服务器只校验：发送方属于该用户、目标属于该用户、帧大小（默认 1 MiB）、速率。
每连接有界队列（默认 256 帧 / 4 MiB）；手机侧溢出直接断开，由客户端带游标重同步（内容可由 PC 端重放），
保证服务器内存有界。用户之间严格隔离（测试覆盖：A 的设备无法寻址 B 的窗口）。

### 3.6 配置 `claude-remote-server.toml`

```toml
listen = "0.0.0.0:8787"
public_url = "https://remote.example.com"
data_dir = "/var/lib/claude-remote"
registration = "token"          # open | token | closed
[limits]
max_users = 1000
max_windows_per_user = 16
max_devices_per_user = 10
frame_bytes = 1048576
[tls]                            # 可选，否则交给反向代理
cert = "/etc/ssl/remote.pem"
key = "/etc/ssl/remote.key"
```

---

## 4. 插件 `claude-remote` 2.0 重写

### 4.1 文件划分

| 文件 | 职责 |
| --- | --- |
| `extension.js` | 激活、模式编排（auto/official/selfHosted）、命令注册 |
| `identity.js` | PC 身份（`user_id`、`agent_secret`、`K`、`epoch`）：存 `context.secrets`（所有窗口共享），首次创建用 globalStorage 下的 `identity.lock`（O_EXCL + 过期回收）防多窗口竞争；重置、密码、设备撤销 |
| `crypto.js` | HKDF / HMAC-SHA256 / AES-256-GCM；真 Node 用 `node:crypto`；ggs-node 用其原生 AES-GCM，HMAC/HKDF 先用 JS（基于 `createHash`）实现，再补原生（§6） |
| `relay.js` | 服务器客户端：WS 优先、长轮询回退、指数退避重连、`epoch_changed` 重载、窗口元数据加密上报 |
| `sources/tap.js` | GGS 宿主旁路源：订阅 `ggs.claudeTap.*` 事件 → 统一事件流 |
| `sources/sdkHost.js` | 自建 SDK 宿主源：自己起 CLI（stream-json + `--permission-prompt-tool stdio` + `--include-partial-messages` + `--resume`），`can_use_tool` 转手机权限卡；沿用 `nodeExecutable` 逻辑；第三方 provider 环境原样继承 |
| `sessions.js` | 保留：会话列表、尾部优先的 JSONL 历史回填、分页（已有实现） |
| `official.js` | 官方 RC：`ggs.claudeChat.remoteControl` 开关、状态订阅、`remoteControlAtStartup` 全会话开关；VS Code 下给出指引 |
| `mirror.js` | 官方 RC 镜像（§2.2）：按 `channelRemoteControlState` 启停每会话镜像，清洗、`uuid` 去重、`gap` 后 JSONL 回填；绝不调用 `official.js` 的写操作 |
| `control.js` | 手机指令 → 动作：GGS 走 `ggs.claudeChat.*` 驱动标签页；无标签页 / VS Code 走 `sdkHost` |
| `panel.js` | 面板：模式切换、服务器地址与连接状态、二维码 + 复制链接、重置密钥、设置/清除登录密码、设备列表与撤销、本 PC 在线窗口、官方 RC 每会话开关及其二维码 |
| `desktop.js` | 保留：headless 回合结束后刷新桌面标签页 |
| 删除 | `server.js`（局域网服务器）、`sjcl.js`、`web/`（手机端迁往服务器工程） |

### 4.2 统一事件流（两个源输出同一形状）

```text
{ kind: "sdk",        session_id, msg }                  // CLI 原样 SDK 消息（含 stream_event）
{ kind: "permission", session_id, request_id, tool, input, suggestions }
{ kind: "state",      session_id, busy, model, permission_mode, rc: {status, connectUrl?} }
{ kind: "sessions",   list }                             // 本窗口工作区的会话
```

### 4.3 手机 ↔ 窗口内层协议（E2E 内）

| 手机请求 | 动作 |
| --- | --- |
| `sessions.list` / `session.subscribe {id, since}` | 历史回填（`sessions.js`）+ 实时事件流；`stream_event` 增量在 PC 端 50 ms 合并 |
| `prompt.send {id, text, mode: now\|queue, model?}` | GGS：`ggs.claudeChat.send`（现有）；VS Code：`sdkHost` |
| `turn.interrupt` | `ggs.claudeChat.stop` / SDK `interrupt` |
| `permission.answer {request_id, allow\|allowAlways\|deny, message?}` | GGS：新增 `ggs.claudeChat.permission`（点击标签页里的权限卡）；SDK：`control_response` |
| `question.answer` | `ggs.claudeChat.answer`（现有 AskUserQuestion） |
| `mode.set` / `model.set` | 新增 `ggs.claudeChat.mode`；`pickChatModel`（现有） |
| `session.new {cwd}` | 打开新会话标签页 / 新 SDK 进程 |

控制一律走"扩展自己的 UI 路径"（DOM 驱动），保证桌面标签页的状态与手机一致；只有 RC 开关走协议级合成请求，
因为扩展会把状态推回 webview，胶囊会同步更新。

### 4.4 设置与命令

设置：`claudeRemote.mode`、`claudeRemote.mirrorOfficial`、`claudeRemote.mirrorControl`、
`claudeRemote.mirrorConnectUrl`、`claudeRemote.serverUrl`、`claudeRemote.autoConnect`、`claudeRemote.official.allSessions`、
`claudeRemote.backend`（desktop/headless，保留）、`claudeRemote.desktopTab`（保留）。注册令牌在首次注册后存入 secrets。
登录密码 **不** 存本地，也不是设置项。
命令：`reveal`、`connect`、`disconnect`、`resetKey`、`setPassword`、`clearPassword`、`copyLink`、
`revokeDevice`、`toggleOfficial`。

---

## 5. 手机端（由服务器托管的 PWA）

- 位置：`claude-remote-server/web/`，构建时 `rust-embed` 内嵌；严格 CSP，无外部 CDN。
- 加密：HTTPS（安全上下文）用 WebCrypto；纯 HTTP 局域网部署回退到内置的 `@noble/ciphers` + `@noble/hashes`。
- 存储：`{origin, user_id, device_id, device_token, k_e2e, epoch}` 存 IndexedDB；提供"忘记此 PC"。
- 导航：PC → 窗口（工作区名、宿主、在线）→ 会话 → 对话。
- 渲染原始 SDK 消息：markdown 文本、可折叠 thinking、tool_use 卡片、按需加载的 tool_result、
  Edit/Write 差异、TodoWrite 列表、AskUserQuestion 卡、权限卡（允许一次 / 始终允许（suggestions）/ 拒绝+理由）、
  流式增量、result 的用量、状态条（忙碌、模型、权限模式）、中断、立即发送 / 本回合后排队、模型选择、新会话。
  未知消息类型显示为折叠的原始 JSON（前向兼容）。
- 渲染器从现有 `web/app.js` 迁移改造。

---

## 6. Git Graph Studio 宿主侧改动（模块 12）

| 改动 | 文件 | 说明 |
| --- | --- | --- |
| `ggs.claudeTap.subscribe/unsubscribe` | `src/extHost.ts` | 在已有的 webview 中继处旁路：`io_message`、`tool_permission_request`（及其取消）、`channelRemoteControlState/Available`，按 `webviewSessions` 标注 sessionId；以 `ggs.hostEvent` 推给订阅的进程型后端；`stream_event` 合并后再跨进程。复制在原消息交付之前同步完成、发送异步，订阅方队列有界（满则丢弃并发 `gap`），旁路代码抛错也必须照常交付原消息——这是 §2.2"不影响官方开关"的宿主侧保证 |
| 授权 | `src/extHost.ts`、`src/i18n.ts` | 首次订阅弹出一次确认（"扩展 X 请求读取 Claude 对话"），结果持久化；可在设置中撤销 |
| `ggs.claudeChat.remoteControl({sessionId, enable})` | `src/extHost.ts` | 向承载该会话的 channel 合成 webview 请求 `toggle_remote_control`，拦截并消费其 `response`，返回 `{status, connectUrl, sessionUrl}` |
| `ggs.claudeChat.permission` / `ggs.claudeChat.mode` | `src/claudeChatInject.ts` | 点击权限卡按钮、切换权限模式（DOM 结构以 Phase 0 实测为准） |
| HMAC / HKDF 原生 | `src-tauri/src/node_runtime/builtins/core.rs`、`prelude.js` | `crypto.createHmac('sha256')`、`crypto.hkdfSync`，Node 形状 |
| （可选，后期）WebSocket 客户端 / `tls.connect` | `node_runtime/builtins/net.rs` | 让 GGS 内也走 WS，替代长轮询 |
| （可选，后期）随安装包附带服务器 | `scripts/prepare.mjs`、Tauri 配置 | 面板"在本机启动中继"，供纯局域网用户使用 |

座位规则：应用代码不得出现扩展 id。`ggs.claudeChat.*` 已有先例；旁路以"Claude 对话 webview 流量"为对象，
订阅方由运行时决定，不在 `src/` 中写死。

---

## 7. 安全要点（OWASP 复核项）

- E2E：服务器（含自建运维者）只见路由元数据；每帧随机 nonce，AAD 绑定用户/epoch/收发方/序号，
  接收方拒绝回退的 `seq`（防重放）。
- 密钥只在 URL fragment、PC 的 secrets、手机的 IndexedDB 中出现；日志中永不打印 token/密钥。
- 配对挑战一次性；配对与登录按用户 + IP 限流和锁定；Argon2id 参数可配。
- 重置即吊销：epoch 递增、所有设备 token 失效、在线连接立即踢出。
- 宿主旁路需要用户一次性授权；`permission.answer` 只能命中当前挂起的 request_id。
- 镜像只出 SDK 内容，不出凭据：OAuth token、work secret、environment id 在旁路之上根本不出现；`connectUrl`
  默认不转发。
- 服务器：body/帧大小上限、每用户窗口/设备上限、有界队列、严格 CSP、`SameSite`/`Secure` 不依赖 cookie（Bearer）。
- `stream_event` 合并与回填分页避免大帧；超大 tool_result 按需拉取。

---

## 8. 测试与验证

| 层 | 内容 |
| --- | --- |
| 服务器 `cargo test` | 注册、挑战-响应、密码与锁定、重置踢人与旧 token 失效、多窗口同用户、多用户隔离、限额、队列溢出断开、长轮询与 WS 等价 |
| 服务器集成 | 起真实二进制 + 模拟 agent + 模拟手机，走完整配对 → 订阅 → 权限往返 |
| 插件 vitest `tests/claudeRemote.test.ts`（重写） | 身份多窗口竞争、加密向量、relay 重连与 `epoch_changed`、两个源产生同形事件、手机指令映射 |
| 宿主 vitest `tests/extensions.test.ts`、`tests/claudeChatInject.test.ts` | 旁路事件（含授权拒绝）、合成 `toggle_remote_control` 的响应拦截、权限卡/模式驱动 |
| 镜像不干扰（宿主 + 插件 vitest） | 镜像开着时：webview 收到的消息序列与关闭镜像时逐条相同；订阅方阻塞/抛错/队列满时原消息照常且不延迟；镜像全程没有任何 webview→扩展的合成请求、没有 stdin 写入、没有设置文件写入；`connected→disconnected` 启停正确；`connectUrl` 被清洗 |
| ggs-node `tests/node_runtime.rs` | `createHmac` / `hkdfSync` 与 Node 向量一致；插件在 ggs-node 下的一致性探针（沿用 `test/conformance.js` 思路） |
| 探针 `scripts/probes/claude-rc-surface.mjs`（新） | 对每个新 claude-code 版本复查 §1.3 的标记和 §1.4 的消息形状，任一变化即报告 |
| 实机 | `tauri dev` 下：官方模式开关 + 二维码；自建模式手机发问、权限往返、中断、两个窗口共用二维码、重置后旧手机被踢 |

---

## 9. 分阶段实施（每步以绿色检查结束）

| 阶段 | 内容 | 完成标志 |
| --- | --- | --- |
| P0 探查 | ggs-node 下 `fetch` 流式/长轮询可行性；`io_message` 流量与合并策略；权限卡与权限模式的 DOM；合成 `toggle_remote_control` 在 GGS 中可用 | 每项一个可复现脚本/测试 |
| P1 服务器核心 | 工程骨架、存储、注册/配对/密码/重置、WS + 长轮询路由、限额 | `cargo test`、`clippy -D warnings` 通过 |
| P2 插件骨架 | identity / crypto / relay / 面板二维码；手机能配对并看到本 PC 的窗口 | 插件 vitest + 服务器集成测试 |
| P3 GGS 旁路 | 宿主 `claudeTap` + 驱动；插件 `tap` 源；手机 SDK 渲染器与历史回填 | 宿主与插件测试 + `tauri dev` 实机 |
| P4 SDK 宿主源 | VS Code / 无标签页路径，含权限往返 | `claudeRemoteActivation` 测试 + VS Code 实机 |
| P5 官方模式 | 开关、状态、二维码、全会话开关、模式规则与第三方强制 | 测试 + 实机（claude.ai 账号） |
| P5b 官方 RC 镜像 | `mirror.js` + 旁路的不干扰保证；P0 先实测官方手机端的 prompt 是否出现在 `io_message` 中 | "镜像不干扰"测试 + 实机：Claude App 与自建手机端同时看到同一回合，官方开关行为与关闭镜像时一致 |
| P6 发布 | 服务器多平台构建、Docker、CI 任务、文档、AGENTS.md 模块表、版本三处同步 | CI 绿 |
| P7 可选 | ggs-node 原生 WebSocket；GGS 附带本机中继；方案 B（若官方开放 base URL） | — |

---

## 10. 模块表变更（AGENTS.md）

新增模块 19 **Claude Remote**："从手机继续本机 Claude Code 对话：官方 Remote Control 接入与自建端到端加密中继"。
归属：`extensions-src/claude-remote/`（从模块 12 的描述中迁出）、`claude-remote-server/`、
`tests/claudeRemote*.test.ts`、`scripts/probes/claude-rc-surface.mjs`。宿主侧的 `claudeTap` / `claudeChat.*`
仍归模块 12。

---

## 11. 待确认的假设

1. **用户 ID = PC**：按"每台电脑共用二维码和用户 ID、按 PC 来分"理解为一台 PC 一个用户。若需要"一个账号下多台 PC"，
   在 User 之上加 Account 层即可，协议不变。
2. **注册策略**默认 `token`（服务器管理员发邀请码），防止公网服务器被滥用。
3. **旧的局域网模式**不再内置于插件；局域网用户在本机或 NAS 上运行 `claude-remote-server`（P7 可由 GGS 一键启动）。
4. **VS Code 下的官方模式**只能给出操作指引和 `remoteControlAtStartup` 开关——VS Code 不允许扩展驱动另一个扩展的 webview。
