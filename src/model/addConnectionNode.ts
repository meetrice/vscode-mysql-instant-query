import * as vscode from "vscode";
import { I18n } from "../common/i18n";
import { INode } from "./INode";

export class AddConnectionNode implements INode {
    public getTreeItem(): vscode.TreeItem {
        const label = I18n.t("tree.addConnection", "Add Connection");
        const treeItem = new vscode.TreeItem(
            label,
            vscode.TreeItemCollapsibleState.None
        );
        treeItem.contextValue = "addConnection";
        treeItem.iconPath = new vscode.ThemeIcon("add");
        treeItem.command = {
            command: "mysqlInstantQuery.addConnection",
            title: label,
        };
        treeItem.id = "add-connection-node";
        return treeItem;
    }

    public getChildren(): INode[] {
        return [];
    }
}
