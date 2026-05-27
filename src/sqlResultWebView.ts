import * as vscode from "vscode";
import { Utility } from "./common/utility";

export interface QueryResultPayload {
    rows: any[];
    fields?: string[];
    columnComments?: { [key: string]: string };
    columnTypes?: { [key: string]: string };
    totalRows?: number;
    sql?: string;
    database?: string;
    table?: string;
}

interface QueryInfo {
    sql?: string;
    database?: string;
    table?: string;
    columnComments?: { [key: string]: string };
    columnTypes?: { [key: string]: string };
}

interface PanelState {
    panel: vscode.WebviewPanel;
    queryInfo: QueryInfo;
    pendingPayload?: QueryResultPayload;
    webviewReady: boolean;
    messageDisposable?: vscode.Disposable;
}

export class SqlResultWebView {
    private static readonly panelStates = new Map<vscode.WebviewPanel, PanelState>();
    private static activePanel: vscode.WebviewPanel | undefined;
    private static layoutInitialized = false;

    private static tableKey(database?: string, table?: string): string | undefined {
        if (!table) {
            return undefined;
        }
        const db = (database ?? "").toLowerCase();
        return `${db}\0${table.toLowerCase()}`;
    }

    private static tablesMatch(
        aDatabase: string | undefined,
        aTable: string | undefined,
        bDatabase: string | undefined,
        bTable: string | undefined,
    ): boolean {
        const keyA = SqlResultWebView.tableKey(aDatabase, aTable);
        const keyB = SqlResultWebView.tableKey(bDatabase, bTable);
        return !!keyA && keyA === keyB;
    }

    private static findPanelStateByTable(database?: string, table?: string): PanelState | undefined {
        for (const state of SqlResultWebView.panelStates.values()) {
            if (SqlResultWebView.tablesMatch(
                database,
                table,
                state.queryInfo.database,
                state.queryInfo.table,
            )) {
                return state;
            }
        }
        return undefined;
    }

    private static getPanelState(panel: vscode.WebviewPanel | undefined): PanelState | undefined {
        if (!panel) {
            return undefined;
        }
        return SqlResultWebView.panelStates.get(panel);
    }

    private static setActivePanel(panel: vscode.WebviewPanel) {
        SqlResultWebView.activePanel = panel;
    }

    private static getActivePanelState(): PanelState | undefined {
        return SqlResultWebView.getPanelState(SqlResultWebView.activePanel);
    }

    private static resolvePanelStateForUpdate(database?: string, table?: string): PanelState | undefined {
        if (table) {
            const matched = SqlResultWebView.findPanelStateByTable(database, table);
            if (matched) {
                return matched;
            }
        }
        return SqlResultWebView.getActivePanelState();
    }

    public static async show(
        data: any[],
        title: string,
        sql?: string,
        database?: string,
        table?: string,
        columnComments?: { [key: string]: string },
        columnTypes?: { [key: string]: string },
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
            columnTypes,
            totalRows,
            sql,
            database,
            table,
        };

        const queryInfo: QueryInfo = { sql, database, table, columnComments, columnTypes };
        const existingState = table ? SqlResultWebView.findPanelStateByTable(database, table) : undefined;

        if (existingState) {
            const panel = existingState.panel;
            existingState.queryInfo = queryInfo;
            panel.title = panelTitle;
            SqlResultWebView.setActivePanel(panel);
            SqlResultWebView.sendDataToPanel(panel, payload);
            panel.reveal(vscode.ViewColumn.Two);
            return;
        }

        const panel = vscode.window.createWebviewPanel("MySQL", panelTitle, vscode.ViewColumn.Two, {
            retainContextWhenHidden: true,
            enableScripts: true,
        });

        const state: PanelState = {
            panel,
            queryInfo,
            pendingPayload: payload,
            webviewReady: false,
        };
        SqlResultWebView.panelStates.set(panel, state);
        SqlResultWebView.setActivePanel(panel);
        SqlResultWebView.registerMessageHandler(panel, state);
        panel.webview.html = SqlResultWebView.getShellHtml();

        panel.onDidChangeViewState((e) => {
            if (e.webviewPanel.visible) {
                SqlResultWebView.setActivePanel(panel);
            }
        });

        panel.onDidDispose(() => {
            SqlResultWebView.panelStates.delete(panel);
            if (state.messageDisposable) {
                state.messageDisposable.dispose();
                state.messageDisposable = undefined;
            }
            if (SqlResultWebView.activePanel === panel) {
                SqlResultWebView.activePanel = undefined;
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
        columnTypes?: { [key: string]: string },
    ) {
        const state = SqlResultWebView.resolvePanelStateForUpdate(database, table);
        if (!state) {
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

        const info = state.queryInfo;
        if (sql || database || table || columnComments || columnTypes) {
            state.queryInfo = {
                sql: sql || info.sql,
                database: database || info.database,
                table: table || info.table,
                columnComments: columnComments || info.columnComments,
                columnTypes: columnTypes || info.columnTypes,
            };
        }

        SqlResultWebView.setActivePanel(state.panel);
        SqlResultWebView.sendDataToPanel(state.panel, {
            rows: data,
            fields: SqlResultWebView.extractFields(data),
            columnComments: columnComments || state.queryInfo.columnComments,
            columnTypes: columnTypes || state.queryInfo.columnTypes,
            totalRows,
            sql: sql || state.queryInfo.sql,
            database: database || state.queryInfo.database,
            table: table || state.queryInfo.table,
        });
    }

    public static updateColumnMetadata(
        columnComments: { [key: string]: string },
        columnTypes?: { [key: string]: string },
    ) {
        const state = SqlResultWebView.getActivePanelState();
        if (!state) {
            return;
        }
        state.queryInfo.columnComments = columnComments;
        if (columnTypes) {
            state.queryInfo.columnTypes = columnTypes;
        }
        if (state.pendingPayload) {
            state.pendingPayload.columnComments = columnComments;
            if (columnTypes) {
                state.pendingPayload.columnTypes = columnTypes;
            }
            return;
        }
        if (!state.webviewReady) {
            return;
        }
        state.panel.webview.postMessage({
            command: "updateColumnMetadata",
            columnComments,
            columnTypes,
        });
    }

    private static flushColumnMetadata(state: PanelState) {
        if (!state.webviewReady) {
            return;
        }
        const info = state.queryInfo;
        if (!info.columnComments && !info.columnTypes) {
            return;
        }
        state.panel.webview.postMessage({
            command: "updateColumnMetadata",
            columnComments: info.columnComments || {},
            columnTypes: info.columnTypes,
        });
    }

    /** @deprecated use updateColumnMetadata */
    public static updateComments(columnComments: { [key: string]: string }) {
        SqlResultWebView.updateColumnMetadata(columnComments);
    }

    public static getLastQueryInfo(): { sql?: string; database?: string; table?: string } | undefined {
        return SqlResultWebView.getActivePanelState()?.queryInfo;
    }

    private static extractFields(rows: any[]): string[] {
        if (!rows || rows.length === 0) {
            return [];
        }
        return Object.keys(rows[0]);
    }

    private static toWebviewSafeValue(value: any): any {
        if (typeof value === "bigint") {
            return value.toString();
        }
        if (Array.isArray(value)) {
            return value.map((item) => SqlResultWebView.toWebviewSafeValue(item));
        }
        if (value && typeof value === "object") {
            if (value instanceof Date) {
                return value;
            }
            const safeObject: { [key: string]: any } = {};
            Object.keys(value).forEach((key) => {
                safeObject[key] = SqlResultWebView.toWebviewSafeValue(value[key]);
            });
            return safeObject;
        }
        return value;
    }

    private static toWebviewSafePayload(payload: QueryResultPayload): QueryResultPayload {
        return {
            ...payload,
            rows: SqlResultWebView.toWebviewSafeValue(payload.rows),
        };
    }

    private static sendDataToPanel(panel: vscode.WebviewPanel, payload: QueryResultPayload) {
        const state = SqlResultWebView.getPanelState(panel);
        if (!state) {
            return;
        }
        if (!state.webviewReady) {
            state.pendingPayload = payload;
            return;
        }
        const safePayload = SqlResultWebView.toWebviewSafePayload(payload);
        panel.webview.postMessage({
            command: "setData",
            ...safePayload,
        });
    }

    private static registerMessageHandler(panel: vscode.WebviewPanel, state: PanelState) {
        if (state.messageDisposable) {
            state.messageDisposable.dispose();
        }
        state.messageDisposable = panel.webview.onDidReceiveMessage((message) => {
            SqlResultWebView.setActivePanel(panel);
            if (message.command === "ready") {
                state.webviewReady = true;
                if (state.pendingPayload) {
                    const info = state.queryInfo;
                    if (info.columnComments) {
                        state.pendingPayload.columnComments = info.columnComments;
                    }
                    if (info.columnTypes) {
                        state.pendingPayload.columnTypes = info.columnTypes;
                    }
                    SqlResultWebView.sendDataToPanel(panel, state.pendingPayload);
                    state.pendingPayload = undefined;
                }
                SqlResultWebView.flushColumnMetadata(state);
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
    <div class="main-layout">
        <div id="columnVisibilityPanel" class="column-visibility-panel" style="display:none;">
            <div class="column-panel-header">
                <label class="column-panel-header-label">
                    <input type="checkbox" id="columnPanelSelectAll" class="column-panel-select-all" checked>
                    <span>字段列表</span>
                </label>
                <button type="button" class="column-panel-close-btn" id="columnPanelCloseBtn" title="关闭">&times;</button>
            </div>
            <input type="text" id="columnPanelSearch" class="column-panel-search" placeholder="搜索字段...">
            <div id="columnPanelList" class="column-panel-list"></div>
            <div class="column-panel-resize-handle" title="拖动调整宽度"></div>
        </div>
        <div class="table-area">
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
        </div>
    </div>
    <div id="columnContextMenu" class="column-context-menu" style="display:none;"></div>
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
                .column-name-row {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 2px;
                    max-width: 100%;
                }
                .column-name {
                    display: inline;
                    font-weight: 600;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
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
                .main-layout { display: flex; flex: 1; overflow: hidden; height: 100%; }
                .table-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
                .column-visibility-panel {
                    width: 260px;
                    min-width: 180px;
                    max-width: 70vw;
                    border-right: 1px solid var(--vscode-panel-border);
                    background-color: var(--vscode-sideBar-background);
                    display: flex;
                    flex-direction: column;
                    flex-shrink: 0;
                    overflow: hidden;
                    position: relative;
                }
                .column-panel-resize-handle {
                    position: absolute;
                    right: 0;
                    top: 0;
                    width: 5px;
                    height: 100%;
                    cursor: col-resize;
                    z-index: 20;
                }
                .column-panel-resize-handle:hover,
                .column-panel-resize-handle.active {
                    background-color: rgba(0, 122, 204, 0.35);
                }
                .column-panel-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 8px;
                    padding: 6px 8px 6px 12px;
                    font-size: 12px;
                    font-weight: 600;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    color: var(--vscode-sideBarTitle-foreground);
                }
                .column-panel-header-label {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    cursor: pointer;
                    user-select: none;
                    min-width: 0;
                    flex: 1;
                }
                .column-panel-close-btn {
                    flex-shrink: 0;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    width: 20px;
                    height: 20px;
                    padding: 0;
                    border: none;
                    border-radius: 3px;
                    background: transparent;
                    color: var(--vscode-sideBarTitle-foreground);
                    font-size: 16px;
                    line-height: 1;
                    cursor: pointer;
                }
                .column-panel-close-btn:hover {
                    background-color: var(--vscode-toolbar-hoverBackground);
                }
                .column-panel-select-all { cursor: pointer; flex-shrink: 0; }
                .column-panel-search {
                    margin: 8px;
                    padding: 4px 8px;
                    font-size: 12px;
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 2px;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    box-sizing: border-box;
                }
                .column-panel-list {
                    flex: 1;
                    overflow-y: auto;
                    padding: 0 4px 8px;
                }
                .column-panel-item {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    padding: 4px 8px 4px 6px;
                    font-size: 12px;
                    border-radius: 3px;
                }
                .column-panel-item:hover { background-color: var(--vscode-list-hoverBackground); }
                .column-panel-item.matched { background-color: rgba(0, 122, 204, 0.08); }
                .column-panel-checkbox { flex-shrink: 0; cursor: pointer; }
                .column-panel-name {
                    flex: 0 1 38%;
                    min-width: 48px;
                    max-width: 38%;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .column-panel-name .highlight { background-color: rgba(255, 193, 7, 0.5); font-weight: 600; }
                .column-panel-pin { flex-shrink: 0; font-size: 10px; }
                .column-panel-filter-wrap {
                    flex: 1;
                    min-width: 0;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                }
                .column-panel-filter {
                    flex: 1;
                    min-width: 0;
                    padding: 2px 6px;
                    font-size: 11px;
                    border: 1px solid transparent;
                    border-radius: 2px;
                    background-color: transparent;
                    color: var(--vscode-input-foreground);
                    box-sizing: border-box;
                }
                .column-panel-filter:hover {
                    border-color: var(--vscode-input-border);
                    background-color: var(--vscode-input-background);
                }
                .column-panel-filter:focus {
                    outline: none;
                    border-color: var(--vscode-focusBorder, #007acc);
                    background-color: var(--vscode-input-background);
                }
                .column-panel-filter::placeholder {
                    color: var(--vscode-descriptionForeground);
                    opacity: 0.85;
                }
                .column-panel-filter-result {
                    flex-shrink: 0;
                    font-size: 10px;
                    color: #007acc;
                    min-width: 32px;
                    text-align: right;
                    white-space: nowrap;
                }
                .column-panel-filter-result:empty { display: none; }
                .column-pin {
                    display: inline-flex;
                    align-items: center;
                    flex-shrink: 0;
                    color: #0066aa;
                    margin-right: 1px;
                }
                .column-pin-icon {
                    width: 7px;
                    height: 7px;
                    display: block;
                }
                .column-type {
                    display: block;
                    font-size: 11px;
                    color: #007acc;
                    font-weight: normal;
                    margin-top: 2px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    max-width: 100%;
                }
                .column-context-menu {
                    position: fixed;
                    z-index: 2000;
                    min-width: 160px;
                    background-color: var(--vscode-menu-background);
                    color: var(--vscode-menu-foreground);
                    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
                    border-radius: 4px;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
                    padding: 4px 0;
                    font-size: 13px;
                }
                .ctx-item {
                    padding: 6px 16px;
                    cursor: pointer;
                    white-space: nowrap;
                }
                .ctx-item:hover { background-color: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
                .ctx-separator {
                    height: 1px;
                    margin: 4px 0;
                    background-color: var(--vscode-panel-border);
                }
                th.data-column.pinned { background-color: #d4e8f7; }
                th.data-column.pinned .column-name { color: #0066aa; }
                thead tr:first-child th.data-column { overflow: hidden; }
                th.data-column.column-flash::after {
                    content: '';
                    position: absolute;
                    inset: 0;
                    pointer-events: none;
                    background: linear-gradient(
                        90deg,
                        transparent 0%,
                        rgba(0, 122, 204, 0.15) 25%,
                        rgba(0, 180, 255, 0.45) 50%,
                        rgba(0, 122, 204, 0.15) 75%,
                        transparent 100%
                    );
                    animation: column-header-gradient-sweep 0.75s ease-out forwards;
                }
                th.data-column.pinned.column-flash::after {
                    background: linear-gradient(
                        90deg,
                        transparent 0%,
                        rgba(0, 102, 170, 0.2) 25%,
                        rgba(0, 160, 230, 0.5) 50%,
                        rgba(0, 102, 170, 0.2) 75%,
                        transparent 100%
                    );
                }
                @keyframes column-header-gradient-sweep {
                    0% { transform: translateX(-100%); opacity: 0.6; }
                    40% { opacity: 1; }
                    100% { transform: translateX(100%); opacity: 0; }
                }
                .column-panel-item.field-flash {
                    animation: column-panel-field-flash 0.75s ease-out;
                }
                .column-panel-item.field-flash .column-panel-name {
                    animation: column-panel-name-pulse 0.75s ease-out;
                }
                @keyframes column-panel-field-flash {
                    0% { background-color: transparent; }
                    30% { background-color: rgba(0, 122, 204, 0.18); }
                    60% { background-color: rgba(0, 180, 255, 0.28); }
                    100% { background-color: transparent; }
                }
                @keyframes column-panel-name-pulse {
                    0% { color: inherit; }
                    40% { color: #007acc; font-weight: 700; }
                    100% { color: inherit; font-weight: inherit; }
                }
        `;
    }

    private static getClientScript(): string {
        return `
(function() {
    const vscode = acquireVsCodeApi();
    let allRows = [];
    let fields = [];
    let columnComments = {};
    let columnTypes = {};
    let pinnedColumns = new Set();
    let hiddenColumns = new Set();
    let showTypes = false;
    let showComments = true;
    let columnPanelOpen = false;
    let columnFilterValues = {};
    let contextMenuColumn = null;
    let pendingColumnMetadata = null;
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

    function fuzzyMatch(text, query) {
        if (!query) return true;
        const t = text.toLowerCase();
        const q = query.toLowerCase();
        let ti = 0;
        for (let qi = 0; qi < q.length; qi++) {
            const idx = t.indexOf(q[qi], ti);
            if (idx === -1) return false;
            ti = idx + 1;
        }
        return true;
    }

    function highlightFuzzy(text, query) {
        if (!query) return escapeHtml(text);
        const t = text;
        const q = query.toLowerCase();
        let ti = 0;
        let html = '';
        let qi = 0;
        while (qi < q.length && ti < t.length) {
            const idx = t.toLowerCase().indexOf(q[qi], ti);
            if (idx === -1) break;
            html += escapeHtml(t.substring(ti, idx));
            html += '<span class="highlight">' + escapeHtml(t.charAt(idx)) + '</span>';
            ti = idx + 1;
            qi++;
        }
        html += escapeHtml(t.substring(ti));
        return html;
    }

    function isColumnVisible(field) {
        if (pinnedColumns.has(field)) return true;
        if (hiddenColumns.has(field)) return false;
        const input = document.getElementById('columnFilterInput');
        const filterText = input ? input.value.toLowerCase().trim() : '';
        if (!filterText) return true;
        const name = field.toLowerCase();
        const comment = (columnComments[field] || '').toLowerCase();
        return name.includes(filterText) || comment.includes(filterText);
    }

    function applyColumnVisibility() {
        document.querySelectorAll('th.data-column, td.data-column').forEach(function(el) {
            const name = el.getAttribute('data-column-name');
            if (!name) return;
            el.classList.toggle('hidden', !isColumnVisible(name));
        });
        renderColumnPanel();
    }

    function buildColumnHeaderContent(field) {
        const comment = columnComments[field] || '';
        const colType = columnTypes[field] || '';
        const isPinned = pinnedColumns.has(field);
        const showComment = showComments;
        const showType = showTypes;
        const pinHtml = isPinned
            ? '<span class="column-pin" title="固定显示"><svg class="column-pin-icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M8 1.2 12.5 5.7v2.8L8 16 3.5 8.5V5.7L8 1.2z"/></svg></span>'
            : '';
        let subHtml = '';
        if (showType && colType) {
            subHtml += '<span class="column-type" title="' + escapeHtml(colType) + '">' + escapeHtml(colType) + '</span>';
        }
        if (showComment && comment) {
            subHtml += '<span class="column-comment" title="' + escapeHtml(comment) + '">' + escapeHtml(comment) + '</span>';
        }
        return '<span class="column-name-row">' + pinHtml + '<span class="column-name">' + escapeHtml(field) + '</span></span>' + subHtml;
    }

    function buildTableHead() {
        const thead = document.getElementById('tableHead');
        if (!thead) return;
        let head = '<tr><th class="column-filter-header"><input type="text" id="columnFilterInput" class="column-filter-input" placeholder="🔍"></th>';
        fields.forEach(function(field, index) {
            const comment = columnComments[field] || '';
            const isPinned = pinnedColumns.has(field);
            const hiddenClass = !isColumnVisible(field) ? ' hidden' : '';
            const pinnedClass = isPinned ? ' pinned' : '';
            head += '<th class="data-column' + hiddenClass + pinnedClass + '" data-column-name="' + escapeHtml(field) + '" data-column-comment="' + escapeHtml(comment) + '" data-column-index="' + index + '">' +
                buildColumnHeaderContent(field) +
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
            const hiddenClass = !isColumnVisible(field) ? ' hidden' : '';
            filterRow += '<th class="filter-header data-column' + hiddenClass + '" data-column-name="' + escapeHtml(field) + '">' +
                '<input type="text" class="filter-input" data-column-index="' + index + '" placeholder=""></th>';
        });
        filterRow += '</tr>';
        thead.innerHTML = head + filterRow;
    }

    function updateHeaderMetadata() {
        document.querySelectorAll('thead tr:first-child th.data-column').forEach(function(th) {
            const name = th.getAttribute('data-column-name');
            if (!name) return;
            const comment = columnComments[name] || '';
            const idx = th.getAttribute('data-column-index');
            th.setAttribute('data-column-comment', comment);
            th.innerHTML = buildColumnHeaderContent(name) +
                '<div class="resize-handle" data-column-index="' + (idx || '0') + '"></div>';
            th.classList.toggle('pinned', pinnedColumns.has(name));
            th.classList.toggle('hidden', !isColumnVisible(name));
        });
        applyColumnVisibility();
    }

    function getColumnFilterMatchCount(field, filterValue) {
        if (!filterValue || !filterValue.trim()) return allRows.length;
        const v = filterValue.toLowerCase().trim();
        let count = 0;
        allRows.forEach(function(row) {
            const cellValue = row[field];
            const text = (cellValue === null || cellValue === undefined) ? 'null' : String(cellValue);
            if (text.toLowerCase().indexOf(v) !== -1) count++;
        });
        return count;
    }

    function syncFilterInputPair(field, value) {
        const idx = fields.indexOf(field);
        if (idx !== -1) {
            document.querySelectorAll('.filter-input').forEach(function(input) {
                if (parseInt(input.getAttribute('data-column-index'), 10) === idx && input.value !== value) {
                    input.value = value;
                }
            });
        }
        document.querySelectorAll('.column-panel-filter').forEach(function(input) {
            if (input.getAttribute('data-field') === field && input.value !== value) {
                input.value = value;
            }
        });
    }

    function updatePanelFilterResultCounts() {
        document.querySelectorAll('.column-panel-filter').forEach(function(input) {
            const field = input.getAttribute('data-field');
            const resultEl = input.parentElement ? input.parentElement.querySelector('.column-panel-filter-result') : null;
            if (!resultEl || !field) return;
            const value = input.value.trim();
            if (!value) {
                resultEl.textContent = '';
                return;
            }
            const count = getColumnFilterMatchCount(field, value);
            resultEl.textContent = count + '/' + allRows.length;
        });
    }

    function applyFiltersFromValues() {
        const filters = [];
        fields.forEach(function(field) {
            const value = (columnFilterValues[field] || '').toLowerCase().trim();
            if (value) filters.push({ field: field, value: value });
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
        updatePanelFilterResultCounts();
    }

    function onFilterInputChange(field, value) {
        if (!field) return;
        columnFilterValues[field] = value;
        syncFilterInputPair(field, value);
        applyFiltersFromValues();
    }

    function renderColumnPanel() {
        const list = document.getElementById('columnPanelList');
        if (!list) return;
        const search = document.getElementById('columnPanelSearch');
        const query = search ? search.value.trim() : '';
        let html = '';
        fields.forEach(function(field, index) {
            const comment = columnComments[field] || '';
            const isChecked = !hiddenColumns.has(field) || pinnedColumns.has(field);
            const isPinned = pinnedColumns.has(field);
            const matched = !query || fuzzyMatch(field, query) || fuzzyMatch(comment, query);
            const nameHtml = query && fuzzyMatch(field, query) ? highlightFuzzy(field, query) : escapeHtml(field);
            const filterValue = columnFilterValues[field] || '';
            const filterPlaceholder = comment || '过滤...';
            const resultText = filterValue.trim()
                ? getColumnFilterMatchCount(field, filterValue) + '/' + allRows.length
                : '';
            html += '<div class="column-panel-item' + (matched && query ? ' matched' : '') + '" data-field="' + escapeHtml(field) + '"' + (matched ? '' : ' style="display:none"') + '>' +
                '<input type="checkbox" class="column-panel-checkbox" data-field="' + escapeHtml(field) + '"' +
                (isChecked ? ' checked' : '') + (isPinned ? ' disabled' : '') + '>' +
                '<span class="column-panel-name" title="' + escapeHtml(field) + '">' + nameHtml + '</span>' +
                (isPinned ? '<span class="column-panel-pin" title="固定显示">📌</span>' : '') +
                '<div class="column-panel-filter-wrap">' +
                '<input type="text" class="column-panel-filter" data-field="' + escapeHtml(field) + '" data-column-index="' + index + '" value="' + escapeHtml(filterValue) + '" placeholder="' + escapeHtml(filterPlaceholder) + '">' +
                '<span class="column-panel-filter-result">' + escapeHtml(resultText) + '</span>' +
                '</div></div>';
        });
        list.innerHTML = html;
        updateSelectAllCheckbox();
    }

    function updateSelectAllCheckbox() {
        const cb = document.getElementById('columnPanelSelectAll');
        if (!cb) return;
        const nonPinned = fields.filter(function(f) { return !pinnedColumns.has(f); });
        if (nonPinned.length === 0) {
            cb.checked = true;
            cb.indeterminate = false;
            cb.disabled = pinnedColumns.size > 0;
            return;
        }
        cb.disabled = false;
        const visibleCount = nonPinned.filter(function(f) { return !hiddenColumns.has(f); }).length;
        if (visibleCount === nonPinned.length) {
            cb.checked = true;
            cb.indeterminate = false;
        } else if (visibleCount === 0) {
            cb.checked = false;
            cb.indeterminate = false;
        } else {
            cb.checked = false;
            cb.indeterminate = true;
        }
    }

    function setAllColumnsVisible(visible) {
        fields.forEach(function(field) {
            if (pinnedColumns.has(field)) return;
            if (visible) {
                hiddenColumns.delete(field);
            } else {
                hiddenColumns.add(field);
            }
        });
        applyColumnVisibility();
    }

    function flashColumnSelection(columnName) {
        document.querySelectorAll('thead tr:first-child th.data-column').forEach(function(th) {
            if (th.getAttribute('data-column-name') !== columnName) return;
            th.classList.remove('column-flash');
            void th.offsetWidth;
            th.classList.add('column-flash');
            setTimeout(function() { th.classList.remove('column-flash'); }, 750);
        });

        if (!columnPanelOpen) return;
        document.querySelectorAll('#columnPanelList .column-panel-item').forEach(function(item) {
            if (item.getAttribute('data-field') !== columnName) return;
            item.classList.remove('field-flash');
            void item.offsetWidth;
            item.classList.add('field-flash');
            item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            item.addEventListener('animationend', function handler() {
                item.classList.remove('field-flash');
                item.removeEventListener('animationend', handler);
            });
        });
    }

    function toggleColumnPanel(show) {
        columnPanelOpen = show !== undefined ? show : !columnPanelOpen;
        const panel = document.getElementById('columnVisibilityPanel');
        if (panel) panel.style.display = columnPanelOpen ? 'flex' : 'none';
        if (columnPanelOpen) renderColumnPanel();
    }

    function hideContextMenu() {
        const menu = document.getElementById('columnContextMenu');
        if (menu) menu.style.display = 'none';
        contextMenuColumn = null;
    }

    function showColumnContextMenu(x, y, columnName) {
        hideContextMenu();
        const menu = document.getElementById('columnContextMenu');
        if (!menu) return;
        contextMenuColumn = columnName;
        const isPinned = pinnedColumns.has(columnName);
        menu.innerHTML =
            '<div class="ctx-item" data-action="togglePanel">显示隐藏列</div>' +
            '<div class="ctx-item" data-action="pin">' + (isPinned ? '取消固定' : '固定显示') + '</div>' +
            '<div class="ctx-item" data-action="hideOthers">隐藏其他</div>' +
            '<div class="ctx-item" data-action="showAll">显示全部字段</div>' +
            '<div class="ctx-separator"></div>' +
            '<div class="ctx-item" data-action="copy">复制列名</div>' +
            '<div class="ctx-item" data-action="toggleType">' + (showTypes ? '隐藏类型' : '显示类型') + '</div>' +
            '<div class="ctx-item" data-action="toggleComment">' + (showComments ? '隐藏注释' : '显示注释') + '</div>';
        menu.style.display = 'block';
        menu.style.left = Math.min(x, window.innerWidth - 180) + 'px';
        menu.style.top = Math.min(y, window.innerHeight - 280) + 'px';
    }

    function handleContextMenuAction(action, columnName) {
        if (!columnName) return;
        switch (action) {
            case 'togglePanel':
                toggleColumnPanel();
                break;
            case 'pin':
                if (pinnedColumns.has(columnName)) {
                    pinnedColumns.delete(columnName);
                } else {
                    pinnedColumns.add(columnName);
                    hiddenColumns.delete(columnName);
                }
                updateHeaderMetadata();
                break;
            case 'hideOthers':
                fields.forEach(function(f) {
                    if (f !== columnName && !pinnedColumns.has(f)) {
                        hiddenColumns.add(f);
                    } else {
                        hiddenColumns.delete(f);
                    }
                });
                applyColumnVisibility();
                break;
            case 'showAll':
                hiddenColumns.clear();
                applyColumnVisibility();
                break;
            case 'copy':
                navigator.clipboard.writeText(columnName);
                break;
            case 'toggleType':
                showTypes = !showTypes;
                updateHeaderMetadata();
                break;
            case 'toggleComment':
                showComments = !showComments;
                updateHeaderMetadata();
                break;
        }
        hideContextMenu();
    }

    function setColumnVisible(field, visible) {
        if (pinnedColumns.has(field)) return;
        if (visible) {
            hiddenColumns.delete(field);
        } else {
            hiddenColumns.add(field);
        }
        applyColumnVisibility();
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
            if (!isColumnVisible(field)) td.classList.add('hidden');
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
        document.querySelectorAll('.filter-input').forEach(function(input) {
            const idx = parseInt(input.getAttribute('data-column-index'), 10);
            const field = fields[idx];
            if (field) columnFilterValues[field] = input.value;
        });
        document.querySelectorAll('.column-panel-filter').forEach(function(input) {
            const field = input.getAttribute('data-field');
            if (field) columnFilterValues[field] = input.value;
        });
        applyFiltersFromValues();
    }

    function filterColumns() {
        applyColumnVisibility();
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
            if (e.target.id === 'columnPanelSearch') renderColumnPanel();
            if (e.target.classList.contains('filter-input')) {
                const idx = parseInt(e.target.getAttribute('data-column-index'), 10);
                const field = fields[idx];
                if (field) onFilterInputChange(field, e.target.value);
            }
            if (e.target.classList.contains('column-panel-filter')) {
                const field = e.target.getAttribute('data-field');
                if (field) onFilterInputChange(field, e.target.value);
            }
        });

        document.getElementById('columnPanelList').addEventListener('click', function(e) {
            if (e.target.classList.contains('column-panel-filter')) e.stopPropagation();
        });

        document.getElementById('columnPanelList').addEventListener('change', function(e) {
            if (!e.target.classList.contains('column-panel-checkbox')) return;
            const field = e.target.getAttribute('data-field');
            if (field) setColumnVisible(field, e.target.checked);
        });

        document.getElementById('columnPanelSelectAll').addEventListener('change', function(e) {
            setAllColumnsVisible(e.target.checked);
        });

        document.getElementById('columnPanelCloseBtn').addEventListener('click', function() {
            toggleColumnPanel(false);
        });

        document.getElementById('columnContextMenu').addEventListener('click', function(e) {
            const item = e.target.closest('.ctx-item');
            if (!item) return;
            const action = item.getAttribute('data-action');
            handleContextMenuAction(action, contextMenuColumn);
        });

        document.getElementById('tableHead').addEventListener('contextmenu', function(e) {
            const th = e.target.closest('th.data-column');
            if (!th || th.classList.contains('filter-header')) return;
            e.preventDefault();
            const name = th.getAttribute('data-column-name');
            if (name) showColumnContextMenu(e.clientX, e.clientY, name);
        });

        document.addEventListener('click', function(e) {
            if (!e.target.closest('#columnContextMenu')) hideContextMenu();
        });

        document.getElementById('tableHead').addEventListener('click', function(e) {
            if (e.target.closest('#selectAllBtn')) toggleSelectAll();
            else if (e.target.closest('#deleteBtn')) deleteSelectedRows();
            else if (e.target.closest('#addBtn')) addNewRow();
            else if (e.target.closest('#refreshBtn')) vscode.postMessage({ command: 'refreshData' });
            else if (e.target.closest('th.data-column') && !e.target.closest('.filter-header') && !e.target.closest('.resize-handle') && !e.target.closest('input')) {
                const th = e.target.closest('th.data-column');
                const name = th.getAttribute('data-column-name');
                if (name) {
                    navigator.clipboard.writeText(name);
                    flashColumnSelection(name);
                }
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
        initColumnPanelResize();
    }

    function initColumnPanelResize() {
        const panel = document.getElementById('columnVisibilityPanel');
        const handle = document.querySelector('.column-panel-resize-handle');
        if (!panel || !handle || handle.dataset.bound) return;
        handle.dataset.bound = '1';
        let isResizing = false, startX = 0, startWidth = 0;
        handle.addEventListener('mousedown', function(e) {
            isResizing = true;
            startX = e.clientX;
            startWidth = panel.offsetWidth;
            handle.classList.add('active');
            e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
            if (!isResizing) return;
            const maxWidth = Math.max(320, window.innerWidth * 0.7);
            const newWidth = Math.max(180, Math.min(maxWidth, startWidth + (e.clientX - startX)));
            panel.style.width = newWidth + 'px';
        });
        document.addEventListener('mouseup', function() {
            if (isResizing) {
                isResizing = false;
                handle.classList.remove('active');
            }
        });
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

    function applyColumnMetadata(message) {
        columnComments = message.columnComments || {};
        if (message.columnTypes) columnTypes = message.columnTypes;
        if (fields.length === 0) return;
        updateHeaderMetadata();
        if (columnPanelOpen) renderColumnPanel();
    }

    function setData(payload) {
        allRows = payload.rows || [];
        fields = payload.fields && payload.fields.length ? payload.fields : (allRows.length ? Object.keys(allRows[0]) : []);
        columnComments = payload.columnComments || {};
        columnTypes = payload.columnTypes || {};
        if (pendingColumnMetadata) {
            columnComments = pendingColumnMetadata.columnComments || columnComments;
            if (pendingColumnMetadata.columnTypes) {
                columnTypes = pendingColumnMetadata.columnTypes;
            }
            pendingColumnMetadata = null;
        }
        totalRowsHint = payload.totalRows || null;
        filteredIndices = null;
        currentPage = 1;
        editingCell = null;
        pinnedColumns = new Set();
        hiddenColumns = new Set();
        columnFilterValues = {};
        showTypes = false;
        showComments = true;

        const noData = document.getElementById('noData');
        const wrapper = document.getElementById('tableWrapper');
        const pagination = document.getElementById('paginationContainer');
        if (allRows.length === 0) {
            noData.style.display = 'block';
            wrapper.style.display = 'none';
            pagination.style.display = 'none';
            toggleColumnPanel(false);
            return;
        }
        noData.style.display = 'none';
        wrapper.style.display = 'block';
        pagination.style.display = 'flex';
        buildTableHead();
        bindStaticUiEvents();
        initStickyColumnResize();
        if (columnPanelOpen) renderColumnPanel();
        updatePagination();
    }

    window.addEventListener('message', function(event) {
        const message = event.data;
        if (message.command === 'setData') setData(message);
        else if (message.command === 'updateColumnMetadata' || message.command === 'updateComments') {
            if (fields.length === 0) {
                pendingColumnMetadata = message;
                return;
            }
            applyColumnMetadata(message);
        }
    });

    vscode.postMessage({ command: 'ready' });
})();
        `;
    }
}
