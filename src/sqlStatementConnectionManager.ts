import * as vscode from "vscode";
import { Constants } from "./common/constants";
import { Global } from "./common/global";
import { IConnection, normalizeDriver, normalizeSslMode } from "./model/connection";

type StatementConnectionEntry = {
    sql: string;
    connection: IConnection;
};

export class SqlStatementConnectionManager {
    private static context: vscode.ExtensionContext;
    private static statementConnections = new Map<string, StatementConnectionEntry>();

    public static initialize(context: vscode.ExtensionContext) {
        SqlStatementConnectionManager.context = context;
    }

    public static registerStatement(document: vscode.TextDocument, range: vscode.Range, sql: string, connection?: IConnection) {
        const selectedConnection = connection || Global.activeConnection;
        if (!selectedConnection) {
            return;
        }
        SqlStatementConnectionManager.statementConnections.set(
            SqlStatementConnectionManager.getKey(document.uri, range, sql),
            { sql, connection: { ...selectedConnection } },
        );
    }

    public static getStatementConnection(document: vscode.TextDocument, range: vscode.Range, sql: string): IConnection | undefined {
        const exact = SqlStatementConnectionManager.statementConnections.get(SqlStatementConnectionManager.getKey(document.uri, range, sql));
        if (exact) {
            return exact.connection;
        }

        const normalizedSql = SqlStatementConnectionManager.normalizeSql(sql);
        const uri = document.uri.toString();
        for (const [key, entry] of SqlStatementConnectionManager.statementConnections.entries()) {
            if (key.startsWith(`${uri}|`) && SqlStatementConnectionManager.normalizeSql(entry.sql) === normalizedSql) {
                return entry.connection;
            }
        }

        return Global.activeConnection;
    }

    public static async pickStatementConnection(documentUri: vscode.Uri, rangeData: number[], sql: string) {
        if (!SqlStatementConnectionManager.context) {
            return;
        }

        const connections = await SqlStatementConnectionManager.getAvailableConnections();
        if (connections.length === 0) {
            vscode.window.showWarningMessage("No database connections available");
            return;
        }

        const current = SqlStatementConnectionManager.getStoredConnection(documentUri, rangeData, sql) || Global.activeConnection;
        const currentKey = current ? SqlStatementConnectionManager.getConnectionKey(current) : undefined;
        const selected = await vscode.window.showQuickPick(
            connections.map((connection) => ({
                label: SqlStatementConnectionManager.getConnectionLabel(connection),
                description: connection.driver || "mysql",
                connection,
                picked: SqlStatementConnectionManager.getConnectionKey(connection) === currentKey,
            })),
            {
                placeHolder: "Select database connection for this SQL statement",
                matchOnDescription: true,
                ignoreFocusOut: true,
            },
        );

        if (!selected) {
            return;
        }

        const range = SqlStatementConnectionManager.rangeFromData(rangeData);
        SqlStatementConnectionManager.statementConnections.set(
            SqlStatementConnectionManager.getKey(documentUri, range, sql),
            { sql, connection: { ...selected.connection } },
        );
        Global.activeConnection = { ...selected.connection };
        vscode.commands.executeCommand("vscode.executeCodeLensProvider", documentUri);
    }

    public static getConnectionLabel(connection?: IConnection): string {
        if (!connection) {
            return "No connection";
        }
        const name = connection.displayName || connection.host || connection.filePath || "Database";
        return connection.database ? `${name} / ${connection.database}` : name;
    }

    private static getStoredConnection(documentUri: vscode.Uri, rangeData: number[], sql: string): IConnection | undefined {
        const range = SqlStatementConnectionManager.rangeFromData(rangeData);
        const exact = SqlStatementConnectionManager.statementConnections.get(SqlStatementConnectionManager.getKey(documentUri, range, sql));
        if (exact) {
            return exact.connection;
        }
        return undefined;
    }

    private static async getAvailableConnections(): Promise<IConnection[]> {
        const stored = SqlStatementConnectionManager.context.globalState.get<{ [key: string]: IConnection }>(Constants.GlobalStateMySQLConectionsKey);
        if (!stored) {
            return Global.activeConnection ? [{ ...Global.activeConnection }] : [];
        }

        const available: IConnection[] = [];
        for (const id of Object.keys(stored)) {
            const conn = stored[id];
            const password = await Global.secrets.get(id);
            const driver = normalizeDriver(conn.driver);
            const baseConnection: IConnection = {
                driver,
                host: conn.host,
                user: conn.user,
                password,
                port: conn.port,
                certPath: conn.certPath,
                filePath: conn.filePath,
                database: conn.database,
                displayName: conn.displayName,
                sslMode: driver === "postgresql" ? normalizeSslMode(conn.sslMode) : undefined,
            };

            try {
                const { DbDriver } = await import("./common/dbDriver");
                const databases = await DbDriver.listDatabases(baseConnection);
                if (databases.length > 0) {
                    databases.forEach((database) => available.push({ ...baseConnection, database }));
                    continue;
                }
            } catch {
                // Keep the stored connection available even when database listing fails.
            }
            available.push(baseConnection);
        }

        return available;
    }

    private static getKey(documentUri: vscode.Uri, range: vscode.Range, sql: string): string {
        return `${documentUri.toString()}|${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}|${SqlStatementConnectionManager.normalizeSql(sql)}`;
    }

    private static rangeFromData(rangeData: number[]): vscode.Range {
        return new vscode.Range(rangeData[0], rangeData[1], rangeData[2], rangeData[3]);
    }

    private static normalizeSql(sql: string): string {
        return sql.replace(/\s+/g, " ").trim();
    }

    private static getConnectionKey(connection: IConnection): string {
        return [connection.driver || "mysql", connection.host, connection.port, connection.user, connection.filePath || "", connection.database || ""].join("|");
    }
}
