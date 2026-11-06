# 星图

把 Aurabot 自己的记忆库渲染成一张可交互的 3D 星图。

- 数据源：Aurabot 的 `memory.sqlite`，通过内置 `memory` 模块读取；**不读 congling**
- 节点：长期记忆、每日摘要、人物小档案、老爹/群友等会话枢纽
- 交互：拖动旋转、滚轮缩放、搜索记忆；点星星看正文
- 面板：安装后在「已安装」或顶部「星图」打开
- 页面随模块分发，不依赖 AstrBot，也不会把记忆上传到任何地方

## 安装

Aurabot 插件 **1.2.0 及以上**，在面板「模块市场」安装后启用即可。

## 权限

- `filesystem`：读取模块自带的 `page.html`
- `plugin-internals`：通过 `api.use('memory')` 读取 Aurabot 记忆

不联网、不写用户文件、不修改记忆。

## 说明

页面基于 AstrBot 的「识海 / memory_sea」前端改写，适配了 Aurabot 的模块路由；数据和显示逻辑改由 Aurabot 记忆库提供。
