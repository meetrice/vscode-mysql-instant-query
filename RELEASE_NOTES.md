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
