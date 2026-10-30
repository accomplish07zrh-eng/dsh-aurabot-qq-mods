# 刷小黑盒

用主人的账号逛小黑盒：看信息流、读帖子和热评、点赞、评论、发帖、删自己的帖。写操作的权限在面板「权限」页，默认仅主人。模块会访问小黑盒及图片上传服务。

在面板「小黑盒」页填 Cookie 并打开；也可通过扫码登录。扫码使用小黑盒 App，二维码由模块生成，不依赖浏览器或额外 npm 包。手机确认后还会检查账号，确认可用才保存 Cookie。等待扫码或等待确认时可继续查询；模块不提供浏览器验证。

自动逛使用小黑盒信息流和后台会话，遵守插件总开关、试运行、醒着时段、每日额度和间隔。开启「只在谷时逛」后，默认避开工作日 9–12 点和 14–18 点，可配置跨午夜的峰时段。可选择让她把值得分享的帖子私聊给主人，默认关闭；开启后按每日上限先占额再发送，超时不自动重发。

请求按接口分档限速（扫码查询间隔至少约 3 秒，并带随机抖动）；遇到验证码或 429 时停止普通请求并持久化冷却，重启后仍生效。手动解除会检查当前账号，检查不通过就保持冷却。冷却期间扫码接口同样暂停；可等待冷却结束，或主动检查已完成验证的当前账号。模块不会自动处理验证码。

原是 Aurabot 内置模块，1.2.0 起搬到社区模块库。老用户升级时，在用的会自动装回来，配置和登录状态不变。

## Core 面板接入

旧版 core 没有新增配置时使用模块默认值：`heybox.offPeakOnly=false`、`peakStartAM=9`、`peakEndAM=12`、`peakStartPM=14`、`peakEndPM=18`、`peakWeekend=false`、`shareToOwner=false`、`shareBias='normal'`（可选 `stingy` / `normal` / `proactive`）、`shareDaily=3`。峰时起点范围 0–23，终点 0–24；起点大于终点表示跨午夜，跨午夜的凌晨按起始日判断周末。面板须将这些字段加入配置默认值、校验和表单，并继续使用 `speakUp.awakeFrom` / `awakeTo` 控制自动任务的醒着时间。

模块提供以下面板接口，路径前缀为 `/aurabot/api`：

- `/heybox/state`：返回已有状态及 `peak`、`risk`、`quota.share`、`limits.shareDaily`、`left.share`。
- `/heybox/risk`：读取风控状态；`/heybox/risk/clear`：主动检查当前账号，通过后解除冷却。
- `/heybox/qr/start`：生成二维码，返回 `png`（data URL）、`qrUrl`、`expire`；`/heybox/qr/poll`：查询扫码状态。`wait` / `ready` 的 `ok` 为 `false`，面板应保留二维码；`state='ok'` 且 `verified=true` 才是登录完成，Cookie 不返回前端。零依赖编码器支持最长 213 字节的二维码内容，超长时会明确返回错误。

不提供 `/heybox/verify/*` 浏览器接口，面板应显示扫码入口和风控状态。分享通过 OneBot `send_private_msg` 发送一次（`retries: 0`），需要主人 QQ 和可用网关。

离线回归：设置 `AURABOT_PLUGIN_DIR` 指向插件源码后运行 `node --import ./scripts/plugin-env.mjs --test "modules/heybox/test/*.test.mjs"`。
