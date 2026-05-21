# 发布到 VS Code / Cursor 应用市场

本文档说明如何将 **Mysql Instant Query** 扩展发布到 [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=meetrice.mysql-instant-query)。

Cursor 与 VS Code 共用同一套扩展市场，发布一次即可在两个编辑器中安装。

## 前置条件

### 1. 发布者账号

- Publisher ID：`meetrice`
- 管理入口：[Visual Studio Marketplace - Manage Publishers](https://marketplace.visualstudio.com/managepublishers)
- 若尚未创建 Publisher，需先用 Microsoft 账号登录并完成 [创建发布者](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#create-a-publisher) 流程

### 2. Personal Access Token (PAT)

发布扩展需要 Azure DevOps 的 Personal Access Token：

1. 打开 [Azure DevOps - Personal Access Tokens](https://dev.azure.com/meetrice/_usersSettings/tokens)（或使用与 Publisher 关联的 Microsoft 账号）
2. 点击 **New Token**
3. 设置：
   - **Name**：例如 `vscode-marketplace-publish`
   - **Organization**：`All accessible organizations`
   - **Expiration**：建议 90 天或自定义
   - **Scopes**：选择 **Custom defined**，勾选 **Marketplace** → **Manage**
4. 创建后**立即复制** Token（只显示一次）

> Token 过期后发布会报错：`The Personal Access Token used has expired`  
> 参考官方文档：[Publishing extensions - Get a Personal Access Token](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token)

### 3. 本地工具

```bash
# Node.js 与项目依赖
npm install

# vsce 无需全局安装，脚本使用 npx 调用
npx @vscode/vsce --version
```

## 发布前检查清单

每次发版前请确认：

- [ ] 功能开发与自测完成
- [ ] 更新 `package.json` 中的 `version`（遵循 [语义化版本](https://semver.org/)）
- [ ] 在 `RELEASE_NOTES.md` 顶部添加本版本说明
- [ ] 同步更新 `publish.sh` 中的版本号提示（可选，便于脚本输出）
- [ ] 运行 `npm run compile` 确保无编译错误
- [ ] 本地验证：`./build-and-install.sh` 安装 VSIX 后手动测试

## 一键发布（推荐）

项目根目录提供了 `publish.sh`：

```bash
# 1. 设置 PAT（不要将 Token 提交到 Git）
export VSCE_PAT="你的_Personal_Access_Token"

# 2. 执行发布脚本
./publish.sh
```

脚本会依次执行：

1. 清理 `out/` 并 `npm run compile`
2. `npx @vscode/vsce package` 生成 `mysql-instant-query-x.y.z.vsix`
3. `npx @vscode/vsce publish` 上传到 Marketplace

发布成功后，建议执行 Git 标记（脚本末尾会提示）：

```bash
git add package.json RELEASE_NOTES.md publish.sh
git commit -m "chore: release version x.y.z"
git tag vx.y.z
git push origin master --tags
```

## 手动分步发布

若需逐步排查问题，可手动执行：

```bash
# 编译
npm run compile

# 仅打包（不上传），用于本地安装测试
npx @vscode/vsce package
# 生成：mysql-instant-query-0.8.4.vsix

# 本地安装测试
code --install-extension mysql-instant-query-0.8.4.vsix --force

# 确认无误后发布
export VSCE_PAT="你的_PAT"
npx @vscode/vsce publish

# 或指定版本发布
npx @vscode/vsce publish 0.8.4
```

## 使用 vsce login（可选）

除环境变量 `VSCE_PAT` 外，也可将 Token 存入本地密钥链：

```bash
npx @vscode/vsce login meetrice
# 按提示输入 PAT

npx @vscode/vsce publish
```

查看已登录的发布者：

```bash
npx @vscode/vsce ls-publishers
```

## 验证发布结果

发布通常需要 **数分钟** 才能在市场索引中更新。

- 扩展页面：<https://marketplace.visualstudio.com/items?itemName=meetrice.mysql-instant-query>
- VS Code 内搜索：`Mysql Instant Query`
- 命令行查看版本：

```bash
code --install-extension meetrice.mysql-instant-query
```

## 常见问题

### PAT 过期

```
Access Denied: The Personal Access Token used has expired.
```

按上文「Personal Access Token」章节重新创建 Token，并更新 `VSCE_PAT` 或重新 `vsce login`。

### 版本号已存在

```
Error: Extension version already exists
```

在 `package.json` 中递增 `version` 后重新发布。Marketplace 不允许覆盖已发布的同一版本。

### 打包体积过大警告

vsce 可能提示 JavaScript 文件过多。当前扩展通过 `.vscodeignore` 排除源码与开发文件；若需进一步优化，可考虑 webpack 打包（见 [Bundling Extensions](https://code.visualstudio.com/api/working-with-extensions/bundling-extension)）。

### 仅本地安装、不发布市场

使用 `./build-and-install.sh`，会自动编译、打包、安装到 VS Code，并同步到 Cursor 扩展目录。

## 相关文件

| 文件 | 说明 |
|------|------|
| `package.json` | 扩展元数据与版本号 |
| `publish.sh` | 一键编译、打包、发布脚本 |
| `build-and-install.sh` | 本地编译安装（不发布市场） |
| `RELEASE_NOTES.md` | 版本更新说明 |
| `.vscodeignore` | 打包时排除的文件 |

## 当前版本状态

| 项目 | 值 |
|------|-----|
| Extension ID | `meetrice.mysql-instant-query` |
| 最新待发布版本 | `0.8.4`（含查询结果面板性能优化） |
| VSIX 文件 | `mysql-instant-query-0.8.4.vsix`（已本地打包） |
