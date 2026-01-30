# Release Notes - Version 0.6.0

## 🎉 Major New Features

### 1. SQL Editor Run Now Buttons
- Added "Run Now" buttons (▶) above each SQL statement in the SQL editor
- Click to execute individual SQL statements without updating editor content
- Supports multiple SQL statements with individual buttons for each
- Uses CodeLens API for seamless integration

### 2. Enhanced Table Information Display
- Results panel now displays the current table name at the top
- Shows format: `📊 Table: \`database\`.\`table\``
- Helps identify which table's data you're viewing

### 3. Improved SQL Statement Generation
- **Single-line format**: All generated UPDATE/INSERT/DELETE statements are now in single-line format for better readability
- **Smart appending**: Generated SQL statements automatically append to existing SQL editor instead of creating new tabs
- **Auto-scroll**: Editor automatically scrolls to show newly generated SQL in the center of the screen
- **Better table name parsing**: Enhanced SQL parsing to correctly handle `database.table` format

### 4. Enhanced Table Name Parsing
- Improved parsing of SQL queries with better support for:
  - `database`.`table` format (with backticks)
  - `database`.table format
  - database.`table` format
  - Simple table names
- Added comprehensive debugging logs for troubleshooting

## 🔧 Improvements

### Smart SQL Editor Management
- Prioritizes appending to existing SQL editors over creating new ones
- Searches through visible editors and all open documents
- Only creates new SQL documents when none exist

### Better User Experience
- All right-click menu commands now append SQL to current editor by default
- No more cluttering with multiple SQL tabs
- Cursor positioning at newly generated SQL for immediate review

### Enhanced Debugging
- Added console logging for UPDATE/INSERT statement generation
- Better error messages with specific details about what's missing
- Logs table name parsing steps for troubleshooting

## 🐛 Bug Fixes

- Fixed "Cannot determine database or table for UPDATE operation" error
- Corrected table name parsing to handle `database.table` format properly
- Fixed Count Table function to append instead of replace content
- Resolved duplicate variable declarations in webview rendering

## 📝 Technical Details

### Modified Files
- `src/runButtonProvider.ts` - CodeLens provider for SQL statements
- `src/common/utility.ts` - Enhanced SQL parsing and editor management
- `src/extension.ts` - Improved UPDATE/INSERT/DELETE generation
- `src/sqlResultWebView.ts` - Table name display in results
- `package.json` - Version update to 0.6.0

### Configuration
- Added `mysql-instant-query.enableRunNowCodeLens` setting (default: true)

## 🚀 Usage Examples

### Run Now Buttons
```sql
SELECT * FROM users WHERE id = 1;
-- ▶ Run Now button appears above

SELECT * FROM orders WHERE status = 'pending';
-- ▶ Run Now button appears above this too
```

### Generated SQL Format
```sql
-- UPDATE (single line)
UPDATE `database`.`table` SET `column` = 'value' WHERE `id` = 1;

-- INSERT (single line)
INSERT INTO `database`.`table` (`col1`, `col2`) VALUES ('val1', 'val2');

-- DELETE (single line)
DELETE FROM `database`.`table` WHERE `id` = 1;
```

## 📋 Compatibility

- Requires VS Code version 1.83.0 or higher
- Compatible with MySQL 5.x, 8.x, and 9.x
- Supports both SSL and non-SSL connections

---

**Full Changelog**: See previous versions for details on earlier features.
