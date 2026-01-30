import * as vscode from "vscode";

export class RunButtonDecoration {
    private static panel: vscode.WebviewPanel | undefined;
    private static currentEditor: vscode.TextEditor | undefined;

    public static show(editor: vscode.TextEditor) {
        this.currentEditor = editor;

        // If panel already exists, just focus it
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        // Create webview panel for the run button
        this.panel = vscode.window.createWebviewPanel(
            'sqlRunButton',
            'SQL Run Button',
            {
                viewColumn: editor.viewColumn,
                preserveFocus: true
            },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                enableCommandUris: true,
                localResourceRoots: []
            }
        );

        // Set webview content
        this.panel.webview.html = this.getWebviewContent();

        // Handle panel close
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.currentEditor = undefined;
        });

        // Handle messages from webview
        this.panel.webview.onDidReceiveMessage(
            message => {
                if (message.command === 'runSQL') {
                    vscode.commands.executeCommand("mysqlInstantQuery.runQuery");
                }
            }
        );
    }

    public static hide() {
        if (this.panel) {
            this.panel.dispose();
            this.panel = undefined;
        }
    }

    private static getWebviewContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SQL Run Button</title>
    <style>
        body {
            padding: 0;
            margin: 0;
            background-color: var(--vscode-editor-background);
            display: flex;
            justify-content: flex-start;
            align-items: center;
            height: 40px;
        }
        .run-button {
            background-color: #ffffff;
            color: #d32f2f;
            border: 2px solid #d32f2f;
            border-radius: 4px;
            padding: 6px 16px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            transition: all 0.2s;
            white-space: nowrap;
        }
        .run-button:hover {
            background-color: #d32f2f;
            color: #ffffff;
        }
        .run-button:active {
            transform: scale(0.98);
        }
        .run-button .icon {
            font-size: 14px;
        }
        @media (prefers-color-scheme: dark) {
            .run-button {
                background-color: #1e1e1e;
                color: #ff6b6b;
                border-color: #ff6b6b;
            }
            .run-button:hover {
                background-color: #ff6b6b;
                color: #1e1e1e;
            }
        }
    </style>
</head>
<body>
    <button class="run-button" id="runBtn">
        <span class="icon">▶</span>
        <span>Run Now</span>
    </button>
    <script>
        const vscode = acquireVsCodeApi();
        document.getElementById('runBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'runSQL' });
        });
    </script>
</body>
</html>`;
    }
}
