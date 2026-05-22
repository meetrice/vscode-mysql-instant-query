import * as path from "path";
import * as vscode from "vscode";
import { INode } from "./INode";
import { AddConnectionNode } from "./addConnectionNode";

export class RootNode implements INode {
    private readonly addConnectionNode = new AddConnectionNode();

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

    public async getChildren(): Promise<INode[]> {
        const connections = await this.getConnectionNodes();
        return [this.addConnectionNode, ...connections];
    }
}
