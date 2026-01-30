import * as vscode from "vscode";
import { Utility } from "./common/utility";

// Helper function to calculate string length (Chinese characters count as 2)
function getStringLength(str: string): number {
    let length = 0;
    for (let i = 0; i < str.length; i++) {
        const charCode = str.charCodeAt(i);
        // Chinese, Japanese, Korean characters are usually in ranges:
        // CJK Unified Ideographs: U+4E00–U+9FFF
        // CJK Extension A: U+3400–U+4DBF
        // CJK Extension B-F: U+20000–U+2EBEF (surrogate pairs)
        // Fullwidth ASCII variants: U+FF01–U+FF60
        if (charCode >= 0x4E00 && charCode <= 0x9FFF ||
            charCode >= 0x3400 && charCode <= 0x4DBF ||
            charCode >= 0xFF01 && charCode <= 0xFF60) {
            length += 2;
        } else {
            length += 1;
        }
    }
    return length;
}

export class SqlResultWebView {
    private static currentPanel: vscode.WebviewPanel | undefined = null;
    private static lastQueryInfo: { sql?: string; database?: string; table?: string } | undefined = undefined;

    public static async show(data, title, sql?: string, database?: string, table?: string) {
        // Always update or create SQL document with the new SQL
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.languageId === 'sql') {
            // Update existing SQL document (add empty line at beginning for consistency)
            const editor = vscode.window.activeTextEditor;
            const fullRange = new vscode.Range(
                editor.document.positionAt(0),
                editor.document.positionAt(editor.document.getText().length)
            );
            await editor.edit(editBuilder => {
                editBuilder.replace(fullRange, (sql ? "\n" + sql : "\n"));
            });
        } else {
            // Create new SQL document
            await Utility.createSQLTextDocument(sql || "");
        }

        // Split editor into two rows (上下分栏)
        await vscode.commands.executeCommand('workbench.action.editorLayoutTwoRows');

        // Create webview panel in the bottom group (ViewColumn.Two in two-row layout)
        const panel = vscode.window.createWebviewPanel("MySQL", title, vscode.ViewColumn.Two, {
            retainContextWhenHidden: true,
            enableScripts: true,
        });

        // Store query info for refresh functionality
        SqlResultWebView.lastQueryInfo = { sql, database, table };

        SqlResultWebView.currentPanel = panel;
        panel.webview.html = SqlResultWebView.getWebviewContent(data);

        // Focus the top editor (SQL) group and resize to ~40%
        await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
        // Decrease editor height to ~40% (each decrease is ~5%)
        for (let i = 0; i < 2; i++) {
            await vscode.commands.executeCommand('workbench.action.decreaseViewHeight');
        }

        // Handle panel close event
        panel.onDidDispose(() => {
            SqlResultWebView.currentPanel = undefined;
        });

        // Handle messages from webview
        panel.webview.onDidReceiveMessage(
            message => {
                if (message.command === 'refreshData') {
                    // Notify extension to refresh data
                    vscode.commands.executeCommand('mysqlInstantQuery.refreshResults');
                } else if (message.command === 'commitChanges') {
                    // Handle commit changes
                    vscode.commands.executeCommand('mysqlInstantQuery.commitChanges', message.changes);
                } else if (message.command === 'deleteRows') {
                    // Handle delete rows
                    vscode.commands.executeCommand('mysqlInstantQuery.deleteSelectedRows', message.rows);
                } else if (message.command === 'showWarning') {
                    // Show warning message
                    vscode.window.showWarningMessage(message.message);
                }
            },
            undefined,
            undefined
        );

    }

    public static updatePanel(data: any, sql?: string, database?: string, table?: string) {
        if (SqlResultWebView.currentPanel) {
            // Update SQL editor if SQL is provided
            if (sql) {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && activeEditor.document.languageId === 'sql') {
                    const editor = vscode.window.activeTextEditor;
                    const fullRange = new vscode.Range(
                        editor.document.positionAt(0),
                        editor.document.positionAt(editor.document.getText().length)
                    );
                    editor.edit(editBuilder => {
                        editBuilder.replace(fullRange, (sql ? "\n" + sql : "\n"));
                    });
                }
            }
            // Update stored query info
            if (sql || database || table) {
                SqlResultWebView.lastQueryInfo = {
                    sql: sql || SqlResultWebView.lastQueryInfo?.sql,
                    database: database || SqlResultWebView.lastQueryInfo?.database,
                    table: table || SqlResultWebView.lastQueryInfo?.table
                };
            }
            // Update webview content
            SqlResultWebView.currentPanel.webview.html = SqlResultWebView.getWebviewContent(data);
        }
    }

    public static getLastQueryInfo(): { sql?: string; database?: string; table?: string } | undefined {
        return SqlResultWebView.lastQueryInfo;
    }

    public static getWebviewContent(data): string {
        const style = `
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                    margin: 0;
                    padding: 16px;
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                }
                table {
                    border-collapse: collapse;
                    width: 100%;
                    font-size: 13px;
                }
                th {
                    background-color: #e0e0e0;
                    border: 1px solid #d0d0d0;
                    padding: 8px 12px;
                    text-align: left;
                    font-weight: 600;
                    cursor: pointer;
                    user-select: none;
                }
                thead tr:first-child th {
                    position: sticky;
                    top: 0;
                    z-index: 10;
                }
                thead tr:first-child th:hover {
                    background-color: #d0d0d0;
                }
                th.filter-header {
                    position: sticky;
                    top: 41px;
                    background-color: #f5f5f5;
                    padding: 4px 8px;
                    z-index: 9;
                }
                th.filter-header input {
                    width: 100%;
                    padding: 4px 6px;
                    font-size: 12px;
                    border: 1px solid #ccc;
                    border-radius: 2px;
                    box-sizing: border-box;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                }
                th.filter-header input:focus {
                    outline: none;
                    border-color: var(--vscode-focusBorder);
                }
                .column-filter-header {
                    position: sticky;
                    left: 0;
                    background-color: #e8e8e8;
                    z-index: 20;
                    width: 180px;
                    min-width: 100px;
                    text-align: center;
                    border-right: 2px solid #ccc;
                    position: relative;
                    padding: 8px 4px 8px 4px;
                }
                th.filter-header.sticky-column {
                    position: sticky;
                    left: 0;
                    z-index: 9;
                    width: 180px;
                    min-width: 100px;
                    border-right: 2px solid #ccc;
                }
                .resize-handle {
                    position: absolute;
                    right: 0;
                    top: 0;
                    height: 100%;
                    width: 10px;
                    cursor: col-resize;
                    background-color: transparent;
                    z-index: 100;
                }
                .resize-handle:hover, .resize-handle.active {
                    background-color: rgba(0, 122, 204, 0.3);
                }
                .column-filter-input {
                    width: 100%;
                    padding: 6px 12px 6px 6px;
                    font-size: 12px;
                    border: 1px solid #bbb;
                    border-radius: 3px;
                    box-sizing: border-box;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    pointer-events: auto;
                }
                .column-filter-input:focus {
                    outline: none;
                    border-color: var(--vscode-focusBorder);
                    box-shadow: 0 0 3px rgba(0, 122, 255, 0.3);
                }
                .column-filter-input::placeholder {
                    color: #999;
                    font-size: 11px;
                }
                .sticky-column {
                    position: sticky;
                    left: 0;
                    background-color: inherit;
                    border-right: 2px solid #ccc;
                    z-index: 5;
                    width: 180px;
                    min-width: 100px;
                }
                th.filter-header.sticky-column {
                    background-color: #f5f5f5;
                }
                .action-buttons {
                    display: flex;
                    gap: 6px;
                    align-items: center;
                    justify-content: center;
                    height: 100%;
                }
                .action-btn {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    width: 28px;
                    height: 28px;
                    border: 1px solid #bbb;
                    border-radius: 4px;
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    cursor: pointer;
                    font-size: 16px;
                    transition: all 0.2s;
                }
                .action-btn:hover {
                    background-color: var(--vscode-button-hoverBackground);
                    border-color: var(--vscode-button-border);
                }
                .action-btn:active {
                    transform: scale(0.95);
                }
                .action-btn.danger {
                    background-color: #f44336;
                    color: white;
                    border-color: #d32f2f;
                }
                .action-btn.danger:hover {
                    background-color: #d32f2f;
                }
                .action-btn.success {
                    background-color: #4caf50;
                    color: white;
                    border-color: #388e3c;
                }
                .action-btn.success:hover {
                    background-color: #388e3c;
                }
                .action-btn.hidden {
                    display: none;
                }
                .row-checkbox {
                    width: 16px;
                    height: 16px;
                    cursor: pointer;
                }
                tr.selected {
                    background-color: rgba(0, 122, 204, 0.1);
                }
                .edit-cell {
                    position: relative;
                }
                .edit-cell input {
                    width: 100%;
                    padding: 4px 6px;
                    border: 1px solid #007acc;
                    border-radius: 2px;
                    font-size: 13px;
                    font-family: inherit;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                }
                .edit-cell input:focus {
                    outline: none;
                    box-shadow: 0 0 3px rgba(0, 122, 255, 0.3);
                }
                .data-column.hidden {
                    display: none;
                }
                th.data-column.hidden, td.data-column.hidden {
                    display: none;
                }
                td {
                    border: 1px solid #e0e0e0;
                    padding: 6px 10px;
                }
                tr:hover {
                    background-color: var(--vscode-editor-hoverHighlightBackground);
                }
                .cell-wrapper {
                    display: inline-block;
                    max-width: 100%;
                }
                .cell-content {
                    white-space: nowrap;
                    display: inline-block;
                }
                .cell-content.truncated {
                    max-width: calc(100% - 30px);
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .expand-btn {
                    background: none;
                    border: none;
                    color: #888;
                    cursor: pointer;
                    padding: 2px 4px;
                    font-size: 14px;
                    display: none;
                    margin-left: 4px;
                }
                .expand-btn:hover {
                    color: var(--vscode-textLink-foreground);
                }
                .cell-content.truncated + .expand-btn {
                    display: inline-flex;
                }
                .empty-cell {
                    color: #999;
                    font-style: italic;
                }
                #modal {
                    display: none;
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background-color: rgba(0, 0, 0, 0.5);
                    z-index: 1000;
                    justify-content: center;
                    align-items: center;
                }
                #modal.show {
                    display: flex;
                }
                .modal-content {
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 8px;
                    padding: 20px;
                    max-width: 80%;
                    max-height: 80%;
                    overflow: auto;
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
                    position: relative;
                }
                .modal-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 16px;
                    padding-bottom: 12px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .modal-title {
                    font-weight: 600;
                    font-size: 14px;
                }
                .close-btn {
                    background: none;
                    border: none;
                    font-size: 20px;
                    cursor: pointer;
                    color: var(--vscode-editor-foreground);
                    padding: 0;
                    width: 28px;
                    height: 28px;
                }
                .close-btn:hover {
                    background-color: var(--vscode-editor-hoverHighlightBackground);
                    border-radius: 4px;
                }
                .modal-value {
                    word-wrap: break-word;
                    white-space: pre-wrap;
                    font-family: Consolas, Monaco, monospace;
                    font-size: 13px;
                    line-height: 1.5;
                }
                .no-data {
                    color: var(--vscode-descriptionForeground);
                    padding: 20px;
                    text-align: center;
                }
                .row-count {
                    margin-bottom: 12px;
                    color: var(--vscode-descriptionForeground);
                    font-size: 12px;
                }
                .pagination-container {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-top: 16px;
                    padding: 12px;
                    background-color: var(--vscode-editor-selectionBackground);
                    border-radius: 4px;
                    flex-wrap: wrap;
                    gap: 12px;
                }
                .pagination-info {
                    color: var(--vscode-descriptionForeground);
                    font-size: 12px;
                }
                .pagination-controls {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .pagination-btn {
                    padding: 4px 12px;
                    font-size: 12px;
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    border-radius: 2px;
                    cursor: pointer;
                    min-width: 32px;
                }
                .pagination-btn:hover:not(:disabled) {
                    background-color: var(--vscode-button-hoverBackground);
                }
                .pagination-btn:disabled {
                    opacity: 0.4;
                    cursor: not-allowed;
                }
                .pagination-btn.active {
                    background-color: var(--vscode-button-hoverBackground);
                    font-weight: 600;
                }
                .page-size-selector {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .page-size-label {
                    color: var(--vscode-descriptionForeground);
                    font-size: 12px;
                }
                .page-size-select {
                    padding: 4px 8px;
                    font-size: 12px;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 2px;
                    cursor: pointer;
                }
                .page-size-select:focus {
                    outline: none;
                    border-color: var(--vscode-focusBorder);
                }
                .pagination-pages {
                    display: flex;
                    gap: 4px;
                }
            </style>
        `;

        const script = `
            <script>
                const vscode = acquireVsCodeApi();
                let allTableData = [];
                let currentPage = 1;
                let pageSize = 10;
                let filteredData = [];

                // Initialize table data
                window.addEventListener('load', function() {
                    const tableRows = document.querySelectorAll('tbody tr');
                    allTableData = Array.from(tableRows).map(row => {
                        const cells = row.querySelectorAll('td');
                        const rowData = {};
                        cells.forEach((cell, index) => {
                            rowData['col_' + index] = cell.textContent;
                        });
                        return rowData;
                    });
                    updatePagination();
                    initColumnFilter();
                    initResizableColumn();
                    initFilters();
                    initActionButtons();
                    initRowCheckboxes();
                });

                // Column filter functionality
                function initColumnFilter() {
                    const columnFilterInput = document.getElementById('columnFilterInput');
                    if (columnFilterInput) {
                        columnFilterInput.addEventListener('input', filterColumns);
                    }
                }

                // Resizable column functionality
                function initResizableColumn() {
                    const filterHeader = document.querySelector('.column-filter-header');
                    if (!filterHeader) return;

                    // Create resize handle
                    const resizeHandle = document.createElement('div');
                    resizeHandle.className = 'resize-handle';
                    filterHeader.appendChild(resizeHandle);

                    let isResizing = false;
                    let startX = 0;
                    let startWidth = 0;

                    resizeHandle.addEventListener('mousedown', function(e) {
                        isResizing = true;
                        startX = e.clientX;
                        startWidth = filterHeader.offsetWidth;
                        resizeHandle.classList.add('active');
                        e.preventDefault();
                        e.stopPropagation();
                    });

                    document.addEventListener('mousemove', function(e) {
                        if (!isResizing) return;

                        const diff = e.clientX - startX;
                        const newWidth = Math.max(100, startWidth + diff); // Minimum 100px

                        // Update filter header width
                        filterHeader.style.width = newWidth + 'px';
                        filterHeader.style.minWidth = newWidth + 'px';

                        // Update all sticky columns in tbody
                        const stickyColumns = document.querySelectorAll('.sticky-column');
                        stickyColumns.forEach(col => {
                            col.style.width = newWidth + 'px';
                            col.style.minWidth = newWidth + 'px';
                        });
                    });

                    document.addEventListener('mouseup', function() {
                        if (isResizing) {
                            isResizing = false;
                            resizeHandle.classList.remove('active');
                        }
                    });
                }

                function filterColumns() {
                    const filterText = document.getElementById('columnFilterInput').value.toLowerCase().trim();
                    const dataColumns = document.querySelectorAll('th.data-column, td.data-column');

                    dataColumns.forEach(column => {
                        const columnName = column.getAttribute('data-column-name');
                        if (columnName) {
                            if (!filterText || columnName.toLowerCase().includes(filterText)) {
                                column.classList.remove('hidden');
                            } else {
                                column.classList.add('hidden');
                            }
                        }
                    });
                }

                function showModal(value) {
                    document.getElementById('modalValue').textContent = value;
                    document.getElementById('modal').classList.add('show');
                }
                function closeModal() {
                    document.getElementById('modal').classList.remove('show');
                }
                document.getElementById('modal').addEventListener('click', function(e) {
                    if (e.target.id === 'modal') {
                        closeModal();
                    }
                });
                document.addEventListener('keydown', function(e) {
                    if (e.key === 'Escape') {
                        closeModal();
                    }
                });

// Copy header text to clipboard
                function copyHeader(headerText, element) {
                    navigator.clipboard.writeText(headerText).then(() => {
                        // Show a brief visual feedback
                        const originalBg = element.style.backgroundColor;
                        element.style.backgroundColor = '#a8d5a8';
                        setTimeout(() => {
                            element.style.backgroundColor = originalBg;
                        }, 200);
                    }).catch(err => {
                        console.error('Failed to copy: ', err);
                    });
                }

                // Filter table based on filter inputs
                function filterTable() {
                    const table = document.querySelector('table');
                    if (!table) return;

                    const filterInputs = document.querySelectorAll('.filter-input');
                    const filters = Array.from(filterInputs).map(input => ({
                        columnIndex: parseInt(input.dataset.columnIndex),
                        value: input.value.toLowerCase()
                    }));

                    const tbody = table.querySelector('tbody');
                    if (!tbody) return;

                    const rows = tbody.querySelectorAll('tr');

                    // Reset filtered data
                    filteredData = [];

                    rows.forEach((row, index) => {
                        const cells = row.querySelectorAll('td');
                        let showRow = true;

                        filters.forEach(filter => {
                            if (filter.value && showRow) {
                                // Add 1 to columnIndex to account for the sticky checkbox column
                                const cellIndex = filter.columnIndex + 1;
                                const cell = cells[cellIndex];
                                if (cell) {
                                    const cellText = cell.textContent.toLowerCase();
                                    if (!cellText.includes(filter.value)) {
                                        showRow = false;
                                    }
                                }
                            }
                        });

                        row.style.display = showRow ? '' : 'none';
                        if (showRow) {
                            filteredData.push(index);
                        }
                    });

                    // Reset to first page when filtering
                    currentPage = 1;
                    updatePagination();
                }

                // Pagination functions
                function getTotalPages() {
                    const totalRows = filteredData.length > 0 ? filteredData.length : allTableData.length;
                    return Math.ceil(totalRows / pageSize);
                }

                function getCurrentPageData() {
                    const totalRows = filteredData.length > 0 ? filteredData.length : allTableData.length;
                    const startIndex = (currentPage - 1) * pageSize;
                    const endIndex = Math.min(startIndex + pageSize, totalRows);
                    
                    if (filteredData.length > 0) {
                        return filteredData.slice(startIndex, endIndex).map(index => allTableData[index]);
                    }
                    return allTableData.slice(startIndex, endIndex);
                }

                function updatePagination() {
                    const totalPages = getTotalPages();
                    const totalRows = filteredData.length > 0 ? filteredData.length : allTableData.length;
                    const startRow = totalRows === 0 ? 0 : (currentPage - 1) * pageSize + 1;
                    const endRow = Math.min(currentPage * pageSize, totalRows);

                    // Update pagination info
                    const infoElement = document.getElementById('paginationInfo');
                    if (infoElement) {
                        infoElement.textContent = \`Showing \${startRow} to \${endRow} of \${totalRows} entries\`;
                    }

                    // Update page buttons
                    renderPageButtons(totalPages);

                    // Update table display
                    updateTableDisplay();
                }

                function renderPageButtons(totalPages) {
                    const pagesContainer = document.getElementById('paginationPages');
                    if (!pagesContainer) return;

                    let html = '';

                    // Previous button
                    html += \`<button class="pagination-btn" onclick="goToPage(\${currentPage - 1})" \${currentPage === 1 ? 'disabled' : ''}>&lt;</button>\`;

                    // Page number buttons
                    const maxVisiblePages = 5;
                    let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
                    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);

                    if (endPage - startPage < maxVisiblePages - 1) {
                        startPage = Math.max(1, endPage - maxVisiblePages + 1);
                    }

                    if (startPage > 1) {
                        html += \`<button class="pagination-btn" onclick="goToPage(1)">1</button>\`;
                        if (startPage > 2) {
                            html += \`<span style="padding: 4px 8px;">...</span>\`;
                        }
                    }

                    for (let i = startPage; i <= endPage; i++) {
                        html += \`<button class="pagination-btn \${i === currentPage ? 'active' : ''}" onclick="goToPage(\${i})">\${i}</button>\`;
                    }

                    if (endPage < totalPages) {
                        if (endPage < totalPages - 1) {
                            html += \`<span style="padding: 4px 8px;">...</span>\`;
                        }
                        html += \`<button class="pagination-btn" onclick="goToPage(\${totalPages})">\${totalPages}</button>\`;
                    }

                    // Next button
                    html += \`<button class="pagination-btn" onclick="goToPage(\${currentPage + 1})" \${currentPage === totalPages || totalPages === 0 ? 'disabled' : ''}>&gt;</button>\`;

                    pagesContainer.innerHTML = html;
                }

                function goToPage(page) {
                    const totalPages = getTotalPages();
                    if (page < 1 || page > totalPages) return;
                    currentPage = page;
                    updatePagination();
                }

                function changePageSize() {
                    const select = document.getElementById('pageSizeSelect');
                    if (select) {
                        pageSize = parseInt(select.value);
                        currentPage = 1;
                        updatePagination();
                    }
                }

                function updateTableDisplay() {
                    const table = document.querySelector('table');
                    if (!table) return;

                    const tbody = table.querySelector('tbody');
                    if (!tbody) return;

                    const allRows = tbody.querySelectorAll('tr');
                    const pageData = getCurrentPageData();

                    // Hide all rows first
                    allRows.forEach(row => {
                        row.style.display = 'none';
                    });

                    // Show only rows for current page
                    if (filteredData.length > 0) {
                        // When filtering, show rows based on filtered indices
                        const startIndex = (currentPage - 1) * pageSize;
                        const endIndex = Math.min(startIndex + pageSize, filteredData.length);
                        for (let i = startIndex; i < endIndex; i++) {
                            const rowIndex = filteredData[i];
                            if (allRows[rowIndex]) {
                                allRows[rowIndex].style.display = '';
                            }
                        }
                    } else {
                        // When not filtering, show rows based on page
                        const startIndex = (currentPage - 1) * pageSize;
                        const endIndex = Math.min(startIndex + pageSize, allTableData.length);
                        for (let i = startIndex; i < endIndex; i++) {
                            if (allRows[i]) {
                                allRows[i].style.display = '';
                            }
                        }
                    }
                }

                // Initialize filter event listeners
                function initFilters() {
                    const filterInputs = document.querySelectorAll('.filter-input');
                    filterInputs.forEach(input => {
                        input.addEventListener('input', filterTable);
                    });
                }

                // Track pending changes
                let pendingChanges = new Map(); // row index -> {column: value}
                let newRowData = null;

                // Initialize action buttons
                function initActionButtons() {
                    const selectAllBtn = document.getElementById('selectAllBtn');
                    const deleteBtn = document.getElementById('deleteBtn');
                    const addBtn = document.getElementById('addBtn');
                    const commitBtn = document.getElementById('commitBtn');
                    const refreshBtn = document.getElementById('refreshBtn');

                    console.log('initActionButtons called');
                    console.log('selectAllBtn:', selectAllBtn);
                    console.log('deleteBtn:', deleteBtn);
                    console.log('addBtn:', addBtn);
                    console.log('refreshBtn:', refreshBtn);

                    if (selectAllBtn) {
                        selectAllBtn.addEventListener('click', toggleSelectAll);
                        console.log('selectAllBtn event attached');
                    }
                    if (deleteBtn) {
                        deleteBtn.addEventListener('click', function(e) {
                            console.log('deleteBtn clicked');
                            deleteSelectedRows();
                        });
                        console.log('deleteBtn event attached');
                    }
                    if (addBtn) {
                        addBtn.addEventListener('click', addNewRow);
                        console.log('addBtn event attached');
                    }
                    if (commitBtn) {
                        commitBtn.addEventListener('click', commitChanges);
                    }
                    if (refreshBtn) {
                        refreshBtn.addEventListener('click', refreshData);
                        console.log('refreshBtn event attached');
                    }
                }

                // Initialize row checkboxes
                function initRowCheckboxes() {
                    // No header checkbox anymore
                }

                function toggleSelectAll() {
                    const checkboxes = document.querySelectorAll('.row-checkbox');
                    const allChecked = Array.from(checkboxes).every(cb => cb.checked);
                    checkboxes.forEach(cb => {
                        cb.checked = !allChecked;
                        cb.closest('tr').classList.toggle('selected', !allChecked);
                    });
                }

                function deleteSelectedRows() {
                    console.log('deleteSelectedRows called');
                    const selectedCheckboxes = document.querySelectorAll('.row-checkbox:checked');
                    console.log('selectedCheckboxes:', selectedCheckboxes.length);
                    if (selectedCheckboxes.length === 0) {
                        vscode.postMessage({
                            command: 'showWarning',
                            message: 'Please select at least one row to delete'
                        });
                        return;
                    }

                    // Collect row data for selected rows
                    const selectedRows = [];
                    selectedCheckboxes.forEach(checkbox => {
                        const row = checkbox.closest('tr');
                        if (row) {
                            const rowData = row.getAttribute('data-row-data');
                            console.log('rowData:', rowData);
                            if (rowData) {
                                selectedRows.push(JSON.parse(rowData));
                            }
                        }
                    });

                    console.log('selectedRows:', selectedRows);
                    console.log('Sending deleteRows command');
                    // Send to extension for SQL generation and confirmation
                    vscode.postMessage({
                        command: 'deleteRows',
                        rows: JSON.stringify(selectedRows)
                    });
                }

                function addNewRow() {
                    const table = document.querySelector('table tbody');
                    if (!table) return;

                    const fields = Array.from(document.querySelectorAll('th.data-column'))
                        .map(th => th.getAttribute('data-column-name'))
                        .filter(name => name);

                    const newRow = document.createElement('tr');
                    newRow.classList.add('new-row');

                    // Add sticky column with checkbox
                    const stickyCell = document.createElement('td');
                    stickyCell.className = 'sticky-column';
                    stickyCell.innerHTML = '<input type="checkbox" class="row-checkbox" data-row-index="new">';
                    newRow.appendChild(stickyCell);

                    // Add editable cells
                    fields.forEach(fieldName => {
                        const cell = document.createElement('td');
                        cell.className = 'data-column edit-cell';
                        cell.setAttribute('data-column-name', fieldName);
                        const input = document.createElement('input');
                        input.type = 'text';
                        input.placeholder = 'Enter value';
                        input.className = 'edit-input';
                        cell.appendChild(input);
                        newRow.appendChild(cell);
                    });

                    table.appendChild(newRow);

                    // Mark as pending change
                    pendingChanges.set('new', { isNew: true, data: {} });
                    updateCommitButton();
                }

                function commitChanges() {
                    if (pendingChanges.size === 0) return;

                    // Collect all changes
                    const changes = [];
                    pendingChanges.forEach((value, key) => {
                        changes.push(value);
                    });

                    // Send to extension to execute SQL
                    vscode.postMessage({
                        command: 'commitChanges',
                        changes: JSON.stringify(changes)
                    });

                    // Clear pending changes
                    pendingChanges.clear();
                    updateCommitButton();
                }

                function updateCommitButton() {
                    const commitBtn = document.getElementById('commitBtn');
                    if (commitBtn) {
                        if (pendingChanges.size > 0) {
                            commitBtn.classList.remove('hidden');
                        } else {
                            commitBtn.classList.add('hidden');
                        }
                    }
                }

                function refreshData() {
                    vscode.postMessage({
                        command: 'refreshData'
                    });
                }

                // Handle cell editing
                document.addEventListener('change', function(e) {
                    if (e.target.classList.contains('edit-input')) {
                        const cell = e.target.closest('td');
                        const row = cell.closest('tr');
                        const rowIndex = row.querySelector('.row-checkbox')?.getAttribute('data-row-index');
                        const columnName = cell.getAttribute('data-column-name');
                        const value = e.target.value;

                        if (rowIndex === 'new') {
                            // New row
                            if (!pendingChanges.has('new')) {
                                pendingChanges.set('new', { isNew: true, data: {} });
                            }
                            pendingChanges.get('new').data[columnName] = value;
                        } else {
                            // Existing row
                            if (!pendingChanges.has(rowIndex)) {
                                pendingChanges.set(rowIndex, { isNew: false, rowIndex: rowIndex, data: {} });
                            }
                            pendingChanges.get(rowIndex).data[columnName] = value;
                            row.classList.add('modified');
                        }

                        updateCommitButton();
                    }
                });
            <\/script>
        `;

        const modal = `
            <div id="modal">
                <div class="modal-content">
                    <div class="modal-header">
                        <span class="modal-title">Cell Content</span>
                        <button class="close-btn" onclick="closeModal()">&times;</button>
                    </div>
                    <div class="modal-value" id="modalValue"></div>
                </div>
            </div>
        `;

        const head = [].concat(
            "<!DOCTYPE html>",
            "<html>",
            "<head>",
            '<meta http-equiv="Content-type" content="text/html;charset=UTF-8">',
            '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
            style,
            "</head>",
            "<body>",
        ).join("\n");

        const body = SqlResultWebView.render(data);

        const tail = [
            modal,
            script,
            "</body>",
            "</html>",
        ].join("\n");

        return head + body + tail;
    }

    private static render(rows) {
        if (rows.length === 0) {
            return '<div class="no-data">No data</div>';
        }

        // Get all field names
        const fields = [];
        for (const field in rows[0]) {
            if (rows[0].hasOwnProperty(field)) {
                fields.push(field);
            }
        }

        // Generate header row with field filter column
        let head = `<th class="column-filter-header">
            <input type="text" id="columnFilterInput" class="column-filter-input" placeholder="🔍 Filter columns...">
        </th>`;
        fields.forEach((field, index) => {
            const escapedField = this.escapeHtml(field);
            head += `<th class="data-column" data-column-name="${escapedField}" onclick="copyHeader('${escapedField}', this)" title="Click to copy: ${escapedField}">${escapedField}</th>`;
        });

        // Generate filter row (first column has action buttons)
        let filterRow = `<th class="filter-header sticky-column">
            <div class="action-buttons">
                <button class="action-btn" id="selectAllBtn" title="Select All">☑️</button>
                <button class="action-btn danger" id="deleteBtn" title="Delete Selected">🗑️</button>
                <button class="action-btn success" id="addBtn" title="Add Row">➕</button>
                <button class="action-btn hidden" id="commitBtn" title="Commit Changes">💾</button>
                <button class="action-btn" id="refreshBtn" title="Refresh">🔄</button>
            </div>
        </th>`;
        fields.forEach((field, index) => {
            filterRow += `<th class="filter-header data-column" data-column-name="${this.escapeHtml(field)}"><input type="text" class="filter-input" data-column-index="${index}" placeholder="Filter..."></th>`;
        });

        let body = "<table><thead><tr>" + head + "</tr><tr>" + filterRow + "</tr></thead><tbody>";

        rows.forEach((row: any, rowIndex: number) => {
            // Store row data as JSON string for delete functionality
            const rowDataJson = JSON.stringify(row).replace(/"/g, '&quot;');
            body += `<tr data-row-data='${rowDataJson}'>`;
            // Add checkbox cell with visible checkbox
            body += `<td class='sticky-column'><input type='checkbox' class='row-checkbox' data-row-index='${rowIndex}'></td>`;
            for (const field in row) {
                if (row.hasOwnProperty(field)) {
                    const value = row[field];
                    const fullValue = value === null || value === undefined ? 'NULL' : String(value);
                    const displayValue = value === null || value === undefined ? '<span class="empty-cell">NULL</span>' : this.escapeHtml(fullValue);
                    const escapedFieldName = this.escapeHtml(field);

                    // Calculate display length (Chinese counts as 2, English as 1)
                    const displayLength = getStringLength(fullValue);
                    // Use 50 as threshold (50 English chars or 25 Chinese chars)
                    const isTruncated = displayLength > 50;

                    // Truncate for display if needed
                    let truncatedValue = fullValue;
                    if (isTruncated) {
                        let currentLength = 0;
                        let truncateIndex = 0;
                        for (let i = 0; i < fullValue.length; i++) {
                            const charCode = fullValue.charCodeAt(i);
                            const charLength = (charCode >= 0x4E00 && charCode <= 0x9FFF ||
                                                charCode >= 0x3400 && charCode <= 0x4DBF ||
                                                charCode >= 0xFF01 && charCode <= 0xFF60) ? 2 : 1;
                            if (currentLength + charLength > 47) { // 47 + "..."
                                break;
                            }
                            currentLength += charLength;
                            truncateIndex = i + 1;
                        }
                        truncatedValue = fullValue.substring(0, truncateIndex);
                    }

                    const escapedFullValue = JSON.stringify(fullValue);
                    const escapedTruncatedValue = this.escapeHtml(truncatedValue);

                    body += "<td class='data-column' data-column-name='" + escapedFieldName + "'>" +
                        "<div class=\"cell-wrapper\">" +
                        "<span class=\"cell-content" + (isTruncated ? " truncated" : "") + "\">" + (isTruncated ? escapedTruncatedValue + "..." : displayValue) + "</span>" +
                        (isTruncated ? "<button class=\"expand-btn\" onclick='showModal(" + escapedFullValue + ")'>...</button>" : "") +
                        "</div>" +
                        "</td>";
                }
            }
            body += "</tr>";
        });

        body += "</tbody></table>";

        // Add pagination controls
        body += `
            <div class="pagination-container">
                <div class="pagination-info" id="paginationInfo">Showing 0 to 0 of 0 entries</div>
                <div class="pagination-controls">
                    <div class="page-size-selector">
                        <span class="page-size-label">Rows per page:</span>
                        <select id="pageSizeSelect" class="page-size-select" onchange="changePageSize()">
                            <option value="5">5</option>
                            <option value="10" selected>10</option>
                            <option value="20">20</option>
                            <option value="50">50</option>
                            <option value="100">100</option>
                        </select>
                    </div>
                    <div class="pagination-pages" id="paginationPages">
                        <button class="pagination-btn" disabled>&lt;</button>
                        <button class="pagination-btn active">1</button>
                        <button class="pagination-btn" disabled>&gt;</button>
                    </div>
                </div>
            </div>
        `;

        return body;
    }

    private static escapeHtml(text: string): string {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, (m) => map[m]);
    }
}
