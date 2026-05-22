import * as vscode from "vscode";
import { INode } from "./INode";

export class AddConnectionNode implements INode {
    public getTreeItem(): vscode.TreeItem {
        const treeItem = new vscode.TreeItem(
            "添加连接",
            vscode.TreeItemCollapsibleState.None
        );
        treeItem.contextValue = "addConnection";
        treeItem.iconPath = new vscode.ThemeIcon("add");
        treeItem.command = {
            command: "mysqlInstantQuery.addConnection",
            title: "添加连接",
        };
        treeItem.id = "add-connection-node";
        return treeItem;
    }

    public getChildren(): INode[] {
        return [];
    }
}
