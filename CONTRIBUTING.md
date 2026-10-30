# 贡献模块

## 提交步骤

1. Fork 本仓库，新建 `modules/<id>/`。格式见 [模块规范](docs/MODULE_SPEC.md)。
2. 本地检查（需要 Node.js 22.2 或更高版本）：

   ```sh
   npm run check
   npm run pack
   ```

3. 把文件夹复制到 Aurabot 数据目录的 `modules/<id>/`，在面板「扩展」页确认能跑。
4. 提 PR，按模板填写。

改已有模块时要升 `version`。入口文件和 `module.json` 里的 `id`、`version`、`api` 要保持一致。

## 审核

模块运行在用户的 Aurabot 进程里，能接触用户的 QQ 和账号配置，所以每次新增和更新都由维护者审核后才会发布。审核重点：

- 代码能读懂，没有混淆，没有在运行时下载并执行代码。
- `capabilities` 和实际行为一致。
- 联网目标和 README 说明一致，用户的 Cookie、消息等数据没有被发到无关地址。
- 不做未经用户同意的群发、加好友、发帖等自动操作。
- 许可证允许本仓库分发，第三方代码已署名。

`pet-pack/` 是素材，不走这个流程。
