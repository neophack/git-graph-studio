# 远程客户端设计与开发计划

> 状态：**开发中**（2026-10-15）。本文件是远程客户端的权威计划，规定界面、交互、同步与兼容性。
> **2026-10-15 落地记录**(同日实施):R0(§3.3 门禁收紧、远程设置只留本端、`boot_context` 增加 `roots`/`workspaceFile` 供远程恢复)、C0(fflate 压缩回退、构建目标对齐 A 级下限、`:has()` 由 hasFallbacks.ts 的类名替代、dvh/16px 输入、`pageshow` 恢复、C 级拦截页 unsupported.html、capabilities.ts)、A1(`Command.profiles` 两套命令配置、撤回远程打开文件夹/新窗口——openOnPc.ts 删除、守护进程 `api/browse` 删除、会话 SPAWN 一律拒绝、picker 输入行删除、K16 前后端删除 `fs_import`/`fs_export`/`fs_transfer_cancel`、Workbench 挂载点参数化、`src/remote/app/main.ts` 远程组合根——remote.html 不再加载桌面 main.ts)、A2 的分类器与稳定性规则(deviceClass.ts,`data-device` 五类 + 派生 `data-form-factor`)。
> **2026-10-16 落地记录**:A2 的布局框架补齐——`src/remote/app/layouts/` 五个布局模块(phonePortrait / phoneLandscape / tabletPortrait / tabletLandscape / desktop)+ 布局宿主 host.ts(§4.2 切换过程:浮层关闭、导航状态经 pages.ts 的同一词汇记录并重放、部件移动不重建)+ parts.ts 部件注册表 + navRail.ts 竖向导航轨(56 图标 / 72 带文字)+ layouts.css;页面栈外壳(手机两种方向 + 平板竖屏)经 `<html data-page-stack>` 共享原手机 CSS 块(remote.css 改键);平板横屏是工作台自身的三栏框架(活动栏加 `.rail-label` 标签、侧栏 320 主栏);桌面形态状态栏最左侧远程指示器(§5.5);§5.7 手机形态键盘门控(页面级修饰键和弦交还浏览器,编辑器内的键保留)。responsive.ts 新增 `onDeviceClassChange`(含方向翻转)并维护 data-page-stack。同日删掉 §11 清单里的副本手机外壳路径:`mirror/phoneShell.ts`、`hostStub.ts` 的 `watchPhoneMode`、镜像协议的 `own` 消息、`remote_mirror_fit` 的手机尺寸分支(PC 窗口任何尺寸都保持桌面外壳,`fitFor` 一律桌面下限)。验收:`tests/remoteLayouts.test.ts` 五种形态互切,标签、脏缓冲、终端会话是同一 DOM。
>
> **2026-10-16 P1 落地记录**(同日第二批):§6.1 文件页与 §6.7 多路径打包。文件页 `src/remote/app/files/`(filesPage 挂进 explorer 侧栏视图——页面栈外壳显示它、隐藏树,宽形态相反;git 字母链接 SCM 的 onStatus,打开走 workbench.openFile)+ pathBar(根图标 + 每级一个标签、横向滚动、长按复制路径、尾部 ▸ 列同级目录)+ fileList(双行行布局:文件夹"12 项 · 3 天前"/文件"24.3 KB · 10-14 18:20"、git 字母着色、中省略文件名;`list_dir_page` 每页 200 + IntersectionObserver 哨兵无限滚动;逐目录滚动位置记忆;排序名称/修改时间/大小/类型 × 升降序、文件夹恒前、隐藏文件开关,按设备记忆)+ multiSelect(450ms 长按进入、计数条 + 底部操作栏:下载/删除(整选一次确认)/重命名(单选,行内)/复制路径)+ 悬浮按钮动作面板(上传文件/上传文件夹(iOS 按 data-cap-ios 隐藏)/新建文件/新建文件夹)。后端 `DirEntryInfo` 新增可选 `modified`/`children`(read_dir_sorted 同一次 metadata,文件夹多一次 read_dir,PC 侧计算)。多路径打包:`ggs-fs` 的 `zip_trees`(单根等价 zip_tree;多根各归其名,重名数字后缀)、协议 `ToInstance::FetchFile` 增 `paths`(serde 缺省,单路径形态线上字节不变;共享控制向量两种形状都有)、守护进程票据与 `api/download-ticket` 携带 `paths`、浏览器线路 `downloadMany` / 共享层 `downloadManyTo`(无多路径能力的线路逐项回退);`serve_file` 多路径分支与文件夹 zip 同一"先空头后字节"流,以选择所在父目录命名。验收:`tests/remoteFiles.test.ts` 九例(行布局、进入返回与滚动恢复、哨兵分页、排序、长按多选、计数条、多选一 zip、单选直下、整选确认删除、路径栏与同级表);守护进程集成测试 `a_multi_path_ticket_packs_one_zip`;ggs-fs zip_trees 两例。**余量**(随 P2/Q 补):传输中心页面(§6.7 的列表/暂停/续传 UI——线路本身已支持断点续传)、下拉刷新、工具条视图按钮、二进制文件的"打开方式"面板、左滑行操作、Playwright 的 iPhone/Pixel 上传下载规格(§14 的矩阵阶段)。
>
> **2026-10-16 P2 落地记录**(第三批):§6.3 更改页交互与 §6.6 终端订阅。左滑手势 `platform/ui/swipe.ts`(`swipeReveal`,进共享 UI 工具箱:动作条挂在行的列表宿主、行自身随指平移,首次决定性移动锁定轴向使纵向滚动不受影响,同时只一行打开,拖拽结束的 click 被吞掉)——`scm/rowActions.ts` 在 `data-page-stack` 标记下挂接:未暂存组露出 放弃+暂存、已暂存组露出 取消暂存、合并组露出 标记已解决,各按钮即悬停按钮与上下文菜单的同一处理器(放弃保留自己的二次确认);两行行布局与提交框吸顶走同一标记的 CSS。差异视图按形态取向(`open.ts` 的 `diffInlineShell`:页面栈外壳一律行内差异——横屏手机 850px 视格若按宽度规则会劈成两半不可读;宽形态保持宽度规则;用户手动固定优先)。终端输出跟随 `features/terminal/outputFollow.ts`(独立状态机、定时器可注入:离开页面 30 秒宽限内保持流,宽限耗尽仅退订各会话的输出监听——生存期监听不动,回来时重取并从 `pty_tail` 的 64KB 回放补拉,宽限内往返零补拉;宽限外新建的会话出生即无订阅),`TerminalView.setOutputFollow` 委托之,`remote/terminalFollow.ts` 由 pages.ts 的观察器驱动(页面栈外壳 = 面板是当前页;宽形态 = 面板可见),`pty_tail` 进 IPC 缝。验收:`tests/remotePages.test.ts` 九例。**P2 余量**(随后续阶段):更改页行数据按需拉取(组折叠不拉行,属 §7.1 的 D 档)、编辑器双指缩放字号、终端双指缩放。
>
> **2026-10-16 S1+L1 落地记录**(同日第四批):**S1 同步策略**(§7.0/§7.2/§7.3)。`src/remote/presence.ts`(新):在场表——每个前端在 `studio://workbench-sync` 通道上广播 `{k:'presence',by,active,device}`,60 s 心跳、150 s TTL 超时、`noteExternal` 接收守护进程 WINDOWS 帧的 `visible`(PC 活跃的权威来源,远程 boot 在每次 WINDOWS 帧后喂入,含启动时补喂);活跃判定为 `document.visibilityState !== 'hidden'`(prerender 视为在途)。`workbenchSync.ts` 重写:门控(活跃前端 <2 时 announce 与 tabs-diff 全部静默,K11;无 presence 参数时行为不变,供旧用例)、追平(变为活跃或 start 时发 `stateRequest`,最近活跃的其他前端应答 `stateSnapshot`——并集合并、缺的标签后台打开(`open`/`openTab` 消息可带 `inactive`)、任何一方不关标签、加入方采纳应答方的活动标签,K14;远程来源的快照文件走与 open 相同的根边界+canonical 复查)、删除 `view`/`sidebar` 两类消息(G8,侧栏与视图切换回归本端布局,`sidebarHideCrosses` 与 showView/toggleSidebar 包装一并删除)。§7.3 保存冲突:`dirty.ts` 的 `markSaveConflict`(监视器命中的脏文件读盘比对——等于 savedDoc 或当前缓冲即视为保存回声,不算冲突)→ 三按钮信息条(比较=磁盘/我的内容差异 tab、使用磁盘版本、保留我的版本),干净重载加 `external-reload` 1.5 s 标签闪烁;`lifecycle.ts` 的 onFsChanged 对每个命名路径 reload 与冲突检查都调。设置新增 `remoteHideNotice`(PC 设备级)。**L1 PC 窗口生命周期**(§17,G13 修复):ggs-remote-proto 增 `ToInstance::Hide`、`ToInstance::Sessions{count}`、`FromInstance::Update.minimized`(serde 缺省不序列化,旧字节不变;control.json 向量新增三条并 bless 同步到守护进程副本——proto 的 bless 写自身 tests/vectors/,需拷回守护进程);守护进程 `INSTANCE_DISPLAY`(0x0C)帧(ws socket,同一 `remote_may_drive` 沙箱边界,未知实例回 notice),`refresh_session_counts` 在计数变化时推 `Sessions`(含归零,遍历 before∪after);`InstanceInfo.minimized` 进 WINDOWS。应用侧 `remote_host.rs`:`Hide` 走 `hide_main`(与 `remote_host_hide_main` 同路径)、`Sessions` 存入 Link、`remote_host_status` 增 `remoteSessions`、`main_minimized`+`note_main_resized`(lib.rs 的 Resized 窗口事件,仅在 minimized 真变时推 Update)。前端 `closeHidesWindow` 纯判定(`keepRunningHidden` 走它:镜像观看者或 remoteSessions>0 即隐藏)+ K15 系统通知(tauri-plugin-notification 新依赖,capability `notification:default`;通知被拒时静默,绝不阻塞关闭)+ `noteWindowHidden()`(关闭隐藏路径把在场表置为不活跃);窗口切换器与守护进程 picker.js 增 minimized 徽标、sessions 数与"在 PC 上关闭/打开窗口"动作,`remote.pcWindow.hide/show` 命令(remote profile)。验收:`remoteWorkbenchSync.test.ts` 改写(view/sidebar 断言改为 G8 本端;新增门控/三前端 K10/追平用例)、`remoteTraffic.test.ts` 增 §7.4 同步族预算行(在场 ~80B 载荷、意图 ≤300B、单独 20 文件 0B、20 标签快照 ≤2KB、Claude 流式与 Git Graph 滚动显式 ≤7KB——实测 6989/6834B)、`remoteLifecycle.test.ts`(新,closeHidesWindow+Presence 单测)、守护进程集成 `instance_display_shows_and_hides_and_sessions_ride_the_count`(Sessions 先于 EnsureRelay 的次序,两个旧用例补消费)。**余量**(随 S2/L2):L2 的 §18 场景矩阵与 `remote_debug_snapshot`、托盘退出的确认对话框、追平合并里 diff/history 标签的后台打开(openDiff 无 inactive 参数,仍取焦点)。
>
> **2026-10-16 落地记录(所有者第四轮指示——picker 路径输入行保留)**:窗口选择页"此 PC 上的窗口"**上方输入文件夹路径打开 ggs 的输入行要保留**(所有者 2026-10-16 原话:"网页上'此 PC 上的窗口'上面输入文件夹路径打开ggs的要保留")。恢复:picker.html 的 `open-row` 输入行与沙箱入口行、picker.js 的 `openTypedFolder`(回车/按钮发 `SPAWN`)、最近列表"没有窗口打开它"时点"打开"即 spawn、`api/session` 的 `folderInput`/`sandbox` 读取(这两个字段后端一直在答,2026-10-15 只是页面停用了它),守护进程 ws 的 `SPAWN` 帧恢复走 `lifecycle::spawn`(`via_remote=true`:沙箱开着时照 §23 约束在根内、根外文件夹在 lifecycle 拒绝)。K4 相应收窄:**远程工作台**(remote.html 会话)仍然没有打开文件/文件夹/新窗口的入口——`pathGate` 的 REFUSED_COMMANDS、`GET /api/browse` 的删除、工作台切换器无"新窗口"全部不变;picker 落地页是唯一例外,也是远程唯一的 spawn 入口。验收:守护进程集成测试 `the_picker_keeps_its_folder_input_and_a_spawn_reaches_lifecycle`(browse 仍 404、session 带 `folderInput:true`、SPAWN 到达 lifecycle 并以"no GGS installation"失败——被听见并按真实规则回答,而非一刀切拒绝)。
>
> **2026-10-16 S2 落地记录**(第五批):**§8 Claude 会话桥**全部落成。§8.1 副本排除输入框:`DomRecorder` 新增 `skip(node)` 选项(RecorderOptions),被跳过的子树序列化为一个带 `data-mirror-skip` 与高度内联样式的空占位——子树内的 childList/属性/文本记录在 flush 一开始就被丢弃,控件、滚动、焦点与光标从未登记也就从不过线;规则由 `claudeChatInject.ts` 新增的 `chatComposerRoot(doc)`(`chatControls` 的 form)提供,`chatBridge.ts` 的 `chatComposerSkipRule()` 按结构判定(FORM 且正是当前 composer 的 form),页面重挂 composer 即被下一次 serialize 抓住,不靠元素引用;fluid 副本(FLUID_CSS)隐藏占位,原生输入区取其空间。装配在 `webviewShare.ts`:流属于 `provider_list` 的 `bridgedExtIds`(`streamIsBridgedChat`,经 `WebviewFrameSource.extOf` 拿 view 的属主——extensionHost 注册、`webviewExtOf` 实现)才装桥,装桥时同步换上 skip 规则、重启 recorder(旧表里 composer 的节点不再对着观看者已不持有的 id 发射)并向所有观看者重发快照;share 随最后一个观看者 stop 后再次 hello 会重新装桥。§8.2 消息:`chat`(op: send/stop/permission/answer/model/mode,带操作 id)/`chatAck`(回执,`detail` 带模型回执的标签)/`chatState`(busy/model/mode/permission/question,100 ms 合并、变化才推)走 MIRROR_UP/DOWN,`w` 为流 id;PC 侧 `mirror/chatBridge.ts` 分发到 claudeChatInject 的既有驱动——`sendChatText`(新)发完把 PC 用户草稿写回、发不出去也原样放回;`answerChatQuestion` 拆出 `pickChatQuestion`/`submitChatQuestion`(answer 消息带 `submit?: boolean`:多题卡逐题 pick,复选框只落一次,最后一题才提交);重发按 id 去重(128 条 LRU,重复 id 只补回执)。远程侧 `remote/app/chat/`:`index.ts` 是挂载门(等 PC 的第一帧 chatState 才懒加载 composer——src/ 依旧不出现扩展 id)、`composer.ts`(原生 textarea:草稿按流存本端 localStorage、忙碌时 ➤ 变停止且发送进本端队列——气泡可撤回,回复结束自动按序发出,队列按标签页存 sessionStorage、重连后按原 id 重发;失败回执把文本放回输入框并提示;模型/模式为行内询问;后台提醒=标题 ● + 震动 + 已授权时的系统通知)、`chatCards.ts`(权限三键与问题选项的原生大按钮卡,Other 的回答框)。IME 门控(§10.2 第 8 项):`isComposing`/`keyCode 229`/compositionend 后 50 ms 内的 Enter 一律不是发送;手机(粗指针)Enter 换行,细指针 Ctrl/⌘+Enter 发送。验收:`tests/remoteChat.test.ts` 十八例(skip 规则×4——占位、子树零字节、结构重挂、fluid 隐藏;桥×4——初始状态与变化才推、发送与草稿写回、五类操作各带回执、重发去重;composer×7——含 100 字 0 B、IME、队列与重挂恢复、失败回退、原生卡;门×1;share 全链路×2——占位快照、chatState、chat 操作落页、PC 侧打字零字节、stop 后重桥),`tests/claudeChatInject.test.ts` 补 composer root 与草稿三例。**S2 余量**(随 Q):底部导航 Claude 项的圆点提醒、Playwright 的 chat.spec(§14 矩阵)、真机 IME/通知检查、多题卡的原生 UI 逐题引导(协议已带 submit 标志,远程 UI 目前按单题卡一步提交)。
>
> **2026-10-16 落地记录(所有者第五轮指示——远程 Claude 用原始界面)**:远程的 Claude **不再自己写界面**(所有者 2026-10-16 原话:"远程claude不要单独自己写界面导致bug很多,使用claude原始界面")。S2 的会话桥整体撤回:删除 `src/remote/app/chat/`(原生输入框/权限卡/问题卡)、`mirror/chatBridge.ts`、协议的 `chat`/`chatAck`/`chatState` 消息族、recorder 的 `skip` 选项与 `data-mirror-skip` 占位、`chatComposerRoot`/`sendChatText`、`webviewExtOf`/`extOf` 链路、`remote.chat.*` 文案与 `.chat-native-*` 样式、`tests/remoteChat.test.ts`。远程的 Claude 页回到**纯副本**:对话区与输入框都是 PC 上那份 Claude 原始页面,打字、点按钮(发送/停止/权限卡/问题卡/模型选择)全部经副本的输入回放进入 PC 的真实页面——即 §8 落地之前的行为。代价如实记录:K7 中"Claude 输入框的内容与光标不同步"不再成立(副本输入本就回放过线),§7.4"在 Claude 输入框里打 100 个字 → 0 B"一行随之作废,§6.4 的"本端的原生输入框"与 §8 全部内容仅作历史。claudeChatInject 的 `pickChatQuestion`/`submitChatQuestion` 拆分保留(`answerChatQuestion` 自用),`ggs.claudeChat.*` 宿主命令不受影响。
>
> **2026-10-16 S3 落地记录**(第六批):**§9.2 滚动所有权**。每条 webview 流的滚动同一时刻只有一个所有者——最后与页面交互(滚轮/触摸/按键)的一端,持有 3 秒租约,自己的后续交互续期。实现:`webviewShare.ts` 的 `gateScroll` 在回放前检查租约——所有者的 `scroll`/`wheel` 照常执行;他人租约存续期间,非所有者的滚动被**丢弃**(不回放、不转移),并向其单发 `own` 消息(持有人 id、设备名、剩余租约),副本据此显示"滚动跟随 <设备名>"提示条(`webviewCopy.ts` 的 `mountScrollHint`,3 秒后自清,所有权回家即清);指针/按键/文本不属滚动,非所有者的点击照常回放,但只在租约失效后才取得所有权。PC 本端:帧上的 `wheel`/`pointerdown`/`keydown`(仅 `isTrusted`,回放器派发的事件不算)让 `main` **立即**取得所有权——本机页面已原生滚了,租约追随现实,远程拽不走 PC 用户正在看的画面。hello 增 `device`(本端 `data-device`),供提示条点名;`own` 为新下行消息,变更时广播、被丢弃时单发。只有一端在看时它天然是所有者——行为与落地前一致。验收:`tests/remoteMirror.test.ts` §9.2 组六例(独占回放、PC 滚轮持有时丢弃并告知、3 秒后转移、非所有者点击照常且不夺权、PC 滚轮从远程手里收回、提示条命名与清除)。
>
> **2026-10-16 落地记录(远程编辑器两处修正——所有者反馈:"远程编辑请没有同步打开pc的打开页面,点击编辑也没有弹出选择哪个页面的选项")**:**§7.0.3 追平的新连竞态**——新远程连接的最初几秒名册是空的(PC 的心跳未到,连接时的 WINDOWS `visible` 词又落在工作台的表创建之前,start 的追平按"无其他活跃前端"跳过,此后再无触发点),远程编辑器页因此看不到 PC 已打开的页面;现在 `presence.ts` 记住 WINDOWS 外部词(`noteExternalPresence`)并在表注册时重放,且名册首次出现活跃他端(`onRosterChange`,workbenchSync 订阅、`awaitingSnapshot` 防重)补发一次追平。**§6.2 对齐**——底部导航与导航轨的"编辑器"**每次点按**都打开已打开编辑器面板(此前首次点按只切页、面板要再点一次),无已打开编辑器时由编辑器页的空状态应答;面板选行先 `revealEditorPage` 再点标签。验收:`remoteWorkbenchSync.test.ts` 新例(空名册起步的远端在名册得知 PC 后追平并跟随其活动标签)、`remoteLifecycle.test.ts` 新例(外部词迟到重放)、`remoteLayouts.test.ts` 新例(选择面板三态:空→空状态、有标签→面板、选行→落地该页)、`remoteResponsive.test.ts`(onTap 每击必报)。
>
> **2026-10-16 L2 部分落地记录**(第六批,§18 的地基):**§18.1 `remote_debug_snapshot`**(`src-tauri/src/remote_debug.rs`,新模块):GGS_TEST_HOOKS=1 才应答(否则 Err;注册随 generate_handler! 恒在——宏是编译期名单,这是"才注册"的务实落法,check-ipc.mjs 新增 TEST_ONLY_COMMANDS 表登记为测试专用);返回扩展后端的 pid/启动计数(I1)、每个已装包的登记日志(活面板与视图在内,I3/I4)、`routing::frontends()`(`main` 打头 + 服务过的前端粘性集合——纯观看的镜像会话到不了后端,诚实缺席)、main 窗口的 created/pageLoads 计数(I9;lib.rs 的 build_main_window 与 on_page_load 计数)与 visible/minimized、会话数。routing 增粘性前端集合(call_begin 记录)。**§18.7 探针** `scripts/probes/remote-lifecycle-check.mjs`(新):live-check 的封闭装配(独立 home、固定端口 config.json、bin/VERSION 预置、set-password)+ 应用带 GGS_TEST_HOOKS=1 拉起 + 裸 ws 会话;快照经会话的 INVOKE 读取;启动瞬态先稳(连续两帧快照的后端键一致才开跑);场景跑 T4 的核心(E4/E5 交替,先清旧 WINDOWS 帧、等**携带目标状态**的推送、1 秒界限=I7),每步前后快照对 I1(pid/启动计数不变)与 I9(created/pageLoads 不变)断言,末尾 I5(会话仍在);报告写 target/studio/remote-lifecycle/remote-lifecycle-report.{md,json};本机实测 6 翻转全过(退出码 0)。`LIFECYCLE_TRACE=1` 转储每帧。Rust 测试:`remote_debug` 的计数器与 frontends 两例。**L2 余量**(继续):§18.3 的 T1–T18 其余场景(浏览器侧副本比对走 live-check 的 CDP 相位)、随机序列(§18.4)、长时运行(§18.5)、平台矩阵(§18.6)、`tests/e2e/remote/lifecycle.spec.ts`(如需 Playwright 形态;§18.7 原文写 Playwright,探针先以裸 ws 会话落地——线上场景本就无需浏览器)。
>
> **2026-10-16 落地记录(布局手动覆盖的菜单入口——所有者反馈:"平板模式没有菜单入口")**:§4.2 的手动覆盖此前只有读侧(`data-device-override` 无人写入,布局无法手选)。本批补上写侧与入口:responsive.ts 新增 `setDeviceOverride`/`deviceOverride`(localStorage `ggsr.deviceOverride` 持久化——与省流模式同为设备级;写入 `<html data-device-override>` 并**立即**重分类,不等 150 ms 去抖;`initResponsive` 启动即播种,强制形态首帧即穿戴、无闪现;方向感知沿用 overrideClass)。入口两处:设置页"远程"分类首行"布局:自动 / 手机 / 平板 / 桌面"(§8 设备级设置清单的第一项,动作面板选择、非自动带修改点,根搜索可及);命令面板 `remote.layoutMode`"布局模式(自动 / 手机 / 平板 / 桌面)"(remote profile)——平板横屏与桌面形态的 Settings 走桌面对话框,命令是全形态共有的入口。验收:`tests/remoteResponsive.test.ts` 新增三例(覆盖立即生效、跨 resize 仍生效、回到自动恢复算法答案;持久化覆盖首帧即穿戴;设置页"远程"分类的选择与撤回)。
>
> **2026-10-16 落地记录(远程工作台加入 /windows 选择页的按钮入口——所有者指示:"远程要有按钮入口可以进入https://ip:port/windows页面")**:此前进入会话(remote.html)后,回窗口选择页只能手改 URL(或等实例退出的 4410 自动跳转)。本批补上显式入口,三处共用一条 `remote.windowsPage` 命令(remote profile):命令面板;导航抽屉"工作区"区"此 PC 上的窗口"行旁新增"窗口选择页"行(browser 图标);窗口切换器(标题栏按钮)首屏列表的最后一行。`windowSwitcher.ts` 新增 `pickerPageUrl(basePath)`(`<basePath>windows`,Hub 前缀下同样成立)与 `goWindowsPicker()`——与 `enterInstance` 同一干净退出(共享 `leaveSession`:先 `detach` 告知 PC、`shutdown` 停死套接字,再整页加载)。K4 不变:这是**导航**不是 spawn,远程工作台自身仍无打开文件/文件夹/新窗口的入口,唯一 spawn 面仍是选择页落地页。验收:`tests/remote.test.ts`(pickerPageUrl 两种 basePath;切换器末行即选择页、点按走干净退出)、`tests/remoteResponsive.test.ts`(抽屉行存在、可用、点按执行命令并关抽屉)。
>
> **2026-10-16 落地记录(远程两处修正——所有者指示:"远程时候,左下角的文件打开按钮不要"、"手机端文件管理上长按没有弹出菜单,或者没有打开的菜单的入口")**:**K4 的最后一处**——活动栏最底部的 Open Folder 按钮(`layout.ts` 的 `buildActivityBar`,spacer 之下,远程桌面形态与平板横屏的左下角)按命令配置构建时就不挂载:远程组合根在 workbench 构造前已切到 remote profile,`activeProfile() !== 'remote'` 才挂;欢迎页(workbench.ts 的 `renderWelcome`)同步收紧——Start 不再列 Open Folder / Clone / Close Folder,Recent 整节不列(远程窗口跟随 PC 的文件夹,`open_folder` 本就在 §3.3 的拒绝表里),Keyboard Shortcuts 列按 `commands.visible` 过滤(desktop-only 命令不再占行)。**§6.1 行菜单**——长按不再直接进入多选,而是弹出该行的动作面板(以文件名标题):打开/进入、传输行(文件:下载;文件夹:打包下载 + 上传到此)、重命名、删除(单行二次确认)、复制路径、多选(进入多选并选中该行);多选进行中的长按仍是切换选中,不在复选框上叠菜单。入口三份:长按(450 ms,gestures.ts 同配方)、每行尾部的 ⋮ 按钮(44 px 目标,始终可见——不依赖手势可发现性)、`contextmenu`(Android 长按的 ~500 ms 追随事件与鼠标右键;已开面板不重开,避免重放滑入动画)。长按后的释放 click 被吞掉——此前菜单/多选刚出现就被这次 click 立即反转,读起来正是"长按没反应"。`fileList.ts` 持手势与 ⋮,`filesPage.ts` 经 `menu(entry)` 钩子组装动作(与多选栏同一套动词),`multiSelect.rename` 对外暴露给菜单复用。验收:`tests/remoteFiles.test.ts` 行菜单四例(长按弹菜单且吞点击、⋮ 打开并执行、contextmenu 打开且不重开、多选中长按仍是切换)+ 多选三例改走菜单的 多选 行;`tests/remoteWorkbenchSync.test.ts` 新例(remote profile 构造的 workbench 活动栏无 open 项、欢迎页无桌面专属链接,桌面基线仍在)。
>
> **2026-10-16 落地记录(编辑器空状态页重设计——所有者指示:"远程这个页面要重新设计,要更好用,更专业")**:§6.2 的编辑器空状态页(`editorSwitcher.ts` 的 `createEditorEmptyState`)从"图标 + 一句话 + 三个竖排按钮"重做为工作区的小仪表盘,设计语言对齐 §6.1/§6.4 的触控页(圆角卡、磁贴、大写节标、双行行):顶部主题色圆角图标砖 + "没有打开的文件" + 工作区名;**仓库卡**(有仓库时)——分支名、↓n/↑n(各自成对、对间留隙)、待变更徽章(干净树为 accent 色的"没有变更"),一点直达源代码管理页,状态读 `workbench.scm`(isRepo/branch/ahead/behind/changes),随状态栏/活动栏的 DOM 变化经既有观察器刷新;**三个入口磁贴**(浏览文件为主题色、转到文件、查看变更)替换原竖排按钮;**"已打开的编辑器"列表**(原有,别处分组的标签一触可达)与**"本机最近打开"列表**(新)——本设备 MRU 存 localStorage `remote.editor.recent`(Hub 下按 PC 前缀隔离,与文件页排序键同法),`sync` 在任何页面上记录当前活动文件标签(去重、上限 15),展示时按 `withinRoots` 过滤到仍在打开文件夹内的路径(最多 5 行,双行行 + 文件图标着色),点行经 `workbench.editors.openFile` 打开;原 `remote.editor.emptyHint` 文案随一句话提示一并删除。验收:`tests/remoteResponsive.test.ts` 新 describe 两例(仪表盘形态与磁贴动作;MRU 记录/去重/关尽后页面应答)、`tests/remoteFiles.test.ts` 新 describe 两例(真 workbench 下仓库卡分支与变更数并一点到 SCM 页;最近列表只列仍在打开文件夹内的文件)。

> **未开始**:L2 的场景矩阵与随机序列(§18.3–§18.6)——§18.1 与 §18.7 的地基已落(见上)。
>
>
> 与其他文档的关系：
>
> - 取代 [remote-linkage-and-settings-plan.md](remote-linkage-and-settings-plan.md) 的 §3–§8。该文件中的 §5.5（设置作用域）和 §9（PC 设置编辑器重写）继续有效，本文 §13 的阶段表引用它们。
> - 取代 [remote-ui-redesign-plan.md](remote-ui-redesign-plan.md) 的 §4–§8。它在 P0 中落地的"远程打开文件夹"按所有者 2026-10-15 的新要求撤回（本文 §3.3）；P0 的守护进程路径门禁加固保留。
> - [ggs-remote-plan.md](ggs-remote-plan.md) 的守护进程、协议帧、Hub 与沙箱不变。本文只在既有事件通道上新增消息类型（§8.2、§9），并收紧远程会话可调用的命令（§3.3）。
> - 遵守 [ggs-development-plan.md](ggs-development-plan.md) §3：不用前端框架，DOM 用 `el()` 手写；每个新动作都是带标题、启用条件和 i18n 键的命令；后端的长任务可以取消，并且以流的形式返回。

## 所有者的要求（2026-10-15）

> 要把 pc 桌面和远程的使用不同 html，远程的 html 根据长宽比自动切换显示适配手机平板电脑，横屏竖屏等。要专业设计，根据不同设备设计不同的操作体验，pc 桌面可以打开文件，打开文件夹，打开新窗口，不需要上传下载。远程页面要支持上传下载，不需要打开文件和文件夹，还有手机端文件列表的显示要方便点击。远程支持各种浏览器，chrome firefox safari 安卓苹果手机浏览器等，兼容性强。远程本地同步要做好，有些需要同步，有些不需要同步，为了节省流量，打开哪个文件要同步，修改文件不需要同步，claude 页面要同步，输入框的光标位置和输入内容不需要同步，对话内容要同步，发送后要同步，就相当远程发命令可以实时看到回答。git graph 可以不用同步滑动位置等，只要同步打开了就可以。主要是方便远程控制，又不要消耗太多流量。参考 mt 管理器，vscode 等各种知名软件设计出最合适的界面交互，交互要人性化，高效率。

原文"不用 html"按"不同 html"理解，即 PC 与远程使用两个入口文档、两套外壳。

所有者的补充要求（2026-10-15，第二轮）：

> 当前代码 git graph 可以多端同步。可以参考？导入导出是什么功能，说清楚。如果远程打开多个不同界面也要同步。如果桌面端没有打开，只有一个远程，就不需要同步。远程 ggs 列表要显示 pc 端是打开还是关闭，可以只关闭 pc 端，而远程不断。还有要严格测试，防止远程打开关闭 pc 端打开关闭导致 claude 和 git graph 插件异常。
>
> 切换活动标签是要同步的。

所有者的决定（2026-10-15，第三轮）：

> PC 重新打开时是跟随远程的状态。2 要弹出。4 导入导出是远程界面才有的功能，本地 pc 不需要。

第三轮带来的改动：K14–K16（§1），以及 §7.0、§11、§16、§17.2 的相应条目。

所有者的指示（2026-10-16，第四轮）：

> 网页上"此 PC 上的窗口"上面输入文件夹路径打开ggs的要保留。

第四轮带来的改动：K4 修订与 §3.3 修订（§1、§3.3）——窗口选择页的路径输入行恢复，详见顶部 2026-10-16 落地记录。

第二轮带来的改动：K9–K13（§1）、G13–G16（§2）、§6.5 与 §9 的 Git Graph 方案（改为沿用现有代码）、§7.0 的同步门控与追平、§11 对导入导出的说明，以及新增的 §17（PC 窗口生命周期）和 §18（生命周期与插件稳定性测试）。

## 目录

1. [约束性决定](#1-约束性决定)
2. [现状与差距](#2-现状与差距)
3. [架构：两个入口、两套命令配置、一个核心](#3-架构两个入口两套命令配置一个核心)
4. [设备分类与自适应](#4-设备分类与自适应)
5. [五种设备形态的交互框架](#5-五种设备形态的交互框架)
6. [页面规格](#6-页面规格)
7. [同步策略](#7-同步策略)
8. [Claude 会话桥](#8-claude-会话桥)
9. [Git Graph：沿用现有同步，加滚动所有权](#9-git-graph沿用现有同步加滚动所有权)
10. [浏览器兼容性](#10-浏览器兼容性)
11. [PC 桌面侧的变化](#11-pc-桌面侧的变化)
12. [设计系统](#12-设计系统)
13. [实施阶段](#13-实施阶段)
14. [测试与验收](#14-测试与验收)
15. [风险](#15-风险)
16. [待所有者确认](#16-待所有者确认)
17. [PC 窗口生命周期](#17-pc-窗口生命周期)
18. [生命周期与插件稳定性测试](#18-生命周期与插件稳定性测试)

## 1. 约束性决定

以下各条来自所有者的要求，开发时不再讨论：

| # | 决定 |
| - | ---- |
| K1 | PC 桌面（`index.html`）与远程（`remote.html`）是两个入口、两套外壳、两套命令配置。 |
| K2 | 远程界面根据视口的**尺寸、长宽比、方向和指针类型**自动选择设备形态：手机竖屏、手机横屏、平板竖屏、平板横屏、桌面浏览器。旋转屏幕或改变窗口大小后实时切换，不刷新页面。 |
| K3 | PC 桌面有"打开文件、打开文件夹、新窗口"，**没有**上传和下载。 |
| K4 | 远程有上传和下载，**没有**"打开文件、打开文件夹、新窗口"。远程只在 PC 已经打开的窗口之间切换。（2026-10-16 第四轮修订：这说的是**远程工作台**；窗口选择页"此 PC 上的窗口"上方输入文件夹路径打开 ggs 的输入行**保留**——见顶部落地记录。） |
| K5 | 手机上的文件列表以点按为先：大行高、平铺的目录列表、路径栏、长按多选。参考 MT 管理器。 |
| K6 | 支持 Chrome、Edge、Firefox、Safari，包括 Android 与 iOS 上的浏览器和常见的 App 内置浏览器，按 §10 的分级执行。 |
| K7 | 同步只覆盖"打开了什么"和"对话内容"。具体包括：打开哪个文件要同步；文件修改不同步；Claude 的对话内容同步，发送后实时看到回答；Claude 输入框的内容和光标不同步；Git Graph 只同步"打开了"，滚动位置不同步。 |
| K8 | 设计目标是方便远程控制，同时流量尽量低。§7.4 的流量预算是验收线。 |
| K9 | 切换活动标签要同步（所有者已确认）。 |
| K10 | 多个远程界面之间也要同步，例如手机和另一台电脑的浏览器同时连着。同步的参与者包括所有"活跃前端"，不分 PC 还是远程（§7.0）。 |
| K11 | 只有一个活跃前端时不发送任何同步消息。典型场景：PC 窗口没有打开，只有一个远程在用。一个前端重新变为活跃时，先追平当前状态，再进入同步（§7.0）。 |
| K12 | 远程的窗口列表要显示每个 PC 窗口是"打开"还是"关闭"。远程可以只关闭 PC 端的窗口，远程会话不断开；PC 用户自己关闭窗口时，远程也不断开（§17）。 |
| K13 | 远程的连接与断开、PC 窗口的打开与关闭，在任何顺序下都不能让 Claude 和 Git Graph 插件出错。§18 的测试是发布门槛。 |
| K14 | PC 窗口重新打开时跟随远程的状态：远程打开过的标签在 PC 上打开，PC 的活动标签切到远程最近的活动标签（§7.0 的追平）。 |
| K15 | 有远程连着时，PC 用户点 × 只隐藏窗口，并弹出系统通知说明 GGS 仍在为远程运行；通知可以勾选"不再提示"（§17.2）。 |
| K16 | 上传和下载只属于远程界面。PC 端的"导入 / 导出"连同它的后端命令全部删除（§11）。 |

## 2. 现状与差距

| # | 现状 | 与要求的差距 | 位置 |
| - | ---- | ------------ | ---- |
| G1 | 远程默认显示 PC 窗口的 DOM 副本；独立界面（`?frontend=1`）则先启动完整的桌面工作台，再用 `MutationObserver` 等标题栏出现后，在外面套一层手机外壳。CSS 负责隐藏桌面部件 | K1：远程没有自己的外壳，手机形态只是隐藏了部件的桌面界面 | `src/remote/boot.ts`、`src/remote/shell.ts` 的 `installRemoteShell`、`remote.css` |
| G2 | 设备形态只看宽度（`formFactorFor`：小于 600 是手机，小于 1024 是平板），不看长宽比和方向；手机横屏宽度超过 600 px 就被当成平板 | K2 | `src/remote/responsive.ts` |
| G3 | 远程的"打开文件夹"会浏览 PC 磁盘并新开窗口（P0）；窗口切换器有"新窗口…" | K4 要求远程没有这些入口 | `src/remote/openOnPc.ts`、`folderBrowser.ts`、`windowSwitcher.ts`、`desktopHooks.ts` 的 `folderOpen` |
| G4 | PC 资源管理器有"导入 / 导出"行（`fs_import` / `fs_export`） | K3 要求 PC 没有上传下载 | `src/features/explorer/transfer.ts`、`explorer.ts` |
| G5 | 手机的文件页就是桌面的树：22 px 行高、逐级缩进、点按箭头才能展开；只有窄窄一行路径，没有多选 | K5 | `src/features/explorer/explorer.ts`、`remote.css` |
| G6 | Claude 对话在远程是 PC 页面的 DOM 流式副本，**包括输入框**：远程每打一个字都要回放到 PC，再把 PC 的变化流回来；输入框的焦点和光标状态也会同步（c963dc6） | K7 要求输入框不同步，并且这是流量大户 | `src/remote/mirror/{webviewCopy,webviewShare,recorder,replay}.ts` |
| G7 | Git Graph 在远程也是 DOM 副本。它的列表是虚拟滚动的，所以远程每滚动一次都要把滚动比例回放到 PC，由 PC 渲染新的可见窗口再流回来 | K7 要求 Git Graph 不同步滚动 | `webviewCopy.ts` 的 `onScroll`、`replay.ts` |
| G8 | `workbenchSync` 除了打开、关闭、活动标签，还同步侧栏视图切换（`view`）和侧栏隐藏（`sidebar`） | K7：只同步"打开了什么" | `src/remote/workbenchSync.ts` |
| G9 | 远程端改设置会把整个设置对象写进 PC 的 `settings.json`，还能在 PC 注册表上执行 `assoc_apply` / `context_menu_apply` | 越权，见 remote-linkage-and-settings-plan.md F5 | `src/platform/settings.ts`、`src/remote/pathGate.ts` |
| G10 | 线路压缩使用 `CompressionStream('deflate-raw')`，需要 Chrome 103+、Firefox 113+、Safari 16.4+；而远程构建目标写的是 `chrome100`、`safari16` | K6：Safari 16.0–16.3 和 Chrome 100–102 上收发帧会直接失败 | `src/remote/frame.ts`、`vite.remote.config.ts` |
| G11 | 3 条 CSS 规则用了 `:has()`，Firefox 121 才支持，Firefox 115 ESR 上这些规则不生效 | K6 | `remote.css` 第 158 行和第 217 行，`shell.css` 第 122 行 |
| G12 | Playwright 只跑桌面设备配置（`Desktop Chrome` 等），没有手机或平板模拟，也没有横屏 | K6 无法验证 | `playwright.remote.config.ts` |
| G13 | **PC 用户关闭窗口时，只有两种情况会改为隐藏窗口**：有 PC 屏幕副本的观看者，或者实例是以 `--remote-host` 启动的。远程用自己的工作台连着的时候（本计划的默认模式），关闭窗口会让整个应用退出：远程会话断开，claude-code 与 git-graph-rs 的后端进程被杀，正在进行的 Claude 回复中断 | K12、K13 | `src/workbench/boot.ts` 的 `onCloseRequested` 与 `keepRunningHidden` |
| G14 | 远程看得到窗口是"隐藏"的（列表上有"已隐藏"徽标），但不能隐藏或显示 PC 窗口。唯一能用的是"关闭窗口"，也就是退出整个实例，远程会话随之断开 | K12 | `daemon/web/picker.js`、`src/remote/windowSwitcher.ts`、`remote_host.rs` 的 `handle`（有 `Show`，没有 `Hide`） |
| G15 | 同步消息总是广播，不管当前有几个活跃前端；一个前端重新变为活跃（PC 窗口重新显示、远程页面从后台回来）时，没有追平步骤，两端的标签会一直不一致，直到下一次操作 | K10、K11 | `src/remote/workbenchSync.ts` |
| G16 | Git Graph 是普通的 VS Code webview 面板：`gitGraphView.js` 用 `createWebviewPanel` 创建，全局只有一个 `GitGraphView.currentPanel`，有 85 种消息，扩展还会自己推送 `refresh` 和 `lossWarning`。远程看到的是这个唯一面板的 DOM 副本，滚动比例会回放给 PC（`webviewCopy.ts` 的 `onScroll`）。同一时间只有一端在看时，这套机制已经工作正常；两端同时看时会抢同一个滚动位置 | K7 | `~/.ggs/extensions/neophack.git-graph-rs-1.0.26/out/gitGraphView.js`、`src/remote/mirror/webviewCopy.ts`、`replay.ts` |

## 3. 架构：两个入口、两套命令配置、一个核心

### 3.1 分层

```text
          index.html                               remote.html
              │                                         │
   src/main.ts（桌面组合根）              src/remote/app/main.ts（远程组合根）
              │                                         │
   DesktopShell（现有 workbench/*）         RemoteShell：按设备形态挂载 5 种布局（§5）
     标题栏菜单 · 活动栏 · 侧栏 · 面板          App 栏 / 导航栏 / 分栏 / 底部导航 / 动作面板
              │                                         │
              └──────────── 工作台核心（共享） ─────────────┘
                 commands · settings · i18n · EditorArea · 编辑器 · SCM 数据 ·
                 资源管理器数据层 · 搜索 · 终端 · 扩展宿主（webview 副本） · platform/ipc
                                        │
                     Tauri IPC（桌面） / WebSocket 垫片（远程，tauriShim）
```

- **工作台核心**：今天 `Workbench` 类持有的服务与视图部件，即 EditorArea、各视图、命令注册。两个外壳共用同一份代码，同一个命令 id 在两端行为一致。
- **外壳**负责框架布局、导航、菜单呈现和手势。桌面外壳就是现在的 `src/workbench/*`。远程外壳是新的 `src/remote/app/`，**不再**先启动桌面框架再用 CSS 隐藏，而是直接把核心的部件挂进自己的布局。
- 第一步按"挂载点"拆分，不重写部件：`Workbench` 的构造过程拆成"创建服务"和"挂载框架"两段。远程组合根只调用"创建服务"，再把 Explorer、EditorArea、SCM、终端等部件的根元素挂进自己的布局容器。具体做法见 §13 的 A1。

### 3.2 命令配置

每个命令新增可见性字段 `profiles?: ('desktop' | 'remote')[]`，缺省表示两端都有。菜单、命令面板、动作面板、抽屉、App 栏和标题栏统一按当前配置过滤，`menus.ts` 里逐项的 `hook('session').remote()` 判断删除。

| 命令 | 桌面 | 远程 | 说明 |
| ---- | :--: | :--: | ---- |
| `workbench.newWindow` 新窗口 | ✓ | ✗ | K3、K4 |
| `workbench.openFolder` 打开文件夹 | ✓ | ✗ | K4；撤回 P0 的远程实现 |
| `workbench.openFileStandalone` 打开文件… | ✓ | ✗ | 远程打开文件 = 在文件页点按，或用快速打开（只在已打开的文件夹内） |
| `workbench.openWorkspace` 打开工作区… | ✓ | ✗ | |
| 打开最近、关闭文件夹、退出 | ✓ | ✗ | 远程的"退出"是"断开 / 退出登录"（§6.8） |
| 开发者工具 | ✓ | ✗ | |
| `explorer.import` / `explorer.export`（`fs_import` / `fs_export`） | ✗（删除） | ✗ | K3，见 §11 |
| `remote.upload` 上传文件、`remote.uploadFolder` 上传文件夹 | ✗ | ✓ | 上传文件夹按浏览器能力显示（§10.3） |
| `remote.download` 下载、`remote.downloadZip` 打包下载 | ✗ | ✓ | 可以多选 |
| `remote.transfers` 传输中心 | ✗ | ✓ | §6.7 |
| `remote.switchWindow` 切换窗口 | ✗ | ✓ | 只切换 PC 上已经打开的窗口，不新建 |
| `remote.windowsPage` 窗口选择页 | ✗ | ✓ | 整页加载守护进程的 `/windows`（抽屉行与切换器末行同源）；导航不是 spawn（K4——spawn 仍只在那页） |
| `remote.pcWindow.hide` 在 PC 上关闭窗口、`remote.pcWindow.show` 在 PC 上打开窗口 | ✗ | ✓ | 远程会话不断开（§17） |
| `remote.screen` 查看 PC 屏幕 | ✗ | ✓ | 降级为"更多"里的一项（§6.8） |
| `remote.dataSaver` 省流模式 | ✗ | ✓ | |
| 设置 | ✓ | ✓ | 远程按 remote-linkage-and-settings-plan.md §5.5 的作用域 |

### 3.3 撤回与收紧

- **删除**：`src/remote/openOnPc.ts`、`src/remote/folderBrowser.ts` 中只供远程使用的部分、`desktopHooks.ts` 中会话版的 `folderOpen`、`windowSwitcher.ts` 的"新窗口…"，以及守护进程 `GET /api/browse`。（2026-10-16 修订：原同在此列的"窗口选择页的 `folderInput` 输入行"按所有者第四轮指示**恢复**——见顶部落地记录。）
- **门禁**：`pathGate.ts` 的 `REFUSED_COMMANDS` 新增 `open_folder`、`app_new_instance`、`settings_write`、`assoc_apply`、`context_menu_apply`、`user_path_apply`、`providers_shell_refresh`。`open_folder` 今天已有专门的拒绝规则，并入这张表。
- 守护进程的 `SPAWN` 保留给托盘与管理 API（PC 前的用户）；远程侧唯一使用它的是窗口选择页的路径输入行（2026-10-16 恢复，`via_remote=true`——沙箱开着时 spawn 落在沙箱根内、根外文件夹拒绝）。**远程工作台**（remote.html 会话）发起的 `SPAWN` 仍然不存在——远程应用从不发这一帧。

## 4. 设备分类与自适应

### 4.1 分类算法

输入取自**布局视口**，不取视觉视口，否则软键盘弹起会让判断抖动：

- `w`、`h`：`document.documentElement.clientWidth` / `clientHeight`；
- `S` 为短边，`L` 为长边；
- 方向：`matchMedia('(orientation: portrait)')`；
- 触屏能力：`matchMedia('(any-pointer: coarse)').matches || navigator.maxTouchPoints > 0`。iPadOS 的 Safari 会伪装成 Mac，靠 `maxTouchPoints` 识别。

```ts
// src/remote/app/deviceClass.ts
export type DeviceClass = 'phone-portrait' | 'phone-landscape' | 'tablet-portrait' | 'tablet-landscape' | 'desktop';

export function classify(w: number, h: number, touch: boolean): DeviceClass {
	const short = Math.min(w, h), portrait = h >= w;
	if (short < 500) return portrait ? 'phone-portrait' : 'phone-landscape';   // 手机：短边 320–480
	if (touch && short < 1100) return portrait ? 'tablet-portrait' : 'tablet-landscape'; // iPad mini 到 iPad Pro 13
	if (w < 600) return 'phone-portrait';                                       // 被拉窄的桌面浏览器窗口
	if (w < 1024) return portrait ? 'tablet-portrait' : 'tablet-landscape';
	return 'desktop';
}
```

| 典型设备 | 视口（CSS px） | 结果 |
| -------- | -------------- | ---- |
| iPhone 15 竖屏 / 横屏 | 393×852 / 852×393 | phone-portrait / phone-landscape |
| Pixel 7 竖屏 / 横屏 | 412×915 / 915×412 | phone-portrait / phone-landscape |
| 折叠屏展开（Galaxy Z Fold） | 约 690×720 | tablet-portrait |
| iPad mini 竖屏 / 横屏 | 744×1133 / 1133×744 | tablet-portrait / tablet-landscape |
| iPad Pro 13" 横屏 | 1376×1032 | tablet-landscape |
| 13" 笔记本浏览器 | 1440×800（精确指针） | desktop |
| 桌面浏览器窗口拉窄到 500 px | 500×900 | phone-portrait |

### 4.2 稳定性规则

- **防抖**：`resize` 和 `orientationchange` 之后等 150 ms 再判断。
- **键盘期间冻结**：可编辑元素获得焦点时，只允许宽度变化触发重新分类，高度变化一律忽略。这样软键盘弹起或收起都不会切换形态。
- **迟滞**：边界两侧各留 24 px 回差，例如短边在 476–524 px 之间时保持当前形态，避免拖动窗口时来回跳。
- **手动覆盖**：设备级设置"布局：自动 / 手机 / 平板 / 桌面"，缺省为自动。覆盖值写入 `<html data-device>`，算法输出被忽略。
- **切换过程**：先关闭临时浮层（菜单、动作面板、抽屉），再记录导航状态，然后卸载旧布局、挂载新布局（部件的 DOM 节点移动，不重建）。最后重新测量 CodeMirror 与 xterm。浏览器支持时用 View Transitions 做 160 ms 淡入，不支持则直接切换（§10.2）。
- **状态映射**：手机的"当前页"、平板的"主栏和详情"、桌面的"侧栏视图和编辑器"三者互相映射，规则见 §5.6。标签、未保存缓冲、终端、webview 副本都保留。

### 4.3 视口与安全区

- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">`。Android Chrome 108+ 遵守 `interactive-widget`；其他浏览器由 `visualViewport` 补位（现有 `responsive.ts` 的 `--vvh` / `--vv-top`）。
- 高度用 `100dvh`，配合 `@supports not (height: 100dvh)` 回退到 `100vh` 加 JS 写入的 `--vvh`。
- 四个方向都使用 `env(safe-area-inset-*)`：刘海、灵动岛、圆角和 Home 指示条。手机横屏时左右两侧的安全区尤其重要。

## 5. 五种设备形态的交互框架

参考对象：MT 管理器（文件列表、路径栏、长按多选、底部操作栏）、VS Code 与 vscode.dev（桌面形态、命令面板、状态栏远程指示器）、iOS 文件 App 与 Android Material 3（导航栏、导航轨、列表与详情的两栏布局、底部动作面板）。

### 5.1 手机竖屏

```text
┌──────────────────────────────┐
│ ☰  git-graph-studio      ⋮  │ ← App 栏 48：标题为当前页，副标题为窗口 / 分支
│ 📁 / src / features / ...  ▸ │ ← 路径栏 40（文件页）
├──────────────────────────────┤
│ 📁 editor                  › │
│    12 项 · 3 天前              │ ← 行高 60，整行都是点按区
│ 📄 main.ts               M   │
│    4.2 KB · 今天 18:20          │
│ ...                          │
│                         (＋) │ ← 悬浮按钮：上传 / 新建
├──────────────────────────────┤
│ 文件   编辑器  更改   Claude  更多 │ ← 底部导航 56 + 安全区，带徽标
└──────────────────────────────┘
```

- **导航**：底部导航固定 5 项：文件、编辑器、更改（徽标为待提交数）、Claude（回复完成或等待批准时出现圆点）、更多。Git Graph、终端、搜索、扩展页、传输、设置、窗口都在"更多"里。"更多"是一个网格面板，用户可以把常用项拖到底部导航，替换第 4 个位置。
- **层级**：每个底部导航项是一个独立的页面栈。打开文件时，编辑器页压在当前栈上。返回手势、系统返回键和 App 栏的返回按钮都弹出栈顶（沿用 `backStack.ts`）。
- **手势**：从左边缘滑动返回；在列表上下拉刷新；长按进入多选；在"更改"页的行上左滑露出"暂存 / 放弃"；在编辑器里双指缩放字号。
- **点按目标**：不小于 48×48 px，行高 60 px，相邻点按区间距不小于 8 px。

### 5.2 手机横屏

```text
┌──┬──────────────────────────────────────────────────────┐
│📁│ ‹ main.ts — src/                          🔍 ✎ ⋮    │ ← 顶栏 40
│✎ │                                                      │
│± │   编辑器 / 列表（全高）                                 │
│✦ │                                                      │
│⋯ │                                                      │
└──┴──────────────────────────────────────────────────────┘
  ↑ 导航轨 56 + 左侧安全区，只有图标
```

- 横屏时高度只有 360–430 px，所以去掉底部导航，换成左侧导航轨，内容区占满全高。顶栏压缩到 40 px，路径栏并入顶栏的副标题。
- 编辑器的辅助键行在软键盘弹起时贴在键盘上方，高度 36 px。
- 文件列表行高降到 52 px，仍然保持单列。横屏手机放两栏后每栏都不足 400 px，可用性反而更差。

### 5.3 平板竖屏

- 左侧导航轨 72 px，带图标和文字。
- 页面单栏显示。文件页点开文件时，编辑器从右侧滑入，盖住 85% 宽度，左边缘露出列表，点露出的部分即可返回。这是平板竖屏常见的列表与详情交互。
- 支持硬件键盘快捷键（§5.7）和指针悬停。

### 5.4 平板横屏

```text
┌──┬───────────────┬──────────────────────────────────┬─────────────┐
│📁│ 📁 / src  ▸    │ main.ts ×  app.ts ×               │ Claude      │
│✎ │ 📁 editor    › │                                  │ (≥1180 px)  │
│± │ 📄 main.ts   M │   编辑器                          │             │
│✦ │ ...           │                                  │ 对话         │
│⋯ │ 主栏 320，可折叠 │                                  │ [输入框] ➤  │
└──┴───────────────┴──────────────────────────────────┴─────────────┘
```

- 导航轨、主栏（320 px，可折叠）、详情区三栏。主栏显示当前导航项的列表：文件、更改或搜索结果；详情区显示编辑器、差异或 Git Graph。
- 宽度达到 1180 px 时，Claude 可以固定为右侧栏（相当于 VS Code 的辅助侧栏），一边看代码一边发指令。
- 编辑器标签条恢复显示，可以拆分成两组。

### 5.5 桌面浏览器

- 采用 VS Code for the Web 的布局：活动栏、侧栏、编辑器分组、面板、状态栏。外观与 PC 桌面一致，但菜单按远程命令配置过滤，并且没有窗口控制按钮。
- **状态栏最左侧是远程指示器** `>< GGS: <PC 名>`，颜色取 `statusBarItem.remoteBackground`。点击后打开快速选择：切换窗口、省流模式、传输中心、查看 PC 屏幕、连接信息、退出登录。
- **状态栏右侧**显示连接质量（RTT 圆点）和传输进度。
- 上下文菜单用浮动菜单，快速输入在顶部居中，和 PC 一样。
- 文件可以从本机拖到资源管理器的某一行或空白处，即上传到该目录；资源管理器的右键菜单有"下载""打包下载"。

### 5.6 形态切换时的状态映射

| 手机（页面栈顶） | 平板（导航项 + 详情） | 桌面（侧栏视图 + 编辑器） |
| ---------------- | --------------------- | ------------------------- |
| 文件 › 某目录 | 文件 + 主栏定位到该目录 | 资源管理器展开并选中该目录 |
| 编辑器 › a.ts | 原导航项 + 详情显示 a.ts | 侧栏保持 + a.ts 为活动编辑器 |
| 更改 › a.ts 的差异 | 更改 + 详情显示差异 | 源代码管理 + 差异编辑器 |
| Claude | Claude 在详情区，或固定在右侧栏 | Claude 侧栏视图 |
| 更多 › 终端 | 终端在详情区 | 面板显示终端 |

### 5.7 键盘（平板外接键盘与桌面）

沿用 VS Code 的快捷键：`Ctrl/⌘+P` 快速打开、`Ctrl/⌘+Shift+P` 命令面板、`Ctrl/⌘+S` 保存、`Ctrl/⌘+F` 查找、`Ctrl/⌘+B` 切换主栏或侧栏、`` Ctrl+` `` 终端、`Ctrl/⌘+Enter` 发送 Claude 消息。手机形态不响应这些快捷键，只保留编辑器内的快捷键。

## 6. 页面规格

### 6.1 文件页（手机与平板主栏，参考 MT 管理器）

**结构（从上到下）**

1. **路径栏**：根目录图标加各级目录的标签，可以横向滚动，进入新目录时自动滚到末尾。点按某一级直接跳转；长按复制该路径；末尾的 `▸` 列出同级目录，用于快速换到兄弟目录。
2. **工具条**（列表向下滚动时隐藏，向上滚动时出现）：搜索框（过滤当前目录，输入后 300 ms 生效）、排序按钮、视图按钮。
3. **列表**：平铺显示**当前目录**的内容，不再是树。

**行规格**

| 项 | 手机竖屏 | 手机横屏 | 平板 |
| -- | -------- | -------- | ---- |
| 行高 | 60 | 52 | 52 |
| 图标 | 32，按文件类型着色（`fileIcons.ts`） | 28 | 28 |
| 第一行 | 文件名 16 px。名字过长时省略中间、保留扩展名（`very-long-na…me.ts`） | 15 px | 14 px |
| 第二行 | 12 px 次要色。文件夹显示"12 项 · 3 天前"，文件显示"24.3 KB · 10-14 18:20" | 同左 | 同左 |
| 右侧 | git 状态字母（M / U / A / D，用 `gitDecoration.*` 颜色），文件夹另有 `›` | 同左 | 同左 |

**交互**

| 操作 | 结果 |
| ---- | ---- |
| 点按文件夹 | 进入该目录，路径栏随之更新，进入动画 120 ms |
| 点按文件 | 在编辑器页打开，默认只读，带解锁按钮（沿用 `editLock.ts`）。二进制或超大文件进入"打开方式"面板：十六进制视图、大文件查看器、下载 |
| 返回 | 回到上一级目录，并恢复该目录离开时的滚动位置（本端记忆，不同步） |
| 长按任意行 | 弹出该行的动作面板（以文件名为标题）：打开/进入、下载（文件夹打包下载、上传到此）、重命名、删除、复制路径、多选（2026-10-16 修订——所有者指示"长按要弹出菜单"；多选经菜单进入，进入时该行选中并震动 10 ms，只有 Android 支持 `navigator.vibrate`）。多选进行中的长按仍是切换该行 |
| 行尾的 ⋮ | 同一动作面板的另一入口（44 px 目标，始终可见）；`contextmenu`（Android 长按的追随事件、鼠标右键）也打开它 |
| 多选模式 | 每行左侧出现复选框；App 栏显示"已选 3 项"、全选和取消；底部操作栏提供下载、删除、重命名（单选时可用）、复制路径、更多（移动到、复制到）。下载多项时自动打包成 zip |
| 下拉 | 刷新当前目录 |
| 悬浮按钮 ＋ | 打开动作面板：上传文件、上传文件夹（按能力显示）、新建文件、新建文件夹 |
| 排序 | 动作面板：名称、修改时间、大小、类型 × 升序 / 降序，文件夹始终在前；"显示隐藏文件"开关。按设备记住 |

**数据**

- 进入目录时调用 `list_dir_page`，每页 200 条。列表底部放一个 `IntersectionObserver` 哨兵，滚到底自动加载下一页，取代今天的"加载更多"按钮。
- 目录内容按需拉取（§7.1 的 D 档），不预取子目录。监视器推送变化时，只有当前显示的目录会重新拉取。
- `.git` 目录始终隐藏。

**桌面浏览器形态**：保留 VS Code 式的树，右键菜单增加"下载 / 打包下载 / 上传到此处"，并支持把本机文件拖入。

### 6.2 编辑器页

- **手机**：默认自动换行，字号 14 px，可以双指缩放，缩放值按设备记住。App 栏显示文件名、所在目录和解锁按钮（✎）。溢出菜单：查找、转到行、下载此文件、复制路径、在 Git Graph 中查看历史。
- **辅助键行**（软键盘弹起时出现，沿用 `editorAccessory.ts`）：Tab、← → ↑ ↓、撤销、重做、注释、查找、保存。
- **打开的文件列表**：点按底部导航的"编辑器"打开面板（沿用 `editorSwitcher.ts`），每行左滑可以关闭。
- **空状态页**（2026-10-16 重设计，所有者指示"要更好用,更专业"）：工作区的小仪表盘——图标砖与工作区名、仓库卡（分支 + ↓n/↑n + 待变更数，一点到更改页）、三个入口磁贴（浏览文件 / 转到文件 / 查看变更）、"已打开的编辑器"与"本机最近打开"两个列表（最近为本设备 MRU，只列仍在打开文件夹内的文件；见顶部落地记录）。
- **大文件**：沿用 `openThreshold.ts` 的窗口化编辑器。
- **保存冲突**：见 §7.3。

### 6.3 更改页

- 顶部是提交输入框和"提交"按钮，滚动时吸顶；溢出菜单里有拉取、推送、同步、暂存全部。
- 分组为合并冲突、已暂存、更改，组标题可以折叠。行布局：文件名在上、目录在下、状态字母在右。
- **行手势**：左滑露出"暂存"（或"取消暂存"）与"放弃"，放弃需要二次确认；点按打开差异。
- **差异视图**：手机上是行内统一差异；平板横屏和桌面是左右并排。上一处、下一处差异的按钮浮在右下角。
- 组的展开状态只在本端保存。行数据按需拉取，组折叠时不拉行（§7.1）。

### 6.4 Claude 页

> **2026-10-16 修订**(所有者第五轮指示,见顶部落地记录):远程 Claude **使用原始界面**——整页(对话区与输入框)都是 PC 上那份 Claude 页面的流式副本,打字、发送、停止、权限卡、问题卡、模型选择全部直接在副本里操作,经副本输入回放进入 PC 的真实页面。下文描述的"本端原生输入框/原生卡片"已随 S2 会话桥撤回,仅作历史。

- **对话区**是 PC 上那份聊天页面的流式副本。用户可以自由上下滚动，滚动只在本端发生；位于底部时自动跟随新内容，离开底部时出现"↓ 新消息"按钮。
- **输入框**是副本里 Claude 自己的输入框：远程的打字经回放进入 PC 的真实输入框,PC 的回显(含 PC 用户自己打的字)随副本流回。
- **发送**：点副本里 Claude 自己的发送按钮(回复进行中它显示"停止",点击即中断)。
- **批准与提问**：直接点副本里的原卡片,点击照常回放到 PC。
- **后台提醒**：页面在后台时，如果回复完成或需要批准，底部导航的 Claude 项出现圆点，标签页标题变成"● 需要批准 — GGS"；在浏览器允许的范围内发送系统通知（§10.3 第 10 项）。

### 6.5 Git Graph 页

- **沿用现有代码**：PC 窗口里只有一个 Git Graph 面板，在 PC 窗口隐藏时也一样；远程看到的是它的流式副本（§9）。
- 只同步"打开了"和"关闭了"，以及它是不是活动标签：一端打开或关闭 Git Graph，其他活跃前端跟着打开或关闭（`workbenchSync` 的 `activeTab` / `closeTab`，与今天相同）。
- 滚动不同步：同一时间只有一端在看时，那一端的滚动驱动这个唯一的面板，不会影响别人；两端同时看时，按 §9.2 的滚动所有权处理。
- 仓库变化时，扩展自己会推送 `refresh`，面板刷新后由副本带给所有观看者。
- 页面内部的交互属于扩展本身，GGS 不改。手机上允许双指缩放；手机横屏时 Git Graph 占满内容区，隐藏 App 栏，轻点顶部唤出。

### 6.6 终端页

- 只有打开了终端页的前端才订阅终端输出；离开终端页 30 秒后退订，回到页面时补拉最近 64 KB 的回滚内容。
- **按键行**：Esc、Tab、Ctrl（粘滞）、Alt、← → ↑ ↓、`|`、`~`、`/`、`-`，可以横向滚动（沿用 `terminalKeys.ts`）。
- **尺寸**：PTY 只有一个尺寸，跟随最近一次输入的前端。另一端用 CSS 缩放显示，不会出现折行错乱。
- 双指缩放字号，按设备记住。

### 6.7 传输中心

- **入口**：文件页的悬浮按钮和多选操作栏、编辑器页的"下载此文件"、桌面形态的右键菜单与拖放。进度显示在状态栏（桌面）或底部导航上方的进度条（手机）。
- **上传**：分块续传（今天的 `fs_write_chunk` / `fs_upload_offset`），可以暂停、继续、取消、重试失败项。页面被切到后台或断网后，回来时从 `fs_upload_offset` 返回的位置继续。同名冲突时询问：保留两者（加 ` (copy)` 后缀）、覆盖、跳过，并提供"对其余项执行相同操作"的选项。
- **下载**：单个文件走票据 URL，响应带 `Content-Disposition: attachment; filename*=`，由浏览器自己的下载管理器接管。文件夹或多个文件打包成 zip。多个文件打包需要守护进程新增"多路径打包"能力，与现有的文件夹打包共用 `zip_tree`。
- **列表**：进行中、已完成、失败三组，每项显示文件名、大小、速度、剩余时间，失败项附原因。完成的记录在本端保留 24 小时。
- **省流模式**：上传与下载不受限制，因为这是用户明确发起的操作；但会在开始前提示总大小。

### 6.8 更多页：窗口与连接

- **PC 卡片**：PC 名、连接方式（局域网或 Hub）、RTT、本次会话的流量。
- **窗口**：列出 PC 上的每个 GGS 实例（文件夹名、分支、未保存数、PC 端状态），点按切换，不提供新建。每行显示 PC 端状态徽标："PC 上已打开"（绿点）或"PC 上已关闭"（灰点，实例仍在后台运行）。行的溢出菜单提供"在 PC 上关闭窗口"和"在 PC 上打开窗口"，两者都不会断开远程会话（§17）；另有"退出此实例"，二次确认后执行，有未保存文件时会先列出。守护进程的窗口选择页（`web/picker.js`）使用同样的徽标与菜单。
- **其他入口**：Git Graph、终端、搜索、扩展视图、传输中心、设置、省流模式开关、查看 PC 屏幕、断开、退出登录。
- **查看 PC 屏幕**是现有的副本模式（ggs-remote-plan.md §22），作为一个全屏页打开。它只用来查看 PC 上弹出的原生对话框之类的情况，不再是默认入口，也不会改变 PC 窗口的尺寸或外壳（§11）。

### 6.9 设置

远程的设置页按 remote-linkage-and-settings-plan.md §5.5（作用域）和 §9.10（共享模型）实现。手机与平板沿用逐级钻入的页面，桌面形态使用 §9 的设置编辑器。另外增加"远程"分类，包含：布局（自动 / 手机 / 平板 / 桌面）、省流模式、Claude 发送键、文件列表的排序和隐藏文件。这些都是设备级设置。

## 7. 同步策略

### 7.0 同步的参与者：活跃前端

**活跃前端的定义**：

| 前端 | 什么时候算活跃 |
| ---- | -------------- |
| PC 窗口（`main`） | 窗口可见（未隐藏、未最小化） |
| 远程页面（`remote/<n>`） | 已连接，并且页面在前台（`document.visibilityState === 'visible'`） |

**规则**：

1. **门控**：只有活跃前端数不少于 2 时，前端才发送 §7.2 的 S 档意图消息。只有一个活跃前端时一条都不发（K11）。数量由 §7.0.1 的在场表给出，每个前端在本地判断，不需要再多一次往返。
2. **多个远程**（K10）：远程与远程之间的同步和远程与 PC 之间完全一样。消息经 Relay 转给其他所有监听的会话；每条消息带发送方的前端 id，接收方忽略自己的回声（今天 `workbenchSync` 的规则）。§18 的测试矩阵包含"PC 关闭，两个远程同时在用"。
3. **追平**：一个前端从不活跃变为活跃时，例如 PC 窗口重新显示、远程页面从后台回来、新的远程连上，它先发一次 `stateRequest`。最近一个活跃的其他前端用 `stateSnapshot` 回答，内容为：打开的标签（输入的 id，不含文件内容）和活动标签。收到后按以下方式合并，然后才开始发送意图消息：
   - **标签取并集**：对方有、自己没有的标签，在本端打开（后台打开，不抢焦点）；自己有、对方没有的标签，向对方发 `open`。任何一方都不因为追平而关闭标签，未保存的缓冲永远不会被关掉。
   - **活动标签取最近活跃的一方**：如果新加入的是 PC 窗口，就切换到远程最近的活动标签。这样 PC 用户回到电脑前，看到的是远程刚刚在看的文件（K14，所有者已确认）。
   - 没有其他活跃前端时，跳过追平。
   - 快照大小：20 个标签约 1.5 KB，只在状态变化时发生，不周期发送。
4. **不受门控影响的流**：Claude 会话副本、Git Graph 面板副本、终端输出、SCM 计数。它们是"把唯一的数据源显示给正在看的人"，不是同步：只要有人在看就传输，没人看就停止。

#### 7.0.1 在场表

- 每个前端在变为活跃或不活跃时发送 `{ k: 'presence', by, active, device }`，约 80 B，另外每 60 秒发一次心跳。只有一个活跃前端时也照发，因为别人要靠它判断门控。
- PC 一侧还会在窗口显示或隐藏时通过守护进程更新 `visible` 字段（今天已有）。远程把 `visible` 当作 PC 是否活跃的权威来源，在场消息作为补充。
- 心跳超过 150 秒未到达的前端视为不活跃。

### 7.1 三档

| 档 | 含义 | 机制 |
| -- | ---- | ---- |
| **S 同步** | 一端变了，另一端马上跟上 | `studio://workbench-sync` 的意图消息（每条约 100 B），以及后端事件 |
| **D 按需** | 只有正在看的那一端才去拉取，不推送 | 请求加应答；带版本号，未变化时回 304 或零字节 |
| **L 本端** | 永不过线 | 内存或按 PC 隔离的 `localStorage` |

### 7.2 逐项归档

| 状态 | 档 | 方向 | 说明 |
| ---- | -- | ---- | ---- |
| 打开文件（路径加行锚点） | **S** | 双向 | K7。消息 `open` |
| 关闭文件标签 | **S** | 双向 | `close`。关闭有未保存修改的标签时，只在发起关闭的一端询问 |
| 切换活动标签 | **S** | 双向 | `active` / `activeTab`。所有者已确认（K9） |
| 打开或关闭扩展页（Claude、Git Graph）、差异、文件历史 | **S** | 双向 | `activeTab` / `closeTab` / `openTab`，与今天相同 |
| 文件内容的编辑、未保存状态 | **L** | — | K7。每端有自己的缓冲。保存写入磁盘后，另一端由监视器触发 `reloadIfClean`，有冲突时按 §7.3 处理 |
| 光标、选区、滚动、折叠、查找条 | **L** | — | |
| 侧栏视图切换、侧栏隐藏、手机的当前页 | **L** | — | **变更**：删除今天的 `view` / `sidebar` 两类消息（G8） |
| 布局、主题、字号、语言、排序 | **L** | — | 设备级设置 |
| Claude 对话内容（消息、流式回复、工具输出、卡片） | **S** | PC → 远程 | 流式 DOM 副本（~~排除输入框（§8）~~ 第五轮起整页都在副本里） |
| Claude 的发送、停止、批准、回答问题、选择模型或模式 | 随副本 | 远程 → PC | ~~命令消息（§8.2）~~ 第五轮撤回：直接操作副本里 Claude 自己的控件，经输入回放 |
| Claude 会话状态（忙碌、待批准、待回答、模型、模式） | 随副本 | PC → 远程 | ~~`chatState`~~ 第五轮撤回：状态就在副本页面上，随 DOM 流过线 |
| Claude 输入框的内容、光标、焦点 | 随副本 | 双向 | ~~K7 排除~~ 第五轮撤回：原始界面的输入框在副本里，打字经回放、回显随副本 |
| Claude 对话区的滚动 | **L** | — | |
| Git Graph 是否打开 | **S** | 双向 | K7 |
| Git Graph 的滚动 | **不同步** | — | K7。只有一端在看时，它的滚动驱动唯一的面板；同时看时由滚动所有者驱动（§9.2） |
| Git Graph 的选择、展开的提交、搜索 | 随面板 | PC 面板 → 观看者 | 页面只有一份，这些是页面本身的状态，会随副本显示；它们只在页面里，不会发出同步消息 |
| Git Graph 的数据 | **D** | — | 面板按需向引擎请求，副本只传渲染出来的行 |
| 目录列表、文件内容、搜索结果、差异 | **D** | — | 打开或展开时才拉取 |
| SCM 计数（徽标） | **S** | PC → 远程 | 只推数字 |
| SCM 的行 | **D** | — | 组展开时拉取 |
| 终端输出 | **S（只给订阅者）** | PC → 订阅的前端 | §6.6 |
| 终端输入 | **S** | 远程 → PC | |
| 通知 | **S（只给发起的前端）** | | 扩展发出的通知路由到发起请求的前端，系统通知只留在 PC |
| 共享设置 | **S** | 双向 | remote-linkage-and-settings-plan.md §5.5 |
| 窗口列表 | **S** | 守护进程 → 远程 | 今天的 `WINDOWS` 帧 |

### 7.3 保存冲突

一端保存时，另一端的处理：

- 那一端**没有**未保存修改：静默重新加载，并在标签上闪一下"已在另一设备上更新"的提示，1.5 秒后消失。
- 那一端**有**未保存修改：编辑器顶部出现信息条"此文件已在 <设备> 上保存。" 提供三个按钮：比较（打开差异）、使用磁盘版本、保留我的版本（下一次保存时覆盖）。行为与 VS Code 的保存冲突一致。
- 实现：`onFsChanged` 中 `reloadIfClean` 跳过的脏文件，改为标记冲突。冲突以文件的 mtime 和内容哈希判断，避免监视器回声误报。

### 7.4 流量预算（验收线）

测量方法：`tests/remoteTraffic.test.ts` 用模拟线路计算，`scripts/probes/remote-live-check.mjs` 在真实链路上实测，结果写入 `metrics.json` 的 `remote.traffic`。数字是下行字节数（含帧头，压缩后）。

| 场景 | 预算 | 今天 |
| ---- | ---- | ---- |
| 空闲 60 秒（页面开着，不操作） | ≤ 2 KB | 取决于 PC 画面上的动画 |
| 在文件页进入 5 个目录（每个 50 项） | ≤ 12 KB | 树展开加 DOM 副本 |
| 打开一个 200 KB 的文件并浏览 30 秒 | ≤ 60 KB（内容只拉一次） | |
| 在远程编辑 50 次按键并保存一次 | 下行 ≤ 1 KB；上行为保存的内容本身 | |
| 在 Claude 输入框里打 100 个字（不发送） | ~~**0 B**~~（已随第五轮撤回作废——原始界面的打字经副本回放过线） | 每个按键都有一次回放和回显 |
| 发送一条消息，回复流式 12 秒 / 360 token | ≤ 7 KB | 7.0 KB（ggs-remote-plan.md §22.8） |
| Git Graph 快速滚动 2 秒 | ≤ 7 KB（沿用现有的批量折叠） | 6.8 KB（ggs-remote-plan.md §22.8） |
| PC 窗口关闭，单个远程打开、切换、关闭 20 个文件 | 同步消息 **0 B**（门控，K11） | 每次操作约 100 B 广播 |
| PC 窗口重新显示（追平 20 个标签） | ≤ 2 KB，一次性 | 无追平 |
| PC 打开一个文件，远程跟着打开 | ≤ 300 B 意图消息加文件内容（D 档） | |

## 8. Claude 会话桥

> **已撤回**(2026-10-16,所有者第五轮指示——见顶部落地记录):远程 Claude 使用**原始界面**,本节描述的原生输入框、原生卡片与 chat/chatAck/chatState 桥不再存在,以下仅作历史记录。现状:副本包含 Claude 自己的输入框,打字与点击经副本输入回放进入 PC 的真实页面。

### 8.1 副本排除输入框

- `DomRecorder` 新增 `skip(node) => boolean` 选项。被跳过的子树只记录一个空占位元素，保留它的尺寸，这样布局不会塌陷；该子树内的变更、表单值、焦点和光标都不再记录。
- 跳过规则由会话驱动提供：`claudeChatInject.ts` 新增 `chatComposerRoot(doc)`，复用 `chatControls` 中已有的输入框定位逻辑。
- 只对桥接扩展的聊天流启用这一规则。挂载条件沿用 `aiProviders.ts` 的方式，由后端的 `bridgedExtIds` 决定，`src/` 下仍然不出现扩展 id。
- 远程副本中占位区域被隐藏，原生输入框放在副本容器之外的底部。

### 8.2 消息

沿用 `MIRROR_UP` / `MIRROR_DOWN` 通道，`w` 字段是流 id（`view:<id>` / `panel:<ext>#<id>`）：

```ts
// 远程 → PC
type ChatUp =
	| { k: 'chat'; w: string; id: string; op: 'send'; text: string }
	| { k: 'chat'; w: string; id: string; op: 'stop' }
	| { k: 'chat'; w: string; id: string; op: 'permission'; decision: 'allow' | 'allowAlways' | 'deny' }
	| { k: 'chat'; w: string; id: string; op: 'answer'; answers: ChatAnswer[] }
	| { k: 'chat'; w: string; id: string; op: 'model'; model: string }
	| { k: 'chat'; w: string; id: string; op: 'mode'; mode: string };

// PC → 远程：每个操作的回执，以及有变化时推送的状态
type ChatDown =
	| { k: 'chatAck'; w: string; id: string; ok: boolean; error?: string }
	| { k: 'chatState'; w: string; busy: boolean; model: string; mode: string;
	    permission?: { title: string; detail: string };
	    question?: { prompt: string; options: { label: string; description?: string }[]; multi: boolean }[] };
```

- **PC 一侧**（新文件 `src/remote/mirror/chatBridge.ts`）：通过 `webviewFrames.ts` 找到聊天页的框架，再调用 `claudeChatInject.ts` 已有的函数：`setChatInput`、`pressSend`、`interruptChat`、`answerChatPermission`、`answerChatQuestion`、`pickChatModel`、`setChatPermissionMode`。
- **不覆盖 PC 的草稿**：执行 `send` 时，先读出 PC 输入框的当前内容，然后填入远程的文本、发送，发送完成后把原草稿写回。PC 前的用户正在打的字不会丢。
- **状态推送**：`chatState` 由 PC 侧监听聊天页的 DOM 变化计算（`chatBusy`、权限卡片、问题卡片是否存在），合并 100 ms 内的变化，只在状态真的改变时发送。
- **远程一侧**（新文件 `src/remote/app/chat/composer.ts`、`chatCards.ts`）：原生输入框、本端队列、权限与问题卡片、模型与模式选择器。

### 8.3 时序

```text
远程                      PC chatBridge                     Claude 页面（PC）
 │ chat{op:send,id}  ───▶ │ 保存草稿 → setChatInput → pressSend ─▶ │
 │ ◀─── chatAck{ok}       │ 写回草稿                              │
 │ ◀─── chatState{busy}   │ ◀──────── DOM 变化（开始回复） ─────── │
 │ ◀─── 副本增量（回复令牌）│ ◀──────── DOM 变化（流式输出） ─────── │
 │ ◀─── chatState{permission} ◀────── 出现权限卡片 ─────────────── │
 │ chat{op:permission} ─▶ │ answerChatPermission ───────────────▶ │
 │ ◀─── chatState{busy:false}  回复结束；远程本端队列发出下一条          │
```

### 8.4 失败处理

- PC 上没有打开聊天页：PC 侧先确保视图显示出来（`ensureWebviewShown`），重试一次后仍失败，回执 `ok: false`，远程把文本留在输入框里并提示原因。
- 驱动找不到输入框或发送按钮（例如 Claude 页面改版）：回执附带错误信息，同时写入扩展宿主日志（`extLog`）；远程回退为"在副本中操作"的提示。
- 断线：本端队列保存在 `sessionStorage`，重连后按顺序重发；操作 id 用于去重。

## 9. Git Graph：沿用现有同步，加滚动所有权

### 9.1 现状（已核实）

已安装的 git-graph-rs 1.0.26 是一个普通的 VS Code 扩展：后端是 `node` 类型，入口为 `out/extension.js`；视图由 `gitGraphView.js` 用 `createWebviewPanel` 创建，页面与扩展通过 `postMessage` 往返，全局只有一个面板（`GitGraphView.currentPanel`）。所以 Git Graph 页面不能在每一端各开一个独立实例；扩展只认这一个面板。

今天的多端同步链路已经可用，本计划直接沿用：

| 环节 | 现有实现 | 本计划的处理 |
| ---- | -------- | ------------ |
| 唯一的面板放在 PC 窗口（隐藏时也在） | `ext_routing` 的 `WEBVIEW_HOME`（所有 webview 请求都路由到桌面窗口） | 不变 |
| 远程看到的是面板的副本 | `webviewShare.ts`（PC）→ `webviewCopy.ts`（远程），录制器带字符串增量、动画采样、批量折叠 | 不变 |
| 打开、关闭、活动标签跨端 | `workbenchSync` 的 `activeTab` / `closeTab`，标签 id 为 `webview:<extId>:<panelId>`，各端相同；面板销毁时，后端的 dispose 镜像会清掉所有副本 | 不变，并接入 §7.0 的门控 |
| 后加入的前端恢复面板 | `ext_process_registrations` 回放登记日志，包括面板的创建参数 | 不变；§18 增加专项测试 |
| 虚拟列表跟随观看者滚动 | 副本把滚动比例发给 PC（`k:'scroll'`），PC 把面板滚到同一位置，渲染出观看者要看的那一屏 | 改为只接受"滚动所有者"的回放（§9.2） |

### 9.2 滚动所有权

- **只有一端在看 Git Graph**（远程控制最常见的情况，PC 窗口关闭或者 PC 用户在看别的标签）：这一端就是滚动所有者，它的滚动回放给唯一的面板，效果等同于独立实例。今天的代码就是这样工作的，无需改动。
- **两端同时在看**：最后一次与 Git Graph 交互（滚轮、触摸、按键）的那一端获得滚动所有权，持有 3 秒，之后如有交互再续期。只有所有者的 `scroll` 回放会被 PC 执行，其他端发来的滚动被忽略，它们的副本跟随所有者显示的那一屏。非所有者的标题栏上显示一行小提示："滚动跟随 <设备名>"。
- **PC 用户正在看**（窗口可见且 Git Graph 为活动标签）：PC 用户的滚轮和触摸同样计为交互，所以 PC 用户滚动时，远程不会把他的画面拽走。
- **实现**：`replay.ts` 收到 `scroll` 时检查所有权表（键为流 id，值为前端 id 和到期时间）；`webviewShare.ts` 在 PC 本地的交互事件上续期 `main` 的所有权。改动不超过 100 行。

### 9.3 可选的完全独立（不在本期范围）

如果以后要求"两端同时看、各自滚动"，唯一可行的路线是让宿主为每个前端分出一个面板 iframe：进站消息带上来源，出站消息按 `command` 字段关联回请求方，没有匹配项的（例如 `refresh`）广播给所有面板。Git Graph 的扩展状态绑定在唯一的面板上（最近加载的仓库、提交缓存、未提交改动的轮询），两份请求交错时有串扰风险。这条路线需要覆盖全部 85 种消息的契约测试，本期不做，列在 §16 Q-3。

## 10. 浏览器兼容性

### 10.1 支持分级

| 级别 | 浏览器与下限 | 承诺 |
| ---- | ------------ | ---- |
| **A** | Chrome / Edge ≥ 103（Windows、macOS、Linux、Android）；Safari ≥ 16.4（macOS 13 以上，iOS / iPadOS 16.4 以上；iOS 上的所有浏览器都使用 WebKit，按同版本的 Safari 计）；Firefox ≥ 115 ESR（桌面与 Android） | 全部功能可用；CI 跑 Playwright 矩阵；每次发布做真机检查 |
| **B** | Samsung Internet ≥ 20；App 内置浏览器：微信、QQ、钉钉、飞书（Android 上取系统 WebView ≥ 103，iOS 上即 WKWebView）；华为、小米、vivo、OPPO 的系统浏览器（Chromium ≥ 103 内核） | 核心功能可用：文件、编辑、更改、Claude、上传下载；每次发布做真机冒烟测试 |
| **C** | 更早的版本 | 显示"浏览器版本过低"页面，附升级说明，不保证可用 |

下限的依据是线路压缩用到的 `CompressionStream('deflate-raw')`：Chrome 103、Firefox 113、Safari 16.4。第 10.2 节的第 1 项会为更旧的浏览器提供回退，回退完成后再评估是否下调 A 级下限。

### 10.2 已知缺口与对策

| # | 能力 | 问题 | 对策 | 阶段 |
| - | ---- | ---- | ---- | ---- |
| 1 | `CompressionStream('deflate-raw')` | 构建目标为 `chrome100` / `safari16`，但这两个版本缺这个 API，帧收发会失败（G10） | 先做特性检测；不支持时懒加载 fflate（MIT 许可，约 8 KB gzip），只在缺失时下载。构建目标对齐到 §10.1 的下限 | C0 |
| 2 | `:has()` | Firefox 115 ESR 不支持，3 条规则失效（G11） | 用 JS 维护的类名替代 | C0 |
| 3 | View Transitions | Firefox 与旧版 Safari 没有 | 作为渐进增强，不支持时直接切换 | A2 |
| 4 | `100vh` | iOS 上会被工具栏挤出屏幕 | 用 `dvh` 并提供回退（§4.3） | C0 |
| 5 | `interactive-widget` | 只有 Android Chrome 108+ 支持 | 用 `visualViewport` 统一处理软键盘 | 已有 |
| 6 | 输入框自动放大 | iOS Safari 在聚焦字号小于 16 px 的输入框时会放大页面 | 所有输入框字号不小于 16 px | C0 |
| 7 | 长按 | iOS 会弹出系统的选择或分享菜单；Android 会触发 `contextmenu` 事件；iOS 不会 | 列表行设置 `-webkit-touch-callout: none` 和 `user-select: none`；统一用 `gestures.ts` 的计时器识别长按（450 ms、移动容差 10 px），屏蔽重复触发的 `contextmenu` | P1 |
| 8 | 输入法组字 | Safari 在 `compositionend` 之后仍会派发一次 `isComposing === false` 的 Enter | 发送的快捷键检查 `isComposing`、`keyCode === 229`，并在 `compositionend` 之后 50 ms 内忽略 Enter | S2 |
| 9 | 剪贴板 | 只能在安全上下文中、由用户手势触发；Firefox 网页基本不能读剪贴板 | 写入用 `navigator.clipboard.writeText`，失败时回退到 `execCommand('copy')`；粘贴依赖系统的长按菜单 | P2 |
| 10 | 系统通知 | iOS 只有添加到主屏幕的 PWA 才能使用（16.4+） | 优先在页面内提醒：底部导航圆点、标签页标题、Android 震动；能用系统通知时再发 | S2 |
| 11 | 上传文件夹 | iOS / iPadOS 的 Safari 不支持 `webkitdirectory` | 检测为 iOS / iPadOS（`maxTouchPoints > 1` 且平台为 Mac 或 iPhone / iPad）时隐藏"上传文件夹"，改为"选择多个文件" | P1 |
| 12 | 下载 | iOS 13+ 支持 `<a download>`；但 PWA 独立模式中下载会在内置预览里打开 | 统一用票据 URL 加 `Content-Disposition: attachment`；独立模式下改用 `window.open`，交给 Safari 处理 | P1 |
| 13 | 后台断线 | iOS 在后台约 30 秒后会挂起 WebSocket；页面可能从往返缓存（bfcache）恢复 | 监听 `pageshow`（`persisted` 为真时）与 `visibilitychange`，立即重连；守护进程有 120 秒的恢复环 | 已有，C0 补测 |
| 14 | Service Worker | 需要受信任的证书；局域网自签证书在 iOS 上需要安装 CA 描述文件 | 没有 Service Worker 时功能照常，只是没有预缓存；登录页提示安装 CA | 已有 |
| 15 | 悬停 | 触屏设备没有悬停 | 只在悬停时显示的控件包在 `@media (hover: hover)` 里，触屏上始终显示或放进菜单 | A2 |
| 16 | 内存 | iOS 对单个标签页的内存限制严格 | 远程首屏只加载外壳和当前页；CodeMirror 语言包、xterm、Git Graph 都懒加载；包体积记录到 `metrics.json` 的 `remote.firstPaintJs` | A1 |

### 10.3 检测方式

- 统一入口 `src/remote/app/capabilities.ts`：在启动时一次性检测上表涉及的能力，结果写到 `<html data-cap-*>` 属性，并导出给 JS 使用。
- 不按 UA 判断浏览器版本。唯一的例外是第 11 项：iOS 的文件夹上传无法检测，只能按平台判断。
- C 级页面在脚本加载之前判断：内联脚本检查 `WebSocket`、`Promise.allSettled`、`structuredClone`，缺少任一项就跳转到"版本过低"页面。

## 11. PC 桌面侧的变化

- **保留**：打开文件、打开文件夹、新窗口、打开工作区、打开最近，以及原生对话框。
- **"导入 / 导出"是什么**：2026-10-13 起，PC 资源管理器的右键菜单里有四项，文字与远程端相同，在 PC 上的含义却完全不同：

  | 菜单项（中文界面） | 后端命令 | 在 PC 上做的事 |
  | ------------------ | -------- | -------------- |
  | 上传文件到这里… | `fs_import` | 弹出 PC 的原生"打开文件"对话框，从这台 PC 的任意位置选文件，**复制进**右键所在的工作区目录。重名时生成" (copy)"副本，不覆盖；有进度条，可以取消 |
  | 上传文件夹到这里… | `fs_import` | 同上，选的是文件夹，整个复制进来 |
  | 下载 | `fs_export` | 弹出 PC 的原生"另存为"对话框，把这个文件**复制到**这台 PC 的另一个位置 |
  | 下载为 Zip | `fs_export` | 把这个文件夹打包成 zip，保存到这台 PC 的另一个位置 |

  这四项其实是"在同一台电脑的两个目录之间复制"，没有任何东西经过网络。用"上传 / 下载"作名字，只是为了和远程端的菜单保持一致；PC 用户用系统的资源管理器拖放就能完成同样的事。PC 屏幕副本有观看者时，这四项会被隐藏（`transferMenuShown`），因为原生对话框只会弹在 PC 屏幕上，远程看不到。所有者已确认：上传下载只属于远程，PC 端全部删除（K16）。

- **删除清单（K16，前后端一起删）**。远程自己的上传下载走另一条路径：分块写入 `fs_write_chunk` / `fs_upload_offset`、守护进程的票据下载、`zip_tree` 打包。远程会话本来就被拒绝调用 `fs_import` / `fs_export`，所以删除它们不影响远程：

  | 位置 | 删除 | 保留 |
  | ---- | ---- | ---- |
  | `src/features/explorer/transfer.ts` | 桌面分支：`fsImport` / `fsExport` / `fsTransferCancel` 的调用、原生对话框、`transferMenuShown` | `uploadInto` / `downloadTo` 改为只走远程线路（文件可移入 `src/remote/`），进度提示接口 `TransferSink` |
  | `src/features/explorer/explorer.ts` | 桌面右键菜单里的四项 | 远程会话的右键菜单仍然显示这四项 |
  | `src/platform/ipc/fs.ts` | `fsImport`、`fsExport`、`fsTransferCancel` 及其类型 | 其余 fs 接口 |
  | `src-tauri/src/cmd_fs.rs`、`lib.rs` | `fs_import`、`fs_export`、`fs_transfer_cancel` 三个命令及注册 | `zip_tree`（`remote_host.rs` 的打包下载要用）、`copy_into`（从系统拖入的复制，不是上传） |
  | `src-tauri/crates/ggs-fs/src/lib.rs` | 导入引擎、导出引擎及其测试 | 不冲突复制的公共部分，`copy_into` 用得到 |
  | `src/remote/pathGate.ts` | `REFUSED_COMMANDS` 里的这两个条目（命令已经不存在） | 列表本身（§3.3 还要往里加） |
  | `src/remote/mirror/explorerTransfer.ts` | 整个文件（往 PC 菜单里追加传输行的逻辑） | — |
  | 测试 | `tests/transfer.test.ts` 的桌面部分、`cmd_fs.rs` 中 `transfer_tests` 的导入导出用例、`tests/pathGate.test.ts` 的相关断言 | 远程传输的用例（`tests/remote.test.ts`） |
  | 文档 | AGENTS.md 模块 3 中"文件传输"一段改写为只属于远程 | — |

  `scripts/check-ipc.mjs` 和 `tests/ipcContract.test.ts` 会核对前端声明与后端注册，删除后必须两边一致。
- **删除**：
  - 资源管理器右键菜单的"导入 / 导出"；
  - `fs_import` / `fs_export` / `fs_transfer_cancel` 三个命令及其前端与测试。但 `zip_tree` 保留，供远程打包下载使用；从系统拖入的复制（`copy_into`）也保留，它不是上传；
  - 副本模式下追加到 PC 菜单里的传输行（`mirror/explorerTransfer.ts`），因为传输已经是远程端自己的功能；
  - `transferMenuShown` 与它对 `mirror.viewersNow()` 的依赖；
  - 副本的"PC 窗口套上手机外壳"路径：`mirror/phoneShell.ts`、`hostStub.ts` 的 `watchPhoneMode`、`remote_mirror_fit` 的手机路径，以及 `own` 消息。
- **新增**：状态栏右侧的远程在场项 `$(remote) 2`。悬停显示已连接的设备、设备形态、当前文件；点击可以断开某台设备（调用守护进程现有的设备管理 API）。
- **不变**：PC 窗口永远是桌面界面，尺寸由 PC 用户决定。远程端的操作只会作为"打开了什么"的意图，在 PC 上体现出来。

## 12. 设计系统

### 12.1 尺寸

| 项 | 手机竖屏 | 手机横屏 | 平板 | 桌面 |
| -- | -------- | -------- | ---- | ---- |
| 正文字号 | 16 | 15 | 14 | 13 |
| 次要文字 | 12 | 12 | 12 | 12 |
| 列表行高 | 60 | 52 | 52 | 22（VS Code 的树） |
| 最小点按区 | 48 | 44 | 44 | 22 |
| App 栏或顶栏 | 48 | 40 | 48 | 30（标题栏） |
| 导航 | 底部导航 56 | 导航轨 56 | 导航轨 72 | 活动栏 48 |
| 页面左右边距 | 16 | 12 + 安全区 | 20 | — |
| 圆角（卡片、面板） | 12 | 12 | 10 | 4 |

### 12.2 颜色与主题

- 只使用 `--vscode-*` 主题令牌，与 PC 用同一套主题文件。"自动"主题跟随 `prefers-color-scheme`。远程的主题是设备级设置。
- 远程专用的派生令牌集中定义在 `remote.css` 的 `:root` 中，并从主题令牌计算：`--ggs-sep`（分隔线）、`--ggs-surface-raised`（面板与卡片）、`--ggs-scrim`（遮罩）、`--ggs-row-active`。
- git 状态颜色用 `gitDecoration.*`；徽标用 `activityBarBadge.*`；远程指示器用 `statusBarItem.remoteBackground`。缺少这些令牌的主题需要补齐，并纳入 `themeContrast.themes.test.ts` 的 WCAG AA 校验。

### 12.3 图标与动效

- 图标只用 codicon，文件类型图标沿用 `fileIcons.ts`。底部导航和导航轨的图标为 24 px，列表中的文件图标为 32 px。
- 动效时长：进入页面 200 ms（`cubic-bezier(.2,.8,.2,1)`），返回 160 ms，动作面板 220 ms，形态切换 160 ms 淡入。在 `prefers-reduced-motion` 下全部取消。
- 反馈：点按时显示 `--ggs-row-active` 底色 80 ms；长按成功时在 Android 上震动 10 ms；破坏性操作（放弃、删除）一律二次确认，并显示可撤销的提示条（5 秒）。

### 12.4 文案

- 每个字符串都走 `t(key)`，中英文同时提供。新增的键以 `remote.app.*` 为前缀。
- 按钮用动词（"上传""下载""暂存"），状态用名词短语（"已选 3 项""排队中"），错误提示说明原因和下一步（"PC 未打开 Claude，已在 PC 上打开，请重试"）。

## 13. 实施阶段

每个阶段结束时必须满足：`npm run typecheck` 和 `npm test` 全绿；动了后端的阶段，`src-tauri/` 下的 `cargo test --all-features` 与 `cargo clippy --all-targets --all-features -- -D warnings` 全绿；动了守护进程的阶段，`extensions-src/ggs-remote/daemon` 的 `cargo test` 与 `cargo clippy` 全绿；涉及启动、IPC、资源的阶段在 `npx tauri dev` 下实测。新文件在同一次提交中登记到 AGENTS.md 的模块地图。

| 阶段 | 内容 | 主要文件 | 验收 |
| ---- | ---- | -------- | ---- |
| **R0 越权止血** | §3.3 的门禁收紧；远程端的设置不再写入 PC 文件（remote-linkage-and-settings-plan.md 的 R0） | `pathGate.ts`、`settings.ts` | `tests/remote.test.ts`：每个被拒命令一条用例；远程端修改设置后，模拟后端收不到 `settings_write` |
| **C0 兼容止血** | §10.2 的第 1、2、4、6、13 项；构建目标对齐；C 级拦截页 | `frame.ts`、`vite.remote.config.ts`、`remote.css`、`remote.html`、`capabilities.ts` | `frame.ts` 单测：无 `CompressionStream` 时走 fflate，并与原生实现交叉解码一致；Playwright Firefox 跑通 `workbench.spec.ts` |
| **A1 远程组合根与命令配置** | §3.1 的拆分：`Workbench` 拆成"创建服务"和"挂载框架"两段；新建 `src/remote/app/main.ts`；`Command.profiles`；撤回远程的打开文件夹与新窗口；删除 PC 的导入导出（§11） | `workbench/boot.ts`、`workbench/workbench.ts`、`platform/commands.ts`、`workbench/menus.ts`、`remote/app/*`、`features/explorer/*`、`cmd_fs.rs` | `commandSweep.test.ts` 分别在两个配置下运行：远程配置中的每个命令都能执行，且不触发被门禁拒绝的调用；桌面配置中没有传输命令；Rust 测试删除导入导出的用例，保留 `zip_tree` 与 `copy_into` 的用例 |
| **A2 设备分类与布局框架** | §4 与 §5：分类器、稳定性规则、5 种布局、状态映射、键盘快捷键；`data-form-factor` 迁移为 `data-device` | `remote/app/deviceClass.ts`、`remote/app/layouts/{phonePortrait,phoneLandscape,tabletPortrait,tabletLandscape,desktop}.ts`、`remote.css` 拆分为按形态的样式文件 | `deviceClass` 单测覆盖 §4.1 表格的每一行和每个迟滞边界；`remoteResponsive.test.ts` 让 5 种形态互相切换，标签、脏缓冲、终端会话保持不变，键盘弹起不触发重新分类 |
| **P1 文件页与传输中心** | §6.1、§6.7；守护进程的多路径打包；iOS 能力分支 | `remote/app/files/{fileList,pathBar,multiSelect}.ts`、`remote/app/transfers.ts`、`remote/transfer.ts`、守护进程 `http` 下载路由 | `tests/remoteFiles.test.ts`（新）：行布局、进入与返回、滚动位置恢复、长按多选、多选下载打包、排序、无限滚动、隐藏 `.git`；Playwright 的 `transfer.spec.ts` 在 iPhone 与 Pixel 配置下跑通上传与下载 |
| **P2 编辑器、更改、终端** | §6.2、§6.3、§6.6；行左滑；终端订阅与退订 | `remote/app/editor/*`、`remote/app/scm/*`、`remote/terminalKeys.ts`、`pty.rs` 的订阅 | 新增用例覆盖行手势、差异视图按形态切换、终端退订后不再收到输出、回来时补拉回滚 |
| **S1 同步策略** | §7.0 的活跃前端、门控、在场表、追平与多远程同步；§7.2：删除 `view` / `sidebar` 消息；§7.3 保存冲突；SCM 行按需拉取；流量预算测试 | `workbenchSync.ts`、`remote/presence.ts`（新）、`workbench/lifecycle.ts`、`features/editor/dirty.ts` | `remoteWorkbenchSync.test.ts` 改写：只有一个活跃前端时零消息；三个前端（PC 加两个远程）两两同步；追平取并集、不关标签、活动标签取最近活跃方；侧栏切换不再跨端，打开与活动标签仍然跨端；保存冲突信息条的三种处理；`remoteTraffic.test.ts` 覆盖 §7.4 的每一行 |
| **S2 Claude 会话桥** | ~~§8 全部内容；§10.2 第 8、10 项~~ **已撤回**(2026-10-16 所有者第五轮指示,见顶部落地记录——远程 Claude 使用原始界面) | — | — |
| **S3 Git Graph 滚动所有权** | §9.2；其余沿用现有代码 | `mirror/replay.ts`、`mirror/webviewShare.ts` | 只有一端在看时，它的滚动驱动面板（回归今天的行为）；两端同时看时，非所有者的滚动被忽略，提示条出现，3 秒后所有权可以转移；PC 用户滚动时远程不会把他的画面拽走；打开、关闭、活动标签照常跨端 |
| **L1 PC 窗口生命周期** | §17：关闭改为隐藏、远程显示或隐藏 PC 窗口的帧、列表徽标、托盘的"退出 GGS" | `workbench/boot.ts`、`remote_host.rs`、`lib.rs`、守护进程 `ws` / `control.rs` / `registry.rs` / `tray`、`web/picker.js`、`remote/windowSwitcher.ts` | Rust：`Hide` / `Show` 的处理、`visible` 在 1 秒内送达；守护进程集成测试：会话持有者才能发送显示或隐藏的帧，沙箱实例的规则不变；vitest：有远程会话连着时关闭窗口只隐藏 |
| **L2 生命周期与插件稳定性测试** | §18 全部内容 | `scripts/probes/remote-lifecycle-check.mjs`（新）、`tests/e2e/remote/lifecycle.spec.ts`（新）、`tests/remoteLifecycle.test.ts`（新） | §18.4 的发布门槛 |
| **Q 兼容矩阵与视觉基线** | §14 的 Playwright 项目；真机检查；每种形态的视觉基线 | `playwright.remote.config.ts`、`tests/e2e/remote/*` | 矩阵全绿；真机检查表签字（§14.2） |
| **D 文档** | AGENTS.md 模块 3、9、19；ggs-remote-plan.md 的 §11 与 §22；两份旧计划的状态行 | | 评审 |

**依赖关系**：R0、C0、L1 可以立即并行开始，其中 L1 修的是 G13，应和 R0 一起尽早发布。A1 → A2 → P1 / P2（P1 和 P2 可以并行）→ S1。S2 只依赖 A2。S3 可以随时开始。L2 的测试框架与 L1 同时动工，用例随各阶段补齐，在 Q 之前全部通过。最后是 Q 和 D。

**估算**（一个熟悉代码库的开发者）：R0 1 天，C0 2 天，A1 5 天，A2 5 天，P1 5 天，P2 4 天，S1 3 天，S2 5 天，S3 1 天，L1 3 天，L2 6 天，Q 3 天，D 1 天，合计约 43 个工作日。

## 14. 测试与验收

### 14.1 自动化

- **vitest**（jsdom）：每个阶段在上表中列出的测试文件。设备形态用 `deviceClass` 加改写 `clientWidth`/`clientHeight` 的方式驱动，不依赖真实的视口。
- **Playwright**：`playwright.remote.config.ts` 增加以下项目：

| 项目名 | 设备配置 | 引擎 |
| ------ | -------- | ---- |
| `desktop-chrome` | Desktop Chrome | Chromium |
| `desktop-firefox` | Desktop Firefox | Firefox |
| `desktop-safari` | Desktop Safari | WebKit |
| `iphone-portrait` / `iphone-landscape` | iPhone 14 / iPhone 14 landscape | WebKit |
| `pixel-portrait` / `pixel-landscape` | Pixel 7 / Pixel 7 landscape | Chromium |
| `ipad-portrait` / `ipad-landscape` | iPad Pro 11 / iPad Pro 11 landscape | WebKit |
| `galaxy-tab` | Galaxy Tab S4 | Chromium |

- **规格文件**：现有的 `login`、`gates`、`transfer`、`workbench`、`visual-baseline`，加上新增的 `files.spec.ts`（列表、多选、上传下载）、`chat.spec.ts`（发送和回复流，用 `fake-claude-server.mjs`）、`rotate.spec.ts`（旋转后形态切换、状态保持）、`sync.spec.ts`（两个浏览器上下文分别扮演 PC 和手机，验证 §7.2 表格中每一项是否跨端）。
- **流量**：`remoteTraffic.test.ts` 按 §7.4 断言；live check 把结果写入 `metrics.json`。
- **生命周期与插件稳定性**：见 §18，这是发布门槛。

### 14.2 真机检查（每次发布前）

| 设备 | 浏览器 | 检查项 |
| ---- | ------ | ------ |
| iPhone（iOS 17 或更新） | Safari、微信内置浏览器 | 竖屏与横屏、安全区、键盘不遮挡输入框、长按不弹出系统菜单、上传多个文件、下载单个文件与 zip、后台 1 分钟后回来自动重连、Claude 发送与批准、中文输入法回车不误发送 |
| Android 手机 | Chrome、Samsung Internet、微信内置浏览器 | 同上，另加上传文件夹、返回键逐级返回、长按震动 |
| iPad | Safari | 平板两种方向、分栏、外接键盘快捷键、触控板悬停 |
| Android 平板或折叠屏 | Chrome | 展开与折叠时形态切换、状态保持 |
| Windows / macOS | Chrome、Edge、Firefox、Safari | 桌面形态、拖放上传、右键下载、远程指示器 |

每项记录通过、失败和备注，存进发布说明。

## 15. 风险

| 风险 | 影响 | 缓解 |
| ---- | ---- | ---- |
| `Workbench` 的拆分（A1）牵动面大 | 桌面回归 | 先拆分再移动；桌面的 `uiSweep`、`commandSweep`、`scenarioHarness` 全绿才继续；在 `tauri dev` 下实测 |
| Claude 页面改版后，会话驱动找不到元素 | 远程无法发送 | 驱动集中在 `claudeChatInject.ts`，失败有回执并记日志；`claude-code-live-check.mjs` 在每次升级扩展时运行；回退为在副本中操作 |
| 两端同时看 Git Graph 时，滚动跟随最后操作的一方，不是完全独立 | 少数并发场景的体验 | §9.2 的提示条说明当前由谁控制；完全独立列为 §16 Q-3，另立一期 |
| 隐藏的 Linux 窗口里计时器被节流 | Claude 的回复在远程停顿 | §17.3 的专项测试，以及移出屏幕而不隐藏的对策 |
| PC 关闭窗口时实例退出（G13） | 远程断开、插件中断 | L1 与 R0 一起尽早发布；T1、T2 两个场景作为回归测试 |
| iOS 后台挂起与内存限制 | 断线、页面被系统回收 | 恢复环、本端队列、懒加载、首屏包体积测量 |
| 移除 `view` / `sidebar` 同步，改变了 2026-10-12 的行为 | 习惯了侧栏跟随的用户 | 本次属于所有者的新指示（K7）；在发布说明中写明 |
| 删除 PC 的导入导出 | 有人在用 | 所有者的指示（K3）；从系统拖入的复制保留 |

## 16. 待所有者确认

- ~~Q-1 活动标签是否同步~~：已确认同步（K9）。
- **Q-2 Claude 回复进行中再发送**：本计划在本端排队，等回复结束再发。另一种做法是直接交给 Claude 处理（Claude Code 自己支持排队时）。
- **Q-3 Git Graph 的完全独立**：本期采用 §9.2 的滚动所有权，两端同时看 Git Graph 时滚动跟随最后操作的一方。是否需要 §9.3 的完全独立（每端一个面板）？如果需要，另立一期，并先做 85 种消息的契约测试。
- **Q-4 底部导航的第 4 位**：默认是 Claude。也可以改成 Git Graph 或终端，用户仍然可以自己拖动替换。
- **Q-5 B 级浏览器**：§10.1 B 级列出的国内 App 内置浏览器与厂商浏览器，是否要升到 A 级（进 CI 或固定真机）？
- ~~Q-6 删除 `fs_import` / `fs_export` 的范围~~：已确认，上传下载只属于远程，PC 端前后端一起删除（K16，§11 的删除清单）。
- ~~Q-7 追平规则~~：已确认，PC 重新打开时跟随远程的状态（K14）。
- ~~Q-8 PC 用户关闭窗口时的提示~~：已确认，弹出系统通知，可勾选"不再提示"（K15）。

## 17. PC 窗口生命周期

### 17.1 状态

| 状态 | 含义 | 远程列表的徽标 | 在同步里算活跃吗 |
| ---- | ---- | -------------- | ---------------- |
| **打开** | 窗口可见，没有最小化 | 绿点"PC 上已打开" | 是 |
| **最小化** | 窗口最小化到任务栏或程序坞 | 黄点"PC 上已最小化" | 否 |
| **关闭** | 窗口隐藏；实例、扩展后端、扩展 webview 都继续运行，只剩托盘图标 | 灰点"PC 上已关闭" | 否 |
| 已退出 | 实例进程不存在 | 不出现在列表里 | — |

不变式：实例运行期间，`main` 窗口**只隐藏，不销毁，不重新加载**。Claude 的聊天视图和 Git Graph 面板都放在这个窗口的文档里（`WEBVIEW_HOME`），一旦销毁，进行中的回复和面板状态就会丢失。今天的 `ensure_main_window` 在窗口不存在时会重建窗口，这条路径只允许出现在实例刚启动时。

### 17.2 状态转换

| 触发 | 条件 | 结果 |
| ---- | ---- | ---- |
| PC 用户点窗口的 × | 有任何远程会话连着（自己的工作台或 PC 屏幕观看者都算），或实例是以 `--remote-host` 启动的 | **隐藏窗口**，实例继续运行。修复 G13：`keepRunningHidden()` 改为询问守护进程当前的会话数（§17.4 的 `Sessions`），不再只看 PC 屏幕的观看者。同时弹出系统通知（K15）："Git Graph Studio 仍在为 2 台远程设备运行。可在托盘中重新打开或退出。" 通知带"不再提示"选项，选择存为 PC 的设备级设置 `remote.hideNotice`。用 Tauri 的通知插件发送；系统禁止通知时改为托盘气泡（Windows）或什么都不做，绝不弹模态对话框阻塞关闭 |
| PC 用户点窗口的 × | 没有远程会话 | 与今天相同：保存快照，处理未保存的文件，然后退出 |
| PC 用户点托盘图标、点任务栏，或再次启动 GGS | 窗口处于关闭状态 | 显示窗口（`ensure_main_window`），守护进程更新 `visible`，PC 前端按 §7.0 追平 |
| 远程点"在 PC 上关闭窗口" | — | 浏览器发送 `INSTANCE_DISPLAY { id, visible: false }`，守护进程转为 `ToInstance::Hide`，实例隐藏窗口（与 `remote_host_hide_main` 同一条路径）。**远程会话不受影响** |
| 远程点"在 PC 上打开窗口" | — | `INSTANCE_DISPLAY { visible: true }` 转为现有的 `ToInstance::Show` |
| 最后一个远程会话断开 | 窗口处于关闭状态 | 实例继续在后台运行（今天的空闲退出已被拒绝）。PC 用户可以从托盘打开窗口，或从托盘退出 |
| PC 用户在托盘点"退出 GGS" | 有远程会话连着 | 先确认："将断开 2 台远程设备；Claude 正在进行的回复会中断。" 确认后检查未保存文件，然后退出 |
| 远程点"退出此实例" | — | 今天的 `INSTANCE_CLOSE`：有未保存文件时返回 `CloseBlocked`，远程端列出这些文件，由用户选择保存、放弃或取消 |

### 17.3 隐藏窗口里的页面是否继续运行

- **Windows**：已实测，隐藏的 Tauri 窗口中 WebView2 仍按全速运行 rAF 和计时器（ggs-remote-plan.md §22，2026-10-12）。
- **macOS**：依赖 `backgroundThrottling: "disabled"`。
- **Linux（WebKitGTK）**：没有实测记录。隐藏窗口中的计时器可能被节流，而 Claude 页面的流式输出依赖计时器。§18 的平台矩阵必须覆盖：窗口隐藏期间，一段 60 秒的流式回复能完整到达远程。如果被节流，对策是隐藏时把窗口移出屏幕并保持"可见"，而不是真正隐藏。

### 17.4 协议的增量

所有增量都是新增字段或新增帧，旧的一方收到时忽略。守护进程与实例之间已有版本握手，新帧只发给声明支持的一方。

| 方向 | 帧或字段 | 说明 |
| ---- | -------- | ---- |
| 浏览器 → 守护进程 | `INSTANCE_DISPLAY { id, visible }` | 需要会话。安全沙箱开启时，只能作用于沙箱实例（与 `ATTACH` 的规则相同） |
| 守护进程 → 实例 | `ToInstance::Hide` | 隐藏窗口，然后回送 `Update { visible: false }` |
| 守护进程 → 实例 | `ToInstance::Sessions { count }` | 有会话连上或断开时推送。`keepRunningHidden()` 以它为准 |
| `WINDOWS` 中的每个窗口 | 新增 `minimized: bool`、`sessions: number` | 列表显示"PC 上已最小化"和"2 台设备在用" |

### 17.5 涉及的文件

`src/workbench/boot.ts`（`keepRunningHidden`、关闭处理）、`src-tauri/src/remote_host.rs`（`Hide`、`Sessions`、`main_visible` 增加最小化判断）、`src-tauri/src/lib.rs`（托盘退出的确认）、守护进程的 `ws`、`control.rs`、`registry.rs`、`tray`、`web/picker.js`、`src/remote/windowSwitcher.ts`、`src/remote/transport.ts`。

## 18. 生命周期与插件稳定性测试

目标（K13）：远程的连接与断开、PC 窗口的打开与关闭，在任何组合和顺序下，Claude（claude-code）和 Git Graph（git-graph-rs）都不出错。本节的测试是**发布门槛**。

### 18.1 每一步之后都要成立的不变式

| # | 不变式 | 检查方法 |
| - | ------ | -------- |
| I1 | 两个扩展后端的进程还活着，PID 不变，启动计数不变（除非这一步本来就要重启它们，例如切换模型提供方） | `ext_process` 的状态（启动次数、最近一次错误） |
| I2 | 进行中的 Claude 回复不被打断：假 Claude 服务器的流式回复完整结束，最后一条消息出现在每个正在看的前端里 | 假服务器的日志，加上各前端副本的文本 |
| I3 | Claude 的聊天页面在 PC 窗口里只有一份：没有重复的视图记录，每个远程副本在重新快照后显示的对话与 PC 一致 | `webviewViews` 的数量，副本 DOM 与源 DOM 的文本对比 |
| I4 | Git Graph 面板最多一个；每个活跃前端看到的打开状态一致；这一步之后，一次"加载提交"的往返在 5 秒内返回；没有意外的 `lossWarning` | 面板登记表；通过面板发送一次刷新并等待回应 |
| I5 | 远程会话不断开（没有 4401，没有被关闭），除非这一步本来就是断开或退出 | 传输层的状态 |
| I6 | 没有任何未保存的缓冲丢失 | 每个前端的脏缓冲列表前后对比 |
| I7 | 每个远程看到的 PC 窗口状态（打开、最小化、关闭）在 1 秒内正确 | `WINDOWS` 帧 |
| I8 | 扩展宿主日志里没有新的 warn 或 error，预期的除外 | `~/.ggs/logs/ext-host.log` 的增量 |
| I9 | 没有泄漏：远程离开后，副本观看者计数回到 0，录制器停止；`main` 窗口没有被重建或重新加载 | 观看者计数、窗口的创建计数、文档加载计数 |

为了能做这些检查，增加一个只在测试中开放的命令 `remote_debug_snapshot`。只有设置了 `GGS_TEST_HOOKS=1` 才注册，返回：后端 PID 与启动计数、webview 面板与视图的登记表、各前端的观看者计数、`main` 窗口的创建计数与文档加载计数、已登记的前端列表。正式构建中这个命令不存在，`check-ipc.mjs` 中把它登记为测试专用。

### 18.2 事件目录

| # | 事件 |
| - | ---- |
| E1 | PC 用户点 × |
| E2 | PC 从托盘或任务栏重新显示窗口 |
| E3 | PC 最小化，以及从最小化恢复 |
| E4 | 远程"在 PC 上关闭窗口" |
| E5 | 远程"在 PC 上打开窗口" |
| E6 | 远程页面刷新 |
| E7 | 远程关闭标签页，再重新打开链接 |
| E8 | 远程页面切到后台 60 秒，再回到前台 |
| E9 | 网络断开 30 秒（在 120 秒恢复窗口之内） |
| E10 | 网络断开 150 秒（超出恢复窗口） |
| E11 | 第二个远程连上，以及断开 |
| E12 | 守护进程重启 |
| E13 | Relay webview 被重建 |
| E14 | 切换模型提供方，claude-code 后端按设计重启 |
| E15 | 远程或 PC 打开、关闭 Claude 视图或 Git Graph 标签 |
| E16 | Claude 回复进行中，以及等待权限批准时 |

### 18.3 固定场景

| # | 场景 | 重点检查 |
| - | ---- | -------- |
| T1 | PC 打开、远程连着 → PC 点 × → 远程继续给 Claude 发消息、在 Git Graph 里加载提交 → PC 从托盘打开 | 窗口只隐藏（G13）；系统通知弹出一次，勾选"不再提示"后再点 × 不再弹出（K15）；I1–I5；PC 重新打开后跟随远程的标签和活动标签（K14） |
| T2 | Claude 回复进行中，PC 点 × | 回复完整到达远程（I2） |
| T3 | Claude 回复进行中，远程依次执行刷新、关闭标签页、切到后台 60 秒 | 回复在 PC 上完成；远程回来后副本完整，没有重复消息 |
| T4 | 远程"在 PC 上关闭窗口"与"打开窗口"交替执行 50 次 | I1、I9：PID 不变，窗口没有被重建，内存没有增长 |
| T5 | PC 关闭，两个远程 A 和 B：A 打开文件，B 跟着打开；A 切换活动标签，B 跟着切换；A 断开，B 继续；PC 打开窗口 | 多远程同步（K10）；PC 追平 |
| T6 | PC 关闭，只有一个远程：打开、切换、关闭 20 个文件 | 同步消息为 0 B（K11） |
| T7 | Git Graph 只在远程打开，PC 关闭：远程滚动到第 2000 个提交 → PC 打开窗口 | 滚动驱动唯一的面板；PC 打开后看到 Git Graph 标签 |
| T8 | Git Graph 在 PC 和远程同时看，两边交替滚动 | 滚动所有权按 §9.2 转移；I4、I8 |
| T9 | PC 关掉 Git Graph 标签，此时远程正在看 | 远程的副本标签关闭；远程再次打开 Git Graph 正常 |
| T10 | PC 窗口从未显示过 Claude 视图，并且处于关闭状态，远程打开 Claude | 视图在隐藏的窗口里完成解析，远程副本出现 |
| T11 | Claude 等待权限批准时，PC 点 ×，远程点"允许" | 批准生效，回复继续 |
| T12 | 网络断开 30 秒，期间远程的输入框里有一条排队消息 | 重连后消息只发送一次（按操作 id 去重） |
| T13 | 网络断开 150 秒 | 重新 ATTACH；副本重新快照；扩展不受影响（I1） |
| T14 | 守护进程重启 | 实例重新连上；远程重新 ATTACH；Claude 和 Git Graph 正常 |
| T15 | 切换模型提供方（E14） | claude-code 重启一次（启动计数加 1）；所有前端的聊天视图重新解析；Git Graph 不受影响 |
| T16 | PC 托盘"退出 GGS"时有未保存文件且有远程连着 | 先确认；取消后一切照旧 |
| T17 | 远程"退出此实例"时有未保存文件 | 远程收到 `CloseBlocked` 并列出文件 |
| T18 | PC 最小化，远程打开 3 个文件，然后 PC 恢复 | 最小化期间不算活跃；恢复后追平 |

### 18.4 随机序列（基于模型的测试）

- 一个事件生成器从 E1–E16 中按权重抽取事件，每轮 200 步，每一步之后检查 I1–I9（带超时的等待）。
- 每轮的随机种子记入日志，失败的种子可以原样重放；修复后，这个种子加入固定的回归列表。
- 运行频率：日常开发每晚 20 个种子；发布前 50 个种子全部通过。

### 18.5 长时间运行

连续运行 4 小时，每 30 秒触发一个随机事件。记录 `ggs`、`ggs-node`（两个扩展后端）和 WebView2 进程的内存，以及 webview 句柄数。合格线：内存增长不超过 15%，句柄数回到基线。每个版本发布前运行一次。

### 18.6 平台

| 平台 | 要求 |
| ---- | ---- |
| Windows | 全部：T1–T18、随机序列、长时间运行 |
| macOS | T1–T18 和随机序列 20 个种子 |
| Linux | T1–T18（重点是 §17.3 的隐藏窗口计时器）和随机序列 20 个种子 |

### 18.7 测试框架

- **基础**：现有的 `scripts/probes/claude-code-sandbox.mjs` 提供假 Claude 服务器、假 git 远端和隔离的 `GGS_HOME`；新的 `scripts/probes/remote-lifecycle-check.mjs` 在此基础上启动应用（`tauri dev`，带 `GGS_TEST_HOOKS=1`），再用 Playwright 打开一个或多个浏览器上下文作为远程端。
- **驱动 PC 端**：显示、隐藏、最小化和点 × 都通过测试命令触发，不依赖鼠标。网络断开用 Playwright 的离线模式模拟，守护进程重启通过它的管理 API 完成。
- **结果**：写入 `target/studio/remote-lifecycle-report.{md,json}`，记录每个场景、每一步、每条不变式的结果和耗时。
- **单元层**：`tests/remoteLifecycle.test.ts`（vitest）覆盖 `keepRunningHidden` 的判断、门控、追平合并和在场表超时；Rust 覆盖 `Hide`、`Sessions` 的处理和 `main_visible` 的最小化判断；守护进程的集成测试覆盖 `INSTANCE_DISPLAY` 的权限与沙箱规则。

### 18.8 发布门槛

以下条件全部满足才能发布：

- §18.3 的 T1–T18 在 Windows 上通过，并在 macOS 或 Linux 至少一个平台上通过；
- 随机序列 50 个种子通过；
- 长时间运行通过；
- 单元层与集成层在 CI 中全绿。

任何一项失败都阻塞发布。修复必须附带一个能复现问题的测试。
