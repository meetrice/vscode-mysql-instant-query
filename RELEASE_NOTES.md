# Release Notes - Version 0.8.7

## 📣 开源地址与用户交流

### README 更新
- 在 Marketplace 展示文档中新增开源仓库地址，方便用户查看源码、提交 Issue 和参与贡献
- 新增微信号 `meetrice`，引导用户围绕数据库查询、ERD 建模、Cursor 集成和插件使用进行交流

### 发布信息
- 升级版本号到 `0.8.7`
- 保留 `0.8.6` 中关于 SQL 查询、多数据库、结果过滤、ERD 和 Cursor 协议的功能说明

## 📝 Modified Files
- `package.json` — version update to 0.8.7
- `package-lock.json` — lockfile version update
- `README.md` — added open source repository and WeChat contact section
- `RELEASE_NOTES.md` — added 0.8.7 release notes

## 📋 Compatibility
- Requires VS Code version 1.83.0 or higher
- Compatible with MySQL, PostgreSQL, DuckDB, and SQLite

---

# Release Notes - Version 0.8.6

## 🚀 SQL 查询与多数据库增强

### SQL 查询工作流
- 强化以 SQL 为核心的查询体验，支持多连接、多 SQL 语句查询与表驱动 SQL 生成
- 优化查询结果视图说明与文档，突出从数据表生成 SQL、执行 SQL、分析结果的完整闭环

### 查询结果过滤
- 强化结果界面的列名过滤与记录过滤能力，提升宽表和大结果集下的数据定位效率
- 补充表过滤、字段过滤与结果过滤的使用场景说明

### ERD 实体关系图
- 完善 ERD 能力描述，突出多表自定义连接、保存打开、导出图片、缩放与缩略图交互
- 补充 DuckDB 表结构、主键、外键和 ERD 元数据读取能力说明

### Cursor 协议集成
- 完善 `cursor://` 文件协议使用说明，支持从网页、文档或外部工具直接唤起 Cursor 并定位指定数据表

### 多数据库支持
- 更新文档与发布说明，明确支持 MySQL、PostgreSQL、DuckDB、SQLite 等主流数据库
- 更新 README 中文版，补充新版功能概览、使用场景和环境要求

## 📝 Modified Files
- `package.json` — version update to 0.8.6
- `package-lock.json` — lockfile version update
- `README.md` — updated Chinese README and feature overview
- `README.en.md` — preserved English README
- `images/01.gif` / `images/02.gif` / `images/03.gif` / `images/04.gif` — feature demos

## 📋 Compatibility
- Requires VS Code version 1.83.0 or higher
- Compatible with MySQL, PostgreSQL, DuckDB, and SQLite

---

# Release Notes - Version 0.8.5

## 🎉 ERD 界面与导出

### 顶部工具条
- 操作按钮改为顶部居中横向工具条，使用 Lucide 线性图标与中文标签
- 新增导出菜单，支持导出 JPG 与 PDF

### 画布控件
- 左下角缩略图按钮改为 map 图标，右下角重置按钮改为 scan-search 图标
- 重置按钮除恢复 100% 缩放外，还会将 ERD 内容居中到可视区域

### 导出优化
- 修复 webview 安全策略导致的导出失败问题
- 提升导出清晰度（高分辨率渲染）
- 导出内容包含表注释与列注释，布局与界面一致（单行显示）

## 📝 Modified Files
- `src/erdWebView.ts` — 工具条、图标、导出、居中视图

## 📋 Compatibility
- Requires VS Code version 1.83.0 or higher
- Compatible with MySQL 5.x, 8.x, and 9.x

---

# Release Notes - Version 0.8.4

## 🚀 Performance

### Query Result Panel — Client-Side Rendering
- Rewrote result WebView to use JSON data + client-side rendering instead of generating full HTML for every row
- Only the current page of rows is rendered in the DOM (default 10 rows), dramatically improving load time for large result sets (e.g. 5000 rows)
- WebView shell is loaded once; subsequent refreshes use `postMessage` instead of replacing the entire HTML document

### Async Column Comments
- Column comments from `information_schema` are fetched in the background after results are shown
- Added LRU cache (100 tables, 30 min TTL) to avoid repeated metadata queries

### Query Optimizations
- `COUNT(*)` before SELECT is now **disabled by default** (`enableCountQuery`) to reduce latency on large tables
- New configurable auto-LIMIT settings: `defaultQueryLimit`, `largeTableQueryLimit`, `largeTableThreshold`
- Removed external Font Awesome CDN dependency from result panel

## 📝 Modified Files
- `src/sqlResultWebView.ts` — client-side rendering architecture
- `src/common/utility.ts` — async comments, LRU cache, configurable LIMIT/COUNT
- `package.json` — new configuration options

## 📋 Compatibility
- Requires VS Code version 1.83.0 or higher
- Compatible with MySQL 5.x, 8.x, and 9.x

---

# Release Notes - Version 0.8.3

## 🔧 Improvements

### Auto-Limit Threshold for Large Tables
- Increased default auto-limit from 1000 to 5000 rows when table row count exceeds 1000
- Improves query preview for large tables while maintaining performance safeguards

## 📝 Modified Files
- `src/common/utility.ts` - Updated auto-limit logic for large result sets

## 📋 Compatibility
- Requires VS Code version 1.83.0 or higher
- Compatible with MySQL 5.x, 8.x, and 9.x

---

# Release Notes - Version 0.8.2

## 🔧 Improvements

### 1. Auto-Limit for Large Result Sets
- Automatically applies LIMIT when query result exceeds configured threshold
- Improves table UX performance for large datasets
- Configurable limit via `mysql-instant-query.uriDefaultLimit` setting

### 2. URI Handler for External Table Queries
- Added support for `cursor://meetrice.mysql-instant-query` URI scheme
- Open tables directly via URL with configurable parameters (table name, prefix, limit)
- Enables deep linking to specific tables

### 3. Enhanced Row Deletion
- Added connection validation before row deletion
- Real-time UI updates after deletion operations

### 4. Table UI Refinements
- Refined table header and pagination styling
- Updated table container layout
- Adjusted column filter layout

### 5. Improved Logging & Startup
- Output channel logging implementation
- Auto-select first connection database on startup
- Auto-select first user database when none selected

### 6. Build Improvements
- Added Cursor extension sync support
- Removed unused output channel

## 📝 Modified Files
- `src/query.ts` - Auto-limit logic and query improvements
- `src/tableWebView.ts` - Table UI refinements
- `src/sqlResultWebView.ts` - Result panel layout improvements
- `src/extension.ts` - URI handler and startup logic
- `package.json` - URI scheme registration, new configuration options
- `publish.sh` - Version update to 0.8.2

## 📋 Compatibility
- Requires VS Code version 1.83.0 or higher
- Compatible with MySQL 5.x, 8.x, and 9.x
- Supports both SSL and non-SSL connections

---

# Release Notes - Version 0.8.1

## 🎨 UI Improvements

### 1. ERD View Button Enhancements
- **Icon-only buttons**: Changed action buttons from text+emoji to emoji-only for cleaner design
- **Consistent sizing**: All buttons now have uniform 40x40px dimensions
- **Improved spacing**: Added proper padding and alignment for better visual harmony
- **Theme adaptability**: Emoji icons automatically adjust to VS Code theme colors (light/dark)
- **Clear tooltips**: Hovering over buttons still shows descriptive tooltips

### Button Changes
- **New ERD**: Changed from "✨ New" to "✨"
- **Save ERD**: Changed from "💾 Save" to "💾"
- **Open ERD**: Changed from "📂 Open" to "📂"

## 🔧 Improvements

### Better User Experience
- More compact button layout saves screen space
- Visual consistency with VS Code's design style
- Faster recognition of button functions with emoji-only design
- Maintains all existing functionality and keyboard accessibility

## 📝 Technical Details

### Modified Files
- `src/erdWebView.ts` - Updated button HTML and CSS styles
- `package.json` - Version update to 0.7.1
- `publish.sh` - Updated script for version 0.7.1

### Configuration
- No new settings added
- All existing settings remain unchanged

## 🚀 Usage Examples

### ERD View Buttons
1. Open any ERD diagram
2. Action buttons are now located at the top right corner
3. Hover over buttons to see tooltips
4. Click buttons to perform actions (New/Save/Open)

### Button Functions
- **✨ (New ERD)**: Creates a new empty ERD diagram
- **💾 (Save ERD)**: Saves current ERD to .merd file
- **📂 (Open ERD)**: Opens existing ERD file from disk

## 📋 Compatibility

- Requires VS Code version 1.83.0 or higher
- Compatible with MySQL 5.x, 8.x, and 9.x
- Supports both SSL and non-SSL connections

---

# Release Notes - Version 0.7.0

## 🎉 Major New Features

### 1. Resizable Table Columns
- Added drag-to-resize functionality for all table columns
- Hover over column edge to see resize cursor
- Drag to adjust column width to your preference
- Minimum width of 50px prevents columns from becoming too narrow
- Width changes sync across header rows and data cells

### 2. Enhanced Results Panel Layout
- **Compact design**: Removed padding around table edges for maximum viewing space
- **Clean title display**: Results tab now shows `\`database\`.\`table\`` format in tab title
- **Removed duplicate header**: Table name no longer shows inside panel (avoids redundancy)
- Table flush against panel edges for better space utilization

### 3. Improved "Run Now" Button Accuracy
- **Precise SQL extraction**: "Run Now" button now executes only the SQL statement from keyword to semicolon
- Handles nested parentheses correctly
- Properly tracks quotes (single, double, backtick)
- Respects escape characters
- Excludes any content after the semicolon (like table structure documentation)

---

**Full Changelog**: See previous versions for details on earlier features.
