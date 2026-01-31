# Release Notes - Version 0.7.1

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
