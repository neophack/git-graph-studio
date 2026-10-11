# GGS Remote — 安全审查记录（§16 / M8.1）

> 2026-10-11,对照 `docs/ggs-remote-plan.md` §16 的清单逐项走查代码后的记录。"在哪"给出
> 实现位置;"结论"如实陈述——包括没做的和做轻了的。OWASP ASVS 5.0 的章节号在各段标出。

## 身份验证（ASVS 2.x）

| 措施 | 在哪 | 结论 |
| ---- | ---- | ---- |
| Argon2id 哈希 | `daemon/src/auth.rs`（m=19456 KiB、t=2、p=1，写 `auth.json` 0600） | ✅ |
| 弱口令表 | `auth.rs` 内置前 1 万常见密码 SHA-1 前缀表 | ✅ |
| 首次设置仅本机 | 未设密码时对外端口只答"请在 PC 上设置"（`http/mod.rs` guard） | ✅ |
| 登录限速与锁定 | `ratelimit.rs`：每 IP 第 5 次起 60 s × 2^n，封顶 1 h；全局每分钟 30 次后统一延迟 2 s | ✅（内存态，重启清零——记录为已知取舍） |
| 改密 epoch → 4401 | `state.rs credentials_changed` → broadcast → 每个 WS 1 s 内关闭（`tests/integration.rs` 与 `tests/hub_link.rs` 均断言） | ✅ |
| 经 Hub 的爆破 | PC 侧限速用 `CONN_OPEN`/`HTTP_REQ` 携带的真实 IP（`hub/session.rs` 注入 ConnectInfo 与 x-forwarded-for）；Hub 另有每 IP×uuid 的登录入口限速（10/min，`hub/src/state.rs`） | ✅ |

## 会话（ASVS 3.x）

- 令牌 256 位随机、只存 SHA-256（`session.rs`）；Cookie `HttpOnly; Secure; SameSite=Strict`，
  `Path=basePath`（Hub 模式下多 PC 互不覆盖，§20.6.1）。✅
- 12 h 滑动 / 30 天绝对过期；WS 连接每 60 s 复验 epoch（`ws/socket.rs` recheck）。✅
- 踢下线 / 全部下线：epoch+1 与单会话撤销都有（`revoke` / `signout-all`）。✅

## CSRF / CSWSH（ASVS 3.5 / 12.x）

- Cookie 为 Strict；`/ws` 校验 Origin == Host（`origin_ok`，Hub 隧道走 `origin_ok_proxied`）；
  HELLO 必须携带会话 CSRF 值；改状态 API 要求 `Content-Type: application/json` +
  `Sec-Fetch-Site` 同站（`json_request_ok`）。✅
- 未实现计划中的 `X-GGS-Base` 相等性校验：Cookie 的 Path 隔离已是实际的跨 PC 防线，该头
  本身是公开值，加一层相等性检查不增加攻击成本——记录为**有意裁剪**（§20.6.1 原文本身
  承认剩余风险只在"工作台自身 XSS"前提下）。

## 传输（ASVS 9.x）

- 默认 TLS 1.2/1.3 自签（`tls.rs`，397 天证书 + 60 s 地址变化重签热更新）；HTTP 仅 loopback
  （`config.rs effective_bind`）。✅
- 隧道客户端：webpki-roots 静态根（偏离计划的 rustls-platform-verifier，已在计划状态行
  记录）；自签 Hub 用 `fp=` SHA-256 指纹固定（`hub/link.rs PinnedVerifier`）。✅

## 访问控制（ASVS 4.x）

- 实例资源只读 `remote/` 前缀（`remote_host.rs`）；插件文件复用 `serve_ext_asset` 的目录
  约束；下载一次性票据（60 s）；资源令牌与会话绑定、改密即失效（`resource_token` /
  `check_resource_token`）。✅
- 配对页 / 插件页二维码须密码解锁（R19，`Tickets::check_unlock`，5 min 内存态）。✅
- `FetchFile` 路径约束与 `ext_fs` 同一策略（打开的文件夹 + 插件目录）。✅

## 输入校验与路径穿越（ASVS 5.x）

- 帧长上限（1 MB/帧、256 MB/消息）、分片总长上限、在途调用 1024 / 订阅 4096、HTTP 体
  64 KB（隧道侧 4 MB 上限缓冲）；`safe_rel_path` 拒绝 `..`、绝对路径、反斜杠、NUL。✅
- **M8.2 fuzz-lite**：`daemon/src/ws/frame.rs` 的 `random_and_mutated_input_never_panics_the_decoder`
  ——LCG 语料 + 头部字段结构化变异 + 逐位翻转，解码器不 panic（cargo-fuzz 常驻模糊未接，
  以可重放的确定性语料替代——记录为替代实现）。

## 本机接口（ASVS 12.x）

- `/admin`、`/relay`、`/pair` 仅 127.0.0.1；admin token 0600 常量时间比较；Relay 令牌一次
  性 60 s；控制通道 Unix socket 0600 / Windows 命名管道按用户名派生。✅

## Hub 侧（§20.6）

- uuid 由公钥哈希推导，接入须签 Hub 一次性挑战且绑定主机名；枚举防护：122 位哈希 +
  三态同页 + 每 IP 100 次/10 min 离线探测封禁 10 min；joinKey 常量时间；T_HELLO 每 IP
  10/min；同密钥二次连接替换旧隧道（T_REPLACED）。✅（`hub/src/{identity,tunnel,state}.rs`，
  `hub/tests/tunnel.rs` 覆盖）
- 跨 PC 缓存只收 `/v/<ver>/` 下带 `immutable` 的 2 MB 内应答（`hub/src/cache.rs` +
  `http_proxy.rs` 的 cacheable 判定）。✅
- 已知面：Hub 可见明文流量（自部署前提，§20.2 记录；M10 端到端加密未做）。

## 拒绝服务（ASVS 12.x）

- 每 IP 连接上限、握手 10 s / HELLO 5 s 超时、会话恢复缓冲 1 MB×2000 帧、Hub 每 IP 会话
  上限与每隧道并发上限。✅

## 日志（ASVS 7.x）

- 登录成败、改密、踢下线、实例拉起入日志；密码 / 令牌 / 文件内容不入；资源令牌在访问
  日志中脱敏（`log.rs redact_path`，有测试）。✅

## 能力说明

- 配对页与 README 均声明：远程用户权限等同本机用户（终端可执行任意命令）。✅

---

## M8.4 — 方案 B（Rust 分发表）评估结论

**不实施。** 方案 A（Relay webview）的内存成本是接入期间每实例一个隐藏 webview
（Windows WebView2 约 60–90 MB），换来的是 180+ 命令、Channel、事件与桌面零差异的行为
和随版本自动同步。方案 B 需要为每命令处理 `State`/`AppHandle`/`Window`/`Channel` 参数并
持续跟随命令集演进——这正是本仓库模块数量级的持续维护面。`remote-memory.mjs` 可度量两
种形态的 RSS；在空闲 RSS ≤ 12–15 MB（R11）已由守护进程本体满足、Relay 只在接入期间存在
的前提下，把工程预算花在 B 上不划算。触发重新评估的条件：多实例同时被远程接入成为常态，
或 WebView2 的每实例成本显著上升。

## M7.3 — 图片缩略图命令：决策

**不做独立命令。** 收益是资源管理器 / Markdown 预览里的整图改为缩略图；代价是把
`png`/`jpeg-decoder`+缩放引入应用二进制（纯 Rust 也是数十万行的解码面），而现有链路已经
流式：大文件走窗口化视图，HTTP 侧有 br 压缩 + SW 缓存 + 省流模式的远程图片开关。等
`remote-traffic.mjs` 的真实数字表明图片流量占比可观时再评估——届时优先 `fs_image_thumb`
风格的后端缩放（`png` crate 已在守护进程树里，应用侧未引入）。
