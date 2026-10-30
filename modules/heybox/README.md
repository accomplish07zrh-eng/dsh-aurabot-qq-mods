# 刷小黑盒

用主人的账号逛小黑盒：看信息流、读帖子和热评、点赞、评论、发帖、删自己的帖。写操作的权限在面板「权限」页，默认仅主人。模块会访问小黑盒及图片上传服务。

在面板「小黑盒」页填 Cookie 并打开；也可通过扫码登录。扫码使用小黑盒 App，二维码由模块生成，不依赖浏览器或额外 npm 包。手机确认后还会检查账号，确认可用才保存 Cookie。等待扫码或等待确认时可继续查询。扫码用不了时可启动独立浏览器窗口，由主人手动登录并完成验证。

自动逛使用小黑盒信息流和后台会话，遵守插件总开关、试运行、醒着时段、每日额度和间隔。开启「只在谷时逛」后，默认避开工作日 9–12 点和 14–18 点，可配置跨午夜的峰时段。她默认可以把值得分享的帖子私聊给主人，也可关闭分享；发送前按每日上限占额，明确失败时回滚，结果不确定时不自动重发。

请求按接口分档限速（扫码查询间隔至少约 3 秒，并带随机抖动）；遇到验证码或 429 时停止普通请求并持久化冷却，重启后仍生效。手动解除会检查当前账号，检查不通过就保持冷却。冷却期间扫码接口同样暂停；可等待冷却结束，或由主人在浏览器窗口中完成验证。浏览器验证只有在页面探测和账号检查均通过后才保存 Cookie、解除冷却；模块不会自动处理验证码。

原是 Aurabot 内置模块，1.2.0 起搬到社区模块库。老用户升级时，在用的会自动装回来，配置和登录状态不变。

## Core 面板接入

旧版 core 没有新增配置时使用模块默认值：`heybox.offPeakOnly=false`、`peakStartAM=9`、`peakEndAM=12`、`peakStartPM=14`、`peakEndPM=18`、`peakWeekend=false`、`shareToOwner=true`、`shareBias='normal'`（可选 `stingy` / `normal` / `proactive`）、`shareDaily=3`。峰时起点范围 0–23，终点 0–24；起点大于终点表示跨午夜，跨午夜的凌晨按起始日判断周末。面板须将这些字段加入配置默认值、校验和表单，并继续使用 `speakUp.awakeFrom` / `awakeTo` 控制自动任务的醒着时间。

模块提供以下面板接口，路径前缀为 `/aurabot/api`：

- `/heybox/state`：返回已有状态及 `peak`、`risk`、`quota.share`、`limits.shareDaily`、`left.share`。
- `/heybox/risk`：读取风控状态；`/heybox/risk/clear`：主动检查当前账号，通过后解除冷却。
- `/heybox/qr/start`：生成二维码，返回 `png`（data URL）、`qrUrl`、`expire`；`/heybox/qr/poll`：查询扫码状态。`wait` / `ready` 的 `ok` 为 `false`，面板应保留二维码；`state='ok'` 且 `verified=true` 才是登录完成，Cookie 不返回前端。零依赖编码器支持最长 213 字节的二维码内容，超长时会明确返回错误。
- `/heybox/verify/start`：可传 `{ "visible": true }` 直接显示窗口，默认收起；成功返回 `ok`、`state`（`waiting` / `clear`）、`why`、`shot`（data URL，可为空）、`visible`、`message`。`clear` 只表示页面没有检测到验证框，尚未完成验证。
- `/heybox/verify/show`：传 `{ "visible": true }` 显示窗口，传 `false` 收起；返回 `ok`、`visible`、`message`。主人须在窗口中手动登录并完成验证。
- `/heybox/verify/finish`：主人操作完后调用；成功返回 `ok=true`、`verified=true`、`nickname`、`heyboxId`、`count`、`shot`、`message`。失败返回 `ok=false`、`verified=false` 和 `message`，页面仍有验证时附 `state='waiting'`、`why`、`shot`。Cookie 不返回前端，未通过或探测出错时不保存 Cookie、不解除冷却。

分享走宿主 `hub.sendText`，扩展模块的发送钩子会生效，需要主人 QQ 和可用网关。宿主对网关连接失败可能重试，但超时不会重试；宿主把发送失败折成 `null` 时模块无法分辨失败和超时，会保留额度并阻止该帖子重发。

离线回归：设置 `AURABOT_PLUGIN_DIR` 指向插件源码后运行 `node --import ./scripts/plugin-env.mjs --test "modules/heybox/test/*.test.mjs"`。

## 详细说明

用你的小黑盒账号逛游戏社区。面板「小黑盒」页：填 Cookie、检查登录、配逛法、看额度和热榜预览。

- **要准备什么**：浏览器登录 [小黑盒](https://www.xiaoheihe.cn/) 后，把整串 Cookie 粘进面板。`pkey` 必须有（读接口用）；想让它能点赞、评论、发帖，还得有 `x_xhh_tokenid`（F12 → Application → Cookies 里能复制到，这个不是 HttpOnly）。
- **它会做什么**：定时看信息流、读帖子正文和热评；有热榜和搜索；按权限决定点不点赞、评不评论。写操作各自有权限开关（「权限」页），默认只认主人私聊。
- **发帖**：走「文章」模式（`link_tag=11`），正文按空行分段，图片走小黑盒图床（腾讯云 COS 直传），所以图片能真正插在文字中间。发帖前它自己会过一遍自检：先看热榜挑题、再看社区高赞帖的角度、素材里必须有具体数字；标题不重复正文首行、不编造第一人称经历、正文 200-800 字、不碰政治和价格判断。
- **发帖风格（三选一，面板里选默认，也能单次指定）**：`diary` = 大肥鱼日记，跟空间日记同一个味——第一人称随手记，可以写今天刷到这条时的反应、想吃白米饭，120-300 字，不分小标题；`news` = 热搜文，报道新闻体，开门见山讲清楚这事、摆具体数字，钩子→信息 3-4 段→我的判断→抛问题，200-800 字；`mix`（默认）= 肥鱼热搜，用日记的口吻写热搜，新闻信息要真、语气是「我跟你说个事」，150-500 字。
- **几个踩过的坑（已修在内核里）**：帖子类型 28（动态）只能纯文本，塞 HTML 会把标签原样显示；分区 id 必须是真实存在的 `7214` 盒友杂谈 / `18745` 数码硬件 / `806933` AI，网上抄来的 58144 并不存在，会一直报「错误的帖子类型」。
- **工具**：`heybox_feed`（刷信息流）、`heybox_watch`（读帖子+热评）、`heybox_hot`（热榜）、`heybox_search`（搜帖找角度）、`heybox_topics`（查分区）、`heybox_like`、`heybox_comment`、`heybox_post`（发帖，可带图）、`heybox_delete`（删自己的帖）。
