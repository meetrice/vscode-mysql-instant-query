import * as vscode from "vscode";
import { I18n } from "./common/i18n";
import { TableFilterState } from "./mysqlTreeDataProvider";

export class FilterInputPanel {
    private static panel: vscode.WebviewView | undefined = undefined;
    private static currentFilter: string = "";

    public static initialize(context: vscode.ExtensionContext) {
        // Register the webview view provider
        const provider = new FilterViewProvider();
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('mysqlInstantQueryFilter', provider)
        );
    }
}

class FilterViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor() {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: []
        };

        webviewView.webview.html = this.getWebviewContent();

        webviewView.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'updateConnectionFilter':
                        TableFilterState.instance.setConnectionFilterText(message.text);
                        break;
                    case 'updateDatabaseFilter':
                        TableFilterState.instance.setDatabaseFilterText(message.text);
                        break;
                    case 'updateFilter':
                        TableFilterState.instance.setFilterText(message.text);
                        break;
                    case 'updateColumnFilter':
                        TableFilterState.instance.setColumnFilterText(message.text);
                        break;
                    case 'clearConnectionFilter':
                        TableFilterState.instance.setConnectionFilterText("");
                        this._view?.webview.postMessage({
                            command: 'setConnectionFilter',
                            text: ''
                        });
                        break;
                    case 'clearDatabaseFilter':
                        TableFilterState.instance.setDatabaseFilterText("");
                        this._view?.webview.postMessage({
                            command: 'setDatabaseFilter',
                            text: ''
                        });
                        break;
                    case 'clearFilter':
                        TableFilterState.instance.setFilterText("");
                        this._view?.webview.postMessage({
                            command: 'setTableFilter',
                            text: ''
                        });
                        break;
                    case 'clearColumnFilter':
                        TableFilterState.instance.setColumnFilterText("");
                        this._view?.webview.postMessage({
                            command: 'setColumnFilter',
                            text: ''
                        });
                        break;
                    case 'clearAll':
                        TableFilterState.instance.clear();
                        this._view?.webview.postMessage({
                            command: 'setConnectionFilter',
                            text: ''
                        });
                        this._view?.webview.postMessage({
                            command: 'setDatabaseFilter',
                            text: ''
                        });
                        this._view?.webview.postMessage({
                            command: 'setTableFilter',
                            text: ''
                        });
                        this._view?.webview.postMessage({
                            command: 'setColumnFilter',
                            text: ''
                        });
                        break;
                }
            },
            null,
        );

        // Listen to filter changes from external sources
        TableFilterState.instance.onDidChangeFilter(() => {
            this._view?.webview.postMessage({
                command: 'setFilters',
                connectionFilter: TableFilterState.instance.connectionFilterText,
                databaseFilter: TableFilterState.instance.databaseFilterText,
                tableFilter: TableFilterState.instance.filterText,
                columnFilter: TableFilterState.instance.columnFilterText
            });
        });
    }

    private getWebviewContent(): string {
        const labelConnection = this.escapeHtml(I18n.t("filterPanel.label.connection", "Connection:"));
        const labelDatabase = this.escapeHtml(I18n.t("filterPanel.label.database", "Database:"));
        const labelTable = this.escapeHtml(I18n.t("filterPanel.label.table", "Table:"));
        const labelColumn = this.escapeHtml(I18n.t("filterPanel.label.column", "Column:"));
        const placeholderConnection = this.escapeHtml(I18n.t("placeholder.filterConnections", "Filter connections..."));
        const placeholderDatabase = this.escapeHtml(I18n.t("placeholder.filterDatabases", "Filter databases..."));
        const placeholderTable = this.escapeHtml(I18n.t("placeholder.filterTables", "Filter tables..."));
        const placeholderColumn = this.escapeHtml(I18n.t("placeholder.filterColumns", "Filter columns..."));
        const lang = I18n.getLocale().toLowerCase().startsWith("zh") ? "zh-CN" : "en";

        return `<!DOCTYPE html>
<html lang="${lang}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        html {
            background: transparent;
            overflow-x: hidden;
        }
        body {
            background: transparent;
            pointer-events: none;
            overflow-x: hidden;
            font-family: var(--vscode-font-family);
            font-size: 12px;
            color: var(--vscode-foreground);
            line-height: 1;
        }
        .filter-container {
            pointer-events: auto;
            display: grid;
            grid-template-columns: max-content 1fr;
            gap: 6px 8px;
            align-items: center;
            padding: 4px 16px 6px 8px;
            overflow-x: hidden;
            max-width: 100%;
        }
        .filter-label {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
        }
        .input-cell {
            display: flex;
            align-items: center;
            gap: 2px;
            min-width: 0;
        }
        input {
            flex: 1;
            min-width: 0;
            padding: 2px 4px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: inherit;
            font-size: inherit;
            border-radius: 2px;
            line-height: 1.4;
        }
        input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }
        .clear-btn {
            padding: 0;
            border: none;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            border-radius: 2px;
            font-family: inherit;
            font-size: 10px;
            line-height: 1;
            width: 14px;
            height: 14px;
            flex-shrink: 0;
            display: none;
        }
        .clear-btn:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }
        .clear-btn.visible {
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }
    </style>
</head>
<body>
    <div class="filter-container">
        <span class="filter-label">${labelConnection}</span>
        <div class="input-cell">
            <input type="text" id="connectionFilterInput" placeholder="${placeholderConnection}" autocomplete="off" spellcheck="false">
            <button id="connectionClearBtn" class="clear-btn" type="button">✕</button>
        </div>
        <span class="filter-label">${labelDatabase}</span>
        <div class="input-cell">
            <input type="text" id="databaseFilterInput" placeholder="${placeholderDatabase}" autocomplete="off" spellcheck="false">
            <button id="databaseClearBtn" class="clear-btn" type="button">✕</button>
        </div>
        <span class="filter-label">${labelTable}</span>
        <div class="input-cell">
            <input type="text" id="tableFilterInput" placeholder="${placeholderTable}" autocomplete="off" spellcheck="false">
            <button id="tableClearBtn" class="clear-btn" type="button">✕</button>
        </div>
        <span class="filter-label">${labelColumn}</span>
        <div class="input-cell">
            <input type="text" id="columnFilterInput" placeholder="${placeholderColumn}" autocomplete="off" spellcheck="false">
            <button id="columnClearBtn" class="clear-btn" type="button">✕</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const connectionInput = document.getElementById('connectionFilterInput');
        const connectionClearBtn = document.getElementById('connectionClearBtn');
        const databaseInput = document.getElementById('databaseFilterInput');
        const databaseClearBtn = document.getElementById('databaseClearBtn');
        const tableInput = document.getElementById('tableFilterInput');
        const tableClearBtn = document.getElementById('tableClearBtn');
        const columnInput = document.getElementById('columnFilterInput');
        const columnClearBtn = document.getElementById('columnClearBtn');

        let connectionTimeout = null;
        let databaseTimeout = null;
        let tableTimeout = null;
        let columnTimeout = null;

        connectionInput.addEventListener('input', (e) => {
            const text = e.target.value;
            updateClearButton('connection', text);

            clearTimeout(connectionTimeout);
            connectionTimeout = setTimeout(() => {
                vscode.postMessage({
                    command: 'updateConnectionFilter',
                    text: text
                });
            }, 100);
        });

        databaseInput.addEventListener('input', (e) => {
            const text = e.target.value;
            updateClearButton('database', text);

            clearTimeout(databaseTimeout);
            databaseTimeout = setTimeout(() => {
                vscode.postMessage({
                    command: 'updateDatabaseFilter',
                    text: text
                });
            }, 100);
        });

        tableInput.addEventListener('input', (e) => {
            const text = e.target.value;
            updateClearButton('table', text);

            clearTimeout(tableTimeout);
            tableTimeout = setTimeout(() => {
                vscode.postMessage({
                    command: 'updateFilter',
                    text: text
                });
            }, 100);
        });

        columnInput.addEventListener('input', (e) => {
            const text = e.target.value;
            updateClearButton('column', text);

            clearTimeout(columnTimeout);
            columnTimeout = setTimeout(() => {
                vscode.postMessage({
                    command: 'updateColumnFilter',
                    text: text
                });
            }, 100);
        });

        connectionInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                clearConnectionFilter();
            }
        });

        databaseInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                clearDatabaseFilter();
            }
        });

        tableInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                clearTableFilter();
            }
        });

        columnInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                clearColumnFilter();
            }
        });

        connectionClearBtn.addEventListener('click', clearConnectionFilter);
        databaseClearBtn.addEventListener('click', clearDatabaseFilter);
        tableClearBtn.addEventListener('click', clearTableFilter);
        columnClearBtn.addEventListener('click', clearColumnFilter);

        function clearConnectionFilter() {
            connectionInput.value = '';
            updateClearButton('connection', '');
            vscode.postMessage({
                command: 'clearConnectionFilter'
            });
            connectionInput.focus();
        }

        function clearDatabaseFilter() {
            databaseInput.value = '';
            updateClearButton('database', '');
            vscode.postMessage({
                command: 'clearDatabaseFilter'
            });
            databaseInput.focus();
        }

        function clearTableFilter() {
            tableInput.value = '';
            updateClearButton('table', '');
            vscode.postMessage({
                command: 'clearFilter'
            });
            tableInput.focus();
        }

        function clearColumnFilter() {
            columnInput.value = '';
            updateClearButton('column', '');
            vscode.postMessage({
                command: 'clearColumnFilter'
            });
            columnInput.focus();
        }

        function updateClearButton(type, text) {
            const btn = type === 'connection' ? connectionClearBtn
                : type === 'database' ? databaseClearBtn
                : type === 'table' ? tableClearBtn
                : columnClearBtn;
            if (text) {
                btn.classList.add('visible');
            } else {
                btn.classList.remove('visible');
            }
        }

        // Listen for messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'setFilters') {
                connectionInput.value = message.connectionFilter || '';
                databaseInput.value = message.databaseFilter || '';
                tableInput.value = message.tableFilter || '';
                columnInput.value = message.columnFilter || '';
                updateClearButton('connection', message.connectionFilter || '');
                updateClearButton('database', message.databaseFilter || '');
                updateClearButton('table', message.tableFilter || '');
                updateClearButton('column', message.columnFilter || '');
            } else if (message.command === 'setConnectionFilter') {
                connectionInput.value = message.text || '';
                updateClearButton('connection', message.text || '');
            } else if (message.command === 'setDatabaseFilter') {
                databaseInput.value = message.text || '';
                updateClearButton('database', message.text || '');
            } else if (message.command === 'setTableFilter') {
                tableInput.value = message.text || '';
                updateClearButton('table', message.text || '');
            } else if (message.command === 'setColumnFilter') {
                columnInput.value = message.text || '';
                updateClearButton('column', message.text || '');
            }
        });

        // Focus connection input on load
        connectionInput.focus();
    </script>
</body>
</html>`;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}
