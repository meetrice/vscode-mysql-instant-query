import * as vscode from "vscode";

export class CodeSnippetsPanel {
    public static initialize(context: vscode.ExtensionContext) {
        const provider = new CodeSnippetsViewProvider();
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('mysqlInstantQuerySnippets', provider)
        );
    }
}

class CodeSnippetsViewProvider implements vscode.WebviewViewProvider {
    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: []
        };

        webviewView.webview.html = this.getWebviewContent();

        webviewView.webview.onDidReceiveMessage(
            message => {
                if (message.command === 'insertText') {
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
                }
            },
            null,
        );
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
        body {
            padding: 0;
            font-family: var(--vscode-font-family);
            font-size: 12px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background);
            line-height: 1;
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

    <script>
        const vscode = acquireVsCodeApi();

        document.querySelectorAll('.quick-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                vscode.postMessage({
                    command: 'insertText',
                    text: btn.getAttribute('data-text')
                });
            });
        });
    </script>
</body>
</html>`;
    }
}
