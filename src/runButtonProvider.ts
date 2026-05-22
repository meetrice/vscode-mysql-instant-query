import * as vscode from "vscode";
import { SqlStatementConnectionManager } from "./sqlStatementConnectionManager";

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

    public refresh() {
        this._onDidChangeCodeLenses.fire();
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
        const text = document.getText();

        // Find all SQL statements
        const sqlStatements = this.findSQLStatements(text, document);

        // Add code lens for each SQL statement
        for (const statement of sqlStatements) {
            const connection = SqlStatementConnectionManager.getStatementConnection(document, statement.range, statement.sql);
            const rangeData = [
                statement.range.start.line,
                statement.range.start.character,
                statement.range.end.line,
                statement.range.end.character,
            ];
            lenses.push(
                new vscode.CodeLens(statement.range, {
                    title: "▶ execute sql",
                    command: "mysqlInstantQuery.runQuery",
                    arguments: [statement.sql, false, connection] // false = don't update SQL editor
                })
            );
            lenses.push(
                new vscode.CodeLens(statement.range, {
                    title: `${SqlStatementConnectionManager.getConnectionLabel(connection)} ▼`,
                    command: "mysqlInstantQuery.selectStatementConnection",
                    arguments: [document.uri, rangeData, statement.sql]
                })
            );
        }

        return lenses;
    }

    private findSQLStatements(text: string, document: vscode.TextDocument): Array<{ range: vscode.Range; sql: string }> {
        const statements: Array<{ range: vscode.Range; sql: string }> = [];

        // SQL keywords that start a statement
        const sqlKeywords = [
            'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP',
            'ALTER', 'TRUNCATE', 'REPLACE', 'CALL', 'EXPLAIN', 'SHOW',
            'DESC', 'DESCRIBE', 'USE', 'SET', 'BEGIN', 'COMMIT', 'ROLLBACK',
            'GRANT', 'REVOKE', 'LOCK', 'UNLOCK', 'START', 'WITH'
        ];

        const lines = text.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmedLine = line.trim();

            // Check if line starts a SQL statement
            const startsWithKeyword = sqlKeywords.some(keyword =>
                new RegExp(`^${keyword}\\s`, 'i').test(trimmedLine) ||
                new RegExp(`^${keyword}$`, 'i').test(trimmedLine)
            );

            if (startsWithKeyword) {
                // Find SQL statement: from this line to the next semicolon
                const startLine = i;
                const startChar = line.indexOf(trimmedLine[0]);
                let endLine = i;
                let endChar = line.length;
                let foundSemicolon = false;

                // Track state for finding semicolon
                let parenCount = 0;
                let quoteChar: string | null = null;
                let lastCharWasEscape = false;

                // Search from current line onward
                for (let j = i; j < lines.length; j++) {
                    const searchLine = lines[j];

                    for (let k = 0; k < searchLine.length; k++) {
                        const char = searchLine[k];

                        // Handle escape characters
                        if (lastCharWasEscape) {
                            lastCharWasEscape = false;
                            continue;
                        }
                        if (char === '\\') {
                            lastCharWasEscape = true;
                            continue;
                        }

                        // Handle quotes
                        if (quoteChar) {
                            if (char === quoteChar) {
                                quoteChar = null;
                            }
                        } else if (char === '\'' || char === '"' || char === '`') {
                            quoteChar = char;
                        }

                        // Handle parentheses
                        else if (char === '(') {
                            parenCount++;
                        } else if (char === ')') {
                            parenCount = Math.max(0, parenCount - 1);
                        }

                        // Check for semicolon (only when not in quotes or parentheses)
                        else if (char === ';' && parenCount === 0 && !quoteChar) {
                            endLine = j;
                            endChar = k;
                            foundSemicolon = true;
                            break;
                        }
                    }

                    if (foundSemicolon) {
                        break;
                    }
                }

                // Extract SQL from start to semicolon (inclusive)
                const startPos = new vscode.Position(startLine, startChar);
                const endPos = new vscode.Position(endLine, endChar + 1); // Include semicolon

                // Use document.getText to get exact text from document
                const range = new vscode.Range(startPos, endPos);
                const sql = document.getText(range);

                console.log(`[RunButtonProvider] Found SQL at line ${i}:`);
                console.log(`  Start: line ${startLine}, char ${startChar}`);
                console.log(`  End: line ${endLine}, char ${endChar}`);
                console.log(`  SQL:`, sql);
                console.log(`  SQL length: ${sql.length}`);

                if (sql && sql.trim()) {
                    statements.push({ range, sql });
                }
            }
        }

        return statements;
    }
}
