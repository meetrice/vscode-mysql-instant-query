# Mysql Instant Query

[中文](README.md)

Mysql Instant Query is a professional SQL-centric database query and development tool. It supports mainstream databases including MySQL, PostgreSQL, DuckDB, and SQLite, helps generate SQL from database tables quickly, executes SQL instantly, and presents query results in a visual result view. It also provides column-name filtering, record filtering, professional ERD entity relationship diagrams, custom graphical relationships, and Cursor file protocol deep links for locating database tables from external tools, helping developers query, analyze, and develop against databases more efficiently.

## Highlights

### 1. SQL Query

The SQL editor supports multiple connections and multiple SQL statement execution.

![SQL Query](images/01.gif)

### 2. Filtered Query

Supports column-name filtering and record filtering.

![Filtered Query](images/02.gif)

### 3. ERD Entity Relationship Diagram

Supports custom relationships across multiple tables, saving and reopening diagrams, and exporting diagrams as images.

![ERD](images/03.gif)

### 4. Cursor Protocol

Use the `cursor://` protocol to launch Cursor directly from a web page or external tool and query a specified database table.

![Cursor Protocol](images/04.gif)

## Feature Overview

### SQL Query And Result Analysis

- **Multi-connection queries** - Execute SQL against selected connections from the SQL editor, suitable for managing multiple database environments
- **Multiple SQL statement execution** - Write and execute multiple SQL statements in the same editor to improve debugging and data validation efficiency
- **Table-driven SQL generation** - Quickly generate common SQL statements from tables, columns, and structure metadata to reduce repetitive manual SQL writing
- **Visual query results** - Present SQL execution results in structured tables with large result browsing, column resizing, and result panel interactions
- **Smart LIMIT strategy** - Configure automatic LIMIT behavior based on table size to balance query performance and result completeness

### Fast Filtering

- **Table filtering** - Locate target tables quickly by table name or table comment
- **Column-name filtering** - Filter fields quickly in table structures and query results, useful for wide tables, complex schemas, and multi-column result sets
- **Record filtering** - Filter records directly in the query result view to locate abnormal data, business samples, and key records efficiently
- **Structure linkage** - Automatically expand related table structures when filtering fields, reducing the cost of finding columns in complex databases

### ERD Entity Relationship Diagram

- **Professional ERD view** - Generate entity relationship diagrams from table structures, primary keys, and foreign keys to help understand data models
- **Custom multi-table relationships** - Create custom relationships between tables in the diagram, suitable for business databases without explicit foreign key constraints
- **Save and reopen** - Save ERD layouts and reopen them later to preserve project-level database structure views
- **Image export** - Export ERD diagrams as images for technical documents, reviews, and team collaboration
- **Enhanced diagram interactions** - Provides zooming, thumbnails, and a centered toolbar for browsing large data models

### Cursor Protocol Integration

- **External table deep links** - Use the `cursor://` file protocol to launch Cursor from web pages, documents, or external tools and locate a specified database table directly
- **Development workflow integration** - Connect database tables with internal systems, API documentation, development platforms, or data dictionaries to reduce context switching
- **Fast query entry point** - Allow external tools to jump directly to target database resources and provide an efficient query entry point for developers

### Multi-Database And Connection Management

- **Mainstream database support** - Supports MySQL, PostgreSQL, DuckDB, SQLite, and related database workflows
- **DuckDB deep integration** - Supports reading DuckDB table structures, primary keys, foreign keys, and ERD metadata
- **Connection testing** - Validate connection availability when adding or editing a connection to reduce configuration errors
- **Connection editing** - Edit connection display names, connection parameters, SSL settings, and database options
- **Secure storage** - Store database passwords through VS Code secure storage

## Use Cases

- **Daily data querying** - Generate SQL from table structures and analyze data directly in the result view after execution
- **Troubleshooting and debugging** - Use multiple SQL statements, record filtering, and column-name filtering to locate abnormal data quickly
- **Database structure understanding** - Use table structure views and ERD diagrams to understand business data models
- **Team knowledge sharing** - Embed ERD images, Cursor protocol links, and table entry points into documentation or internal platforms
- **Cross-database development** - Keep a consistent query experience across MySQL, PostgreSQL, DuckDB, and SQLite

## Usage

### Add Database Connection

1. Click the **Mysql Instant Query** icon in the Activity Bar
2. Click the **+** button in the sidebar
3. Select the database type and enter connection details
4. Use connection testing to verify the configuration
5. Save the connection and browse databases, tables, and columns

### Execute SQL Query

Open a SQL file or generate SQL from a database table, then execute it using one of these methods:

- Right-click and select **Run MySQL Query**
- Use shortcut: `Ctrl+Alt+E` (Windows/Linux) or `Cmd+Alt+E` (macOS)
- Press `F1` and type `Run MySQL Query`

You can write multiple SQL statements in the same editor and execute a selected statement or selected fragment.

### Analyze Query Results

- Use column-name filtering to narrow down visible fields quickly
- Use record filtering to locate target rows quickly
- Resize columns to inspect long text, IDs, timestamps, and business fields
- Configure automatic LIMIT behavior based on table size to avoid accidentally querying very large tables

### Use ERD

- Open an ERD entity relationship diagram from a database or multiple tables
- Generate base relationships from primary keys and foreign keys
- Add custom relationships for business tables without foreign key constraints
- Save the diagram layout and continue editing it later
- Export the ERD as an image for documents or reviews

### Use Cursor Protocol

After configuring a `cursor://` link in a web page, document, or external system, you can launch Cursor directly and locate a specified database table. This is useful for data dictionaries, admin panels, API documentation, and development platforms.

## Keyboard Shortcuts

| Key | Command |
|-----|---------|
| `Ctrl+Alt+E` / `Cmd+Alt+E` | Run SQL Query |
| `Ctrl+Shift+T` / `Cmd+Shift+T` | Open Table |
| `Ctrl+Shift+F` / `Cmd+Shift+F` | Focus Table Filter |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `mysql-instant-query.maxTableCount` | `500` | Maximum number of tables shown in tree view |
| `mysql-instant-query.enableDelimiterOperator` | `true` | Enable support for the DELIMITER operator |
| `mysql-instant-query.enableTelemetry` | `true` | Anonymous usage collection |
| `mysql-instant-query.enableCountQuery` | `false` | Run COUNT(*) before SELECT to choose automatic LIMIT behavior |
| `mysql-instant-query.defaultQueryLimit` | `100` | Automatic LIMIT for small tables when count query is enabled |
| `mysql-instant-query.largeTableQueryLimit` | `5000` | Automatic LIMIT for large tables or when count query is disabled |
| `mysql-instant-query.largeTableThreshold` | `1000` | Row-count threshold used to determine large-table LIMIT behavior |
| `mysql-instant-query.uriDefaultLimit` | `100` | Default LIMIT when opening a table through URI |

## Requirements

- Visual Studio Code 1.83.0 or higher
- Cursor or an editor compatible with the VS Code extension ecosystem
- MySQL 5.0+, PostgreSQL, DuckDB, or SQLite

## Publishing

This extension is published to the Visual Studio Marketplace as [`meetrice.mysql-instant-query`](https://marketplace.visualstudio.com/items?itemName=meetrice.mysql-instant-query).

### Quick Publish

```bash
export VSCE_PAT="your_azure_devops_pat"   # Marketplace -> Manage scope
./publish.sh
```

The script compiles TypeScript, packages a `.vsix`, and uploads it to the Marketplace.

### Local Install Only (No Marketplace)

```bash
./build-and-install.sh
```

### Full Guide

See **[docs/publishing.md](docs/publishing.md)** for:

- Creating a Publisher and Personal Access Token (PAT)
- Pre-release checklist
- Manual step-by-step publish commands
- Troubleshooting expired PAT, duplicate version, and related issues

## License

MIT

## Marketplace

Available on [Visual Studio Code Marketplace](https://marketplace.visualstudio.com/items?itemName=meetrice.mysql-instant-query) and installable in Cursor.

## Open Source And Community

- Open source repository: [https://github.com/meetrice/vscode-mysql-instant-query](https://github.com/meetrice/vscode-mysql-instant-query)
- WeChat: `meetrice`

You are welcome to submit issues, share feedback, or contribute through GitHub. For discussions about database querying, ERD modeling, Cursor integration, or plugin usage, you can also add WeChat `meetrice`.

---

**Mysql Instant Query aims to be a sharp and efficient tool for developers working on database querying, data analysis, and data model understanding.**
