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
                    case "addSnippet":
                        await this.addSnippet(message.label, message.text);
                        break;
                    case "updateSnippet":
                        await this.updateSnippet(message.id, message.label, message.text);
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
        const i18nJson = JSON.stringify({
            dialogAddTitle: I18n.t("snippetsPanel.dialog.addTitle", "Add code snippet"),
            dialogEditTitle: I18n.t("snippetsPanel.dialog.editTitle", "Edit code snippet"),
            buttonAdd: I18n.t("snippetsPanel.button.add", "Add"),
            buttonSave: I18n.t("snippetsPanel.button.save", "Save"),
            errorEmptyDisplayName: I18n.t(
                "snippetsPanel.error.emptyDisplayName",
                "Display name cannot be empty"
            ),
            errorEmptyCodeSnippet: I18n.t(
                "snippetsPanel.error.emptyCodeSnippet",
                "Code snippet cannot be empty"
            ),
        });

        const labelDisplayName = this.escapeHtml(
            I18n.t("snippetsPanel.label.displayName", "Display name:")
        );
        const labelCodeSnippet = this.escapeHtml(
            I18n.t("snippetsPanel.label.codeSnippet", "Code snippet:")
        );
        const dialogAddTitle = this.escapeHtml(
            I18n.t("snippetsPanel.dialog.addTitle", "Add code snippet")
        );
        const menuEdit = this.escapeHtml(I18n.t("snippetsPanel.menu.edit", "Edit"));
        const menuDelete = this.escapeHtml(I18n.t("snippetsPanel.menu.delete", "Delete"));
        const menuPinToTop = this.escapeHtml(
            I18n.t("snippetsPanel.menu.pinToTop", "Pin to top")
        );
        const buttonAdd = this.escapeHtml(I18n.t("snippetsPanel.button.add", "Add"));
        const buttonSave = this.escapeHtml(I18n.t("snippetsPanel.button.save", "Save"));
        const buttonCancel = this.escapeHtml(I18n.t("button.cancel", "Cancel"));
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
        .dialog-overlay {
            pointer-events: auto;
            display: none;
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.45);
            align-items: center;
            justify-content: center;
            z-index: 100;
        }
        .dialog-overlay.visible {
            display: flex;
        }
        .dialog {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
            border-radius: 4px;
            padding: 12px;
            width: calc(100% - 24px);
            max-width: 320px;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
        }
        .dialog-title {
            font-weight: 600;
            margin-bottom: 10px;
            font-size: 13px;
        }
        .form-row {
            margin-bottom: 8px;
        }
        .form-row label {
            display: block;
            margin-bottom: 4px;
            font-size: 11px;
        }
        .form-row input,
        .form-row textarea {
            width: 100%;
            padding: 4px 6px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-font-family);
            font-size: 12px;
            border-radius: 2px;
        }
        .form-row textarea {
            min-height: 72px;
            resize: vertical;
        }
        .form-error {
            color: var(--vscode-errorForeground);
            font-size: 11px;
            margin-bottom: 6px;
            display: none;
        }
        .form-error.visible {
            display: block;
        }
        .dialog-actions {
            display: flex;
            justify-content: flex-end;
            gap: 6px;
            margin-top: 10px;
        }
        .dialog-actions button {
            padding: 4px 12px;
            border: 1px solid var(--vscode-button-border);
            border-radius: 2px;
            cursor: pointer;
            font-family: var(--vscode-font-family);
            font-size: 12px;
        }
        .dialog-actions .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .dialog-actions .btn-primary:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .dialog-actions .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .dialog-actions .btn-secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
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

    <div class="dialog-overlay" id="dialog-overlay">
        <div class="dialog" id="snippet-dialog">
            <div class="dialog-title" id="dialog-title">${dialogAddTitle}</div>
            <div class="form-error" id="form-error"></div>
            <div class="form-row">
                <label for="display-name">${labelDisplayName}</label>
                <input type="text" id="display-name" />
            </div>
            <div class="form-row">
                <label for="code-snippet">${labelCodeSnippet}</label>
                <textarea id="code-snippet"></textarea>
            </div>
            <div class="dialog-actions">
                <button type="button" class="btn-secondary" id="dialog-cancel">${buttonCancel}</button>
                <button type="button" class="btn-primary" id="dialog-confirm">${buttonAdd}</button>
            </div>
        </div>
    </div>

    <div class="context-menu" id="context-menu">
        <button type="button" class="context-menu-item" data-action="edit">${menuEdit}</button>
        <button type="button" class="context-menu-item" data-action="delete">${menuDelete}</button>
        <button type="button" class="context-menu-item" data-action="pin">${menuPinToTop}</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const i18n = ${i18nJson};

        let snippets = ${snippetsJson};
        let dialogMode = 'add';
        let editingId = null;
        let contextSnippetId = null;

        const snippetButtonsEl = document.getElementById('snippet-buttons');
        const dialogOverlay = document.getElementById('dialog-overlay');
        const dialogTitle = document.getElementById('dialog-title');
        const dialogConfirm = document.getElementById('dialog-confirm');
        const displayNameInput = document.getElementById('display-name');
        const codeSnippetInput = document.getElementById('code-snippet');
        const formError = document.getElementById('form-error');
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
            addBtn.title = i18n.dialogAddTitle;
            addBtn.addEventListener('click', () => openDialog('add'));
            snippetButtonsEl.appendChild(addBtn);
        }

        function openDialog(mode, snippet) {
            dialogMode = mode;
            editingId = snippet ? snippet.id : null;
            dialogTitle.textContent = mode === 'add' ? i18n.dialogAddTitle : i18n.dialogEditTitle;
            dialogConfirm.textContent = mode === 'add' ? i18n.buttonAdd : i18n.buttonSave;
            displayNameInput.value = snippet ? snippet.label : '';
            codeSnippetInput.value = snippet ? snippet.text : '';
            formError.classList.remove('visible');
            formError.textContent = '';
            dialogOverlay.classList.add('visible');
            displayNameInput.focus();
        }

        function closeDialog() {
            dialogOverlay.classList.remove('visible');
            editingId = null;
        }

        function hideContextMenu() {
            contextMenu.classList.remove('visible');
            contextSnippetId = null;
        }

        function validateForm() {
            const label = displayNameInput.value.trim();
            const text = codeSnippetInput.value;
            if (!label) {
                formError.textContent = i18n.errorEmptyDisplayName;
                formError.classList.add('visible');
                return null;
            }
            if (!text) {
                formError.textContent = i18n.errorEmptyCodeSnippet;
                formError.classList.add('visible');
                return null;
            }
            return { label, text };
        }

        document.getElementById('dialog-cancel').addEventListener('click', closeDialog);
        dialogOverlay.addEventListener('click', (e) => {
            if (e.target === dialogOverlay) {
                closeDialog();
            }
        });

        dialogConfirm.addEventListener('click', () => {
            const data = validateForm();
            if (!data) {
                return;
            }
            if (dialogMode === 'add') {
                vscode.postMessage({
                    command: 'addSnippet',
                    label: data.label,
                    text: data.text,
                });
            } else {
                vscode.postMessage({
                    command: 'updateSnippet',
                    id: editingId,
                    label: data.label,
                    text: data.text,
                });
            }
            closeDialog();
        });

        contextMenu.querySelectorAll('.context-menu-item').forEach(item => {
            item.addEventListener('click', () => {
                const action = item.dataset.action;
                const snippet = snippets.find(s => s.id === contextSnippetId);
                hideContextMenu();
                if (!snippet) {
                    return;
                }
                if (action === 'edit') {
                    openDialog('edit', snippet);
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
                if (dialogOverlay.classList.contains('visible')) {
                    closeDialog();
                } else {
                    hideContextMenu();
                }
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
