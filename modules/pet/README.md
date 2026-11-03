# 桌宠

桌宠：桌面上的「大肥鱼」，有气泡、动作、工作状态和碎碎念。

装好后在面板「桌宠」页下载客户端。素材包从本仓库 `pet-pack/` 下载，许可是 CC BY-NC-SA 4.0。接口说明见 [PET_MODULE_API.md](PET_MODULE_API.md)。

设计、客户端形态和物理逻辑来自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，署名见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

原是 Aurabot 内置模块，1.2.0 起搬到社区模块库。老用户升级时，在用的会自动装回来，配置和登录状态不变。

## 人物大小

配置项 `petScale`（0.5~2.0，默认 1）：整个桌宠窗口按比例缩放，物理和拖拽跟着一起变。面板「桌宠」卡的大小滑条改的就是这一项（1.0.3 起支持）。

1.0.3 还修了两个手感问题：拖动时按帧合并移动指令（高回报率鼠标不再卡顿），窗口跑出所有屏幕时 30 秒内自己回来。

**升级到 1.0.3 后客户端文件有变化**：面板「桌宠」卡会提示「插件里的客户端更新了」，点一次「重新生成客户端」并重启 Electron 才生效。

## 松手后落地

配置项 `petReleaseLand`（默认开，1.0.4 起支持）：开着时拖动松手会按甩出的速度抛出去、落回屏幕底部（带 Q 弹挤压）；关掉后松手停在哪就在哪，不抛也不落。面板「桌宠」卡的「松手后落地」开关改的就是这一项。

## 远端直连（服务器部署）

插件跑在服务器（无桌面）上时，桌宠客户端可以在你自己的电脑上运行、直连服务器插件。

1. 面板「连接」页填**插件对外地址**（如 `https://bot.example.com`），点「验证并保存」；
2. 「桌宠」页点「下载客户端包」，解压到你自己的电脑；
3. 装好 Electron 后在解压目录运行 `npx electron main.js`。

同机部署（桌宠和插件在同一台电脑）**不用配任何东西**——留空即同机模式，行为与旧版完全一致。

### 安全须知（务必读）

- **必须用 https。** 明文 `http://` 的跨机访问**默认被直接阻断**（令牌与气泡内容在公网明文传输等于送人）。反向代理上请配置 TLS；仅内网自测才考虑打开 `allowInsecureRemote`。
- **面板接口默认只允许本机访问。** `/aurabot/api/panel/*` 是管理接口（能改配置、能下客户端包），公网上裸奔等于把管理权交出去。要用远端管理必须显式开 `security.panelRemoteAccess`（面板「安全防护」页），**并且**在反向代理层再加一道认证（Basic Auth / OAuth 等）。
- **反代只放行桌宠客户端实际调用的精确路径**，其余一律 404。

  ⚠ 注意路径：`pet` 属于核心的稳定路由（前缀为空），所以**没有** `/ext/pet/` 这一段——
  按 `/aurabot/api/ext/pet/*` 配 nginx 会全部 404。全部走 `x-pet-token`（素材走 query 参数 `token`），
  最小可用集合（不配客户端起不来）：

  | 路径 | 方法 | 用途 |
  | --- | --- | --- |
  | `/aurabot/api/events` | GET | 长轮询收事件（关闭响应缓冲，`proxy_read_timeout ≥ 60s`） |
  | `/aurabot/api/config` | GET | 拉配置与形象包视图 |
  | `/aurabot/api/asset/*` | GET | 素材动画 webm |

  按需追加（对应客户端功能，不用该功能可以不放行）：

  | 路径 | 方法 | 用途 |
  | --- | --- | --- |
  | `/aurabot/api/playback` | POST | 动画播放回执 |
  | `/aurabot/api/whisper` | POST | 碎碎念（主动搭话） |
  | `/aurabot/api/focus` | POST | 右键菜单切专注模式 |
  | `/aurabot/api/chat`、`/chat/history`、`/chat/state` | POST/GET | 对话框（聊天、历史、状态回执） |
  | `/aurabot/api/behavior`、`/behavior/env`、`/behavior/reaction`、`/behavior/icon/act` | POST | 行为大脑（下发、桌面窗口上报、反应回执、图标动作） |

  **不要图省事写 `/aurabot/api/*`**：那样会把 `douyin` / `heybox` / `group-admin` / `tophub` 等
  **没有 token** 的模块路由一起暴露到公网。

- **放在反向代理后面时，要填 `trustedProxy`。** 插件判断「请求从哪来」只看 TCP 连接的对端地址
  （`socket.remoteAddress`），因为 `X-Forwarded-For` 是客户端自己就能写的头。反代部署时
  连接对端永远是反代自己（如 `127.0.0.1`），不填 `trustedProxy` 的话所有用户都会被当成同机。
  填上反代地址（`127.0.0.1`=本机 nginx、`172.17.0.1`=容器网关，多个用逗号分隔）后，
  插件才会采信 `X-Forwarded-For` 的**最后一跳**作为真实来源（用于限速与明文判定）。
  留空 = 从不相信任何转发头（最安全，适合直连暴露或纯同机）。
- **令牌**是长期 bearer，是跨机场景的唯一防线。泄露后用面板「轮换令牌」应急——旧令牌立即失效，再重新下载客户端包。可设 `tokenTtlDays` 让令牌定期过期（0 = 不过期，默认）。
- **令牌暴力尝试有限速**：同一来源 IP 连续 20 次失败后按指数退避封禁（最长 30 分钟）。
- 客户端包**不要外传**：里面内嵌了 `host.json`（含令牌）。
- `host.json` 与 `host-token` 在支持 POSIX 权限的平台上一律以 **0600** 写盘（仅属主可读写）。

nginx 反代要点：关闭响应缓冲（长轮询 25 秒不能被掐）、`proxy_read_timeout` 设到 60 秒以上、TLS 必须开。
