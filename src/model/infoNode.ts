import * as vscode from "vscode";
import { INode } from "./INode";

export class InfoNode implements INode {
    constructor(private readonly label: string) {}

    public getTreeItem(): vscode.TreeItem {
        const item = new vscode.TreeItem(
            this.label,
            vscode.TreeItemCollapsibleState.None
        );
        item.contextValue = "info";
        return item;
    }

    public getChildren(): INode[] {
        return [];
    }
}
