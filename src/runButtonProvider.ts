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
        const text = document.getText();

        // Find all SQL statements
        const sqlStatements = this.findSQLStatements(text, document);

        // Add code lens for each SQL statement
        for (const statement of sqlStatements) {
            lenses.push(
                new vscode.CodeLens(statement.range, {
                    title: "▶ Run Now",
                    command: "mysqlInstantQuery.runQuery",
                    arguments: [statement.sql, false] // false = don't update SQL editor
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
        let currentStatement: string[] = [];
        let statementStartLine = 0;
        let statementStartChar = 0;
        let inStatement = false;
        let parenCount = 0; // Track parentheses for multi-line statements
        let quoteChar: string | null = null; // Track quotes
        let lastCharWasEscape = false; // Track escape characters

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmedLine = line.trim();

            // Check if line starts a SQL statement
            const startsWithKeyword = sqlKeywords.some(keyword =>
                new RegExp(`^${keyword}\\s`, 'i').test(trimmedLine) ||
                new RegExp(`^${keyword}$`, 'i').test(trimmedLine)
            );

            if (startsWithKeyword) {
                // If we're already in a statement, check if it's complete
                if (inStatement) {
                    // Save the previous statement if it has content
                    if (currentStatement.length > 0) {
                        const sql = currentStatement.join('\n');
                        const startPos = new vscode.Position(statementStartLine, statementStartChar);
                        const endPos = new vscode.Position(i - 1, lines[i - 1].length);
                        const range = new vscode.Range(startPos, endPos);
                        statements.push({ range, sql });
                    }
                }

                // Start a new statement
                inStatement = true;
                statementStartLine = i;
                statementStartChar = line.indexOf(trimmedLine[0]);
                currentStatement = [line];
                parenCount = 0;
                quoteChar = null;
                lastCharWasEscape = false;

                // Track parentheses and quotes for this line
                for (const char of line) {
                    if (lastCharWasEscape) {
                        lastCharWasEscape = false;
                        continue;
                    }
                    if (char === '\\') {
                        lastCharWasEscape = true;
                        continue;
                    }
                    if (quoteChar) {
                        if (char === quoteChar) {
                            quoteChar = null;
                        }
                    } else if (char === '\'' || char === '"' || char === '`') {
                        quoteChar = char;
                    } else if (char === '(') {
                        parenCount++;
                    } else if (char === ')') {
                        parenCount = Math.max(0, parenCount - 1);
                    }
                }
            } else if (inStatement) {
                // Continue building the statement
                currentStatement.push(line);

                // Track parentheses and quotes
                for (const char of line) {
                    if (lastCharWasEscape) {
                        lastCharWasEscape = false;
                        continue;
                    }
                    if (char === '\\') {
                        lastCharWasEscape = true;
                        continue;
                    }
                    if (quoteChar) {
                        if (char === quoteChar) {
                            quoteChar = null;
                        }
                    } else if (char === '\'' || char === '"' || char === '`') {
                        quoteChar = char;
                    } else if (char === '(') {
                        parenCount++;
                    } else if (char === ')') {
                        parenCount = Math.max(0, parenCount - 1);
                    }
                }

                // Check if statement ends with semicolon (and not in parentheses or quotes)
                const trimmedEnd = trimmedLine.endsWith(';');
                if (trimmedEnd && parenCount === 0 && !quoteChar) {
                    // End of statement
                    const sql = currentStatement.join('\n');
                    const startPos = new vscode.Position(statementStartLine, statementStartChar);
                    const endPos = new vscode.Position(i, line.length);
                    const range = new vscode.Range(startPos, endPos);

                    statements.push({ range, sql });

                    // Reset for next statement
                    currentStatement = [];
                    inStatement = false;
                    parenCount = 0;
                    quoteChar = null;
                    lastCharWasEscape = false;
                }
            }
        }

        // Handle last statement if it doesn't end with semicolon
        if (inStatement && currentStatement.length > 0) {
            const sql = currentStatement.join('\n');
            const startPos = new vscode.Position(statementStartLine, statementStartChar);
            const endPos = new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
            const range = new vscode.Range(startPos, endPos);

            statements.push({ range, sql });
        }

        return statements;
    }
}
