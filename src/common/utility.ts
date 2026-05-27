"use strict";
import * as asciitable from "asciitable";
import * as fs from "fs";
import * as vscode from "vscode";
import LRU = require("lru-cache");
import { IConnection } from "../model/connection";
import { SqlResultWebView } from "../sqlResultWebView";
import { SqlStatementConnectionManager } from "../sqlStatementConnectionManager";
import { AppInsightsClient } from "./appInsightsClient";
import { DbDriver } from "./dbDriver";
import { Global } from "./global";
import { OutputChannel } from "./outputChannel";

export class Utility {
    public static readonly maxTableCount = Utility.getConfiguration().get<number>("maxTableCount");
    public static customDataLimit: number | undefined = undefined;

    private static columnMetadataCache = new LRU<string, { comments: { [key: string]: string }; types: { [key: string]: string } }>({
        max: 100,
        maxAge: 1000 * 60 * 30,
    });

    public static getConfiguration(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration("mysql-instant-query");
    }

    public static queryPromise<T>(connectionOptions: IConnection, sql: string): Promise<T> {
        return DbDriver.queryPromise<T>(connectionOptions, sql);
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

        if (this.getConfiguration().get<boolean>("enableDelimiterOperator")) {
            sql = this.removeDelimiterInstructions(sql);
        }

        // Parse database and table from SQL
        let parsedDatabase: string | undefined;
        let parsedTable: string | undefined;
        const parsed = Utility.parseTableFromSQL(sql);
        if (parsed.database) {
            parsedDatabase = parsed.database;
        }
        if (parsed.table) {
            parsedTable = parsed.table;
        }
        // Use active connection database as fallback
        if (!parsedDatabase && connectionOptions && connectionOptions.database) {
            parsedDatabase = connectionOptions.database;
        }

        const totalRowCount = await Utility.maybeFetchTotalRowCount(connectionOptions, parsedDatabase, parsedTable);
        sql = Utility.applyAutoLimit(sql, totalRowCount);

        OutputChannel.show();
        OutputChannel.appendLine("[Start] Executing database query...");
        try {
            const rows = await DbDriver.executeQuery(connectionOptions, sql);
            if (Array.isArray(rows)) {
                if (rows.some(((row) => Array.isArray(row)))) {
                    rows.forEach((row, index) => {
                        if (Array.isArray(row)) {
                             Utility.showQueryResult(row, "Results " + (index + 1), sql, totalRowCount !== undefined ? totalRowCount : totalRows, parsedDatabase, parsedTable, false, updateSQLEditor, appendSQLEditor);
                        } else {
                            OutputChannel.show();
                            OutputChannel.appendLine(JSON.stringify(row));
                        }
                    });
                } else {
                    Utility.showQueryResult(rows, "Results", sql, totalRowCount !== undefined ? totalRowCount : totalRows, parsedDatabase, parsedTable, false, updateSQLEditor, appendSQLEditor);
                }
            } else {
                OutputChannel.show();
                OutputChannel.appendLine(JSON.stringify(rows));
            }
            AppInsightsClient.sendEvent("runQuery.end", { Result: "Success" });
        } catch (err) {
            OutputChannel.show();
            OutputChannel.appendLine(String(err));
            AppInsightsClient.sendEvent("runQuery.end", { Result: "Fail", ErrorMessage: String(err) });
        }
        OutputChannel.show();
        OutputChannel.appendLine("[Done] Finished database query.");
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
        if (connectionOptions.driver === "duckdb") {
            console.log("[DuckDB runQueryWithTotal] start", {
                inputSql: sql,
                database,
                table,
                updatePanel,
                appendSQLEditor,
                connectionOptions: {
                    driver: connectionOptions.driver,
                    host: connectionOptions.host,
                    filePath: connectionOptions.filePath,
                    database: connectionOptions.database,
                },
            });
        }

        if (this.getConfiguration().get<boolean>("enableDelimiterOperator")) {
            sql = this.removeDelimiterInstructions(sql);
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

        const totalRows = await Utility.maybeFetchTotalRowCount(connectionOptions, parsedDatabase, parsedTable);
        sql = Utility.applyAutoLimit(sql, totalRows);
        if (connectionOptions.driver === "duckdb") {
            console.log("[DuckDB runQueryWithTotal] before execute", {
                parsedDatabase,
                parsedTable,
                totalRows,
                finalSql: sql,
            });
        }

        OutputChannel.show();
        OutputChannel.appendLine("[Start] Executing database query...");
        try {
            const rows = await DbDriver.executeQuery(connectionOptions, sql);
            if (connectionOptions.driver === "duckdb") {
                console.log("[DuckDB runQueryWithTotal] execute success", {
                    isArray: Array.isArray(rows),
                    rowCount: Array.isArray(rows) ? rows.length : undefined,
                    rowsPreview: Array.isArray(rows) ? rows.slice(0, 3) : rows,
                });
            }
            if (Array.isArray(rows)) {
                if (rows.some(((row) => Array.isArray(row)))) {
                    rows.forEach((row, index) => {
                        if (Array.isArray(row)) {
                             Utility.showQueryResult(row, "Results " + (index + 1), sql, totalRows, parsedDatabase, parsedTable, updatePanel, true, appendSQLEditor);
                        } else {
                            OutputChannel.show();
                            OutputChannel.appendLine(JSON.stringify(row));
                        }
                    });
                } else {
                    Utility.showQueryResult(rows, "Results", sql, totalRows, parsedDatabase, parsedTable, updatePanel, true, appendSQLEditor);
                }
            } else {
                OutputChannel.show();
                OutputChannel.appendLine(JSON.stringify(rows));
            }
            AppInsightsClient.sendEvent("runQuery.end", { Result: "Success" });
        } catch (err) {
            if (connectionOptions.driver === "duckdb") {
                console.error("[DuckDB runQueryWithTotal] execute failed", err);
            }
            OutputChannel.show();
            OutputChannel.appendLine(String(err));
            AppInsightsClient.sendEvent("runQuery.end", { Result: "Fail", ErrorMessage: String(err) });
        }
        OutputChannel.show();
        OutputChannel.appendLine("[Done] Finished database query.");
    }

    private static isUntitledSqlEditor(editor: vscode.TextEditor | undefined): editor is vscode.TextEditor {
        return !!editor
            && editor.document.languageId === "sql"
            && editor.document.uri.scheme === "untitled";
    }

    public static async createSQLTextDocument(sql: string = "", appendToExisting: boolean = true) {
        // Only append to an active untitled SQL editor; never open existing project SQL files
        if (appendToExisting) {
            const sqlEditor = vscode.window.activeTextEditor;
            if (Utility.isUntitledSqlEditor(sqlEditor)) {
                await Utility.appendSQLToEditor(sql, sqlEditor);
                return sqlEditor;
            }
        }

        // Create new SQL document (no existing SQL editor found)
        // Add an empty line at the beginning for better editing experience
        const content = sql ? "\n" + sql : "\n";
        const textDocument = await vscode.workspace.openTextDocument({ content: content, language: "sql" });
        const editor = await vscode.window.showTextDocument(textDocument);
        if (sql) {
            const lines = sql.split('\n');
            const start = new vscode.Position(1, 0);
            const end = new vscode.Position(1 + lines.length - 1, lines[lines.length - 1].length);
            SqlStatementConnectionManager.registerStatement(textDocument, new vscode.Range(start, end), sql);
        }
        // Move cursor to the first line (empty line)
        const position = new vscode.Position(0, 0);
        editor.selection = new vscode.Selection(position, position);
        return editor;
    }

    public static async appendSQLToEditor(sql: string, targetEditor?: vscode.TextEditor) {
        const editor = targetEditor || vscode.window.activeTextEditor;

        if (Utility.isUntitledSqlEditor(editor)) {
            // Append to existing SQL document
            const document = editor.document;
            const lastLine = document.lineCount - 1;
            const lastLineLength = document.lineAt(lastLine).text.length;

            // Add two newlines (blank line separator) before the new SQL
            const insertPosition = new vscode.Position(lastLine, lastLineLength);
            const content = "\n\n" + sql;
            const sqlLines = sql.split('\n');
            const startLine = lastLine + 2;
            const start = new vscode.Position(startLine, 0);
            const end = new vscode.Position(startLine + sqlLines.length - 1, sqlLines[sqlLines.length - 1].length);

            await editor.edit(editBuilder => {
                editBuilder.insert(insertPosition, content);
            });
            SqlStatementConnectionManager.registerStatement(document, new vscode.Range(start, end), sql);

            // Scroll to the newly added SQL
            // Calculate the new line count after insertion
            const newLineCount = document.lineCount;
            const targetLine = newLineCount - 1;

            // Move cursor to the end of the new content and reveal it in center of screen
            const endPosition = new vscode.Position(targetLine, document.lineAt(targetLine).text.length);
            editor.selection = new vscode.Selection(endPosition, endPosition);
            editor.revealRange(new vscode.Range(targetLine, 0, targetLine, 0), vscode.TextEditorRevealType.InCenter);
        } else {
            await Utility.createSQLTextDocument(sql, false);
        }
    }

    public static createConnection(connectionOptions: IConnection): any {
        return DbDriver.createConnection(connectionOptions);
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

        let columnComments: { [key: string]: string } | undefined;
        let columnTypes: { [key: string]: string } | undefined;
        if (database && table && data && data.length > 0) {
            try {
                const metadata = await Utility.fetchColumnMetadata(database, table);
                if (metadata) {
                    columnComments = metadata.comments;
                    columnTypes = metadata.types;
                }
            } catch (err) {
                console.error("Error fetching column metadata:", err);
            }
        }

        if (updatePanel) {
            SqlResultWebView.updatePanel(data, sql, database, table, columnComments, totalRows, columnTypes);
        } else {
            SqlResultWebView.show(data, title, sql, database, table, columnComments, columnTypes, updateSQLEditor, appendSQLEditor, totalRows);
        }
    }

    public static async fetchColumnMetadata(
        database: string,
        table: string,
    ): Promise<{ comments: { [key: string]: string }; types: { [key: string]: string } } | undefined> {
        const cacheKey = `${database}.${table}`;
        const cached = Utility.columnMetadataCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        if (!Global.activeConnection) {
            return undefined;
        }

        const connectionOptions = {
            host: Global.activeConnection.host,
            user: Global.activeConnection.user,
            password: Global.activeConnection.password,
            port: Global.activeConnection.port,
            certPath: Global.activeConnection.certPath,
            driver: Global.activeConnection.driver,
            filePath: Global.activeConnection.filePath,
            database,
        };

        const columns = await DbDriver.listColumns(connectionOptions, database, table);

        if (!columns || columns.length === 0) {
            return undefined;
        }

        const comments: { [key: string]: string } = {};
        const types: { [key: string]: string } = {};
        columns.forEach((col) => {
            if (col.COLUMN_COMMENT) {
                comments[col.COLUMN_NAME] = col.COLUMN_COMMENT;
            }
            if (col.COLUMN_TYPE) {
                types[col.COLUMN_NAME] = col.COLUMN_TYPE;
            }
        });

        const metadata = { comments, types };
        Utility.columnMetadataCache.set(cacheKey, metadata);
        return metadata;
    }

    private static async maybeFetchTotalRowCount(
        connectionOptions: IConnection,
        database?: string,
        table?: string,
    ): Promise<number | undefined> {
        const enableCountQuery = Utility.getConfiguration().get<boolean>("enableCountQuery", false);
        if (!enableCountQuery || !database || !table) {
            return undefined;
        }

        try {
            const countResult = await Utility.queryPromise<any[]>(
                connectionOptions,
                `SELECT COUNT(*) as total FROM \`${database}\`.\`${table}\`;`,
            );
            return countResult && countResult[0] ? countResult[0].total : undefined;
        } catch (err) {
            return undefined;
        }
    }

    private static applyAutoLimit(sql: string, totalRowCount?: number): string {
        const upperSql = sql.trim().toUpperCase();
        if (!upperSql.startsWith("SELECT") || upperSql.includes("LIMIT")) {
            return sql;
        }

        const config = Utility.getConfiguration();
        const defaultLimit = config.get<number>("defaultQueryLimit", 100);
        const largeLimit = Utility.customDataLimit || config.get<number>("largeTableQueryLimit", 5000);
        const largeThreshold = config.get<number>("largeTableThreshold", 1000);
        const enableCountQuery = config.get<boolean>("enableCountQuery", false);

        let limit: number;
        if (enableCountQuery && totalRowCount !== undefined && totalRowCount > largeThreshold) {
            limit = largeLimit;
        } else if (enableCountQuery && totalRowCount !== undefined) {
            limit = defaultLimit;
        } else {
            limit = largeLimit;
        }

        return sql.trim().replace(/;\s*$/, "") + ` LIMIT ${limit}`;
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
