# Claude Remote (LAN)

从手机远程使用桌面上的 Claude Code:读会话、读图片、继续会话、开新会话。
一个 VSIX,同时支持 VS Code 与 Git Graph Studio(离线运行,无云端依赖)。

## 工作方式

- 扩展读取 Claude Code 自己的会话存储:`$CLAUDE_CONFIG_DIR/projects/**/*.jsonl`
  (默认 `~/.claude`;GGS 的 provider 桥会把它重定向到 `~/.ggs/claude`,两者都被识别)。
- `claude-remote.start` 在局域网接口上启动一个 HTTP 服务,并在通知里给出
  `http://<局域网IP>:<端口>` 与 24 位配对令牌(复制按钮)。
- 手机打开该地址,输入令牌配对;之后**所有请求与应答体都是 AES-256-GCM 密文**,
  密钥由令牌经 PBKDF2-SHA256(150k 轮)派生——令牌本身从不再次上线,
  局域网嗅探只能看到随机字节与长度。
- 发送消息即在本机以工作目录运行 `claude -p "<prompt>" --output-format json`
  (可 `--resume <sessionId>` 继续会话);轮询任务直至完成,新会话会即时出现在列表里。

## 安全模型(局域网 + 纵深)

| 层 | 措施 |
| --- | --- |
| 网络 | 仅局域网;无任何云端中继、无遥测 |
| 认证 | 160-bit 随机配对令牌;密文即认证(只有持令者能构造可解密请求) |
| 机密性 | 每条请求/应答 AES-256-GCM,每次随机 IV;配对令牌只在配对时进入派生函数 |
| 暴力破解 | 解密失败计数 + 10 秒惩罚窗 |
| 页面 | HTML 转义输出;图片经鉴权接口按需拉取 |
| 生命周期 | 服务器随命令显式停止、随窗口关闭而关闭 |

## 命令

- `Claude Remote: Start LAN Server` — 启动并显示配对信息(URL + 令牌,可复制)
- `Claude Remote: Stop LAN Server`
- `Claude Remote: Show Pairing Info Again`

## 构建与安装

```sh
node extensions-src/claude-remote/build.mjs
# 产物:target/studio/claude-remote-<version>.vsix
```

VS Code:`Extensions → … → Install from VSIX…`。
Git Graph Studio:Extensions 视图的 Install from VSIX,或该 VSIX 的打开方式。

## 已知边界

- 局域网明文 HTTP 承载密文——令牌泄露即等于会话泄露,令牌只显示给本机用户;
  如需跨网,请走 VPN,不要把端口暴露到公网。
- `claude -p` 按无头模式运行:工具调用遵循 Claude Code 的权限配置,
  未授权工具会被拒绝(与桌面交互模式的权限规则一致)。
- 会话读取器扫描每个文件的头部与尾部窗口(256 KiB),超长会话的更早历史不进手机视图。
