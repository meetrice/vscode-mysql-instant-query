import * as path from "path";
import * as vscode from "vscode";
import { I18n } from "../common/i18n";
import { INode } from "./INode";
import { AddConnectionNode } from "./addConnectionNode";
import { NewQueryNode } from "./newQueryNode";

export class RootNode implements INode {
    private readonly addConnectionNode = new AddConnectionNode();
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
        return [this.newQueryNode, this.addConnectionNode, ...connections];
    }
}
