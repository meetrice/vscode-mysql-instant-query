import * as path from "path";
import * as vscode from "vscode";
import { INode } from "./INode";

export class RootNode implements INode {
    constructor(private readonly getConnectionNodes: () => Promise<INode[]>) {}

    public getTreeItem(): vscode.TreeItem {
        const treeItem = new vscode.TreeItem(
            "数据库",
            vscode.TreeItemCollapsibleState.Expanded
        );
        treeItem.contextValue = "databasesRoot";
        treeItem.iconPath = path.join(__filename, "..", "..", "..", "resources", "database.svg");
        treeItem.id = "databases-root";
        return treeItem;
    }

    public getChildren(): Promise<INode[]> {
        return this.getConnectionNodes();
    }
}
