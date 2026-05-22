import * as vscode from "vscode";
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
                    case 'updateFilter':
                        TableFilterState.instance.setFilterText(message.text);
                        break;
                    case 'updateColumnFilter':
                        TableFilterState.instance.setColumnFilterText(message.text);
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
                            command: 'setTableFilter',
                            text: ''
                        });
                        this._view?.webview.postMessage({
                            command: 'setColumnFilter',
                            text: ''
                        });
                        break;
                    case 'insertText':
                        // Insert text at cursor or copy to clipboard
                        const textToInsert = message.text;
                        if (vscode.window.activeTextEditor) {
                            const editor = vscode.window.activeTextEditor;
                            const position = editor.selection.active;
                            editor.edit(editBuilder => {
                                editBuilder.insert(position, textToInsert);
                            });
                        } else {
                            vscode.env.clipboard.writeText(textToInsert);
                            vscode.window.showInformationMessage(`Copied to clipboard: ${textToInsert}`);
                        }
                        break;
                }
            },
            null,
        );

        // Listen to filter changes from external sources
        TableFilterState.instance.onDidChangeFilter(() => {
            this._view?.webview.postMessage({
                command: 'setFilters',
                tableFilter: TableFilterState.instance.filterText,
                columnFilter: TableFilterState.instance.columnFilterText
            });
        });
    }

    private getWebviewContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
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
            height: auto;
        }
        body {
            padding: 0;
            font-family: var(--vscode-font-family);
            font-size: 12px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background);
            line-height: 1;
        }
        .filter-container {
            display: flex;
            flex-direction: column;
            gap: 4px;
            width: 100%;
        }
        .input-container {
            display: flex;
            gap: 2px;
            align-items: center;
            width: 100%;
            padding: 3px 4px;
        }
        .filter-label {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            flex-shrink: 0;
            min-width: 45px;
        }
        .search-icon {
            font-size: 11px;
            flex-shrink: 0;
        }
        input {
            flex: 1;
            padding: 1px 4px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: inherit;
            font-size: inherit;
            border-radius: 2px;
            min-width: 0;
            line-height: 1.4;
        }
        input:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }
        input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }
        .clear-btn {
            padding: 1px 4px;
            border: none;
            background-color: transparent;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            border-radius: 2px;
            font-family: inherit;
            font-size: 10px;
            flex-shrink: 0;
            display: none;
            line-height: 1.4;
        }
        .clear-btn:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }
        .clear-btn.visible {
            display: block;
        }
        .quick-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            padding: 4px 4px 6px 4px;
        }
        .quick-btn {
            padding: 3px 8px;
            border: 1px solid var(--vscode-button-border);
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            cursor: pointer;
            border-radius: 2px;
            font-family: var(--vscode-font-family);
            font-size: 11px;
            flex-shrink: 0;
            line-height: 1.4;
            white-space: nowrap;
        }
        .quick-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .quick-btn:active {
            background-color: var(--vscode-button-secondaryActiveBackground);
        }
    </style>
</head>
<body>
    <div class="filter-container">
        <div class="input-container">
            <span class="filter-label">Table:</span>
            <input type="text" id="tableFilterInput" placeholder="Filter tables..." autocomplete="off">
            <button id="tableClearBtn" class="clear-btn">✕</button>
        </div>
        <div class="input-container">
            <span class="filter-label">Column:</span>
            <input type="text" id="columnFilterInput" placeholder="Filter columns..." autocomplete="off">
            <button id="columnClearBtn" class="clear-btn">✕</button>
        </div>
        <div class="quick-actions">
            <button class="quick-btn" data-text="SELECT * FROM ">SELECT *</button>
            <button class="quick-btn" data-text="SELECT COUNT(*) FROM ">COUNT</button>
            <button class="quick-btn" data-text="WHERE ">WHERE</button>
            <button class="quick-btn" data-text="AND ">AND</button>
            <button class="quick-btn" data-text="OR ">OR</button>
            <button class="quick-btn" data-text="ORDER BY ">ORDER BY</button>
            <button class="quick-btn" data-text="GROUP BY ">GROUP BY</button>
            <button class="quick-btn" data-text="LIMIT ">LIMIT</button>
            <button class="quick-btn" data-text="LIKE '%">LIKE</button>
            <button class="quick-btn" data-text="IN ()">IN</button>
            <button class="quick-btn" data-text="INSERT INTO  VALUES ()">INSERT</button>
            <button class="quick-btn" data-text="UPDATE  SET ">UPDATE</button>
            <button class="quick-btn" data-text="DELETE FROM ">DELETE</button>
            <button class="quick-btn" data-text="JOIN ">JOIN</button>
            <button class="quick-btn" data-text="LEFT JOIN ">LEFT JOIN</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const tableInput = document.getElementById('tableFilterInput');
        const tableClearBtn = document.getElementById('tableClearBtn');
        const columnInput = document.getElementById('columnFilterInput');
        const columnClearBtn = document.getElementById('columnClearBtn');

        let tableTimeout = null;
        let columnTimeout = null;

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

        tableClearBtn.addEventListener('click', clearTableFilter);
        columnClearBtn.addEventListener('click', clearColumnFilter);

        // Quick action buttons
        const quickBtns = document.querySelectorAll('.quick-btn');
        quickBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const textToInsert = btn.getAttribute('data-text');
                vscode.postMessage({
                    command: 'insertText',
                    text: textToInsert
                });
            });
        });

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
            const btn = type === 'table' ? tableClearBtn : columnClearBtn;
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
                tableInput.value = message.tableFilter || '';
                columnInput.value = message.columnFilter || '';
                updateClearButton('table', message.tableFilter || '');
                updateClearButton('column', message.columnFilter || '');
            } else if (message.command === 'setTableFilter') {
                tableInput.value = message.text || '';
                updateClearButton('table', message.text || '');
            } else if (message.command === 'setColumnFilter') {
                columnInput.value = message.text || '';
                updateClearButton('column', message.text || '');
            }
        });

        // Focus table input on load
        tableInput.focus();
    </script>
</body>
</html>`;
    }
}
