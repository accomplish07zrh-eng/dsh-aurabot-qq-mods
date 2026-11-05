# 看小红书（xhs）

让她逛小红书：搜笔记、看正文和配图、读评论、回评论。

## 它需要一座桥

小红书那套签名（`x-s` / `x-t` / `x-s-common` / `x-rap`）是 Python 生态里的活儿，插件是 Node。
所以这个模块拆成两半：

- **本模块（Node）**：工具、人格接线、发图。读单条正文走页面 SSR，不需要签名。
- **xhs-bridge（Python，单独部署）**：搜索、读评论、发评论这些要签名的活儿交给它。

没有桥，`xhs_search` / `xhs_comments` / `xhs_comment` 都用不了，`xhs_read` 还能用（只要配了 cookie）。

## 部署桥

桥的源码、依赖清单、启动参数和接口样例见随包的 `xhs-bridge/`（MIT）。
一句话版：

```bash
pip install -r requirements.txt          # 桥目录里
XHS_BRIDGE_PORT=8099 XHS_BRIDGE_TOKEN=<随机串> python3 xhs_bridge.py
```

然后在这个模块的设置里填：

| 设置项 | 说明 |
|---|---|
| `bridgeUrl` | 桥地址，默认 `http://127.0.0.1:8099` |
| `bridgeToken` | 桥设了 `XHS_BRIDGE_TOKEN` 就填这里 |
| `cookieFile` | 桥工作区那份 `xhs_cookies.json`；读正文用它 |
| `cookie` | 手填 cookie，优先级最高（一般不用） |
| `sendImages` / `maxImages` | 读帖时顺带发几张图 |
| `allowComment` | 回帖总开关 |
| `cooldownSec` | 两条评论之间的最小间隔 |

## 工具

| 工具 | 用途 |
|---|---|
| `xhs_search` | 搜笔记，回标题、作者、赞评数和 `id` + `token` |
| `xhs_read` | 看一条笔记的正文和配图。**纯 id 必须同时给 token**，否则页面是空壳 |
| `xhs_comments` | 读评论 / 楼中楼 |
| `xhs_comment` | 发评论或回复某条评论（`reply_to` 填对方 comment_id，`at_user` 填对方 user_id 才会 @ 到人）。**只有主人私聊时才会挂出来**，且受 `allowComment` 和冷却限制 |
| `xhs_like` | 点赞 / 取消赞（`action` 为 `like` 或 `unlike`）。仅主人私聊 |
| `xhs_replies` | 看谁回复了我发过的评论，返回 note_id / reply_comment_id / 对方 user_id，可直接接着回。仅主人私聊 |

命令：`/xhs 链接`、`/xhs 关键词`、`/xhs 健康`。

## 注意

- 发评论是真的发到公开笔记下面，发出去不能撤回，只有主人私聊能用。
- 搜索和评论依赖小红书接口签名，上游改版后要更新桥。
- 读评论有概率性空响应（平台软限流），桥里已经重试过。
