import * as vscode from "vscode";
import { I18n } from "../common/i18n";
import { INode } from "./INode";

export class SettingsNode implements INode {
    public getTreeItem(): vscode.TreeItem {
        const label = I18n.t("tree.settings", "Settings");
        const treeItem = new vscode.TreeItem(
            label,
            vscode.TreeItemCollapsibleState.None
        );
        treeItem.contextValue = "settings";
        treeItem.iconPath = new vscode.ThemeIcon("settings-gear");
        treeItem.command = {
            command: "mysqlInstantQuery.openSettings",
            title: label,
        };
        treeItem.id = "settings-node";
        return treeItem;
    }

    public getChildren(): INode[] {
        return [];
    }
}
