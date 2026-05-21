import * as vscode from "vscode";
import { Utility } from "./common/utility";

export interface QueryResultPayload {
    rows: any[];
    fields?: string[];
    columnComments?: { [key: string]: string };
    totalRows?: number;
    sql?: string;
    database?: string;
    table?: string;
}

export class SqlResultWebView {
    private static currentPanel: vscode.WebviewPanel | undefined;
    private static lastQueryInfo: { sql?: string; database?: string; table?: string; columnComments?: { [key: string]: string } } | undefined;
    private static layoutInitialized = false;
    private static pendingPayload: QueryResultPayload | undefined;
    private static messageDisposable: vscode.Disposable | undefined;

    public static async show(
        data: any[],
        title: string,
        sql?: string,
        database?: string,
        table?: string,
        columnComments?: { [key: string]: string },
        updateSQLEditor: boolean = true,
        appendSQLEditor: boolean = true,
        totalRows?: number,
    ) {
        if (updateSQLEditor) {
            if (appendSQLEditor) {
                await Utility.appendSQLToEditor(sql || "");
            } else {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && activeEditor.document.languageId === "sql") {
                    const editor = vscode.window.activeTextEditor;
                    const fullRange = new vscode.Range(
                        editor.document.positionAt(0),
                        editor.document.positionAt(editor.document.getText().length),
                    );
                    await editor.edit((editBuilder) => {
                        editBuilder.replace(fullRange, sql ? "\n" + sql : "\n");
                    });
                } else {
                    await Utility.createSQLTextDocument(sql || "");
                }
            }
        }

        if (!SqlResultWebView.layoutInitialized) {
            await vscode.commands.executeCommand("workbench.action.editorLayoutTwoRows");
            await vscode.commands.executeCommand("workbench.action.focusFirstEditorGroup");
            for (let i = 0; i < 2; i++) {
                await vscode.commands.executeCommand("workbench.action.decreaseViewHeight");
            }
            SqlResultWebView.layoutInitialized = true;
        }

        const panelTitle = database && table ? `\`${database}\`.\`${table}\`` : title;
        const payload: QueryResultPayload = {
            rows: data,
            fields: SqlResultWebView.extractFields(data),
            columnComments,
            totalRows,
            sql,
            database,
            table,
        };

        SqlResultWebView.lastQueryInfo = { sql, database, table, columnComments };

        if (SqlResultWebView.currentPanel) {
            SqlResultWebView.currentPanel.title = panelTitle;
            SqlResultWebView.sendData(payload);
            return;
        }

        const panel = vscode.window.createWebviewPanel("MySQL", panelTitle, vscode.ViewColumn.Two, {
            retainContextWhenHidden: true,
            enableScripts: true,
        });

        SqlResultWebView.currentPanel = panel;
        SqlResultWebView.pendingPayload = payload;
        SqlResultWebView.registerMessageHandler(panel);
        panel.webview.html = SqlResultWebView.getShellHtml();

        panel.onDidDispose(() => {
            SqlResultWebView.currentPanel = undefined;
            SqlResultWebView.pendingPayload = undefined;
            if (SqlResultWebView.messageDisposable) {
                SqlResultWebView.messageDisposable.dispose();
                SqlResultWebView.messageDisposable = undefined;
            }
        });
    }

    public static updatePanel(
        data: any[],
        sql?: string,
        database?: string,
        table?: string,
        columnComments?: { [key: string]: string },
        totalRows?: number,
    ) {
        if (!SqlResultWebView.currentPanel) {
            return;
        }

        if (sql) {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && activeEditor.document.languageId === "sql") {
                const editor = vscode.window.activeTextEditor;
                const fullRange = new vscode.Range(
                    editor.document.positionAt(0),
                    editor.document.positionAt(editor.document.getText().length),
                );
                editor.edit((editBuilder) => {
                    editBuilder.replace(fullRange, sql ? "\n" + sql : "\n");
                });
            }
        }

        if (sql || database || table || columnComments) {
            SqlResultWebView.lastQueryInfo = {
                sql: sql || SqlResultWebView.lastQueryInfo?.sql,
                database: database || SqlResultWebView.lastQueryInfo?.database,
                table: table || SqlResultWebView.lastQueryInfo?.table,
                columnComments: columnComments || SqlResultWebView.lastQueryInfo?.columnComments,
            };
        }

        SqlResultWebView.sendData({
            rows: data,
            fields: SqlResultWebView.extractFields(data),
            columnComments: columnComments || SqlResultWebView.lastQueryInfo?.columnComments,
            totalRows,
            sql: sql || SqlResultWebView.lastQueryInfo?.sql,
            database: database || SqlResultWebView.lastQueryInfo?.database,
            table: table || SqlResultWebView.lastQueryInfo?.table,
        });
    }

    public static updateComments(columnComments: { [key: string]: string }) {
        if (!SqlResultWebView.currentPanel) {
            return;
        }
        if (SqlResultWebView.lastQueryInfo) {
            SqlResultWebView.lastQueryInfo.columnComments = columnComments;
        }
        SqlResultWebView.currentPanel.webview.postMessage({
            command: "updateComments",
            columnComments,
        });
    }

    public static getLastQueryInfo(): { sql?: string; database?: string; table?: string } | undefined {
        return SqlResultWebView.lastQueryInfo;
    }

    private static extractFields(rows: any[]): string[] {
        if (!rows || rows.length === 0) {
            return [];
        }
        return Object.keys(rows[0]);
    }

    private static sendData(payload: QueryResultPayload) {
        if (!SqlResultWebView.currentPanel) {
            return;
        }
        SqlResultWebView.currentPanel.webview.postMessage({
            command: "setData",
            ...payload,
        });
    }

    private static registerMessageHandler(panel: vscode.WebviewPanel) {
        if (SqlResultWebView.messageDisposable) {
            SqlResultWebView.messageDisposable.dispose();
        }
        SqlResultWebView.messageDisposable = panel.webview.onDidReceiveMessage((message) => {
            if (message.command === "ready") {
                if (SqlResultWebView.pendingPayload) {
                    SqlResultWebView.sendData(SqlResultWebView.pendingPayload);
                    SqlResultWebView.pendingPayload = undefined;
                }
                return;
            }
            if (message.command === "refreshData") {
                vscode.commands.executeCommand("mysqlInstantQuery.refreshResults");
            } else if (message.command === "deleteRows") {
                vscode.commands.executeCommand("mysqlInstantQuery.deleteSelectedRows", message.rows);
            } else if (message.command === "showWarning") {
                vscode.window.showWarningMessage(message.message);
            } else if (message.command === "generateUpdateSQL") {
                vscode.commands.executeCommand("mysqlInstantQuery.generateUpdateSQL", message);
            } else if (message.command === "generateInsertSQL") {
                vscode.commands.executeCommand("mysqlInstantQuery.generateInsertSQL", message);
            }
        });
    }

    private static getShellHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>${SqlResultWebView.getStyles()}</style>
</head>
<body>
    <div id="noData" class="no-data" style="display:none;">No data</div>
    <div class="table-wrapper" id="tableWrapper" style="display:none;">
        <table>
            <thead id="tableHead"></thead>
            <tbody id="dataBody"></tbody>
        </table>
    </div>
    <div class="pagination-container" id="paginationContainer" style="display:none;">
        <div class="pagination-info" id="paginationInfo">0-0 / 0</div>
        <div class="pagination-controls">
            <div class="page-size-selector">
                <select id="pageSizeSelect" class="page-size-select">
                    <option value="5">5</option>
                    <option value="10" selected>10</option>
                    <option value="20">20</option>
                    <option value="50">50</option>
                    <option value="100">100</option>
                </select>
            </div>
            <div class="pagination-pages" id="paginationPages"></div>
        </div>
    </div>
    <div id="modal">
        <div class="modal-content">
            <div class="modal-header">
                <span class="modal-title">Cell Content</span>
                <button class="close-btn" id="modalCloseBtn">&times;</button>
            </div>
            <div class="modal-value" id="modalValue"></div>
        </div>
    </div>
    <script>${SqlResultWebView.getClientScript()}</script>
</body>
</html>`;
    }

    private static getStyles(): string {
        return `
                body {
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                    margin: 0;
                    padding: 0;
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    height: 100vh;
                    display: flex;
                    flex-direction: column;
                }
                .table-wrapper { flex: 1; overflow: auto; }
                table { border-collapse: collapse; width: 100%; font-size: 13px; }
                th {
                    background-color: #e0e0e0;
                    border: 1px solid #d0d0d0;
                    padding: 8px 12px;
                    text-align: center;
                    font-weight: 600;
                    cursor: pointer;
                    user-select: none;
                    vertical-align: top;
                    position: relative;
                }
                .column-name { display: block; font-weight: 600; }
                .column-comment {
                    display: block;
                    font-size: 11px;
                    color: #666;
                    font-weight: normal;
                    margin-top: 2px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    max-width: 100%;
                }
                thead { position: sticky; top: 0; z-index: 100; background-color: #e0e0e0; }
                thead tr:first-child th { padding: 2px; background-color: #e0e0e0; }
                th.filter-header { background-color: #f5f5f5; padding: 4px 8px; cursor: default; }
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
                .column-filter-header {
                    position: sticky;
                    left: 0;
                    background-color: #f0f0f0;
                    z-index: 20;
                    width: 70px;
                    min-width: 70px;
                    border-right: 2px solid #ccc;
                    padding: 4px;
                }
                th.filter-header.sticky-column, .sticky-column {
                    position: sticky;
                    left: 0;
                    z-index: 9;
                    width: 70px;
                    min-width: 70px;
                    border-right: 2px solid #ccc;
                    background-color: #f0f0f0;
                }
                tbody .sticky-column { padding: 4px; vertical-align: middle; text-align: center; }
                .resize-handle {
                    position: absolute;
                    right: 0;
                    top: 0;
                    height: 100%;
                    width: 10px;
                    cursor: col-resize;
                    z-index: 100;
                }
                .resize-handle:hover, .resize-handle.active { background-color: rgba(0, 122, 204, 0.3); }
                .column-filter-input {
                    width: 80px;
                    padding: 4px;
                    margin-top: 4px;
                    font-size: 11px;
                    border: 1px solid #bbb;
                    border-radius: 3px;
                    box-sizing: border-box;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                }
                .action-btn {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    width: 18px;
                    height: 18px;
                    border: none;
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    cursor: pointer;
                    font-size: 11px;
                }
                .action-btn:hover { background-color: var(--vscode-button-hoverBackground); }
                .action-btn.danger { background-color: #f44336; color: white; }
                .action-btn.danger:hover { background-color: #d32f2f; }
                .action-btn.success { background-color: #4caf50; color: white; }
                .action-btn.success:hover { background-color: #388e3c; }
                .action-btn-group { display: inline-flex; border: 1px solid #bbb; border-radius: 4px; overflow: hidden; }
                .action-btn-group .action-btn { border-right: 1px solid #bbb; }
                .action-btn-group .action-btn:last-child { border-right: none; }
                .row-checkbox { width: 14px; height: 14px; cursor: pointer; margin-right: 2px; vertical-align: middle; }
                .row-number { font-size: 11px; color: #888; margin-right: 2px; min-width: 16px; display: inline-block; vertical-align: middle; }
                .save-row-btn, .cancel-row-btn, .save-new-row-btn {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    width: 12px;
                    height: 12px;
                    border-radius: 2px;
                    cursor: pointer;
                    font-size: 8px;
                    padding: 0;
                    vertical-align: middle;
                }
                .save-row-btn, .save-new-row-btn { border: 1px solid #4caf50; background-color: #4caf50; color: white; }
                .cancel-row-btn { border: 1px solid #999; background-color: #f5f5f5; color: #666; margin-left: 2px; }
                .save-row-btn.hidden, .cancel-row-btn.hidden { display: none !important; }
                tr.selected { background-color: rgba(0, 122, 204, 0.1); }
                tr.selected .sticky-column { background-color: #d8e8f0; }
                tr.editing { background-color: rgba(255, 193, 7, 0.1); }
                tr.editing .sticky-column { background-color: #f8f0d8; }
                tr.new-row .sticky-column { background-color: #e8f8e8; }
                td.editing { padding: 0 !important; }
                td.editing input, .edit-cell input {
                    width: 100%;
                    height: 100%;
                    padding: 6px 8px;
                    border: 2px solid #007acc;
                    border-radius: 0;
                    font-size: 13px;
                    font-family: inherit;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    box-sizing: border-box;
                    outline: none;
                }
                .edit-cell { padding: 0 !important; }
                .data-column.hidden { display: none; }
                td { border: 1px solid #e0e0e0; padding: 6px; }
                tr:hover { background-color: var(--vscode-editor-hoverHighlightBackground); }
                tr:hover .sticky-column { background-color: #e8e8e8; }
                .cell-wrapper { display: inline-block; max-width: 100%; }
                .cell-content { white-space: nowrap; display: inline-block; }
                .cell-content.truncated { max-width: calc(100% - 30px); overflow: hidden; text-overflow: ellipsis; }
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
                .expand-btn:hover { color: var(--vscode-textLink-foreground); }
                .cell-content.truncated + .expand-btn { display: inline-flex; }
                .empty-cell { color: #999; font-style: italic; }
                #modal {
                    display: none;
                    position: fixed;
                    inset: 0;
                    background-color: rgba(0, 0, 0, 0.5);
                    z-index: 1000;
                    justify-content: center;
                    align-items: center;
                }
                #modal.show { display: flex; }
                .modal-content {
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 8px;
                    padding: 20px;
                    max-width: 80%;
                    max-height: 80%;
                    overflow: auto;
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
                }
                .modal-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 16px;
                    padding-bottom: 12px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .close-btn {
                    background: none;
                    border: none;
                    font-size: 20px;
                    cursor: pointer;
                    color: var(--vscode-editor-foreground);
                    width: 28px;
                    height: 28px;
                }
                .modal-value {
                    word-wrap: break-word;
                    white-space: pre-wrap;
                    font-family: Consolas, Monaco, monospace;
                    font-size: 13px;
                    line-height: 1.5;
                }
                .no-data { color: var(--vscode-descriptionForeground); padding: 20px; text-align: center; }
                .pagination-container {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 3px 12px;
                    background-color: var(--vscode-editor-selectionBackground);
                    border-top: 1px solid var(--vscode-panel-border);
                    flex-wrap: wrap;
                    gap: 12px;
                    flex-shrink: 0;
                }
                .pagination-info { color: var(--vscode-descriptionForeground); font-size: 12px; }
                .pagination-controls { display: flex; align-items: center; gap: 8px; }
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
                .pagination-btn:hover:not(:disabled) { background-color: var(--vscode-button-hoverBackground); }
                .pagination-btn:disabled { opacity: 0.4; cursor: not-allowed; }
                .pagination-btn.active { background-color: var(--vscode-button-hoverBackground); font-weight: 600; }
                .page-size-select {
                    padding: 4px 8px;
                    font-size: 12px;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 2px;
                    cursor: pointer;
                }
                .pagination-pages { display: flex; gap: 4px; }
        `;
    }

    private static getClientScript(): string {
        return `
(function() {
    const vscode = acquireVsCodeApi();
    let allRows = [];
    let fields = [];
    let columnComments = {};
    let filteredIndices = null;
    let currentPage = 1;
    let pageSize = 10;
    let totalRowsHint = null;
    let editingCell = null;
    let uiInitialized = false;

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function getStringLength(str) {
        let length = 0;
        for (let i = 0; i < str.length; i++) {
            const code = str.charCodeAt(i);
            if ((code >= 0x4E00 && code <= 0x9FFF) ||
                (code >= 0x3400 && code <= 0x4DBF) ||
                (code >= 0xFF01 && code <= 0xFF60)) {
                length += 2;
            } else {
                length += 1;
            }
        }
        return length;
    }

    function truncateDisplayValue(fullValue) {
        const displayLength = getStringLength(fullValue);
        if (displayLength <= 50) {
            return { text: fullValue, truncated: false };
        }
        let currentLength = 0;
        let truncateIndex = 0;
        for (let i = 0; i < fullValue.length; i++) {
            const code = fullValue.charCodeAt(i);
            const charLength = (code >= 0x4E00 && code <= 0x9FFF) ||
                (code >= 0x3400 && code <= 0x4DBF) ||
                (code >= 0xFF01 && code <= 0xFF60) ? 2 : 1;
            if (currentLength + charLength > 47) break;
            currentLength += charLength;
            truncateIndex = i + 1;
        }
        return { text: fullValue.substring(0, truncateIndex) + '...', truncated: true, fullValue };
    }

    function formatCellHtml(value) {
        if (value === null || value === undefined) {
            return '<span class="empty-cell">NULL</span>';
        }
        const fullValue = String(value);
        const info = truncateDisplayValue(fullValue);
        if (!info.truncated) {
            return '<span class="cell-content">' + escapeHtml(fullValue) + '</span>';
        }
        const encoded = encodeURIComponent(fullValue);
        return '<span class="cell-content truncated">' + escapeHtml(info.text) + '</span>' +
            '<button class="expand-btn" data-full-value="' + encoded + '">...</button>';
    }

    function getActiveIndices() {
        if (filteredIndices !== null) return filteredIndices;
        const indices = [];
        for (let i = 0; i < allRows.length; i++) indices.push(i);
        return indices;
    }

    function buildTableHead() {
        const thead = document.getElementById('tableHead');
        if (!thead) return;
        let head = '<tr><th class="column-filter-header"><input type="text" id="columnFilterInput" class="column-filter-input" placeholder="🔍"></th>';
        fields.forEach(function(field, index) {
            const comment = columnComments[field] || '';
            const commentHtml = comment ? '<span class="column-comment" title="' + escapeHtml(comment) + '">' + escapeHtml(comment) + '</span>' : '';
            head += '<th class="data-column" data-column-name="' + escapeHtml(field) + '" data-column-comment="' + escapeHtml(comment) + '" data-column-index="' + index + '">' +
                '<span class="column-name">' + escapeHtml(field) + '</span>' + commentHtml +
                '<div class="resize-handle" data-column-index="' + index + '"></div></th>';
        });
        head += '</tr>';

        let filterRow = '<tr><th class="filter-header sticky-column"><div class="action-btn-group">' +
            '<button class="action-btn" id="selectAllBtn" title="Select All">✓</button>' +
            '<button class="action-btn danger" id="deleteBtn" title="Delete Selected">✕</button>' +
            '<button class="action-btn success" id="addBtn" title="Add Row">+</button>' +
            '<button class="action-btn" id="refreshBtn" title="Refresh">↻</button>' +
            '</div></th>';
        fields.forEach(function(field, index) {
            filterRow += '<th class="filter-header data-column" data-column-name="' + escapeHtml(field) + '">' +
                '<input type="text" class="filter-input" data-column-index="' + index + '" placeholder=""></th>';
        });
        filterRow += '</tr>';
        thead.innerHTML = head + filterRow;
    }

    function updateHeaderComments() {
        document.querySelectorAll('thead tr:first-child th.data-column').forEach(function(th) {
            const name = th.getAttribute('data-column-name');
            const comment = columnComments[name] || '';
            th.setAttribute('data-column-comment', comment);
            let commentEl = th.querySelector('.column-comment');
            if (comment) {
                if (!commentEl) {
                    commentEl = document.createElement('span');
                    commentEl.className = 'column-comment';
                    th.insertBefore(commentEl, th.querySelector('.resize-handle'));
                }
                commentEl.textContent = comment;
                commentEl.title = comment;
            } else if (commentEl) {
                commentEl.remove();
            }
        });
    }

    function createRowElement(row, globalIndex) {
        const tr = document.createElement('tr');
        tr.setAttribute('data-row-index', String(globalIndex));

        const sticky = document.createElement('td');
        sticky.className = 'sticky-column';
        sticky.innerHTML = '<input type="checkbox" class="row-checkbox" data-row-index="' + globalIndex + '">' +
            '<span class="row-number">' + (globalIndex + 1) + '</span>' +
            '<button class="save-row-btn hidden" data-row-index="' + globalIndex + '" title="Save changes">✓</button>' +
            '<button class="cancel-row-btn hidden" data-row-index="' + globalIndex + '" title="Cancel">↩</button>';
        tr.appendChild(sticky);

        fields.forEach(function(field) {
            const td = document.createElement('td');
            td.className = 'data-column';
            td.setAttribute('data-column-name', field);
            td.innerHTML = '<div class="cell-wrapper">' + formatCellHtml(row[field]) + '</div>';
            tr.appendChild(td);
        });
        return tr;
    }

    function renderPage() {
        const tbody = document.getElementById('dataBody');
        if (!tbody) return;
        tbody.innerHTML = '';
        const indices = getActiveIndices();
        const start = (currentPage - 1) * pageSize;
        const pageIndices = indices.slice(start, start + pageSize);
        pageIndices.forEach(function(globalIndex) {
            tbody.appendChild(createRowElement(allRows[globalIndex], globalIndex));
        });
    }

    function getTotalCount() {
        return filteredIndices !== null ? filteredIndices.length : allRows.length;
    }

    function updatePagination() {
        const totalRows = getTotalCount();
        const totalPages = Math.max(1, Math.ceil(totalRows / pageSize) || 1);
        if (currentPage > totalPages) currentPage = totalPages;
        const startRow = totalRows === 0 ? 0 : (currentPage - 1) * pageSize + 1;
        const endRow = Math.min(currentPage * pageSize, totalRows);
        const info = document.getElementById('paginationInfo');
        if (info) {
            const hint = totalRowsHint && totalRowsHint > allRows.length ? ' (loaded ' + allRows.length + ')' : '';
            info.textContent = startRow + '-' + endRow + ' / ' + totalRows + hint;
        }
        renderPageButtons(totalPages);
        renderPage();
    }

    function renderPageButtons(totalPages) {
        const container = document.getElementById('paginationPages');
        if (!container) return;
        let html = '<button class="pagination-btn" data-page="' + (currentPage - 1) + '"' + (currentPage === 1 ? ' disabled' : '') + '>&lt;</button>';
        const maxVisible = 5;
        let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
        let endPage = Math.min(totalPages, startPage + maxVisible - 1);
        if (endPage - startPage < maxVisible - 1) startPage = Math.max(1, endPage - maxVisible + 1);
        if (startPage > 1) {
            html += '<button class="pagination-btn" data-page="1">1</button>';
            if (startPage > 2) html += '<span style="padding:4px 8px;">...</span>';
        }
        for (let i = startPage; i <= endPage; i++) {
            html += '<button class="pagination-btn' + (i === currentPage ? ' active' : '') + '" data-page="' + i + '">' + i + '</button>';
        }
        if (endPage < totalPages) {
            if (endPage < totalPages - 1) html += '<span style="padding:4px 8px;">...</span>';
            html += '<button class="pagination-btn" data-page="' + totalPages + '">' + totalPages + '</button>';
        }
        html += '<button class="pagination-btn" data-page="' + (currentPage + 1) + '"' + (currentPage >= totalPages || totalPages === 0 ? ' disabled' : '') + '>&gt;</button>';
        container.innerHTML = html;
    }

    function applyFilters() {
        const filterInputs = document.querySelectorAll('.filter-input');
        const filters = [];
        filterInputs.forEach(function(input) {
            const value = input.value.toLowerCase().trim();
            if (value) {
                filters.push({ field: fields[parseInt(input.getAttribute('data-column-index'), 10)], value: value });
            }
        });
        if (filters.length === 0) {
            filteredIndices = null;
        } else {
            filteredIndices = [];
            allRows.forEach(function(row, index) {
                let match = true;
                for (let i = 0; i < filters.length; i++) {
                    const cellValue = row[filters[i].field];
                    const text = (cellValue === null || cellValue === undefined) ? 'null' : String(cellValue);
                    if (text.toLowerCase().indexOf(filters[i].value) === -1) {
                        match = false;
                        break;
                    }
                }
                if (match) filteredIndices.push(index);
            });
        }
        currentPage = 1;
        updatePagination();
    }

    function filterColumns() {
        const input = document.getElementById('columnFilterInput');
        const filterText = input ? input.value.toLowerCase().trim() : '';
        const visible = new Set();
        document.querySelectorAll('thead tr:first-child th.data-column').forEach(function(th) {
            const name = th.getAttribute('data-column-name') || '';
            const comment = th.getAttribute('data-column-comment') || '';
            if (!filterText || name.toLowerCase().includes(filterText) || comment.toLowerCase().includes(filterText)) {
                visible.add(name);
            }
        });
        document.querySelectorAll('th.data-column, td.data-column').forEach(function(el) {
            const name = el.getAttribute('data-column-name');
            if (!name) return;
            el.classList.toggle('hidden', !visible.has(name));
        });
    }

    function showModal(value) {
        document.getElementById('modalValue').textContent = value;
        document.getElementById('modal').classList.add('show');
    }

    function closeModal() {
        document.getElementById('modal').classList.remove('show');
    }

    function saveEdit() {
        if (!editingCell) return;
        const row = editingCell.row;
        const cell = row.querySelectorAll('td')[editingCell.cellIndex];
        const input = cell.querySelector('input');
        if (!input) return;
        const newValue = input.value;
        const globalIndex = parseInt(row.getAttribute('data-row-index'), 10);
        const rowData = allRows[globalIndex];
        cell.classList.remove('editing');
        cell.innerHTML = '<div class="cell-wrapper"><span class="cell-content">' + escapeHtml(newValue) + '</span></div>';
        vscode.postMessage({
            command: 'generateUpdateSQL',
            rowData: rowData,
            columnName: editingCell.columnName,
            originalValue: editingCell.originalValue,
            newValue: newValue
        });
        row.querySelector('.save-row-btn').classList.add('hidden');
        row.querySelector('.cancel-row-btn').classList.add('hidden');
        row.classList.remove('editing');
        editingCell = null;
    }

    function cancelEdit() {
        if (!editingCell) return;
        const row = editingCell.row;
        const cell = row.querySelectorAll('td')[editingCell.cellIndex];
        cell.classList.remove('editing');
        cell.innerHTML = '<div class="cell-wrapper"><span class="cell-content">' + escapeHtml(editingCell.originalValue) + '</span></div>';
        row.querySelector('.save-row-btn').classList.add('hidden');
        row.querySelector('.cancel-row-btn').classList.add('hidden');
        row.classList.remove('editing');
        editingCell = null;
    }

    function toggleSelectAll() {
        const checkboxes = document.querySelectorAll('#dataBody .row-checkbox');
        const allChecked = Array.from(checkboxes).every(function(cb) { return cb.checked; });
        checkboxes.forEach(function(cb) {
            cb.checked = !allChecked;
            cb.closest('tr').classList.toggle('selected', !allChecked);
        });
    }

    function deleteSelectedRows() {
        const selected = document.querySelectorAll('#dataBody .row-checkbox:checked');
        if (selected.length === 0) {
            vscode.postMessage({ command: 'showWarning', message: 'Please select at least one row to delete' });
            return;
        }
        const rows = [];
        selected.forEach(function(cb) {
            const idx = parseInt(cb.getAttribute('data-row-index'), 10);
            rows.push(allRows[idx]);
        });
        vscode.postMessage({ command: 'deleteRows', rows: JSON.stringify(rows) });
    }

    function addNewRow() {
        const tbody = document.getElementById('dataBody');
        if (!tbody) return;
        const visibleFields = fields.filter(function(field) {
            const headers = document.querySelectorAll('thead tr:first-child th.data-column');
            for (let i = 0; i < headers.length; i++) {
                const th = headers[i];
                if (th.getAttribute('data-column-name') === field && !th.classList.contains('hidden')) {
                    return true;
                }
            }
            return false;
        });
        const tr = document.createElement('tr');
        tr.className = 'new-row';
        tr.setAttribute('data-row-index', 'new');
        const sticky = document.createElement('td');
        sticky.className = 'sticky-column';
        sticky.innerHTML = '<input type="checkbox" class="row-checkbox" data-row-index="new">' +
            '<button class="save-new-row-btn" data-row-index="new" title="Save new row">✓</button>';
        tr.appendChild(sticky);
        visibleFields.forEach(function(field) {
            const td = document.createElement('td');
            td.className = 'data-column edit-cell';
            td.setAttribute('data-column-name', field);
            td.innerHTML = '<input type="text" class="edit-input" placeholder="Enter value">';
            tr.appendChild(td);
        });
        tbody.insertBefore(tr, tbody.firstChild);
    }

    function saveNewRow(row) {
        const rowData = {};
        const fieldsWithValues = [];
        row.querySelectorAll('td.data-column:not(.hidden)').forEach(function(cell) {
            const fieldName = cell.getAttribute('data-column-name');
            const input = cell.querySelector('input');
            const value = input ? input.value.trim() : '';
            if (fieldName) {
                rowData[fieldName] = value;
                if (value !== '') fieldsWithValues.push(fieldName);
            }
        });
        if (fieldsWithValues.length === 0) {
            vscode.postMessage({ command: 'showWarning', message: 'No values to insert. Please fill in at least one field.' });
            return;
        }
        const filteredRowData = {};
        fieldsWithValues.forEach(function(f) { filteredRowData[f] = rowData[f]; });
        vscode.postMessage({ command: 'generateInsertSQL', rowData: filteredRowData, fields: fieldsWithValues });
    }

    function bindStaticUiEvents() {
        if (uiInitialized) return;
        uiInitialized = true;

        document.getElementById('pageSizeSelect').addEventListener('change', function(e) {
            pageSize = parseInt(e.target.value, 10);
            currentPage = 1;
            updatePagination();
        });

        document.getElementById('paginationPages').addEventListener('click', function(e) {
            const btn = e.target.closest('.pagination-btn');
            if (!btn || btn.disabled) return;
            const page = parseInt(btn.getAttribute('data-page'), 10);
            if (!isNaN(page)) {
                currentPage = page;
                updatePagination();
            }
        });

        document.addEventListener('input', function(e) {
            if (e.target.id === 'columnFilterInput') filterColumns();
            if (e.target.classList.contains('filter-input')) applyFilters();
        });

        document.getElementById('tableHead').addEventListener('click', function(e) {
            if (e.target.closest('#selectAllBtn')) toggleSelectAll();
            else if (e.target.closest('#deleteBtn')) deleteSelectedRows();
            else if (e.target.closest('#addBtn')) addNewRow();
            else if (e.target.closest('#refreshBtn')) vscode.postMessage({ command: 'refreshData' });
            else if (e.target.closest('th.data-column') && !e.target.closest('.resize-handle') && !e.target.closest('input')) {
                const th = e.target.closest('th.data-column');
                const name = th.getAttribute('data-column-name');
                if (name) navigator.clipboard.writeText(name);
            }
        });

        document.getElementById('dataBody').addEventListener('click', function(e) {
            if (e.target.classList.contains('expand-btn')) {
                showModal(decodeURIComponent(e.target.getAttribute('data-full-value')));
            } else if (e.target.closest('.save-row-btn')) saveEdit();
            else if (e.target.closest('.cancel-row-btn')) cancelEdit();
            else if (e.target.closest('.save-new-row-btn')) saveNewRow(e.target.closest('tr'));
            else if (e.target.classList.contains('row-checkbox')) {
                e.target.closest('tr').classList.toggle('selected', e.target.checked);
            }
        });

        document.getElementById('dataBody').addEventListener('dblclick', function(e) {
            const cell = e.target.closest('td.data-column');
            if (!cell) return;
            const row = cell.closest('tr');
            if (!row || row.classList.contains('new-row')) return;
            if (editingCell) saveEdit();
            const cellIndex = Array.from(row.querySelectorAll('td')).indexOf(cell);
            const columnName = cell.getAttribute('data-column-name');
            const globalIndex = parseInt(row.getAttribute('data-row-index'), 10);
            const rowData = allRows[globalIndex];
            if (!columnName || !rowData) return;
            const rawValue = rowData[columnName];
            const originalValue = rawValue === null || rawValue === undefined ? '' : String(rawValue);
            editingCell = { row: row, cellIndex: cellIndex, originalValue: originalValue, columnName: columnName };
            cell.classList.add('editing');
            cell.innerHTML = '<input type="text" class="edit-input" value="' + escapeHtml(originalValue) + '">';
            cell.querySelector('input').focus();
            row.querySelector('.save-row-btn').classList.remove('hidden');
            row.querySelector('.cancel-row-btn').classList.remove('hidden');
            row.classList.add('editing');
        });

        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                if (editingCell) { e.preventDefault(); cancelEdit(); }
                else closeModal();
            } else if (e.key === 'Enter' && editingCell) {
                e.preventDefault();
                saveEdit();
            }
        });

        document.getElementById('modal').addEventListener('click', function(e) {
            if (e.target.id === 'modal') closeModal();
        });
        document.getElementById('modalCloseBtn').addEventListener('click', closeModal);

        initColumnResize();
    }

    function initStickyColumnResize() {
        const filterHeader = document.querySelector('.column-filter-header');
        if (!filterHeader || filterHeader.querySelector('.sticky-resize-handle')) return;
        const handle = document.createElement('div');
        handle.className = 'resize-handle sticky-resize-handle';
        filterHeader.appendChild(handle);
        let isResizing = false, startX = 0, startWidth = 0;
        handle.addEventListener('mousedown', function(e) {
            isResizing = true;
            startX = e.clientX;
            startWidth = filterHeader.offsetWidth;
            handle.classList.add('active');
            e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
            if (!isResizing) return;
            const newWidth = Math.max(60, startWidth + (e.clientX - startX));
            filterHeader.style.width = newWidth + 'px';
            filterHeader.style.minWidth = newWidth + 'px';
            document.querySelectorAll('.sticky-column').forEach(function(col) {
                col.style.width = newWidth + 'px';
                col.style.minWidth = newWidth + 'px';
            });
        });
        document.addEventListener('mouseup', function() {
            if (isResizing) { isResizing = false; handle.classList.remove('active'); }
        });
    }

    function initColumnResize() {
        const table = document.querySelector('table');
        if (!table || table.dataset.resizeBound) return;
        table.dataset.resizeBound = '1';
        let resizing = false, currentTh = null, startX = 0, startWidth = 0;
        table.addEventListener('mousedown', function(e) {
            if (!e.target.classList.contains('resize-handle') || e.target.classList.contains('sticky-resize-handle')) return;
            e.preventDefault();
            resizing = true;
            currentTh = e.target.closest('th');
            startX = e.pageX;
            startWidth = currentTh.offsetWidth;
            e.target.classList.add('active');
        });
        document.addEventListener('mousemove', function(e) {
            if (!resizing || !currentTh) return;
            const width = Math.max(50, startWidth + (e.pageX - startX));
            const colName = currentTh.getAttribute('data-column-name');
            document.querySelectorAll('[data-column-name]').forEach(function(cell) {
                if (cell.getAttribute('data-column-name') !== colName) return;
                cell.style.width = width + 'px';
                cell.style.minWidth = width + 'px';
                cell.style.maxWidth = width + 'px';
            });
        });
        document.addEventListener('mouseup', function() {
            if (resizing) {
                resizing = false;
                document.querySelectorAll('.resize-handle.active').forEach(function(h) { h.classList.remove('active'); });
                currentTh = null;
            }
        });
    }

    function setData(payload) {
        allRows = payload.rows || [];
        fields = payload.fields && payload.fields.length ? payload.fields : (allRows.length ? Object.keys(allRows[0]) : []);
        columnComments = payload.columnComments || {};
        totalRowsHint = payload.totalRows || null;
        filteredIndices = null;
        currentPage = 1;
        editingCell = null;

        const noData = document.getElementById('noData');
        const wrapper = document.getElementById('tableWrapper');
        const pagination = document.getElementById('paginationContainer');
        if (allRows.length === 0) {
            noData.style.display = 'block';
            wrapper.style.display = 'none';
            pagination.style.display = 'none';
            return;
        }
        noData.style.display = 'none';
        wrapper.style.display = 'block';
        pagination.style.display = 'flex';
        buildTableHead();
        bindStaticUiEvents();
        initStickyColumnResize();
        updatePagination();
    }

    window.addEventListener('message', function(event) {
        const message = event.data;
        if (message.command === 'setData') setData(message);
        else if (message.command === 'updateComments') {
            columnComments = message.columnComments || {};
            updateHeaderComments();
        }
    });

    vscode.postMessage({ command: 'ready' });
})();
        `;
    }
}
