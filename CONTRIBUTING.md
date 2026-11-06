# 参与贡献

欢迎提交问题与 Pull Request。普通问题请附操作步骤、预期与实际结果、Windows / Linux 版本、Node.js 版本，以及脱敏后的相关日志。安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。

```bash
npm ci
npm run check
npm test
```

修改文件安装、解压、下载、权限或恢复流程时，请补充能验证边界与失败恢复的回归测试。测试使用临时目录和明确的服务器替身，不对在线玩家发送测试消息，也不下载或运行真实游戏服务器。

浏览器冒烟检查：

```bash
npx playwright install chromium
npm run test:e2e
```

浏览器检查使用独立临时账号与服务器格式样本，退出后清理；工坊网络不属于此冒烟检查的验收范围。

请勿提交 `.env`、数据库、私钥、真实账号、服务器地址、日志、第三方游戏内容、`node_modules/` 或原始部署截图。提交前检查 `git diff --cached`。提交的原创代码按仓库 MIT 许可证提供；引入外部代码时必须保留其许可证与署名。
