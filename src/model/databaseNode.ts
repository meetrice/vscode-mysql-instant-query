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
import { MySQLTreeDataProvider } from "../mysqlTreeDataProvider";

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

    public getTreeItem(): vscode.TreeItem {
        // Check global expand state
        let isExpanded = this.allExpanded;
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
        const treeItem = new vscode.TreeItem(
            this.database || "(unknown)",
            isExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
        );
        treeItem.contextValue = "database";
        treeItem.iconPath = path.join(__filename, "..", "..", "..", "resources", "database.svg");
        treeItem.id = `${this.connectionId}:${this.database}#v${expandVersion}`;
        return treeItem;
    }

    public async getChildren(): Promise<INode[]> {
        const options = this.getConnectionOptions();

        return DbDriver.listTables(options, this.database)
            .then((tables) => {
                // Get pinned tables from global state
                const pinnedTables: string[] = this.treeDataProvider ? this.treeDataProvider.getPinnedTables() : [];

                // Get filter text from global filter state (import dynamically to avoid circular dependency)
                let filterText = "";
                try {
                    // Access the filter state through the treeDataProvider if available
                    if (this.treeDataProvider && (this.treeDataProvider as any).getFilterText) {
                        filterText = (this.treeDataProvider as any).getFilterText() || "";
                    }
                } catch (e) {
                    // Ignore if filter is not available
                }

                const filterLower = filterText.toLowerCase().trim();

                const tableNodes = tables
                    .filter((table) => {
                        if (!filterLower) return true;
                        const tableName = (table.TABLE_NAME || "").toLowerCase();
                        const tableComment = (table.TABLE_COMMENT || "").toLowerCase();
                        // Support fuzzy matching for both table name and comment
                        return tableName.includes(filterLower) || tableComment.includes(filterLower);
                    })
                    .map<TableNode>((table) => {
                        const tableKey = `${this.host}:${this.port}:${this.database}:${table.TABLE_NAME}`;
                        const isPinned = pinnedTables.indexOf(tableKey) >= 0;
                        // Check if there's a column filter active or global expand - if so, auto-expand tables
                        let columnFilter = "";
                        let hasColumnFilter = false;
                        let allExpanded = false;
                        try {
                            if (this.treeDataProvider) {
                                if ((this.treeDataProvider as any).getColumnFilterText) {
                                    columnFilter = (this.treeDataProvider as any).getColumnFilterText() || "";
                                    hasColumnFilter = columnFilter.length > 0;
                                }
                                if ((this.treeDataProvider as any).getAllExpanded) {
                                    allExpanded = (this.treeDataProvider as any).getAllExpanded() || false;
                                }
                            }
                        } catch (e) {
                            // Ignore
                        }
                        const tableNode = new TableNode(
                            this.host,
                            this.user,
                            this.password,
                            this.port,
                            this.database,
                            table.TABLE_NAME,
                            this.certPath,
                            isPinned,
                            this.treeDataProvider,
                            hasColumnFilter || allExpanded,
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
        Utility.createSQLTextDocument();

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
