# 第三方组件

本仓库的原创面板代码使用 MIT 许可证。第三方软件及内容适用各自许可证，本项目的 MIT 许可证不替代它们的授权条件。

直接 npm 依赖包括 Express、Helmet、https-proxy-agent、Multer、tar、yauzl、yazl、Zod；开发与浏览器测试依赖 Playwright。精确版本及传递依赖记录在 `package-lock.json`。它们通过 `npm ci` 从 registry 安装，许可证文件由各包随分发物提供；本仓库不捆绑 `node_modules`。

Node.js、SteamCMD、DepotDownloader、Caddy、Left 4 Dead 2、SourceMod、MetaMod，以及任何第三方地图、插件、扩展或图片不属于本项目原创面板代码。仓库只提供适配代码与通用部署模板，不分发这些程序或游戏内容。安装、下载和再分发时请分别遵守其许可证、Steam 条件与内容作者要求。

繁体中文翻译初稿使用 OpenCC（本地生成工具）转换；运行代码未包含或依赖 OpenCC。翻译修订方式见 `docs/i18n.md`。

Left 4 Dead 2 与 Steam 等名称用于说明兼容目标，本项目与 Valve 无隶属或官方背书关系。
