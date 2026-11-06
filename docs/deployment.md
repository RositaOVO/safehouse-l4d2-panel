# 部署与常见问题

## 本地配置

从 `.env.example` 复制为 `.env`，按实际情况设置 `PANEL_DATA`、`ALLOWED_ROOTS` 和 `STEAMCMD_PATH`。启动脚本自动读取根目录 `.env`。

`ALLOWED_ROOTS` 使用分号分隔，Windows 路径可写成 `D:/GameServers`；Linux 可使用 `/srv/l4d2`。不要把整个文件系统当作游戏授权根目录。已有服务端目录应包含平台对应的启动文件与 `left4dead2/gameinfo.txt`。

## Linux systemd + Caddy 示例

以下示例在安装了 Node.js、npm、Caddy 和 systemd 的 Linux 主机上执行。路径均是通用示例，需要根据系统调整。创建系统账号、安装服务与配置 HTTPS 需要管理员权限，面板和游戏本身使用 `safehouse` 账号运行。

```bash
sudo useradd --system --create-home --home-dir /var/lib/safehouse --shell /usr/sbin/nologin safehouse
sudo install -d -o safehouse -g safehouse /var/lib/safehouse /srv/l4d2
sudo install -d -o root -g root /opt/safehouse /etc/safehouse
sudo cp -a src public scripts deploy package.json package-lock.json .node-version /opt/safehouse/
cd /opt/safehouse
sudo npm ci --omit=dev
sudo install -m 600 deploy/panel.env.example /etc/safehouse/panel.env
```

编辑 `/etc/safehouse/panel.env` 中的域名、目录与 SteamCMD 路径，再初始化管理员：

```bash
sudo -u safehouse node --env-file=/etc/safehouse/panel.env /opt/safehouse/src/cli.js init
sudo install -m 644 /opt/safehouse/deploy/safehouse.service /etc/systemd/system/safehouse.service
sudo systemctl daemon-reload
sudo systemctl enable --now safehouse
```

`deploy/safehouse.service` 中 `ExecStart` 默认使用 `/usr/bin/node`；如果 Node.js 安装在其他路径，请先修改。服务使用 `KillMode=process`，游戏进程由面板按 PID、创建时间和路径重新识别。仅重启面板不会主动重启已分离的游戏。

把 `deploy/Caddyfile` 的域名改为自己的解析域名并按 Caddy 的部署方式加载。HTTPS 反向代理需保留 Host、设置 `X-Forwarded-Proto: https`，并允许预期大小的上传。后端保持 `127.0.0.1:8787`，不直接暴露到公网。

开放所需的 HTTPS 端口与游戏 UDP 端口；游戏的 RCON TCP 端口仅允许本机或明确授权来源。具体防火墙和云平台安全组配置由部署环境决定，模板不会自动打开所有端口。

Linux 文件缓存回收助手是可选项：阅读 `deploy/install-maintenance-helper.sh` 后，以管理员身份执行。它安装固定的缓存回收动作及冷却时间，不赋予面板任意 root 命令执行入口。无需此功能时不安装。

## 数据与升级

升级前备份数据目录、`.env` / `panel.env` 和游戏配置；数据目录的 `master.key` 与数据库必须配套保存。源码与运行数据分开，切勿把数据库、初始密码、日志、备份或私钥提交到 GitHub。

更新源码后执行 `npm ci --omit=dev`，再重启面板服务。不要直接覆盖现有游戏目录；地图与插件更新使用面板事务和备份流程。若有任务运行中，先等待其完成或取消。

## 常见问题

- **忘记密码**：在本机带正确数据环境运行 `node --env-file-if-exists=.env src/cli.js reset-password admin`；新随机密码写入数据目录的 `initial-access.txt`，原会话失效。
- **工坊网络错误**：检查主机到 Steam 的 DNS / HTTPS 网络；可配置官方 Web API Key 或合适的 HTTPS 代理。不要禁用证书校验。特定项目可能受到 Steam 权限或下载策略限制。
- **目录不能接管**：检查授权根目录、文件权限、启动文件与 `gameinfo.txt`，避免使用目录联接 / 符号链接绕过边界。
- **地图不能安装**：先停止当前游戏实例；确认是实际 VPK / ZIP、空间足够、分卷完整，没有 BSP 重名冲突。任务详情会显示失败原因。
- **有空间却显示不足**：核对报错所指磁盘，安装还可能需要解压、最终写入和旧文件回滚副本；5 GiB 提醒线本身不阻止小地图安装。
- **插件有文件却未运行**：磁盘存在、是否启用、游戏是否加载是不同状态。查看插件详情、游戏日志、依赖扩展及 gamedata，而非仅按文件名判断成功。
- **公网上传失败**：检查反向代理上传体积 / 超时配置，以及面板磁盘额度。不要将登录页或分享网页当作地图直链。
