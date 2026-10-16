# 远程与本地联动、视图自由切换与设置编辑器重写计划

> 状态：**提案**（2026-10-15）。本文只是计划，不含代码改动。
>
> **2026-10-15 更新**：§3–§8（视图轴、联动、网页视图、手机视图、PC 屏幕叠层）已被 [remote-client-plan.md](remote-client-plan.md) 取代。远程界面改为按设备形态自动适配，远程不再提供打开文件夹。本文的 §5.5（设置作用域）与 §9（PC 设置编辑器重写）继续有效，由 remote-client-plan.md §13 引用。
>
> 与其他计划的关系：
>
> - [remote-ui-redesign-plan.md](remote-ui-redesign-plan.md)：P0 已落地。本计划接管它的 P1–P5，并修订其中两节：§4 的排版不再只由宽度决定（改为本文 §4 的"视图"轴），§8 的"查看 PC 屏幕"改为页内叠层（本文 §8）。本计划同时回答了它的 Q-b。它的 Q-a、Q-c、Q-d、Q-e 仍然待定，见本文 §13。
> - [ggs-remote-plan.md](ggs-remote-plan.md)：`ggs-remote/1` 的帧格式、守护进程、Hub、沙箱都不改。本计划只**收紧**远程会话可调用的命令（§5.5），并在已有的事件通道上新增两条小消息（§5.3 在场信息、§5.5 设置变更）。
> - [ggs-development-plan.md](ggs-development-plan.md) §3：本计划遵守全部原则。新视图用 `el()` 与 `ui.ts` 原语手写 DOM；新命令都有标题、启用条件和 i18n 键。

所有者的要求（2026-10-15）：

> 分析当前代码的远程和本地的联动要设计的更好，远程可以随意切换手机视图和网页视图，要专业，美观，vscode 风格，重写 pc 端的设置页面，要专业。

## 目录

0. [术语与理解](#0-术语与理解)
1. [现状分析](#1-现状分析)
2. [目标与非目标](#2-目标与非目标)
3. [模型：三条互相独立的轴](#3-模型三条互相独立的轴)
4. [视图切换：不刷新页面](#4-视图切换不刷新页面)
5. [联动：角色、在场、跟随与设置作用域](#5-联动角色在场跟随与设置作用域)
6. [网页视图：VS Code for the Web 的样子](#6-网页视图vs-code-for-the-web-的样子)
7. [手机视图的打磨](#7-手机视图的打磨)
8. [PC 屏幕：从独立页面改为叠层](#8-pc-屏幕从独立页面改为叠层)
9. [PC 端设置编辑器重写](#9-pc-端设置编辑器重写)
10. [视觉规范](#10-视觉规范)
11. [分阶段实施](#11-分阶段实施)
12. [测试矩阵](#12-测试矩阵)
13. [待所有者确认](#13-待所有者确认)

## 0. 术语与理解

| 术语 | 含义 |
| ---- | ---- |
| **PC 窗口** | GGS 在 PC 上的桌面窗口。它是实例（文件、进程、扩展后端）的宿主，**永远**显示桌面界面。 |
| **远程端** | 浏览器里运行的 GGS 工作台（今天叫"独立界面"，`?frontend=1`）：手机、平板，或另一台电脑上的浏览器。 |
| **手机视图** | 远程端的手机 App 形态：单栏全屏页、App 栏、底部导航、抽屉、动作面板（今天的 `shell.ts` 手机外壳）。 |
| **网页视图** | 远程端的桌面工作台形态：活动栏、侧栏、编辑器分栏、面板、状态栏，外观对标 VS Code for the Web（vscode.dev）。 |
| **PC 屏幕** | PC 窗口的实时 DOM 副本（今天的副本模式，ggs-remote-plan.md §22），用来"看 PC 上正在发生什么"。 |

**对需求的理解**：这里的"手机视图 / 网页视图"指远程工作台的两种**排版形态**，两者都运行浏览器自己的工作台，与设备宽度无关，可以随时互切，切换时不刷新页面。PC 屏幕副本则作为第三个入口，在两种视图里都能打开（§8）。如果所有者说的"网页视图"其实是 PC 屏幕副本，§3 的模型照样成立，只需把 §4 的切换目标换掉。见 §13 D-1。

## 1. 现状分析

| # | 现象 | 根因 | 位置 |
| - | ---- | ---- | ---- |
| F1 | "副本还是独立界面""手机还是桌面排版""谁决定 PC 窗口尺寸"三件事纠缠在一起，由四个地方分别决定 | 没有统一的状态模型。`boot.ts` 用 `wantsOwnUi(request, phone, pcVisible)` 决定；`viewerBoot.ts` 收到窗口列表后，若 PC 显示了该窗口就自动跳走；`host.ts` 可以下发 `own` 消息把观看者踢到独立界面；`hostStub.ts` 的 `watchPhoneMode` 发现 PC 窗口宽度低于 600 px 时，就给 PC 窗口套上手机外壳 | `src/remote/boot.ts`、`src/remote/mirror/{uiMode,viewerBoot,host,hostStub}.ts` |
| F2 | 用户选不了排版。手机横屏超过 600 px 就变成平板排版；桌面浏览器用不了手机视图；平板也没法要桌面视图 | 排版只看视口宽度：`responsive.ts` 的 `formFactorFor(width)` 决定 `data-form-factor`，有 11 个模块和 `remote.css` 里 53 条规则以它为准 | `src/remote/responsive.ts`、`shell.ts` 的 `placePhoneChrome`、`nav.ts`、`actionSheet.ts`、`workbenchSync.ts`、`workbench/menus.ts` |
| F3 | 切换模式要整页刷新 | `modeUrl()` 加上 `location.replace`：工作台重新启动，重新 ATTACH，重新下载代码块，webview 副本重新快照，本端的终端回滚、快速输入、滚动位置全部丢失；经 Hub 的慢链路要等好几秒 | `uiMode.ts` 的 `modeUrl`、`shell.ts` 的 `remote.liveView`、`viewerBoot.ts` 的 `ownUi` |
| F4 | 远程观看会改动 PC 窗口 | `remote_mirror_fit` 会把隐藏窗口改成观看者的尺寸；宽度低于 600 px 时 PC 窗口会套上手机外壳（`phoneShell.ts`）；PC 前的用户和远程用户在争同一个窗口 | `mirror/phoneShell.ts`、`hostStub.ts`、`remote_host.rs` |
| F5 | **设置没有作用域，远程会改坏 PC。** 手机上改字号或主题，会把**整个**设置对象写进 PC 的 `~/.ggs/settings.json`；手机改文件关联或资源管理器右键菜单，会在 **PC 的注册表**里执行 `assoc_apply` / `context_menu_apply`；改终端 Shell 会让 PC 重启桥接的 claude-code 后端，正在进行的对话随之中断；另一端不会实时收到变更，下一次写入又是整对象覆盖，于是悄悄回滚对方的修改 | `settings.ts` 的 `updateSetting` → `persistSettingsFile` → `settingsWrite(JSON.stringify(settings))`；`pathGate.ts` 的 `REFUSED_COMMANDS` 只有 `fs_import` / `fs_export` | `src/platform/settings.ts`、`src/remote/pathGate.ts` |
| F6 | 两端看不见对方在不在 | PC 工作台里没有"谁连着、在看什么"的提示；远程端只知道窗口的 `visible`，不知道 PC 前的人是否在操作 | `summary.ts` 只上报窗口摘要 |
| F7 | 跟随要么全有，要么全无 | `workbenchSync.ts` 总是双向同步打开、关闭、活动标签与侧栏视图：手机上翻文件，会把 PC 的活动编辑器一起拽走；没有"独立浏览"选项，也没有"跳到 PC 当前文件"这一步操作 | `src/remote/workbenchSync.ts` |
| F8 | 桌面宽度的远程端只是 PC 桌面工作台加一个切换按钮 | 菜单靠 `menus.ts` 里逐项的 `hook('session').remote()` 判断裁剪；界面上没有"这是远程会话、连的是哪台 PC、连接质量如何"的标识；断线提示是自绘横幅，不是 VS Code 的通知或状态栏样式 | `workbench/menus.ts`、`remote/shell.ts` 的 `addSwitcherButton`、`banner.ts` |
| F9 | PC 设置对话框不专业 | 720×460 的模态框；只有 4+1 个平铺分类；用的是原生 `select` / `checkbox`；搜索只对当前语言做子串匹配；没有"重置此设置""复制设置 ID"、`@modified` 筛选；扩展设置直接显示原始 id，忽略 `title` / `order` / `enumDescriptions`；没有 JSON 入口（`dispatch.ts:96` 把 `openSettingsJson` 也映射到了这个对话框）；不标注"需要重启""仅 Windows"；只能用鼠标操作 | `src/workbench/settingsPanel.ts`、`shell.css` 第 942–966 行与第 1191–1192 行 |
| F10 | 两套设置界面各自实现了搜索、匹配、行模型 | 桌面的 `settingsPanel.ts` 与手机的 `remote/settingsPage.ts`（570 行）各写一份，已经开始分叉：手机有 Remote 分类，桌面没有；两者的搜索范围也不同 | 同上 |

## 2. 目标与非目标

**目标**

- G1 远程端可以**随时**在手机视图与网页视图之间切换，任何设备都可以；不刷新页面，标签、未保存内容、终端、webview 副本、滚动位置都保留；切换过程在 250 ms 内完成。
- G2 各端的角色固定：PC 窗口永远是桌面界面，远程端不会改变它的尺寸、外壳与布局；远程端只同步操作与数据，不改动 PC 前用户的屏幕。
- G3 设置有作用域：每个设置要么跟设备走，要么在 PC 上共享，要么只能在 PC 上改。远程端不能改动 PC 的系统集成；共享设置按键合并、实时推送，不再整对象覆盖。
- G4 联动看得见、可控：两端都能看到对方在场；远程端可以选"协同"或"独立浏览"；有"跳到 PC 当前位置"这一步操作。
- G5 PC 设置界面重写为 VS Code 式的设置编辑器：编辑器标签页、分层目录、可搜索、可重置、带 JSON 入口、可完全用键盘操作，扩展设置一等呈现；手机设置页共用它的数据模型。
- G6 网页视图的外观与交互对标 VS Code for the Web：远程指示器、状态栏连接质量、浮动菜单、命令面板，菜单按远程命令配置过滤。

**非目标**

- 不做多人光标或协作编辑（remote-ui-redesign-plan.md Q-d 仍待定）。
- 不改 `ggs-remote/1` 帧格式、Hub 与沙箱。
- 不做"工作区 / 文件夹"级设置（GGS 目前没有工作区设置文件；需要时另立计划）。
- 不做键盘快捷方式编辑器（另立计划；本计划只给设置编辑器的目录预留"键盘快捷方式"入口）。

## 3. 模型：三条互相独立的轴

| 轴 | 取值 | 谁决定 | 存在哪里 | 切换代价 |
| -- | ---- | ------ | -------- | -------- |
| **来源** | 工作台 / PC 屏幕 | 用户。默认是工作台；PC 屏幕是叠层（§8） | 不持久化；`?mirror=1` 打开轻量入口 | 不刷新：叠层打开或关闭 |
| **视图** | 手机 / 网页 | 用户。首次访问按设备推断：宽度低于 600 px，或粗指针且短边低于 500 px，默认手机视图，否则默认网页视图；之后记住选择 | 按 PC 隔离的 `localStorage` 键 `remote.view`（`installScopedStorage` 已经按 PC 分前缀）；`?view=phone\|web` 只覆盖一次，不写入 | 不刷新：§4 |
| **档位** | 网页视图：紧凑（< 900 px）/ 常规 / 宽（> 1400 px）；手机视图：单栏，宽窗口里居中成手机宽度的一栏 | 视口宽度，自动 | 不持久化 | 纯 CSS |

PC 窗口不在这三条轴上：它永远是桌面界面、桌面尺寸，焦点仿真也只在有 PC 屏幕观看者时开启。

```text
               ┌──────────── 远程端（浏览器） ────────────┐
   打开链接 ──▶ │  工作台 ◀───── 关闭叠层 ───── PC 屏幕叠层 │
               │   │  ▲                          ▲        │
               │   ▼  │ 切换视图（无刷新）        │ 打开叠层 │
               │  手机视图 ⇄ 网页视图 ─────────────┘        │
               └──────────────────────────────────────────┘
   ?mirror=1 ──▶ 轻量 PC 屏幕页 ──"打开工作台"──▶ 在页内加载工作台（无刷新）
```

今天的 `wantsOwnUi`、观看页的自动跳转、`own` 消息、`watchPhoneMode` 全部删除。删除后，"用哪种界面"只由用户的视图选择决定。

## 4. 视图切换：不刷新页面

### 4.1 机制

- 新模块 `src/remote/view.ts` 提供 `currentView()`、`setView(view)`、`onViewChange(listener)`。`<html>` 上写 `data-view="phone|web"`。
- `responsive.ts` 的 `formFactor()` 改为由视图推导：手机视图返回 `'phone'`，网页视图返回宽度档（`'tablet'` / `'desktop'`）。现有的 11 个调用方（`nav.phoneShell()`、`actionSheet` 的菜单呈现、`workbenchSync` 的侧栏判断、`menus.ts` 等）因此**不需要改调用方式**。`onFormFactorChange` 在视图切换时也会触发。
- `remote.css` 的 53 条 `[data-form-factor="phone"]` 规则迁移为 `[data-view="phone"]`。平板与桌面档的规则继续以宽度为准，放在 `[data-view="web"]` 下。
- 视图切换后同步调整：`placePhoneChrome()`（手机外壳部件已经是"只建一次，之后切换显示"），菜单呈现方式（手机视图用动作面板，网页视图用浮动菜单），设置入口（`installPhoneSettingsEntry`），以及指针尺寸（手机视图里的点按目标保持 44 px，鼠标下也一样，所见即手机 App）。

### 4.2 切换流程

1. 关闭临时浮层：上下文菜单、动作面板、抽屉、快速输入、软键盘（先 `blur`）。
2. 记录导航状态：活动编辑器、可见的侧栏视图、面板是否显示、手机当前页面。
3. 用 `document.startViewTransition` 切换 `data-view`，做 160 ms 交叉淡入；`prefers-reduced-motion` 或不支持该 API 时直接切换。
4. 按下表恢复对应状态。
5. 重新测量：CodeMirror 的 `requestMeasure`、xterm 的 `fit`、webview 副本按新容器尺寸重新排版（`webviewCopy.ts` 的流式副本本来就跟随容器尺寸）。
6. 通过在场消息（§5.3）把新视图报给 PC。

| 手机视图的页面 | ⇄ | 网页视图的状态 |
| -------------- | - | -------------- |
| 文件页 | | 侧栏显示资源管理器，编辑器区保持原样 |
| 编辑器页 | | 侧栏收起时的编辑器区；侧栏状态记住，切回网页视图时还原 |
| 更改页 | | 侧栏显示源代码管理 |
| 扩展页（Claude、Git Graph……） | | 对应的侧栏容器或编辑器标签 |
| 终端页 | | 面板显示终端 |
| 设置页（某一级） | | 设置编辑器标签，定位到同一分类（§9） |

两种视图共用一个工作台实例，所以标签、脏缓冲、终端会话与回滚、搜索结果、各编辑器的滚动位置天然保留。

### 4.3 入口

- **网页视图**：状态栏远程指示器的快速选择（§6.2）里的"切换到手机视图"；"查看 → 外观"菜单。
- **手机视图**：抽屉顶部 PC 卡片上的切换开关；App 栏溢出菜单里的"切换到网页视图"。
- **命令面板**：`remote.view.phone`、`remote.view.web`、`remote.view.toggle`。默认不绑定快捷键，避免与 VS Code 习惯键冲突。
- **URL**：`?view=phone|web`，用于分享和测试。

### 4.4 宽屏上的手机视图

网页里的手机视图在宽于 600 px 的窗口中显示为居中的一栏（最大宽度 480 px），两侧用 `--vscode-editorGroup-emptyBackground` 填充，顶部有一行"手机视图 · 切换到网页视图"提示，效果相当于手机 App 的预览。是否改为铺满宽度见 §13 D-7。

## 5. 联动：角色、在场、跟随与设置作用域

### 5.1 角色

| 角色 | 是谁 | 能做什么 | 不能做什么 |
| ---- | ---- | -------- | ---------- |
| PC 窗口（主控） | `main` 前端 | 一切本地操作，包括系统集成与原生对话框 | 不会被远程端改变尺寸、外壳或布局 |
| 远程端 | `remote/<n>`，手机或网页视图 | 远程命令配置里的全部命令（remote-ui-redesign-plan.md §5）；改设备级与共享设置 | 不能改仅 PC 的设置，不能调用系统集成命令，不能弹 PC 的原生对话框 |
| PC 屏幕观看者 | 远程端打开的叠层 | 看 PC 窗口，把输入回放到 PC 窗口 | 不会让 PC 窗口变形（§8） |

### 5.2 PC 窗口不再变形

删除以下内容：`hostStub.ts` 的 `watchPhoneMode`、`mirror/phoneShell.ts`、`responsive.ts` 的 `setPointerOverride`、`host.ts` 里按设备形态分配窗口适配权的逻辑和 `own` 消息、`remote_mirror_fit` 的手机路径。隐藏窗口保持上次的桌面尺寸，由 PC 屏幕叠层负责缩放。焦点仿真（`remote_mirror_focus`）保留，因为副本要显示光标和焦点样式，但只在 PC 屏幕叠层打开期间生效。

### 5.3 在场信息

- 每个前端在打开、切换视图、切换活动编辑器、空闲或恢复时，广播一条在场消息，并每 30 秒发一次心跳；每条不超过 120 B：`{ by, device, view, activeFile, idle }`。消息走 `studio://workbench-sync` 同一通道的新消息类型 `presence`，不新增协议帧。
- **PC 端**：状态栏右侧显示 `$(remote) 2`；悬停卡片按设备列出：设备名、视图（手机或网页）、当前文件、空闲时长；点击打开同样内容的快速选择，选中一项可以"跳到该设备的当前文件"。
- **远程端**：远程指示器的悬停卡片里显示"PC：使用中 / 空闲 3 分钟"，以及其他远程设备。
- 预算：空闲 60 秒的在场流量不超过 300 B，会计入 remote-ui-redesign-plan.md §7 的空闲预算。

### 5.4 跟随模式

| 模式 | 同步的内容 | 默认 |
| ---- | ---------- | ---- |
| **协同** | 打开、关闭（标签集合）+ 活动标签 + 侧栏视图，双向（今天的行为，即所有者 2026-10-12 定下的"操作一一对应"） | ✓ |
| **独立浏览** | 只同步打开和关闭（两边的标签集合保持一致，未保存确认仍然路由到发起端）；活动标签与侧栏视图不跨端 | |

- 模式按设备记住（`remote.follow`），在远程指示器里切换。PC 的在场卡片上会标出哪些设备处于独立浏览。
- 一步操作"跳到 PC 当前位置"（`remote.jumpToPc`）：按 PC 的在场信息打开它的活动文件并定位到行，单向且只执行一次，不改变当前模式。
- `workbenchSync.ts` 的改动范围：发送端按模式过滤 `active`、`activeTab`、`view`、`sidebar` 四类消息；接收端不变。PC 一端始终是协同。

### 5.5 设置作用域

| 作用域 | 含义 | 存储 | 远程端 | 成员（提案，见 §13 D-5） |
| ------ | ---- | ---- | ------ | ------------------------ |
| **设备** | 每个前端各自的显示偏好 | PC 窗口：`~/.ggs/settings.json`（和今天一样）；远程端：本浏览器中按 PC 隔离的 `localStorage`，**从不写入 PC** | 可改，只影响本设备 | `theme`、`locale`、`fontSize`、`density`、`minimap`、`stickyScroll`、`showOutline`、`bracketColors`、`wordWrap`、`mouseWheelScrollSensitivity`、`fastScrollSensitivity`、`terminalRightClickBehavior`，以及远程专用的 `remote.view`、`remote.follow`、省流模式 |
| **共享** | 作用于同一批文件和行为，两端必须一致 | PC 的 `~/.ggs/settings.json`，按键合并写入 | 可改；修改实时推送给所有前端 | `autoSave`、`autoSaveDelay`、`tabSize`、`snippetSuggestions`、`pathCompletion`、`searchSmartCase`；扩展设置默认归入这一档 |
| **仅 PC** | 改动的是 PC 这台机器（注册表、进程、渲染器） | PC 的 `~/.ggs/settings.json` | **只读**，标注"在 PC 上更改" | `fileAssociations`、`explorerContextMenu`、`linuxDmabuf`、`terminalShell`、`extensionLogLevel`、`claudeTapAccess`；扩展里声明为 `scope: application` 或 `machine` 的设置 |

实现：

- `SettingDef` 新增 `scope: 'device' | 'shared' | 'machine'`。扩展设置读取 `contributes.configuration` 的 `scope` 字段，`application` 和 `machine` 映射为仅 PC，其余映射为共享。
- 新增后端命令 `settings_patch(entries)`，位于 `cmd_settings` 域：对 `settings.json` 加文件锁，按键读改写，然后广播 `studio://settings-changed { keys, by }`。各前端收到后只应用共享键，并派发 `SETTINGS_EVENT`。PC 自己的写入也改为补丁写，不再整对象覆盖。
- `pathGate.ts` 的 `REFUSED_COMMANDS` 新增 `settings_write`、`assoc_apply`、`context_menu_apply`、`user_path_apply`、`providers_shell_refresh`。远程端的 `settings_patch` 由门禁按键校验：只允许共享键，带有仅 PC 键的请求整条拒绝。门禁规则在 Relay 一侧执行，和路径门禁同一层。
- 两个设置界面都给每一行标上作用域徽标：远程端显示"此设备"或"所有设备"，仅 PC 的行置灰并带锁形图标；PC 端只在共享行上显示"远程设备也会生效"的提示。
- 迁移：`settings.json` 的格式不变；远程端的设备键首次运行时从 PC 文件读取一次作为初值，之后各存各的。

## 6. 网页视图：VS Code for the Web 的样子

### 6.1 布局

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ ≡  文件 编辑 选择 查看 转到 终端 帮助    [ 🔍 git-graph-studio · DESKTOP-A1 ]    │ ← 无窗口控制按钮
├──┬───────────────┬─────────────────────────────────────────────────────────┤
│📄│ 资源管理器      │ main.ts ×  settings.ts ×                                │
│🔍│ ▾ GIT-GRAPH-…  │                                                         │
│⑂│   src          │   编辑器                                                │
│🧩│   docs         │                                                         │
│  │               ├─────────────────────────────────────────────────────────┤
│⚙│               │ 终端                                                     │
├──┴───────────────┴─────────────────────────────────────────────────────────┤
│▌>< GGS: DESKTOP-A1 │ ⑂ main ↑1 │ ⚠ 0          ● 38 ms  ⇅ 1.2 MB  👤 PC 使用中 │
└────────────────────────────────────────────────────────────────────────────┘
```

- **标题栏**：去掉窗口控制按钮；命令中心显示"文件夹 · PC 名"；宽度低于 900 px 时菜单栏收成活动栏顶部的 ≡（vscode.dev 的紧凑菜单）。
- **菜单**：按远程命令配置过滤（吸收 remote-ui-redesign-plan.md 的 P1：`Command.profiles`，删除 `menus.ts` 里的逐项判断）。
- **上下文菜单与快速输入**：用桌面的浮动菜单和顶部居中的快速输入，与 PC 一致。
- **断线提示**：从自绘横幅改为状态栏远程指示器变色（警告色加旋转图标）；超过 5 秒仍未恢复时，再弹一条 VS Code 式通知（"正在重新连接 DESKTOP-A1…"，附"重试"按钮）。`banner.ts` 只保留给 PC 屏幕的轻量页使用。

### 6.2 远程指示器

状态栏最左侧，使用 VS Code 的 `statusBarItem.remoteBackground` / `remoteForeground` 颜色，显示 `>< GGS: <PC 名>`。点击打开快速选择，分组如下：

| 分组 | 项 |
| ---- | -- |
| 窗口 | 切换窗口…（今天的窗口切换器）· 在新窗口打开 PC 上的文件夹… |
| 视图 | 切换到手机视图 · 查看 PC 屏幕 |
| 联动 | 协同 / 独立浏览（单选）· 跳到 PC 当前位置 |
| 连接 | 省流模式 ✓ · 流量统计 · 连接信息（RTT、经由 Hub 或局域网、加密状态） |
| 会话 | 返回窗口列表 · 退出登录 |

### 6.3 状态栏右侧

- 连接质量：圆点（绿、黄、红按 RTT 阈值）加毫秒数；悬停显示路径（局域网或 Hub）和最近 1 分钟的流量。
- 省流模式开启时显示图标。
- 在场：PC 状态（§5.3）。

### 6.4 主题令牌

远程端使用与 PC 相同的 `static/theme/*.css`。缺少的令牌（`statusBarItem.remoteBackground/Foreground`、`statusBarItem.warningBackground`）在每个主题里补齐，值取自对应 VS Code 主题的原值，并进入 `themeContrast.themes.test.ts` 的 WCAG 校验。

## 7. 手机视图的打磨

- **抽屉顶部的 PC 卡片**：PC 名、连接质量、在场；卡片下方一行"网页视图"开关和"查看 PC 屏幕"。窗口、传输、省流模式三行保留在抽屉里。
- **App 栏溢出菜单**：增加"切换到网页视图""跳到 PC 当前位置"。
- **设置页**：改为读取 §9.10 的共享模型（分节、作用域徽标、`@modified` 筛选、中英双语搜索），删除自己那份匹配与分类逻辑；新增"远程访问"分类，放视图、跟随、省流三项。
- **宽屏居中一栏**（§4.4）。
- 不变的部分：页面模型（`pages.ts`）、底部导航、动作面板、编辑辅助行、返回栈、只读锁。

## 8. PC 屏幕：从独立页面改为叠层

- **网页视图**：PC 屏幕是一个编辑器标签"PC 屏幕 — DESKTOP-A1"，可以关闭、拆分、拖动；`MirrorViewer` 挂在标签容器里，hello 消息报告容器尺寸。
- **手机视图**：PC 屏幕是一个全屏页，带返回步骤；双指缩放，其余手势沿用 `viewerInput.ts`。
- 叠层打开时开始发送 hello，关闭时发送 bye；PC 端照旧是"有观看者才加载 host"。工作台在叠层下面一直活着。
- **`?mirror=1` 轻量入口**：只启动观看器，不加载工作台，适合慢链路。页面顶部的"打开工作台"按钮先拆掉观看器，再在页内动态加载 `main.ts`，不刷新页面。
- 输入归属：叠层获得焦点时，键盘和指针回放到 PC；离开叠层时归还本地工作台。叠层边框高亮 2 px `focusBorder`，标明"此刻在操作 PC"。
- 删除"PC 显示窗口时观看页自动跳到独立界面"的规则（F1）。

## 9. PC 端设置编辑器重写

### 9.1 形态

- 设置界面从模态对话框改为**编辑器标签页**：新增编辑器输入类型 `settings`，单实例，`Ctrl+,` 打开，标签显示 `$(settings-gear) 设置`。它可以与代码并排、拆分，也会和其他标签一样参与工作台同步（标签 id `settings`）。
- 活动栏底部增加"管理"齿轮，菜单项为：命令面板、设置、键盘快捷方式（预留）、主题、扩展。
- `workbench.action.openSettings` 打开设置编辑器；`workbench.action.openSettingsJson` 打开 JSON（§9.9）；`dispatch.ts:96` 分别映射。
- 删除 `src/workbench/settingsPanel.ts`，以及 `shell.css` 里 `.settings-overlay`、`.settings-dialog` 等相关规则。

### 9.2 外观

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ ⚙ 设置 ×                                                                 │
├──────────────────────────────────────────────────────────────────────────┤
│  [ 🔍 搜索设置                                         ] 12 个结果  ⫶ {} │ ← 筛选 · 打开 JSON
│  用户                                                  (远程端：此设备 | PC)│
├───────────────────┬──────────────────────────────────────────────────────┤
│ 常用               │ 文本编辑器 › 字体                                     │
│ ▾ 文本编辑器        │                                                      │
│     字体     ◀──── │ ▌Editor: Font Size  已修改                            │
│     格式            │ ▌控制编辑器的字号（像素）。                            │
│     滚动            │ ▌[ 16 px             ▾]                              │
│     建议            │                                                      │
│     装饰            │ ⚙ Editor: Tab Size                                   │
│ ▸ 文件              │   一级缩进等于多少个空格；按 Tab 时插入。               │
│ ▸ 工作台            │   [ 4                  ▾]                            │
│ ▸ 终端              │                                                      │
│   搜索              │   Editor: Word Wrap                                  │
│ ▸ 扩展              │   ☑ 长行在视口边缘折行。                              │
│   应用程序          │                                                      │
└───────────────────┴──────────────────────────────────────────────────────┘
```

### 9.3 结构

- **页头**：搜索框（`Ctrl+F` 聚焦，显示结果数）、筛选按钮（菜单：`@modified`、`@tag:restart`、`@tag:windows`、`@ext:<id>`、`@id:<key>`，选中后插入搜索框）、"打开设置 (JSON)"图标按钮。作用域标签页只在远程端出现（"此设备 | PC"），PC 端只有"用户"一个标题。
- **左侧目录**：可折叠的树，显示各节命中数；单击滚动到对应节，滚动时目录高亮跟随；编辑器宽度低于 700 px 时目录自动隐藏（与 VS Code 一致）。
- **右侧列表**：节标题吸顶（"文本编辑器 › 字体"）；内容最大宽度 1000 px，居中。

### 9.4 单个设置的结构

- **标题行**：`分类: 名称`，分类部分加粗（如 **Editor:** Font Size），与 VS Code 的写法一致；中文界面显示"**编辑器：**字号"，悬停显示英文 id。
- **描述**：支持行内代码、链接，以及 `#settingKey#` 形式的跳转（点击定位到另一个设置）。
- **控件**：位于描述下方。
- **已修改**：左侧 2 px 竖条（`settings.modifiedItemIndicator`），标题后加"已修改"字样，悬停显示"默认值：X"。
- **齿轮菜单**：悬停或聚焦时出现在左侧边距，菜单项为重置此设置、复制设置 ID、复制为 JSON，扩展设置另有"打开扩展详情"。
- **徽标**：需要重启（修改后在行内出现"立即重启"按钮）、仅 Windows、作用域（§5.5）、已弃用（`deprecationMessage`）。

### 9.5 控件

所有控件都手写，不用原生控件外观，以便统一使用主题令牌。

| 类型 | 控件 |
| ---- | ---- |
| 布尔 | 18 px 方形复选框，勾号用 codicon `check`，令牌 `settings.checkbox*`；描述文字作为它的 label，点击描述也能切换 |
| 枚举、主题、语言 | 自绘下拉框（`settings.dropdown*`）：键盘上下选择、输入首字母跳转；悬停某个选项时在列表底部显示它的 `enumDescriptions` |
| 数字 | 输入框（`settings.numberInput*`），失焦或回车时校验 `min`、`max`、`step`；越界时在行内显示错误（`inputValidation.errorBorder` / `errorBackground`），不写入 |
| 文本 | 输入框（`settings.textInput*`），支持 `pattern` 校验 |
| 文件关联 | 多选标签网格：每个扩展名一个可切换标签，附"全选""恢复默认"；列表来自 `assoc_list_defaults`（不变） |
| JSON、数组、对象 | 不提供行内编辑，显示"在 settings.json 中编辑"链接（§9.9），与 VS Code 一致 |

### 9.6 搜索

- 分词后逐词匹配，范围包括标题、描述、id、枚举标签，**中英两种语言都参与匹配**（中文界面也能搜 `tab size`）。
- 排序：id 完全命中 > 标题前缀 > 标题包含 > 描述包含。
- 命中的文字用 `editor.findMatchHighlightBackground` 高亮；目录只保留有命中的节，并显示命中数。
- 无结果时显示"没有找到设置"和"清除筛选"按钮。
- 匹配同步执行，不防抖：内置设置约 30 个，加上扩展设置通常不超过数百个。

### 9.7 数据结构

`SettingDef`（`src/platform/settings.ts`）新增字段：

| 字段 | 用途 |
| ---- | ---- |
| `section` | 目录叶节点，见下表 |
| `order` | 节内顺序 |
| `scope` | §5.5 |
| `tags` | `restart`、`windows`、`experimental`，替代今天的 `windowsOnly` |
| `enumDescriptions` | 每个选项的 i18n 说明键 |
| `commonlyUsed` | 是否进入"常用"节 |

目录（每个节标题一个 i18n 键，中英都有）：

| 一级 | 二级 | 成员 |
| ---- | ---- | ---- |
| 常用 | — | `theme`、`fontSize`、`autoSave`、`tabSize`、`wordWrap`、`locale` |
| 文本编辑器 | 字体 | `fontSize` |
| | 格式 | `tabSize`、`wordWrap` |
| | 滚动 | `mouseWheelScrollSensitivity`、`fastScrollSensitivity`、`stickyScroll` |
| | 建议 | `snippetSuggestions`、`pathCompletion` |
| | 装饰 | `minimap`、`bracketColors`、`showOutline` |
| 文件 | 自动保存 | `autoSave`、`autoSaveDelay` |
| | 关联 | `fileAssociations`、`explorerContextMenu` |
| 工作台 | 外观 | `theme`、`density` |
| | 语言 | `locale` |
| 终端 | — | `terminalShell`、`terminalRightClickBehavior` |
| 搜索 | — | `searchSmartCase` |
| 扩展 | 扩展平台 | `extensionLogLevel`、`claudeTapAccess` |
| | 每个扩展一节 | 按显示名排序 |
| 应用程序 | 渲染 | `linuxDmabuf` |
| 远程访问 | — | 只在远程端出现：视图、跟随、省流模式 |

### 9.8 扩展设置

`contributions.ts` 的 `ExtensionSettingDef` 补读以下字段：配置节的 `title`、`order`（以及数组形式的多个配置节，每节成为一个二级目录）、`enumDescriptions` / `markdownEnumDescriptions`、`minimum` / `maximum`、`pattern`、`deprecationMessage`、`scope`、`tags`。标题按 VS Code 的规则由 id 推导：`gitGraph.graph.colours` 显示为 **Graph:** Colours，去掉扩展前缀，后续各段转成首字母大写的词组。

### 9.9 settings.json

- `workbench.openSettingsJson` 在普通编辑器标签里打开 `~/.ggs/settings.json`。
- 保存时用 `loadSettingsFile()` 重新加载并派发 `SETTINGS_EVENT`。
- JSON 无效或键的类型不对时：在编辑器里显示诊断波浪线（复用诊断存储 `features/extensions/editorDiagnostics.ts`），并弹出通知；内存中的设置保持不变。未知键只给出警告，保留在文件里（可能是新版本的设置）。

### 9.10 共享数据模型

新增 `src/platform/settingsModel.ts`，集中实现目录树、搜索与排序、筛选标记、已修改判断、作用域、标题推导、选项标签解析，供以下两处使用：

- PC 与网页视图的设置编辑器：`src/workbench/settings/`；
- 手机设置页：`src/remote/settingsPage.ts`，只保留手机呈现层（逐级钻入、动作面板、开关）。

### 9.11 键盘与无障碍

- 目录使用 `role="tree"`，列表使用 `role="list"`；用漫游 tabindex，`↑` / `↓` 在设置之间移动，`Enter` 进入控件，`Esc` 回到行，再按一次 `Esc` 回到搜索框。
- 行聚焦时显示 `settings.focusedRowBackground` 和 1 px `focusBorder`。
- 控件通过 `aria-describedby` 关联描述；已修改、需要重启通过 `aria-label` 朗读。

### 9.12 性能

- 设置编辑器单独成一个懒加载代码块，首屏包体积不变（由 `measure.mjs` 的 `firstPaintJs` 记录）。
- 打开到首帧的时间：内置设置加 300 个扩展设置时不超过 30 ms，在自检页里测量并写入 `metrics.json`。
- 超过 500 行时改用虚拟列表，复用 `src/scroll/` 的行滚动模型。

### 9.13 文件

| 文件 | 说明 | 模块 |
| ---- | ---- | ---- |
| `src/platform/settingsModel.ts` | 共享模型（§9.10） | 2 |
| `src/workbench/settings/settingsEditor.ts` | 编辑器页：页头、目录、列表、键盘 | 2 |
| `src/workbench/settings/settingsWidgets.ts` | 复选框、下拉框、数字与文本输入、标签网格 | 2 |
| `src/workbench/settings/settingsToc.ts` | 目录树 | 2 |
| `src/workbench/settings/settings.css` | 样式 | 2 |
| `src/features/editor/open.ts` | 新增 `settings` 输入类型 | 6 |
| `src-tauri/src/cmd_settings.rs`（新建，把今天写在 `lib.rs` 里的 `settings_read` / `settings_write` 一起迁入） | `settings_patch` 与 `studio://settings-changed` | 2 |
| `src/remote/view.ts` | 视图轴（§4） | 19 |
| `src/remote/presence.ts` | 在场（§5.3） | 19 |
| `src/remote/remoteIndicator.ts` | 远程指示器与状态栏项（§6） | 19 |
| 删除 `src/workbench/settingsPanel.ts`、`src/remote/mirror/phoneShell.ts` | | |

AGENTS.md 的模块地图在对应阶段同步更新。

## 10. 视觉规范

- **字号**：界面 13 px；描述 12 px（`descriptionForeground`）；节标题 26 px 细体（VS Code 设置编辑器的一级标题），二级标题 13 px 加粗。
- **间距**：设置行上下内边距 12 px，左边距 20 px（其中 8 px 留给已修改竖条和齿轮）；控件与描述间距 6 px；下拉框宽 300 px，数字框宽 80 px。
- **颜色**：只用主题令牌。新增令牌在每个主题里给出 VS Code 原值：`settings.headerForeground`、`settings.modifiedItemIndicator`、`settings.rowHoverBackground`、`settings.focusedRowBackground`、`settings.focusedRowBorder`、`settings.dropdownBackground/Foreground/Border/ListBorder`、`settings.checkboxBackground/Foreground/Border`、`settings.textInputBackground/Foreground/Border`、`settings.numberInputBackground/Foreground/Border`、`statusBarItem.remoteBackground/Foreground`。
- **图标**：只用 codicon（`settings-gear`、`filter`、`json`、`gear`、`remote`、`device-mobile`、`browser`、`screen-full`、`lock`）。
- **动效**：视图切换 160 ms 淡入；菜单和下拉框 80 ms；`prefers-reduced-motion` 时全部取消。
- **质量门**：`themeContrast.themes.test.ts` 覆盖新令牌（WCAG AA）；`uiMetrics.ts` 新增设置编辑器的布局不变量（无横向滚动、控件不溢出、目录与列表不重叠）；`uiSweep.test.ts` 把设置编辑器纳入每个主题的扫描。

## 11. 分阶段实施

每个阶段结束时 `npm run typecheck` 和 `npm test` 必须全绿；改动后端的阶段还要通过 `src-tauri/` 下的 `cargo test --all-features` 和 `cargo clippy --all-targets --all-features -- -D warnings`；改动启动、IPC 或资源的阶段要在 `npx tauri dev` 下实测。

| 阶段 | 内容 | 验收与测试 |
| ---- | ---- | ---------- |
| **R0 立即止血** | `REFUSED_COMMANDS` 增加 `assoc_apply`、`context_menu_apply`、`user_path_apply`、`providers_shell_refresh`、`settings_write`；远程端的 `persistSettingsFile` 改为只写本地（共享键在 S2 之前暂时按设备保存）；手机设置页把仅 PC 的行改为只读 | `tests/remote.test.ts`：门禁对五个命令的拒绝；远程端修改设置后，scripted backend 收不到任何 `settings_write`；手机设置页仅 PC 的行不可交互 |
| **S1 模型** | `SettingDef` 新增 `section`、`order`、`scope`、`tags`、`enumDescriptions`、`commonlyUsed`；新增 `settingsModel.ts`；补读扩展设置的元数据；界面不变 | `tests/settingsRegistry.test.ts`：每个设置都有节和作用域，目录无空节，i18n 键齐全；`settingsModel` 的搜索、排序、筛选、中英匹配单测 |
| **S2 作用域与实时推送** | 后端 `settings_patch` 加文件锁、按键合并，广播 `studio://settings-changed`；门禁按键校验；设备键改存本地；两个设置界面显示作用域徽标 | Rust：并发补丁不丢键、未知键保留、文件损坏时报错而不覆盖；vitest：一端改共享键，另一端实时应用；远程端改设备键不触发后端写 |
| **S3 设置编辑器** | §9 全部内容：编辑器标签、目录、控件、搜索、齿轮菜单、JSON、键盘；删除 `settingsPanel.ts` | 新增 `tests/settingsEditor.test.ts`（渲染、搜索、`@modified`、重置、校验、键盘导航、扩展节、JSON 保存与重新加载、无效 JSON 的诊断）；`uiSweep` 和主题对比度测试；自检页新增设置编辑器检查 |
| **V1 视图轴** | `view.ts`、`data-view`、53 条 CSS 迁移、无刷新切换、状态映射、`?view=`、命令 | `tests/remoteResponsive.test.ts`：两种视图互切 10 次后，标签、脏缓冲、终端会话、活动编辑器保持不变；任意宽度下都能进入任一视图；切换时浮层全部关闭；`remote-phone-shots.mjs` 为两种视图各截图 |
| **V2 网页视图外观** | 远程指示器、状态栏连接与在场项、命令配置 `Command.profiles`（吸收 remote-ui-redesign-plan.md 的 P1）、紧凑菜单、断线状态改到状态栏 | `commandSweep` 在远程配置下重跑：配置里的每个命令都能执行，且不触发被门禁拒绝的调用；远程指示器的快速选择项与 §6.2 表格一致（快照测试） |
| **V3 手机视图打磨** | 抽屉 PC 卡片、溢出菜单项、宽屏居中、设置页接入共享模型并新增远程访问分类 | `remoteResponsive` 新增用例；`settingsPage.ts` 删除重复逻辑后，原有用例全部保持通过 |
| **V4 PC 屏幕叠层** | §8：标签或全屏页形式的叠层、轻量入口的页内加载；删除 `phoneShell.ts`、`watchPhoneMode`、`own` 消息、`remote_mirror_fit` 的手机路径（吸收 remote-ui-redesign-plan.md 的 P3） | `tests/remoteMirror.test.ts` 改写 PC 手机模式的相关用例：观看者打开或关闭时，PC 窗口的尺寸和 `data-remote-shell` 都不变；Playwright 规格默认进入工作台，并测试叠层的开关 |
| **V5 在场与跟随** | §5.3 和 §5.4 | `tests/remoteWorkbenchSync.test.ts`：独立浏览模式下 `active` 与 `view` 消息不发出，打开和关闭照常同步；`jumpToPc` 能打开文件并定位到行；在场消息的大小和频率断言 |
| **T 流量预算** | 即 remote-ui-redesign-plan.md 的 P4，加上在场消息的预算 | `remoteTraffic.test.ts` 的预算表 |
| **D 文档回写** | AGENTS.md 的模块 2、6、19；ggs-remote-plan.md §11 和 §22；remote-ui-redesign-plan.md 的状态行 | 文档评审 |

依赖顺序：R0 → S1 → S2 → S3；V1 → V2 → V3 → V4 → V5 → T → D。S 线和 V 线可以并行；V3 的设置页部分依赖 S1。**R0 修的是远程端改动 PC 系统集成的问题，建议在所有其他阶段之前单独发布。**

## 12. 测试矩阵

| 维度 | 取值 | 覆盖方式 |
| ---- | ---- | -------- |
| 视图 × 宽度 | 手机视图 / 网页视图 × 390、768、1280、1920 px | `remoteResponsive.test.ts` 参数化；截图探针 |
| 来源 | 工作台、PC 屏幕叠层、轻量 `?mirror=1` | `remoteMirror.test.ts`；Playwright（Chromium、Firefox、WebKit） |
| 跟随 | 协同、独立浏览 × PC 与一台远程设备、PC 与两台远程设备 | `remoteWorkbenchSync.test.ts` |
| 设置作用域 | 设备、共享、仅 PC × PC 端、远程网页视图、远程手机视图 | `settings.test.ts`、`remote.test.ts` 的门禁用例、Rust 的 `settings_patch` 测试 |
| 主题 | 全部内置主题 | `themeContrast.themes.test.ts`、`uiSweep.test.ts` |
| 语言 | en、zh-cn | i18n 键完整性测试；中英搜索用例 |
| 真机 | Windows 本机 `tauri dev`；手机经局域网；手机经 Hub | `scripts/probes/remote-live-check.mjs`、`remote-hub-multi-check.mjs` 增加视图切换与设置作用域步骤 |

## 13. 待所有者确认

- **D-1 "网页视图"的含义**：(1) 浏览器里的桌面工作台，本计划按此理解；(2) PC 屏幕副本。选 (2) 时，§4 的切换目标改为"手机视图 ⇄ PC 屏幕"，其余部分不变。
- **D-2 远程端能否改仅 PC 的设置**：(1) 只读，标注"在 PC 上更改"（建议）；(2) 可以改，但要二次确认，并在 PC 端弹出通知。
- **D-3 默认跟随模式**：(1) 协同，即今天的行为（建议）；(2) 独立浏览。
- **D-4 设置界面形态**：(1) 编辑器标签页，与 VS Code 一致（建议）；(2) 保留模态对话框，只重做其中的内容。
- **D-5 作用域划分**：§5.5 的成员表是提案。有争议的是 `wordWrap`、`locale`（建议归设备），以及 `autoSave`（建议归共享，因为两端编辑的是同一份缓冲）。
- **D-6 remote-ui-redesign-plan.md 的遗留问题**：Q-a（本地资源管理器的传输行）、Q-c（远程打开工作区）、Q-d（光标与选区）、Q-e（`folderInput` 关闭时的行为）仍待回答；它的 Q-b 由本计划回答：桌面浏览器默认使用网页视图的工作台。
- **D-7 宽屏上的手机视图**：(1) 居中一栏，480 px（建议）；(2) 铺满宽度。
