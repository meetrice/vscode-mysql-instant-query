import * as path from "path";
import * as vscode from "vscode";
import { I18n } from "../common/i18n";
import { ConnectionNode } from "./connectionNode";
import { INode } from "./INode";
import { TableFilterState } from "../mysqlTreeDataProvider";
import { AddConnectionNode } from "./addConnectionNode";
import { NewQueryNode } from "./newQueryNode";
import { SettingsNode } from "./settingsNode";

export class RootNode implements INode {
    private readonly addConnectionNode = new AddConnectionNode();
    private readonly settingsNode = new SettingsNode();
    private readonly newQueryNode = new NewQueryNode();

    constructor(private readonly getConnectionNodes: () => Promise<INode[]>) {}

    public getTreeItem(): vscode.TreeItem {
        const treeItem = new vscode.TreeItem(
            I18n.t("tree.rootDatabases", "Database"),
            vscode.TreeItemCollapsibleState.Expanded
        );
        treeItem.contextValue = "databasesRoot";
        treeItem.iconPath = path.join(__filename, "..", "..", "..", "resources", "database.svg");
        treeItem.id = "databases-root";
        return treeItem;
    }

    public async getChildren(): Promise<INode[]> {
        const connections = await this.getConnectionNodes();
        const filterLower = TableFilterState.instance.connectionFilterText.toLowerCase().trim();
        const filteredConnections = filterLower
            ? connections.filter((node) => {
                if (node instanceof ConnectionNode) {
                    return node.getDisplayLabel().toLowerCase().includes(filterLower);
                }
                return true;
            })
            : connections;
        return [this.newQueryNode, this.addConnectionNode, this.settingsNode, ...filteredConnections];
    }
}
