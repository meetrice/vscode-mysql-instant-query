"use strict";
import * as asciitable from "asciitable";
import * as fs from "fs";
import * as mysql from "mysql2";
import * as vscode from "vscode";
import { IConnection } from "../model/connection";
import { SqlResultWebView } from "../sqlResultWebView";
import { AppInsightsClient } from "./appInsightsClient";
import { Global } from "./global";
export class Utility {
    public static readonly maxTableCount = Utility.getConfiguration().get<number>("maxTableCount");

    public static getConfiguration(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration("mysql-instant-query");
    }

    public static queryPromise<T>(connection, sql: string): Promise<T> {
        return new Promise((resolve, reject) => {
            connection.query(sql, (err, rows) => {
                if (err) {
                    reject("Error: " + err.message);
                } else {
                    resolve(rows);
                }
            });
            connection.end();
        });
    }

    // Remove MySQL instructions: DELIMITER
    public static removeDelimiterInstructions(sql: string) {
        if (!sql.search(/delimiter/i)) {
            return sql;
        }
        const rc = new RegExp(/(?<!--\s+.*)(delimiter\s+(\S+))/gi);
        let currentDelimiter = ";";
        let nextPosition = 0;
        let result = "";
        let a;

        while (Boolean(a = rc.exec(sql))) {
            result += (currentDelimiter === ";")
                ? sql.slice(nextPosition, a.index)
                : sql.slice(nextPosition, a.index).replace(new RegExp(currentDelimiter, "g"), ";");
            nextPosition = a.index + a[1].length;
            currentDelimiter = a[2];
        }
        result += (currentDelimiter === ";")
            ? sql.slice(nextPosition)
            : sql.slice(nextPosition).replace(new RegExp(currentDelimiter, "g"), ";");
        return result;
    }

    public static async runQuery(sql?: string, connectionOptions?: IConnection, totalRows?: number, updateSQLEditor: boolean = true, appendSQLEditor: boolean = true) {
        AppInsightsClient.sendEvent("runQuery.start");
        if (!sql && !vscode.window.activeTextEditor) {
            vscode.window.showWarningMessage("No SQL file selected");
            AppInsightsClient.sendEvent("runQuery.noFile");
            return;
        }
        if (!connectionOptions && !Global.activeConnection) {
            const hasActiveConnection = await Utility.hasActiveConnection();
            if (!hasActiveConnection) {
                vscode.window.showWarningMessage("No MySQL Server or Database selected");
                AppInsightsClient.sendEvent("runQuery.noMySQL");
                return;
            }
        }

        if (!sql) {
            const activeTextEditor = vscode.window.activeTextEditor;
            const selection = activeTextEditor.selection;
            if (selection.isEmpty) {
                // No selection: get all text and find the first SQL statement
                const allText = activeTextEditor.document.getText();
                sql = Utility.getFirstSQLStatement(allText);
                if (!sql) {
                    // If no SQL statement found, use all text as fallback
                    sql = allText;
                }
            } else {
                sql = activeTextEditor.document.getText(selection);
            }
        }

        connectionOptions = connectionOptions ? connectionOptions : Global.activeConnection;
        connectionOptions.multipleStatements = true;
        const connection = Utility.createConnection(connectionOptions);

        if (this.getConfiguration().get<boolean>("enableDelimiterOperator")) {
            sql = this.removeDelimiterInstructions(sql);
        }

        // OutputChannel.appendLine("[Start] Executing MySQL query...");
        connection.query(sql, (err, rows) => {
            if (Array.isArray(rows)) {
                if (rows.some(((row) => Array.isArray(row)))) {
                    rows.forEach((row, index) => {
                        if (Array.isArray(row)) {
                             Utility.showQueryResult(row, "Results " + (index + 1), sql, totalRows, undefined, undefined, false, updateSQLEditor, appendSQLEditor);
                        } else {
                            // OutputChannel.appendLine(JSON.stringify(row));
                        }
                    });
                } else {
                    Utility.showQueryResult(rows, "Results", sql, totalRows, undefined, undefined, false, updateSQLEditor, appendSQLEditor);
                }

            } else {
                // OutputChannel.appendLine(JSON.stringify(rows));
            }

            if (err) {
                // OutputChannel.appendLine(err);
                AppInsightsClient.sendEvent("runQuery.end", { Result: "Fail", ErrorMessage: err });
            } else {
                AppInsightsClient.sendEvent("runQuery.end", { Result: "Success" });
            }
            // OutputChannel.appendLine("[Done] Finished MySQL query.");
        });
        connection.end();
    }

    // Parse table name from SQL query
    // The first word after FROM is treated as the table name (case-insensitive, ignoring quotes)
    private static parseTableFromSQL(sql: string): { database?: string, table?: string } {
        const trimmedSql = sql.trim();

        // Find FROM keyword (case-insensitive)
        const fromIndex = trimmedSql.toUpperCase().indexOf('FROM');
        if (fromIndex === -1) {
            console.log('[parseTableFromSQL] No FROM keyword found in SQL:', trimmedSql);
            return { database: undefined, table: undefined };
        }

        // Get everything after FROM
        const afterFrom = trimmedSql.substring(fromIndex + 4).trim();

        console.log('[parseTableFromSQL] SQL after FROM:', afterFrom);

        // Handle backtick-quoted identifiers: `database`.`table` or `database`.`table`
        // Match pattern: `database`.`table` or database.table or `database`.table or database.`table`
        let database: string | undefined = undefined;
        let table: string | undefined = undefined;

        // Try to match `database`.`table` pattern first
        const backtickDotBacktickPattern = /^`([^`]+)`\.`([^`]+)`/;
        const match1 = afterFrom.match(backtickDotBacktickPattern);
        if (match1) {
            database = match1[1];
            table = match1[2];
            console.log('[parseTableFromSQL] Matched `database`.`table` pattern:', { database, table });
            return { database, table };
        }

        // Try to match `database`.table pattern
        const backtickDotPattern = /^`([^`]+)`\.(\w+)/;
        const match2 = afterFrom.match(backtickDotPattern);
        if (match2) {
            database = match2[1];
            table = match2[2];
            console.log('[parseTableFromSQL] Matched `database`.table pattern:', { database, table });
            return { database, table };
        }

        // Try to match database.`table` pattern
        const dotBacktickPattern = /^(\w+)\.`([^`]+)`/;
        const match3 = afterFrom.match(dotBacktickPattern);
        if (match3) {
            database = match3[1];
            table = match3[2];
            console.log('[parseTableFromSQL] Matched database.`table` pattern:', { database, table });
            return { database, table };
        }

        // Try to match database.table pattern (without backticks)
        const dotPattern = /^(\w+)\.(\w+)/;
        const match4 = afterFrom.match(dotPattern);
        if (match4) {
            database = match4[1];
            table = match4[2];
            console.log('[parseTableFromSQL] Matched database.table pattern:', { database, table });
            return { database, table };
        }

        // Try to match `table` pattern (just table name with backticks)
        const backtickPattern = /^`([^`]+)`/;
        const match5 = afterFrom.match(backtickPattern);
        if (match5) {
            table = match5[1];
            console.log('[parseTableFromSQL] Matched `table` pattern:', { table });
            return { database: undefined, table };
        }

        // Fallback: just get the first word
        const words = afterFrom.split(/[\s,;)]/);
        if (words.length > 0) {
            table = words[0].replace(/[`'"`]/g, '');
            console.log('[parseTableFromSQL] Fallback pattern:', { table });
            return { database: undefined, table };
        }

        console.log('[parseTableFromSQL] No table name found');
        return { database: undefined, table: undefined };
    }

    // Get the first SQL statement from text that may contain multiple statements
    private static getFirstSQLStatement(text: string): string | null {
        // SQL keywords that start a statement
        const sqlKeywords = [
            'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP',
            'ALTER', 'TRUNCATE', 'REPLACE', 'CALL', 'EXPLAIN', 'SHOW',
            'DESC', 'DESCRIBE', 'USE', 'SET', 'BEGIN', 'COMMIT', 'ROLLBACK',
            'GRANT', 'REVOKE', 'LOCK', 'UNLOCK', 'START', 'WITH'
        ];

        const lines = text.split('\n');
        let statement: string[] = [];
        let inStatement = false;
        let parenCount = 0;
        let quoteChar: string | null = null;

        for (const line of lines) {
            const trimmedLine = line.trim();

            // Check if line starts a SQL statement
            const startsWithKeyword = sqlKeywords.some(keyword =>
                new RegExp(`^${keyword}\\s`, 'i').test(trimmedLine) ||
                new RegExp(`^${keyword}$`, 'i').test(trimmedLine)
            );

            if (startsWithKeyword && !inStatement) {
                // Start of a new statement
                inStatement = true;
                statement = [line];
                parenCount = 0;
                quoteChar = null;
            } else if (inStatement) {
                // Continue building the statement
                statement.push(line);

                // Track parentheses and quotes
                for (const char of line) {
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

                // Check if statement ends with semicolon
                if (trimmedLine.endsWith(';') && parenCount === 0 && !quoteChar) {
                    // End of statement
                    return statement.join('\n');
                }
            }
        }

        // If no complete statement found, return null
        return null;
    }

    public static async runQueryWithTotal(sql?: string, database?: string, table?: string, updatePanel: boolean = false, appendSQLEditor: boolean = false) {
        AppInsightsClient.sendEvent("runQuery.start");
        if (!sql && !vscode.window.activeTextEditor) {
            vscode.window.showWarningMessage("No SQL file selected");
            AppInsightsClient.sendEvent("runQuery.noFile");
            return;
        }
        if (!Global.activeConnection) {
            const hasActiveConnection = await Utility.hasActiveConnection();
            if (!hasActiveConnection) {
                vscode.window.showWarningMessage("No MySQL Server or Database selected");
                AppInsightsClient.sendEvent("runQuery.noMySQL");
                return;
            }
        }

        if (!sql) {
            const activeTextEditor = vscode.window.activeTextEditor;
            const selection = activeTextEditor.selection;
            if (selection.isEmpty) {
                // No selection: get all text and find the first SQL statement
                const allText = activeTextEditor.document.getText();
                sql = Utility.getFirstSQLStatement(allText);
                if (!sql) {
                    // If no SQL statement found, use all text as fallback
                    sql = allText;
                }
            } else {
                sql = activeTextEditor.document.getText(selection);
            }
        }

        const connectionOptions = Global.activeConnection;
        connectionOptions.multipleStatements = true;
        const connection = Utility.createConnection(connectionOptions);

        if (this.getConfiguration().get<boolean>("enableDelimiterOperator")) {
            sql = this.removeDelimiterInstructions(sql);
        }

        // Auto add LIMIT 100 if SQL is SELECT and doesn't have LIMIT
        const upperSql = sql.trim().toUpperCase();
        if (upperSql.startsWith('SELECT') && !upperSql.includes('LIMIT')) {
            sql = sql.trim() + ' LIMIT 100';
        }

        // Use provided database and table, or parse from SQL as fallback
        let parsedDatabase = database;
        let parsedTable = table;

        // Only parse from SQL if database/table were not provided
        if (!parsedDatabase || !parsedTable) {
            const parsed = Utility.parseTableFromSQL(sql);
            if (!parsedDatabase && parsed.database) {
                parsedDatabase = parsed.database;
            }
            if (!parsedTable && parsed.table) {
                parsedTable = parsed.table;
            }
            // If SQL contains only table name (no database), use the passed database as fallback
            if (parsedTable && !parsedDatabase && database) {
                parsedDatabase = database;
            }
        }

        // Get total row count if database and table are available
        let totalRows: number | undefined = undefined;
        if (parsedDatabase && parsedTable) {
            try {
                const countConnection = Utility.createConnection(connectionOptions);
                const countResult = await Utility.queryPromise<any[]>(countConnection, `SELECT COUNT(*) as total FROM \`${parsedDatabase}\`.\`${parsedTable}\`;`);
                totalRows = countResult && countResult[0] ? countResult[0].total : undefined;
            } catch (err) {
                // Ignore count query errors
            }
        }

        // OutputChannel.appendLine("[Start] Executing MySQL query...");
        connection.query(sql, (err, rows) => {
            if (Array.isArray(rows)) {
                if (rows.some(((row) => Array.isArray(row)))) {
                    rows.forEach((row, index) => {
                        if (Array.isArray(row)) {
                             Utility.showQueryResult(row, "Results " + (index + 1), sql, totalRows, parsedDatabase, parsedTable, updatePanel, true, appendSQLEditor);
                        } else {
                            // OutputChannel.appendLine(JSON.stringify(row));
                        }
                    });
                } else {
                    Utility.showQueryResult(rows, "Results", sql, totalRows, parsedDatabase, parsedTable, updatePanel, true, appendSQLEditor);
                }

            } else {
                // OutputChannel.appendLine(JSON.stringify(rows));
            }

            if (err) {
                // OutputChannel.appendLine(err);
                AppInsightsClient.sendEvent("runQuery.end", { Result: "Fail", ErrorMessage: err });
            } else {
                AppInsightsClient.sendEvent("runQuery.end", { Result: "Success" });
            }
            // OutputChannel.appendLine("[Done] Finished MySQL query.");
        });
        connection.end();
    }

    public static async createSQLTextDocument(sql: string = "", appendToExisting: boolean = true) {
        // Check if we should append to existing SQL editor
        if (appendToExisting) {
            // First, try to use the active editor if it's a SQL file
            let sqlEditor = vscode.window.activeTextEditor;
            if (sqlEditor && sqlEditor.document.languageId === 'sql') {
                await Utility.appendSQLToEditor(sql, sqlEditor);
                return sqlEditor;
            }

            // If active editor is not SQL, check all visible editors for a SQL file
            const visibleEditors = vscode.window.visibleTextEditors;
            for (const editor of visibleEditors) {
                if (editor.document.languageId === 'sql') {
                    await Utility.appendSQLToEditor(sql, editor);
                    return editor;
                }
            }

            // If no visible SQL editor, check all open text documents
            const sqlDocuments = vscode.workspace.textDocuments.filter(doc => doc.languageId === 'sql');
            if (sqlDocuments.length > 0) {
                // Open the first SQL document
                const doc = await vscode.workspace.openTextDocument(sqlDocuments[0].uri);
                const editor = await vscode.window.showTextDocument(doc, { preview: false });
                await Utility.appendSQLToEditor(sql, editor);
                return editor;
            }
        }

        // Create new SQL document (no existing SQL editor found)
        // Add an empty line at the beginning for better editing experience
        const content = sql ? "\n" + sql : "\n";
        const textDocument = await vscode.workspace.openTextDocument({ content: content, language: "sql" });
        const editor = await vscode.window.showTextDocument(textDocument);
        // Move cursor to the first line (empty line)
        const position = new vscode.Position(0, 0);
        editor.selection = new vscode.Selection(position, position);
        return editor;
    }

    public static async appendSQLToEditor(sql: string, targetEditor?: vscode.TextEditor) {
        // Use provided editor or fall back to active editor
        const editor = targetEditor || vscode.window.activeTextEditor;

        if (editor && editor.document.languageId === 'sql') {
            // Append to existing SQL document
            const document = editor.document;
            const lastLine = document.lineCount - 1;
            const lastLineLength = document.lineAt(lastLine).text.length;

            // Add two newlines (blank line separator) before the new SQL
            const insertPosition = new vscode.Position(lastLine, lastLineLength);
            const content = "\n\n" + sql;

            await editor.edit(editBuilder => {
                editBuilder.insert(insertPosition, content);
            });

            // Scroll to the newly added SQL
            // Calculate the new line count after insertion
            const newLineCount = document.lineCount;
            const targetLine = newLineCount - 1;

            // Move cursor to the end of the new content and reveal it in center of screen
            const endPosition = new vscode.Position(targetLine, document.lineAt(targetLine).text.length);
            editor.selection = new vscode.Selection(endPosition, endPosition);
            editor.revealRange(new vscode.Range(targetLine, 0, targetLine, 0), vscode.TextEditorRevealType.InCenter);
        } else {
            // Create new SQL document if no active SQL editor
            await Utility.createSQLTextDocument(sql);
        }
    }

    public static createConnection(connectionOptions: IConnection): any {
        const newConnectionOptions: any = Object.assign({}, connectionOptions);
        // Handle SSL certificate path if provided
        if (connectionOptions.certPath && fs.existsSync(connectionOptions.certPath)) {
            newConnectionOptions.ssl = {
                ca: fs.readFileSync(connectionOptions.certPath),
            };
        }
        // For MySQL 8.0+ and MySQL 9.0+ compatibility with caching_sha2_password:
        // Try with SSL first, but if the server doesn't support SSL, allow fallback
        // Set flags to allow secure connection even without proper SSL
        newConnectionOptions.flags = '+MYSQL_OPT_ALLOW_ENCRYPTED_CONNECTION';
        // Don't force SSL - let the server and client negotiate
        // This allows both SSL and non-SSL connections to work
        return mysql.createConnection(newConnectionOptions);
    }

    private static getPreviewUri(data) {
        const uri = vscode.Uri.parse("sqlresult://mysql/data");

        return uri.with({ query: data });
    }

    private static async showQueryResult(data, title: string, sql?: string, totalRows?: number, database?: string, table?: string, updatePanel: boolean = false, updateSQLEditor: boolean = true, appendSQLEditor: boolean = false) {
        console.log('[showQueryResult] Called with params:', { database, table, hasSQL: !!sql });

        // If database and table are not provided, try to parse from SQL
        if ((!database || !table) && sql) {
            console.log('[showQueryResult] Parsing table from SQL...');
            const parsed = Utility.parseTableFromSQL(sql);
            console.log('[showQueryResult] Parsed result:', parsed);

            if (!database && parsed.database) {
                database = parsed.database;
                console.log('[showQueryResult] Using parsed database:', database);
            }
            if (!database && Global.activeConnection && Global.activeConnection.database) {
                // Use active connection database as fallback
                database = Global.activeConnection.database;
                console.log('[showQueryResult] Using active connection database as fallback:', database);
            }
            if (!table && parsed.table) {
                table = parsed.table;
                console.log('[showQueryResult] Using parsed table:', table);
            }
        }

        console.log('[showQueryResult] Final database and table:', { database, table });

        // Get column comments if database and table are available
        let columnComments: { [key: string]: string } | undefined = undefined;
        if (database && table && data && data.length > 0) {
            try {
                // Get connection options from global active connection
                if (Global.activeConnection) {
                    const connectionOptions = {
                        host: Global.activeConnection.host,
                        user: Global.activeConnection.user,
                        password: Global.activeConnection.password,
                        port: Global.activeConnection.port,
                        database: database,
                        certPath: Global.activeConnection.certPath,
                    };

                    const connection = Utility.createConnection(connectionOptions);
                    const columns = await Utility.queryPromise<any[]>(connection,
                        `SELECT COLUMN_NAME, COLUMN_COMMENT
                         FROM information_schema.COLUMNS
                         WHERE TABLE_SCHEMA = '${database}' AND TABLE_NAME = '${table}';`);

                    if (columns && columns.length > 0) {
                        columnComments = {};
                        columns.forEach(col => {
                            if (col.COLUMN_COMMENT) {
                                columnComments[col.COLUMN_NAME] = col.COLUMN_COMMENT;
                            }
                        });
                    }
                }
            } catch (err) {
                // Ignore errors fetching column comments
                console.error('Error fetching column comments:', err);
            }
        }

        // vscode.commands.executeCommand(
        //     "vscode.previewHtml",
        //     Utility.getPreviewUri(JSON.stringify(data)),
        //     vscode.ViewColumn.Two,
        //     title).then(() => { }, (e) => {
        //         OutputChannel.appendLine(e);
        //     });
        if (updatePanel) {
            SqlResultWebView.updatePanel(data, sql, database, table, columnComments);
        } else {
            SqlResultWebView.show(data, title, sql, database, table, columnComments, updateSQLEditor, appendSQLEditor);
        }
    }

    private static async hasActiveConnection(): Promise<boolean> {
        let count = 5;
        while (!Global.activeConnection && count > 0) {
            await Utility.sleep(100);
            count--;
        }
        return !!Global.activeConnection;
    }

    private static sleep(ms) {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }
}
