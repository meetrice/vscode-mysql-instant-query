import * as uuidv1 from "uuid/v1";
import * as vscode from "vscode";
import { Constants } from "./common/constants";
import { I18n } from "./common/i18n";

export interface ICodeSnippet {
    id: string;
    label: string;
    text: string;
}

const DEFAULT_SNIPPETS: Omit<ICodeSnippet, "id">[] = [
    { label: "SELECT *", text: "SELECT * FROM " },
    { label: "COUNT", text: "SELECT COUNT(*) FROM " },
    { label: "WHERE", text: "WHERE " },
    { label: "AND", text: "AND " },
    { label: "OR", text: "OR " },
    { label: "ORDER BY", text: "ORDER BY " },
    { label: "GROUP BY", text: "GROUP BY " },
    { label: "LIMIT", text: "LIMIT " },
    { label: "LIKE", text: "LIKE '%" },
    { label: "IN", text: "IN ()" },
    { label: "INSERT", text: "INSERT INTO  VALUES ()" },
    { label: "UPDATE", text: "UPDATE  SET " },
    { label: "DELETE", text: "DELETE FROM " },
    { label: "JOIN", text: "JOIN " },
    { label: "LEFT JOIN", text: "LEFT JOIN " },
];

export class CodeSnippetsPanel {
    private static context: vscode.ExtensionContext;

    public static initialize(context: vscode.ExtensionContext) {
        CodeSnippetsPanel.context = context;
        const provider = new CodeSnippetsViewProvider(context);
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider("mysqlInstantQuerySnippets", provider)
        );
    }

    public static getSnippets(): ICodeSnippet[] {
        const stored = CodeSnippetsPanel.context.globalState.get<ICodeSnippet[]>(
            Constants.GlobalStateCodeSnippetsKey
        );
        if (stored && stored.length > 0) {
            return stored;
        }
        return DEFAULT_SNIPPETS.map((s, i) => ({
            id: `default-${i}`,
            label: s.label,
            text: s.text,
        }));
    }

    public static async saveSnippets(snippets: ICodeSnippet[]): Promise<void> {
        await CodeSnippetsPanel.context.globalState.update(
            Constants.GlobalStateCodeSnippetsKey,
            snippets
        );
    }
}

class CodeSnippetsViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(private readonly context: vscode.ExtensionContext) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [],
        };

        webviewView.webview.html = this.getWebviewContent();

        webviewView.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case "insertText":
                        this.insertText(message.text);
                        break;
                    case "openAddDialog":
                        await this.showSnippetDialog("add");
                        break;
                    case "openEditDialog":
                        await this.showSnippetDialog("edit", message.id);
                        break;
                    case "deleteSnippet":
                        await this.deleteSnippet(message.id);
                        break;
                    case "pinSnippet":
                        await this.pinSnippet(message.id);
                        break;
                }
            },
            null,
        );

        this.refreshWebview();
    }

    private insertText(textToInsert: string) {
        if (vscode.window.activeTextEditor) {
            const editor = vscode.window.activeTextEditor;
            const position = editor.selection.active;
            editor.edit((editBuilder) => {
                editBuilder.insert(position, textToInsert);
            });
        } else {
            vscode.env.clipboard.writeText(textToInsert);
            vscode.window.showInformationMessage(
                I18n.format("info.copied", [textToInsert])
            );
        }
    }

    private async showSnippetDialog(mode: "add" | "edit", snippetId?: string) {
        const existing =
            mode === "edit" && snippetId
                ? CodeSnippetsPanel.getSnippets().find((s) => s.id === snippetId)
                : undefined;

        if (mode === "edit" && !existing) {
            return;
        }

        const dialogTitle =
            mode === "add"
                ? I18n.t("snippetsPanel.dialog.addTitle", "Add code snippet")
                : I18n.t("snippetsPanel.dialog.editTitle", "Edit code snippet");
        const emptyNameError = I18n.t(
            "snippetsPanel.error.emptyDisplayName",
            "Display name cannot be empty"
        );
        const emptyTextError = I18n.t(
            "snippetsPanel.error.emptyCodeSnippet",
            "Code snippet cannot be empty"
        );

        const label = await vscode.window.showInputBox({
            title: dialogTitle,
            prompt: I18n.t("snippetsPanel.label.displayName", "Display name:"),
            placeHolder: I18n.t("snippetsPanel.label.displayName", "Display name:"),
            value: existing?.label ?? "",
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value?.trim()) {
                    return emptyNameError;
                }
                return undefined;
            },
        });
        if (label === undefined) {
            return;
        }

        const text = await vscode.window.showInputBox({
            title: dialogTitle,
            prompt: I18n.t("snippetsPanel.label.codeSnippet", "Code snippet:"),
            placeHolder: I18n.t("snippetsPanel.label.codeSnippet", "Code snippet:"),
            value: existing?.text ?? "",
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value) {
                    return emptyTextError;
                }
                return undefined;
            },
        });
        if (text === undefined) {
            return;
        }

        if (mode === "add") {
            await this.addSnippet(label, text);
        } else if (existing) {
            await this.updateSnippet(existing.id, label, text);
        }
    }

    private async addSnippet(label: string, text: string) {
        const snippets = CodeSnippetsPanel.getSnippets();
        snippets.push({
            id: uuidv1(),
            label: label.trim(),
            text,
        });
        await CodeSnippetsPanel.saveSnippets(snippets);
        this.refreshWebview();
    }

    private async updateSnippet(id: string, label: string, text: string) {
        const snippets = CodeSnippetsPanel.getSnippets();
        const index = snippets.findIndex((s) => s.id === id);
        if (index === -1) {
            return;
        }
        snippets[index] = {
            id,
            label: label.trim(),
            text,
        };
        await CodeSnippetsPanel.saveSnippets(snippets);
        this.refreshWebview();
    }

    private async deleteSnippet(id: string) {
        const snippets = CodeSnippetsPanel.getSnippets().filter((s) => s.id !== id);
        await CodeSnippetsPanel.saveSnippets(snippets);
        this.refreshWebview();
    }

    private async pinSnippet(id: string) {
        const snippets = CodeSnippetsPanel.getSnippets();
        const index = snippets.findIndex((s) => s.id === id);
        if (index <= 0) {
            return;
        }
        const [item] = snippets.splice(index, 1);
        snippets.unshift(item);
        await CodeSnippetsPanel.saveSnippets(snippets);
        this.refreshWebview();
    }

    private refreshWebview() {
        this._view?.webview.postMessage({
            command: "setSnippets",
            snippets: CodeSnippetsPanel.getSnippets(),
        });
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    private getWebviewContent(): string {
        const snippets = CodeSnippetsPanel.getSnippets();
        const snippetsJson = JSON.stringify(snippets);
        const menuEdit = this.escapeHtml(I18n.t("snippetsPanel.menu.edit", "Edit"));
        const menuDelete = this.escapeHtml(I18n.t("snippetsPanel.menu.delete", "Delete"));
        const menuPinToTop = this.escapeHtml(
            I18n.t("snippetsPanel.menu.pinToTop", "Pin to top")
        );
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
        .quick-actions {
            pointer-events: auto;
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            padding: 4px 16px 6px 8px;
            overflow-x: hidden;
            max-width: 100%;
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
        .quick-btn.add-btn {
            min-width: 28px;
            font-weight: bold;
            font-size: 14px;
            padding: 1px 8px;
        }
        .context-menu {
            pointer-events: auto;
            display: none;
            position: fixed;
            z-index: 200;
            min-width: 100px;
            background: var(--vscode-menu-background);
            border: 1px solid var(--vscode-menu-border);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            border-radius: 3px;
            padding: 4px 0;
        }
        .context-menu.visible {
            display: block;
        }
        .context-menu-item {
            display: block;
            width: 100%;
            text-align: left;
            padding: 4px 12px;
            border: none;
            background: transparent;
            color: var(--vscode-menu-foreground);
            font-family: var(--vscode-font-family);
            font-size: 12px;
            cursor: pointer;
        }
        .context-menu-item:hover {
            background: var(--vscode-menu-selectionBackground);
            color: var(--vscode-menu-selectionForeground);
        }
    </style>
</head>
<body>
    <div class="quick-actions" id="snippet-buttons"></div>

    <div class="context-menu" id="context-menu">
        <button type="button" class="context-menu-item" data-action="edit">${menuEdit}</button>
        <button type="button" class="context-menu-item" data-action="delete">${menuDelete}</button>
        <button type="button" class="context-menu-item" data-action="pin">${menuPinToTop}</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const addDialogTitle = ${JSON.stringify(
            I18n.t("snippetsPanel.dialog.addTitle", "Add code snippet")
        )};

        let snippets = ${snippetsJson};
        let contextSnippetId = null;

        const snippetButtonsEl = document.getElementById('snippet-buttons');
        const contextMenu = document.getElementById('context-menu');

        function renderButtons() {
            snippetButtonsEl.innerHTML = '';
            snippets.forEach(snippet => {
                const btn = document.createElement('button');
                btn.className = 'quick-btn';
                btn.type = 'button';
                btn.textContent = snippet.label;
                btn.dataset.id = snippet.id;
                btn.dataset.text = snippet.text;
                btn.addEventListener('click', () => {
                    vscode.postMessage({ command: 'insertText', text: snippet.text });
                });
                btn.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    contextSnippetId = snippet.id;
                    contextMenu.style.left = e.clientX + 'px';
                    contextMenu.style.top = e.clientY + 'px';
                    contextMenu.classList.add('visible');
                });
                snippetButtonsEl.appendChild(btn);
            });

            const addBtn = document.createElement('button');
            addBtn.className = 'quick-btn add-btn';
            addBtn.type = 'button';
            addBtn.textContent = '+';
            addBtn.title = addDialogTitle;
            addBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'openAddDialog' });
            });
            snippetButtonsEl.appendChild(addBtn);
        }

        function hideContextMenu() {
            contextMenu.classList.remove('visible');
            contextSnippetId = null;
        }

        contextMenu.querySelectorAll('.context-menu-item').forEach(item => {
            item.addEventListener('click', () => {
                const action = item.dataset.action;
                const snippet = snippets.find(s => s.id === contextSnippetId);
                hideContextMenu();
                if (!snippet) {
                    return;
                }
                if (action === 'edit') {
                    vscode.postMessage({ command: 'openEditDialog', id: snippet.id });
                } else if (action === 'delete') {
                    vscode.postMessage({ command: 'deleteSnippet', id: snippet.id });
                } else if (action === 'pin') {
                    vscode.postMessage({ command: 'pinSnippet', id: snippet.id });
                }
            });
        });

        document.addEventListener('click', () => hideContextMenu());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                hideContextMenu();
            }
        });

        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message.command === 'setSnippets') {
                snippets = message.snippets;
                renderButtons();
            }
        });

        renderButtons();
    </script>
</body>
</html>`;
    }
}
