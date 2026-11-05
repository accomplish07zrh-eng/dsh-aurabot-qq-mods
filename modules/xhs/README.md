# 看小红书（xhs）

让她逛小红书：读正文和配图、搜笔记、读评论、回评论、点赞，还能看谁回了她的评论。

## 装完先做什么

1. 面板里把小红书 cookie 粘进「小红书 cookie」。
2. 完事。别人发来的小红书链接，她就能打开读正文、发配图。

这时是**基础模式**：只能读。搜索、读评论、回评论、点赞、查回复都要签名，得另外起一座本地桥。

想升级成**完整模式**：

1. 面板点「复制部署说明」，把它粘给你自己的 DSH / 别的 AI，让它按说明在本机搭桥；
2. 桥起来后，面板点「测试连接」，看到「桥通了，登录的是 xxx」；
3. 设置里打开「完整功能（搜索/评论/点赞）」。桥不通时就算打开，这几个工具也不会挂出来。

不装桥完全不影响读笔记。

## 它需要一座桥（可选）

小红书那套签名（`x-s` / `x-t` / `x-s-common` / `x-rap`）是 Python 生态里的活儿，插件是 Node。
所以这个模块拆成两半：

- **本模块（Node）**：工具、人格接线、发图。读单条正文走页面 SSR，不需要签名。
- **xhs-bridge（Python，单独部署）**：搜索、评论、点赞、查回复这些要签名的活儿交给它。

桥单独发布在 [xhs-bridge](https://github.com/yuccc7878/xhs-bridge)（MIT）：

```bash
git clone https://github.com/yuccc7878/xhs-bridge.git && cd xhs-bridge
pip install -r requirements.txt        # Python ≥ 3.10
npm i crypto-js                        # Node ≥ 20，x-rap 签名要
git clone https://github.com/cv-cat/Spider_XHS spider_xhs   # 签名库，不随桥分发
python3 xhs_bridge.py
```

不装桥就只能读；装了才有搜索/评论/点赞。它依赖的 Spider_XHS 上游没有 LICENSE，所以不能随包分发，得自己 clone。接口契约见下。

没有桥的时候模块照常工作：`xhs_read` 还能用（配了 cookie 就行），其余工具不会挂出来。

## 桥的接口

默认地址 `http://127.0.0.1:8099`，可以在设置里改。桥设了 `XHS_BRIDGE_TOKEN` 时，所有请求都要带 `Authorization: Bearer <token>`。

```
GET  /health
  → { ok, user: { nickname, red_id, guest } }        guest=false 才算登录有效

GET  /search?q=<关键词>&page=<页码>
  → { ok, items: [{ id, token, title, author, likes, comments, type }] }

GET  /comments?id=<note_id>&token=<xsec_token>&parent=<可选>&cursor=<可选>
  → { ok, comments: [{ id, author, ip, likes, sub_count, content }], cursor, has_more }

POST /comment   body: { note_id, content, reply_comment_id, at_user_id }
  → { ok, toast, comment_id, http }                  // 风控时 ok=false 且带 verifytype

POST /like      body: { note_id, action }            // action: like / unlike
  → { ok, msg? }                                     // 取消赞在桥里走 dislike 接口，参数名 note_oid

GET  /replies?limit=<条数>
  → { ok, count, items: [{ note_id, reply_comment_id, user_id, author, content, iso }] }

GET  /mine?limit=<条数>
  → { ok, items: [...] }                             // 我发过的评论，排查用
```

`token` 是小红书的 `xsec_token`，搜索结果里有；没有它，正文页面多半是空壳。

## 设置

桥地址和密钥不在设置页里：模块默认连 `http://127.0.0.1:8099`，桥不设密钥就能用。只有跨容器、换端口或者桥设了 `XHS_BRIDGE_TOKEN` 时，才需要在插件配置文件里改 `bridgeUrl` / `bridgeToken`（这两项仍然存在，只是不显示）。

| 设置项 | 说明 |
|---|---|
| `cookie` | **手动粘贴**的小红书 cookie，模块唯一的 cookie 来源 |
| `enableSearch` / `enableRead` / `enableComments` | 三个能力各自的开关 |
| `groupRead` | 群里也能用（默认关，只有主人私聊） |
| `sendImages` / `sendImagesInGroup` / `maxImages` / `imageGapMs` | 读帖时发不发配图、发几张、之间停多久 |
| `maxDescChars` / `maxResults` | 正文截断长度、搜索结果条数 |
| `allowComment` / `cooldownSec` / `dailyComments` / `riskCooldownMin` | 回帖开关、最小间隔、每日上限、风控冷却时长 |
| `fullMode` | 完整功能总开关。默认关 = 基础模式只读；桥通了再打开 |

## 发帖（可选，默认关）

设置里打开「允许发帖」后，主人私聊里可以：

```
/xhs 发帖 标题 | 正文 #话题        （图片跟命令一起发过来）
/xhs 发                            确认发出去
/xhs 取消                          扔掉草稿
/xhs 草稿                          看看现在草稿长什么样
```

- 先出草稿预览，**30 秒内**回 `/xhs 发` 才真发（草稿 30 分钟过期）
- 默认 `publishPrivate` 开：发成**仅自己可见**。小红书的删帖接口要浏览器点，模块删不掉，公开内容撤不回
- 每天最多 `dailyPosts` 条、两条之间至少 `postGapMin` 分钟；撞到 verifytype 记风控冷却并拒绝继续发
- 图片在确认那一刻才上传（桥的 file_id 缓存 30 分钟，重启就废），单张 ≤10MB，最多 9 张
- 正文里的 `#话题` 会自动抽出来当话题传给桥

> **发出去撤不回。** 模块没有删帖接口（创作者后台的删除要浏览器里点），公开笔记发出去只能你自己登录创作者后台手动删。所以 `publishPrivate` 默认开，先用「仅自己可见」试，确认没问题再关。

## 自动刷帖（可选）

在设置里打开「自动刷帖」后，模块每 `autoIntervalMin` 分钟（默认 180，带 0.8–1.3 倍随机抖动）自己搜一轮关键词，挑没看过的笔记读一遍。

| 设置 | 默认 | 说明 |
|---|---|---|
| `autoBrowse` | 关 | 总开关，要完整功能 + 桥 |
| `autoIntervalMin` | 180 | 两轮之间至少隔多久，实际会随机浮动 |
| `autoKeywords` | 空 | 逗号分隔，轮着搜；空则用内置的宽泛词 |
| `autoPerRun` | 1 | 每轮看几篇（1–3） |
| `autoDailyNotes` | 10 | 每天最多刷几篇 |
| `autoRunsPerDay` | 8 | 每天最多跑几轮 |
| `autoHours` | 9-23 | 只在这个小时区间里跑 |
| `autoLike` / `autoDailyLikes` | 关 / 5 | 刷到就点赞。**小红书的点赞等于收藏**，会出现在自己的主页/赞过列表里，所以默认关 |
| `autoReply` | 关 | 刷到合适的会留一句评论，不想说话就跳过；和手动回帖共用每日额度与冷却 |
| `autoNotify` | 关 | 每轮结束给主人私聊发一条汇总 |

护栏：

- 默认全关；要同时满足「完整功能 + 自动刷帖 + 桥在线 + 不在风控冷却 + 在活跃时段 + 今天没被暂停」
- 看过的 id 记在 `state.json` 的 `seenNotes`，不会重复刷同一条
- 搜索、点赞、评论任意一步撞到验证码 / 429 / 「频繁」，当天直接停（`autoPauseDay`），第二天自动恢复
- 面板上有今天刷了几篇、跑了几轮、下次大概几点，以及「立即刷一次」

## 工具

| 工具 | 用途 |
|---|---|
| `xhs_search` | 搜笔记，回标题、作者、赞评数和**完整链接** |
| `xhs_read` | 看一条笔记的正文和配图；给链接，或者 `note_id` + `token` |
| `xhs_comments` | 读评论 / 楼中楼 |
| `xhs_comment` | 发评论或回复某条评论。`reply_to` 填对方 comment_id 才是楼中楼；`at_user` 填对方 user_id 才会 @ 到人 |
| `xhs_like` | 点赞 / 取消赞（`action` 为 `like` 或 `unlike`） |
| `xhs_replies` | 看谁回复了她发过的评论，返回 note_id / reply_comment_id / user_id，可以直接接着回 |

后三个（评论、点赞、查回复）**只有主人私聊时才会挂出来**，另受 `allowComment`、评论间隔和每日上限约束。

命令：`/xhs 链接`、`/xhs 关键词`、`/xhs 健康`。

## cookie 怎么维护

- 模块只认面板里那份，不从任何文件读。
- 桥会自己轮换并回写它的 `xhs_cookies.json`，但**不会**同步到模块；两边各管各的。
- 读正文开始报「页面里没有状态数据（cookie 可能过期了）」时，从桥那边重新导出一份粘进面板就行。

## 注意

- 发评论是真的发到公开笔记下面，发出去不能撤回，只有主人私聊能用；删评论也只能你自己上小红书删。
- 发帖同理，而且更重：公开笔记只能你登录创作者后台手动删。
- 点赞会以账号身份留下痕迹，取消赞也不一定马上被平台回收计数。
- 搜索、评论、点赞都依赖小红书接口签名，上游改版后要更新桥。
- 撞到验证码或 429 时模块会进入冷却并拒绝继续请求（评论和点赞都算），不会自动过验证。
- 读评论有概率性空响应（平台软限流），桥里已经重试过。

## 许可

MIT，见 `LICENSE`。桥和 Spider_XHS 都不在本仓库内。
