# 项目结构摘要

## 项目概述
MySQL Instant Query - VS Code 扩展，提供 MySQL/PostgreSQL/SQLite/DuckDB 数据库浏览器和 SQL 查询面板。

## 核心目录结构

```
src/
├── extension.ts                 # 扩展入口：注册所有命令、TreeView、URI Handler
├── mysqlTreeDataProvider.ts     # TreeView 数据提供器 + 表/列过滤状态管理
├── connectionWebView.ts         # 连接管理 WebView（增/删/改连接表单）
├── filterInputPanel.ts          # 侧边栏表名过滤 WebView
├── erdWebView.ts                # ERD 可视化 WebView（~3891行，核心视图）
├── sqlResultWebView.ts          # SQL 查询结果 WebView（~1821行，结果展示）
├── runButtonProvider.ts         # SQL 编辑器 CodeLens（Run Now 按钮）
├── sqlStatementConnectionManager.ts  # SQL 语句级连接管理
├── common/
│   ├── constants.ts             # 扩展 ID 和 GlobalState 键常量
│   ├── global.ts                # 全局活动连接 + 状态栏
│   ├── utility.ts               # 工具类：查询、配置、SQL 生成、文件操作
│   ├── dbDriver.ts              # 多数据库驱动封装（mysql2/pg/sqlite/duckdb）
│   ├── i18n.ts                  # 多语言管理
│   ├── outputChannel.ts         # Output 通道封装
│   └── appInsightsClient.ts     # 遥测
└── model/
    ├── connection.ts            # IConnection 接口 + 驱动/SSL 规范化
    ├── INode.ts                 # TreeView 节点接口
    ├── rootNode.ts              # 根节点
    ├── connectionNode.ts        # 连接节点
    ├── databaseNode.ts          # 数据库节点
    ├── tableNode.ts             # 表节点（查询、结构、固定、备份、删除）
    ├── columnNode.ts            # 列节点（选择、过滤、复制）
    ├── infoNode.ts              # 信息节点
    ├── addConnectionNode.ts     # 添加连接节点
    └── newQueryNode.ts          # 新建查询节点
```

## 资源与配置
- `package.json` — 完整命令、菜单、配置、快捷键定义
- `tsconfig.json` — TypeScript 编译配置（commonjs, es6, outDir: out）
- `language/` — 多语言包（en/zh-cn）
- `resources/` — 图标资源
- `docs/` — 开发文档（publishing, filter-fix）

## 技术栈
- VS Code Extension API（TreeView, WebView, CodeLens, UriHandler）
- TypeScript + ES6
- 数据库：mysql2, pg, better-sqlite3, duckdb
- 其他：asciitable, lru-cache, applicationinsights, uuid

## 常见修改场景

| 修改内容 | 对应文件 |
|---------|---------|
| 添加/修改命令 | `extension.ts` + `package.json` (commands + menus) |
| 修改连接表单 | `connectionWebView.ts` + `model/connection.ts` |
| 修改数据库查询逻辑 | `common/dbDriver.ts` |
| 修改 SQL 结果展示 | `sqlResultWebView.ts` |
| 修改 ERD 可视化 | `erdWebView.ts` |
| 修改表/列过滤 | `filterInputPanel.ts` + `mysqlTreeDataProvider.ts` |
| 修改树节点行为 | `model/tableNode.ts`, `model/columnNode.ts`, `model/databaseNode.ts` |
| 修改快捷键 | `package.json` → keybindings |
| 修改语言/国际化 | `language/` + `common/i18n.ts` |
| 修改 URI 外部链接处理 | `extension.ts` → `handleExternalUri()` |
| 修改配置项 | `package.json` → configuration + `common/utility.ts` |
| 添加新数据库驱动 | `common/dbDriver.ts` + `model/connection.ts` |
