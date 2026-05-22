import * as path from "path";
import * as vscode from "vscode";
import { AppInsightsClient } from "../common/appInsightsClient";
import { Constants } from "../common/constants";
import { DbDriver } from "../common/dbDriver";
import { Global } from "../common/global";
import { Utility } from "../common/utility";
import { MySQLTreeDataProvider } from "../mysqlTreeDataProvider";
import { DatabaseDriver, IConnection, SslMode } from "./connection";
import { DatabaseNode } from "./databaseNode";
import { InfoNode } from "./infoNode";
import { INode } from "./INode";

const DRIVER_ICONS: Record<DatabaseDriver, string> = {
    mysql: "database-mysql.svg",
    postgresql: "database-pgsql.svg",
    sqlite: "database-sqlite.svg",
    duckdb: "database-duckdb.svg",
};

export class ConnectionNode implements INode {
    constructor(
        private readonly id: string,
        private readonly host: string,
        private readonly user: string,
        private readonly password: string,
        private readonly port: string,
        private readonly certPath: string,
        private readonly displayName: string,
        private readonly treeDataProvider?: MySQLTreeDataProvider,
        private readonly driver: DatabaseDriver = "mysql",
        private readonly filePath?: string,
        private readonly sslMode?: SslMode,
        private readonly initialDatabase?: string,
    ) {}

    public getConnectionOptions(database?: string): IConnection {
        return DbDriver.getConnectionOptionsFromNode(
            this.host,
            this.user,
            this.password,
            this.port,
            this.certPath,
            this.driver,
            this.filePath,
            database || this.initialDatabase,
            this.sslMode,
        );
    }

    public getTreeItem(): vscode.TreeItem {
        let isExpanded = false;
        let expandVersion = 0;
        try {
            if (this.treeDataProvider) {
                if ((this.treeDataProvider as any).getAllExpanded) {
                    isExpanded = (this.treeDataProvider as any).getAllExpanded() || false;
                }
                if ((this.treeDataProvider as any).getExpandVersion) {
                    expandVersion = (this.treeDataProvider as any).getExpandVersion() || 0;
                }
            }
        } catch (e) {
            // Ignore
        }

        const driverLabel = this.driver !== "mysql" ? ` (${this.driver})` : "";
        const treeItem = new vscode.TreeItem(
            (this.displayName || this.host) + driverLabel,
            isExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
        );
        treeItem.contextValue = "connection";
        treeItem.iconPath = path.join(__filename, "..", "..", "..", "resources", DRIVER_ICONS[this.driver]);
        treeItem.id = `${this.id}#v${expandVersion}`;
        return treeItem;
    }

    public async getChildren(): Promise<INode[]> {
        const options = this.getConnectionOptions();

        return DbDriver.listDatabases(options)
            .then((databases) => {
                return databases.map<DatabaseNode>((database) => {
                    return new DatabaseNode(
                        this.id,
                        this.host,
                        this.user,
                        this.password,
                        this.port,
                        database,
                        this.certPath,
                        this.treeDataProvider,
                        this.driver,
                        this.filePath,
                        this.sslMode,
                    );
                });
            })
            .catch((err) => {
                const message = typeof err === "string"
                    ? err
                    : (err && err.message) ? err.message : String(err);
                return [new InfoNode(message)];
            });
    }

    public async newQuery() {
        AppInsightsClient.sendEvent("newQuery", { viewItem: "connection" });
        Utility.createSQLTextDocument();

        Global.activeConnection = this.getConnectionOptions();
    }

    public async deleteConnection(context: vscode.ExtensionContext, mysqlTreeDataProvider: MySQLTreeDataProvider) {
        AppInsightsClient.sendEvent("deleteConnection");
        const connections = context.globalState.get<{ [key: string]: IConnection }>(Constants.GlobalStateMySQLConectionsKey);
        delete connections[this.id];
        await context.globalState.update(Constants.GlobalStateMySQLConectionsKey, connections);

        await Global.secrets.delete(this.id);

        mysqlTreeDataProvider.refresh();
    }

    public async editDisplayName(context: vscode.ExtensionContext, mysqlTreeDataProvider: MySQLTreeDataProvider) {
        AppInsightsClient.sendEvent("editDisplayName");
        const newDisplayName = await vscode.window.showInputBox({
            prompt: "Edit display name for this connection",
            placeHolder: "My Database Server",
            value: this.displayName,
            ignoreFocusOut: true
        });
        if (newDisplayName === undefined) {
            return;
        }

        const connections = context.globalState.get<{ [key: string]: IConnection }>(Constants.GlobalStateMySQLConectionsKey);
        if (connections && connections[this.id]) {
            connections[this.id] = {
                ...connections[this.id],
                displayName: newDisplayName
            };
            await context.globalState.update(Constants.GlobalStateMySQLConectionsKey, connections);
            mysqlTreeDataProvider.refresh();
        }
    }

    public getId(): string {
        return this.id;
    }

    public getDriver(): DatabaseDriver {
        return this.driver;
    }
}
