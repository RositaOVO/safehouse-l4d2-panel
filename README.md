# SAFEHOUSE · 求生之路 2 服务器管理面板

中文 Web 管理面板，支持 **Windows 与 Linux**。使用 Node.js、SQLite 和原生前端模块管理 Left 4 Dead 2 专用服务器。

**开源许可证：MIT。** 本仓库仅包含面板源码、测试和通用部署模板，不包含游戏文件、第三方地图 / 插件、运行数据或任何线上实例的登录信息。

## 功能

- **服务器管理**：发现 Steam 库、授权目录及运行实例；接管已有服务器；通过 SteamCMD 安装与更新；启动、关闭、重启、异常拉起和连续崩溃保护。
- **Steam 工坊**：关键词搜索、排序、分类、分页；解析项目链接 / ID；展开合集；查看详情并安装地图。支持 Web API 与社区公开页面后备读取。
- **地图管理**：本地 VPK / ZIP 上传、工坊下载、公网 HTTP / HTTPS 直链下载、可选 SHA256 校验；地图与章节识别、启用 / 禁用、更新检查、版本回滚和卸载。
- **插件管理**：SourceMod / MetaMod 检测；显示磁盘文件与实际运行状态；启用、禁用、SMX 上传、标准目录 ZIP / TAR.GZ 安装及框架安装。
- **游戏运维**：RCON 控制台、在线玩家、踢人与封禁、SourceMod 公告、启动参数、配置编辑与历史恢复、玩法配置组。
- **维护**：任务队列与取消、定时计划、备份恢复、地图扫描接管、诊断包、通知、内存缓存整理和带预览的磁盘清理。
- **账号与安全**：账号密码登录、实例授权、四种角色、CSRF / Origin / Host 检查、来源与地址校验、路径边界、归档校验、文件事务与操作审计。
- **按需空间检查**：地图安装按真实文件、解压与回滚需求计算，同盘合并、跨盘分别检查；每个写入磁盘保留 256 MiB 余量，不用固定 5 GiB 门槛拦截小地图。

## 快速开始

安装受支持且已更新安全补丁的 Node.js 24.x 或 26.x。代码要求至少 24.22.1 / 26.12.1，具体范围见 `package.json`；`.node-version` 提供已验证的基线版本。

```bash
git clone https://github.com/RositaOVO/safehouse-l4d2-panel.git
cd safehouse-l4d2-panel
npm ci
```

Windows 双击 `start.cmd`；Linux 执行：

```bash
bash start.sh
```

打开 <http://127.0.0.1:8787>。首次启动创建 `admin` 账号，随机密码写入 `data/initial-access.txt`。登录后修改密码并删除该初始信息文件。

默认仅监听本机，不需要独立数据库服务。面板数据保存在 `data/`，可通过 `PANEL_DATA` 调整位置。首次接管前，在 `.env` 的 `ALLOWED_ROOTS` 中添加游戏安装目录的父目录，多个目录用分号分隔。

```dotenv
# Linux 示例；Windows 可使用 D:/GameServers
ALLOWED_ROOTS=/srv/l4d2
```

已有游戏服务器可直接接管；全新安装需要 SteamCMD 和足够磁盘空间。面板安装器要求至少 25 GiB 可用空间；地图安装使用单独的按需空间判断。实际完整服务端体积会随游戏更新而变化。

## 公网部署

公网访问必须使用 HTTPS 反向代理及专用低权限系统账号。通用部署步骤见 [Linux 部署说明](docs/deployment.md)，模板位于 `deploy/`。

```dotenv
HOST=127.0.0.1
PORT=8787
PUBLIC_ORIGIN=https://panel.example.com
TRUST_PROXY=loopback
```

反向代理应保留 Host 并设置 `X-Forwarded-Proto`。游戏端口与面板入口分开配置，RCON TCP 端口应仅允许本机或明确授权来源访问。

## 使用与开发

- [各模块使用说明](docs/usage.md)
- [部署与常见问题](docs/deployment.md)
- [安全边界与漏洞报告](SECURITY.md)
- [参与贡献](CONTRIBUTING.md)
- [第三方组件说明](THIRD_PARTY_NOTICES.md)

```bash
npm run check
npm test

# 可选：独立临时实例的浏览器冒烟检查
npx playwright install chromium
npm run test:e2e
```

自动测试使用临时文件、最小格式样本及显式替身，不下载或启动真实游戏服务器。浏览器冒烟检查也创建独立临时实例，不读取已有 `data/`。85 项自动测试已在 Windows、WSL Linux 与 Ubuntu 验证；这些检查不等于对任意第三方地图、插件或所有游戏模式完成实战验收。

`docs/ci.yml.example` 提供可选的 GitHub Actions 测试模板。复制到 `.github/workflows/ci.yml` 后启用；提交工作流需要 GitHub 账号 / 令牌具备相应权限。

## 注意事项

Steam 源站不可达、限流、权限限制或缺少有效文件下载地址时，工坊安装仍可能失败；界面会报告错误，不会模拟下载成功。地图与插件文件操作通常需要先停止游戏实例。第三方插件尤其是原生扩展必须来自可信来源。

本项目不是 Valve、Steam、SourceMod 或 MetaMod 的官方产品，也不包含它们的分发文件；有关软件及内容保留各自许可证与使用条件。
