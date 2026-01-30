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

## 🔧 Improvements

### Better User Experience
- Results panel uses full available space with zero padding
- Column widths persist during the session
- More intuitive table layout
- Cleaner visual hierarchy

### Enhanced Code Quality
- Fixed table name parsing edge cases
- Improved SQL statement boundary detection
- Better handling of complex SQL with nested structures

## 🐛 Bug Fixes

- Fixed "Run Now" button including content after semicolon in execution
- Resolved SQL syntax errors caused by including table structure documentation
- Improved handling of quoted strings in SQL statement detection

## 📝 Technical Details

### Modified Files
- `src/sqlResultWebView.ts` - Column resize functionality, compact layout, enhanced title display
- `src/runButtonProvider.ts` - Improved SQL statement extraction logic
- `package.json` - Version update to 0.7.0

### Configuration
- No new settings added
- All existing settings remain unchanged

## 🚀 Usage Examples

### Resizing Columns
1. Open any query results
2. Move mouse to the right edge of any column header
3. Cursor changes to resize indicator
4. Click and drag to adjust width
5. Release to set new width

### Run Now Button Precision
```sql
-- This SQL will be executed completely:
SELECT * FROM `wecomf`.`fa_uran_videofiles` ORDER BY `id` DESC LIMIT 5;

-- This content (table structure) is NOT executed:
id (编号)  filename (文件名)  path (路径) ...
```

### Results Tab Title
- Tab shows: `` `database`.`table` ``
- Panel shows clean table without redundant title
- Maximum space for data viewing

## 📋 Compatibility

- Requires VS Code version 1.83.0 or higher
- Compatible with MySQL 5.x, 8.x, and 9.x
- Supports both SSL and non-SSL connections

---

**Full Changelog**: See previous versions for details on earlier features.
