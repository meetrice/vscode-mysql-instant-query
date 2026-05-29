import * as vscode from "vscode";
import { INode } from "./INode";
import { I18n } from "../common/i18n";

export class NewErdNode implements INode {

    getTreeItem(): vscode.TreeItem {
        const item = new vscode.TreeItem(I18n.t("tree.newErd"), vscode.TreeItemCollapsibleState.None);
        item.command = {
            command: "mysqlInstantQuery.newErdFromTree",
            title: I18n.t("tree.newErd"),
        };
        item.iconPath = new vscode.ThemeIcon("type-hierarchy");
        return item;
    }

    getChildren(): INode[] {
        return [];
    }
}
