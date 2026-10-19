# 架构与文件职责

当前为可运行 TypeScript 实现。原 `.d.ts` 框架文件已替换为 `.ts`，数据库、HTTP、WebSocket、播放器与页面逻辑均已接通。

## 技术与边界

Node.js 24+、原生 HTTP、ws、busboy、music-metadata、内置 SQLite；前端原生 DOM 与 HTMLAudioElement，通过 esbuild 构建。同源 HTTP + WS，固定一个房间，单进程最多五个收听租约，无第三方运行时 CDN。

依赖方向为 `client → shared ← server`。服务端持有权威歌曲、时间锚点、播放模式和版本；前端只保存视图、音量、拖动预览和显示状态。音频文件通过受保护的 Range 接口分别传给客户端。

视觉来自 frontend_design.html，接入差异见 FRONTEND_MAPPING.md。原导出包保留为参考；正式页面不依赖其压缩资源、iframe 或 DCLogic 演示状态。

## 文件索引

| 文件 | 实现职责 |
| --- | --- |
| src/shared/models.ts | 歌曲、1 GB 配额、房间、席位、时间样本类型 |
| src/shared/protocol.ts | 控制指令验证、AppError、统一目标进度公式 |
| src/server/config.ts | 环境变量与来源校验，五人和 1 GB 产品约束 |
| src/server/persistence.ts | SQLite 表、事务、歌曲与会话数据、播放恢复快照 |
| src/server/auth.ts | scrypt 密码校验、随机会话 Cookie、CSRF、Origin、登录限流 |
| src/server/seats.ts | 五人原子分配、刷新/断线保留、标签页接管 |
| src/server/playback.ts | SerialCommandQueue、PlaybackOrder、RoomService；模式与播放状态 |
| src/server/media.ts | MP3 帧检查、Ogg 页链/CRC 与 Vorbis/Opus 编码检查、响应 MIME |
| src/server/storage.ts | MusicStorage、MP3/Ogg 元数据解析、预留配额与清理 |
| src/server/application.ts | 播放/删除协调、共享串行队列、在线数与自然结束调度 |
| src/server/http.ts | HTTP 路由、JSON/multipart、静态资源与音频 Range/HEAD |
| src/server/realtime.ts | RoomGateway，WS 会话、消息验证、探时、心跳和广播 |
| src/server/main.ts | createServer 组合根、启动/关闭、恢复、定时维护 |
| src/client/transport.ts | ApiClient、XHR 上传进度、RoomConnection、重连及请求编号 |
| src/client/audio.ts | AudioPlayer、ClockEstimator、SyncController、MediaSessionBridge |
| src/client/state.ts | ClientStore，页面/歌曲/在线人数/上传任务本地状态 |
| src/client/shell.ts | AppShell，登录/房间、标签、状态提示和通知 |
| src/client/views.ts | PlaylistView、PlayerView、DeleteDialog，纯文本渲染 |
| src/client/main.ts | ClientApplication，事件绑定、加入、校时、刷新、上传和退出 |
| src/client/index.html | 单页面结构与持久音频宿主 |
| src/client/styles/*.css | tokens、layout、components，手机标签、横屏、桌面双栏 |
| scripts/build.mjs | 构建服务端、前端、同步和播放顺序算法测试包 |
| scripts/backup.mjs | 停机后 SQLite 一致性备份与音频复制 |
| deploy/* | systemd 和 HTTP Nginx 配置 |

## 主要流程

登录点击先尝试解锁音频，再提交密码、保存昵称、连接 WS 和申请席位。浏览器阻止播放时提供继续收听入口。席位由会话关联，WS 控制额外检查当前连接，防止被接管的标签页继续操作。

控制经 WS 验证后进入 SerialCommandQueue，RoomService 更新版本并保存恢复位置、广播。明确 play/pause，不使用服务端 toggle。随机结果由服务端选择，单曲循环由服务端统一重置时间锚点；audio.loop=false，playbackRate=1。

随机模式排除最近 `min(3, 歌曲数 - 1)` 首不同歌曲，确保小歌单仍有候选；在剩余歌曲中优先选择随机命中次数最少的歌曲，同次数时等概率抽取。只有成功切歌后的随机下一首和自然结束计入次数，手动点歌、上一首和单曲循环只更新最近播放记录。回退历史与最近播放记录独立，回退不会抹掉刚听过的歌曲；新增歌曲以当前最低次数加入，删除歌曲退出计数。计数和历史保存在进程内，服务重启后重新开始，恢复的当前歌曲进入最近播放记录。

RoomState 增加 `playlistId`（null 表示全部歌曲）和 `nextTrackId`（单个优先待播位置），均进入原播放快照并通过 WS 同步。`setNextTrack` 设置或取消待播，`setPlaylist` 改变全房间播放范围；`selectTrack` 可附带 `playlistId`，原有不带此字段的指令沿用当前范围。下一首与自然结束统一经过 advance，优先消费仍在范围内的待播歌曲，之后才使用原播放模式；指定待播不计入随机次数。切换播放范围后重置均衡计数；空歌单、历史回退也严格限定候选范围，不回退到全部歌曲。改变范围不打断当前歌曲。

SQLite 自动新增 `playlists(id, data)` 表，JSON 保存名称、创建时昵称、时间和去重后的 trackIds；旧数据库和旧播放快照仍可直接读取。登录成员共享管理歌单，创建者由服务端会话写入。新增 `GET/POST /api/playlists`、`PATCH /api/playlists/:id`（改名）、`POST /api/playlists/:id/tracks`（operation=add/remove，trackIds 最多 1000 个）；写入沿用 Origin/CSRF 校验和共享串行队列，增删成员后通知客户端刷新，移除待播成员同时清空待播状态。全局删除及启动清理缺失文件时同步移除成员关系，单纯移出歌单不删除文件。

自然结束与最后一人离开由每秒维护任务检查，并通过同一队列处理；这样无需挂在客户端 ended 事件，也没有旧曲结束定时器误触发的问题。WS 每秒推送轻量房间快照，每二十秒心跳。每十秒保存位置，异常退出可能回退少量进度。重启新 epoch 并恢复暂停。

上传使用 Busboy 单文件 multipart + X-File-Size，服务端流式计算实际长度和哈希。先原子预留容量，写入临时目录，验证 MP3 帧或 Ogg 单音轨页链与 CRC 及 music-metadata 可识别时长，提取歌名/歌手，再移动文件并同步提交数据库。无需 ffprobe 或转码程序。

上传最多两路。慢速文件 IO 不占用房间控制队列，数据库提交片段同步执行，中间没有 await，因此同一进程不存在删除和提交交叉执行的窗口。磁盘移动与数据库事务之间通过清理补偿及启动核对恢复；重复内容返回已有曲目，临时或已移动的重复文件清理后释放预留。

删除在共享队列内标记不可见，并清空正在播放的该曲。物理清理位于队列外，成功后移除记录、广播容量。失败保留 pending-delete 占用并每三十秒重试。pendingDeleteBytes 是 occupiedBytes 的子集，不重复计量。

前端 ClockEstimator 选择低 RTT 探时样本；SyncController 以服务端时间推导当前目标，误差大于 0.35 秒直接 seek，周期跳转节流一秒。等待加载或缓冲后重算最新位置。客户端只通过 UI/Media Session 显式动作提交全房间操作，媒体自然 pause/waiting/ended 不向全房间发送暂停。

ClientApplication 持有唯一 AudioPlayer 和 WS。手机标签与桌面双栏读取同一 ClientStore，标签/旋转不改变收听状态。歌单刷新统一排队，避免并发旧响应覆盖新请求。上传区分传输和校验，删除弹窗等待成功后关闭，远端已删除则提示并关闭。

## 数据与恢复

SQLite 使用 WAL，tracks 保存类型化曲目 JSON；sessions 保存令牌哈希、显示信息与到期；settings 保存带随机盐的 scrypt 密码校验值及播放快照；reservations 保存预留字节。密码变化清除旧会话。数据库中的会话信息不会包含原始 Cookie 令牌或房间明文密码。

启动先清理上次中断的临时文件及孤立音乐，核对缺失文件，再恢复暂停状态。数据目录必须仅由该应用实例管理，不支持多个服务共享目录。备份期间停服务，复制一致性 SQLite 快照和音乐；恢复进全新目录，避免旧 WAL/SHM。

## 验证与当前边界

自动化覆盖真实 MP3、六个 WS 客户端、五端竞争、重复指令、循环、随机历史、上传/删除配额与重启。同步测试使用模拟媒体设备验证五端目标校正、拒绝旧快照、自动播放失败和倍速恒为 1，不能代替真实五设备声音一致性测量。

浏览器已验证真实上传、播放、暂停、模式切换、删除取消及响应式视图；本地测试不是正式 Debian 部署验收。手机锁屏、iPhone Chrome、中国线路与长时间五端一秒目标仍需实机验证，详见 VALIDATION.md。
