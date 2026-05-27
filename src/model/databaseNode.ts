import * as path from "path";
import * as vscode from "vscode";
import { AppInsightsClient } from "../common/appInsightsClient";
import { DbDriver } from "../common/dbDriver";
import { Global } from "../common/global";
import { Utility } from "../common/utility";
import { DatabaseDriver, SslMode } from "./connection";
import { InfoNode } from "./infoNode";
import { INode } from "./INode";
import { TableNode } from "./tableNode";
import { MySQLTreeDataProvider, TableFilterState } from "../mysqlTreeDataProvider";

export class DatabaseNode implements INode {
    private allExpanded: boolean = false;

    constructor(private readonly connectionId: string, private readonly host: string, private readonly user: string,
                private readonly password: string, private readonly port: string, private readonly database: string,
                private readonly certPath: string,
                private treeDataProvider?: MySQLTreeDataProvider,
                private readonly driver: DatabaseDriver = "mysql",
                private readonly filePath?: string,
                private readonly sslMode?: SslMode) {
    }

    private getConnectionOptions() {
        return DbDriver.getConnectionOptionsFromNode(
            this.host,
            this.user,
            this.password,
            this.port,
            this.certPath,
            this.driver,
            this.filePath,
            this.database,
            this.sslMode,
        );
    }

    public setAllExpanded(value: boolean): void {
        this.allExpanded = value;
    }

    public getExpandKey(): string {
        return `${this.connectionId}:${this.database}`;
    }

    public getTreeItem(): vscode.TreeItem {
        const isExpanded = TableFilterState.instance.getDatabaseExpanded(this.getExpandKey());

        const treeItem = new vscode.TreeItem(
            this.database || "(unknown)",
            isExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
        );
        treeItem.contextValue = "database";
        treeItem.iconPath = path.join(__filename, "..", "..", "..", "resources", "database.svg");
        treeItem.id = this.getExpandKey();
        return treeItem;
    }

    public async getChildren(): Promise<INode[]> {
        const options = this.getConnectionOptions();

        return DbDriver.listTables(options, this.database)
            .then(async (tables) => {
                // Get pinned tables from global state
                const pinnedTables: string[] = this.treeDataProvider ? this.treeDataProvider.getPinnedTables() : [];

                const tableFilterText = TableFilterState.instance.filterText;
                const columnFilterText = TableFilterState.instance.columnFilterText;
                const tableFilterLower = tableFilterText.toLowerCase().trim();
                const columnFilterLower = columnFilterText.toLowerCase().trim();
                const hasColumnFilter = columnFilterLower.length > 0;

                let matchingColumnTables: Set<string> | undefined;
                if (hasColumnFilter) {
                    matchingColumnTables = await DbDriver.listTableNamesMatchingColumnFilter(
                        options,
                        this.database,
                        columnFilterLower,
                    );
                }

                const tableNodes = tables
                    .filter((table) => {
                        const tableName = table.TABLE_SCHEMA
                            ? `${table.TABLE_SCHEMA}.${table.TABLE_NAME}`
                            : (table.TABLE_NAME || "");
                        const tableNameLower = tableName.toLowerCase();
                        const tableComment = (table.TABLE_COMMENT || "").toLowerCase();

                        if (tableFilterLower) {
                            const matchesTable = tableNameLower.includes(tableFilterLower)
                                || tableComment.includes(tableFilterLower);
                            if (!matchesTable) {
                                return false;
                            }
                        }

                        if (matchingColumnTables) {
                            const bareName = (table.TABLE_NAME || "").toLowerCase();
                            if (!matchingColumnTables.has(tableNameLower) && !matchingColumnTables.has(bareName)) {
                                return false;
                            }
                        }

                        return true;
                    })
                    .map<TableNode>((table) => {
                        const tableName = table.TABLE_SCHEMA ? `${table.TABLE_SCHEMA}.${table.TABLE_NAME}` : table.TABLE_NAME;
                        const tableKey = `${this.host}:${this.port}:${this.database}:${tableName}`;
                        const isPinned = pinnedTables.indexOf(tableKey) >= 0;
                        const allExpanded = this.treeDataProvider?.getAllExpanded() || false;
                        const tableNode = new TableNode(
                            this.host,
                            this.user,
                            this.password,
                            this.port,
                            this.database,
                            tableName,
                            this.certPath,
                            isPinned,
                            this.treeDataProvider,
                            allExpanded,
                            this.driver,
                            this.filePath,
                            this.sslMode,
                        );
                        // Set table comment on the node for display
                        if (table.TABLE_COMMENT) {
                            tableNode.setTableComment(table.TABLE_COMMENT);
                        }
                        return tableNode;
                    });

                // Sort: pinned tables first (in order of pinning), then alphabetical
                tableNodes.sort((a, b) => {
                    if (a.pinned && !b.pinned) return -1;
                    if (!a.pinned && b.pinned) return 1;
                    if (a.pinned && b.pinned) {
                        // Sort by pin order
                        const aIndex = pinnedTables.indexOf(a.getKey());
                        const bIndex = pinnedTables.indexOf(b.getKey());
                        return aIndex - bIndex;
                    }
                    // Both not pinned, sort alphabetically
                    return a.table.localeCompare(b.table);
                });

                return tableNodes;
            })
            .catch((err) => {
                const message = typeof err === "string"
                    ? err
                    : (err && err.message) ? err.message : String(err);
                return [new InfoNode(message)];
            });
    }

    public async newQuery() {
        AppInsightsClient.sendEvent("newQuery", { viewItem: "database" });
        Utility.createSQLTextDocument("", false);

        Global.activeConnection = this.getConnectionOptions();
    }

    public async selectDatabase() {
        AppInsightsClient.sendEvent("selectDatabase", { viewItem: "database" });

        Global.activeConnection = this.getConnectionOptions();

        vscode.window.showInformationMessage(`Database selected: ${this.database}`);
    }

    public async refresh() {
        if (this.treeDataProvider) {
            this.treeDataProvider.refresh(this);
        }
    }
}
