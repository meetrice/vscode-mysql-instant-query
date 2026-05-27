import * as vscode from "vscode";
import { I18n } from "../common/i18n";
import { INode } from "./INode";

export class NewQueryNode implements INode {
    public getTreeItem(): vscode.TreeItem {
        const label = I18n.t("tree.newQuery", "New Query");
        const treeItem = new vscode.TreeItem(
            label,
            vscode.TreeItemCollapsibleState.None
        );
        treeItem.contextValue = "newQuery";
        treeItem.iconPath = new vscode.ThemeIcon("new-file");
        treeItem.command = {
            command: "mysqlInstantQuery.newQueryFromTree",
            title: label,
        };
        treeItem.id = "new-query-node";
        return treeItem;
    }

    public getChildren(): INode[] {
        return [];
    }
}
