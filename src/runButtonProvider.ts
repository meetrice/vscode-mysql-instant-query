import * as vscode from "vscode";

export class RunNowCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    constructor() {
        // Refresh code lenses when document changes
        vscode.workspace.onDidChangeTextDocument(() => {
            this._onDidChangeCodeLenses.fire();
        });

        // Refresh code lenses when configuration changes
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('mysql-instant-query.enableRunNowCodeLens')) {
                this._onDidChangeCodeLenses.fire();
            }
        });
    }

    public provideCodeLenses(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        // Check if CodeLens is enabled in settings
        const config = vscode.workspace.getConfiguration('mysql-instant-query');
        const enabled = config.get<boolean>('enableRunNowCodeLens', true);

        if (!enabled || document.languageId !== 'sql') {
            return [];
        }

        const lenses: vscode.CodeLens[] = [];

        // Add a code lens at the beginning of the document
        if (document.lineCount > 0) {
            const firstLine = document.lineAt(0);
            const range = new vscode.Range(0, 0, 0, firstLine.text.length);

            lenses.push(
                new vscode.CodeLens(range, {
                    title: "▶ Run Now",
                    command: "mysqlInstantQuery.runQuery",
                    arguments: []
                })
            );
        }

        return lenses;
    }
}
