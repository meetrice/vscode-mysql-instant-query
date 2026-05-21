# Mysql Instant Query

A powerful and efficient MySQL instant query tool for Visual Studio Code with advanced filtering, snippets, and table management capabilities.

## Screenshots

*main*
![screenshot](images/screenshot.png)

*count*
![count](images/count.png)

*select column*
![select column](images/select%20column.png)

*select filter*
![select filter](images/select%20filter.png)


![view table structure](images/view%20table%20structure.png)


## Features

### Core Functionality
- **Manage MySQL Connections** - Support SSL connections with secure password storage
- **Browse MySQL Structure** - Navigate servers, databases, tables, and columns in a tree view
- **Run SQL Queries** - Execute queries with result preview and syntax highlighting
- **Edit Connection Display Names** - Customize how your connections appear

### Advanced Filtering
- **Table Filter** - Quickly filter tables by name or comment in real-time
- **Column Filter** - Filter columns within tables by name, type, or comment
- **Auto-Expand** - Tables automatically expand when column filter is active

### SQL Snippets Panel
Quick-access buttons for common SQL keywords and patterns:
- `SELECT *`, `COUNT`, `WHERE`, `AND`, `OR`
- `ORDER BY`, `GROUP BY`, `LIMIT`, `LIKE`, `IN`
- `INSERT`, `UPDATE`, `DELETE`, `JOIN`, `LEFT JOIN`

### Table Management
- **Pin Tables** - Pin frequently used tables to the top for quick access
- **Double-Click Table** - Quickly select top 100 rows
- **Table Structure View** - View detailed table structure with columns, keys, indexes, and sample data
- **Copy Table Name** - One-click copy to clipboard
- **Count Rows** - Get row count for any table
- **Add Column** - Interactive column creation wizard
- **Drop Table** - Delete tables with confirmation
- **Backup Table** - Create timestamped table backups

### Column Operations
- **Select Column** - Query a single column with auto-ordering
- **Select with Filter** - Apply WHERE conditions to column queries
- **Copy Column Name** - Copy column name to clipboard
- **Insert Column Name** - Insert column name at cursor position
- **Drop Column** - Generate DROP COLUMN SQL

### UI Enhancements
- **Smart Expand/Collapse** - Dynamic icons that change based on state
- **System Database Filter** - Hides system databases (information_schema, mysql, performance_schema, sys)
- **Table Comments** - View table comments in tooltips and descriptions
- **Column Details** - View column name, type, and comment in a clean format

## Usage

### Add MySQL Connection

1. Click the **Mysql Instant Query** icon in the Activity Bar
2. Click the **+** button in the sidebar
3. Enter connection details:
   - Host
   - Username
   - Password (securely stored)
   - Port (default: 3306)
   - SSL certificate path (optional)

### Run SQL Query

Open a SQL file, then use one of these methods:
- Right-click and select **Run MySQL Query**
- Use shortcut: `Ctrl+Alt+E` (Windows/Linux) or `Cmd+Alt+E` (macOS)
- Press `F1` and type `Run MySQL Query`

You can also select a portion of SQL to run only the selected query.

### Quick Table Access

- **Double-click** any table to select the top 100 rows
- **Pin** frequently used tables by right-clicking and selecting "Pin Table"

### Filter Tables & Columns

Use the **Filter & Snippets** panel at the top of the sidebar:
- Type in the **Table** field to filter tables
- Type in the **Column** field to filter columns within expanded tables
- Click snippet buttons to insert SQL keywords into your editor

### Keyboard Shortcuts

| Key | Command |
|-----|---------|
| `Ctrl+Alt+E` / `Cmd+Alt+E` | Run MySQL Query |
| `Ctrl+Shift+T` / `Cmd+Shift+T` | Open Table |
| `Ctrl+Shift+F` / `Cmd+Shift+F` | Focus Table Filter |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysql-instant-query.maxTableCount` | `500` | Maximum number of tables shown in tree view |
| `mysql-instant-query.enableDelimiterOperator` | `true` | Enable support for DELIMITER operator |
| `mysql-instant-query.enableTelemetry` | `true` | Anonymous usage collection |
| `mysql-instant-query.enableCountQuery` | `false` | Run COUNT(*) before SELECT to choose auto LIMIT |
| `mysql-instant-query.defaultQueryLimit` | `100` | Auto LIMIT for small tables (when count query enabled) |
| `mysql-instant-query.largeTableQueryLimit` | `5000` | Auto LIMIT for large tables or when count query disabled |
| `mysql-instant-query.largeTableThreshold` | `1000` | Row count threshold for large table LIMIT |
| `mysql-instant-query.uriDefaultLimit` | `100` | Default LIMIT when opening table via URI |

## Requirements

- Visual Studio Code 1.83.0 or higher
- MySQL 5.0 or higher (including MySQL 8.0+)

## Publishing

This extension is published to the Visual Studio Marketplace as [`meetrice.mysql-instant-query`](https://marketplace.visualstudio.com/items?itemName=meetrice.mysql-instant-query).

### Quick publish

```bash
export VSCE_PAT="your_azure_devops_pat"   # Marketplace → Manage scope
./publish.sh
```

The script compiles TypeScript, packages a `.vsix`, and uploads to the marketplace.

### Local install only (no marketplace)

```bash
./build-and-install.sh
```

### Full guide

See **[docs/publishing.md](docs/publishing.md)** for:

- Creating a Publisher and Personal Access Token (PAT)
- Pre-release checklist
- Manual step-by-step publish commands
- Troubleshooting (expired PAT, duplicate version, etc.)

## Repository

This is an enhanced MySQL management tool for Visual Studio Code.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT

## Marketplace

Available on [Visual Studio Code Marketplace](https://marketplace.visualstudio.com/items?itemName=meetrice.mysql-instant-query) and installable in Cursor.

---

**Enjoy using Mysql Instant Query!**
