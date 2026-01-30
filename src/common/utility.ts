"use strict";
import * as asciitable from "asciitable";
import * as fs from "fs";
import * as mysql from "mysql2";
import * as vscode from "vscode";
import { IConnection } from "../model/connection";
import { SqlResultWebView } from "../sqlResultWebView";
import { AppInsightsClient } from "./appInsightsClient";
import { Global } from "./global";
import { OutputChannel } from "./outputChannel";

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
                sql = activeTextEditor.document.getText();
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

        OutputChannel.appendLine("[Start] Executing MySQL query...");
        connection.query(sql, (err, rows) => {
            if (Array.isArray(rows)) {
                if (rows.some(((row) => Array.isArray(row)))) {
                    rows.forEach((row, index) => {
                        if (Array.isArray(row)) {
                             Utility.showQueryResult(row, "Results " + (index + 1), sql, totalRows, undefined, undefined, false, updateSQLEditor, appendSQLEditor);
                        } else {
                            OutputChannel.appendLine(JSON.stringify(row));
                        }
                    });
                } else {
                    Utility.showQueryResult(rows, "Results", sql, totalRows, undefined, undefined, false, updateSQLEditor, appendSQLEditor);
                }

            } else {
                OutputChannel.appendLine(JSON.stringify(rows));
            }

            if (err) {
                OutputChannel.appendLine(err);
                AppInsightsClient.sendEvent("runQuery.end", { Result: "Fail", ErrorMessage: err });
            } else {
                AppInsightsClient.sendEvent("runQuery.end", { Result: "Success" });
            }
            OutputChannel.appendLine("[Done] Finished MySQL query.");
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
            return { database: undefined, table: undefined };
        }

        // Get everything after FROM
        const afterFrom = trimmedSql.substring(fromIndex + 4).trim();

        // Remove leading quotes (backticks, single quotes, double quotes)
        let tableName = afterFrom.replace(/^[`'"`]*/, '');

        // Find the end of the table name (stop at space, comma, semicolon, parenthesis, or quote)
        const endMatch = tableName.match(/[\s,;)`'"`]/);
        if (endMatch) {
            tableName = tableName.substring(0, endMatch.index);
        }

        // Check if it contains a dot (database.table format)
        const dotIndex = tableName.indexOf('.');
        if (dotIndex !== -1) {
            const database = tableName.substring(0, dotIndex);
            const table = tableName.substring(dotIndex + 1);
            return { database, table };
        }

        return { database: undefined, table: tableName };
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
                sql = activeTextEditor.document.getText();
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

        OutputChannel.appendLine("[Start] Executing MySQL query...");
        connection.query(sql, (err, rows) => {
            if (Array.isArray(rows)) {
                if (rows.some(((row) => Array.isArray(row)))) {
                    rows.forEach((row, index) => {
                        if (Array.isArray(row)) {
                             Utility.showQueryResult(row, "Results " + (index + 1), sql, totalRows, parsedDatabase, parsedTable, updatePanel, true, appendSQLEditor);
                        } else {
                            OutputChannel.appendLine(JSON.stringify(row));
                        }
                    });
                } else {
                    Utility.showQueryResult(rows, "Results", sql, totalRows, parsedDatabase, parsedTable, updatePanel, true, appendSQLEditor);
                }

            } else {
                OutputChannel.appendLine(JSON.stringify(rows));
            }

            if (err) {
                OutputChannel.appendLine(err);
                AppInsightsClient.sendEvent("runQuery.end", { Result: "Fail", ErrorMessage: err });
            } else {
                AppInsightsClient.sendEvent("runQuery.end", { Result: "Success" });
            }
            OutputChannel.appendLine("[Done] Finished MySQL query.");
        });
        connection.end();
    }

    public static async createSQLTextDocument(sql: string = "", appendToExisting: boolean = true) {
        const activeEditor = vscode.window.activeTextEditor;

        // Check if there's an active SQL editor and we should append
        if (appendToExisting && activeEditor && activeEditor.document.languageId === 'sql') {
            // Append to existing SQL document
            await Utility.appendSQLToEditor(sql);
            return activeEditor;
        }

        // Create new SQL document (original behavior)
        // Add an empty line at the beginning for better editing experience
        const content = sql ? "\n" + sql : "\n";
        const textDocument = await vscode.workspace.openTextDocument({ content: content, language: "sql" });
        const editor = await vscode.window.showTextDocument(textDocument);
        // Move cursor to the first line (empty line)
        const position = new vscode.Position(0, 0);
        editor.selection = new vscode.Selection(position, position);
        return editor;
    }

    public static async appendSQLToEditor(sql: string) {
        const activeEditor = vscode.window.activeTextEditor;

        if (activeEditor && activeEditor.document.languageId === 'sql') {
            // Append to existing SQL document
            const editor = vscode.window.activeTextEditor;
            const document = editor.document;
            const lastLine = document.lineCount - 1;
            const lastLineLength = document.lineAt(lastLine).text.length;

            // Add two newlines (blank line separator) before the new SQL
            const insertPosition = new vscode.Position(lastLine, lastLineLength);
            const content = "\n\n" + sql;

            await editor.edit(editBuilder => {
                editBuilder.insert(insertPosition, content);
            });
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
