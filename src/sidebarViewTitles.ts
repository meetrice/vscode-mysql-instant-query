import * as vscode from "vscode";
import { I18n } from "./common/i18n";

let treeView: vscode.TreeView<unknown> | undefined;
let filterView: vscode.WebviewView | undefined;
let snippetsView: vscode.WebviewView | undefined;

export function registerSidebarTreeView(view: vscode.TreeView<unknown>): void {
    treeView = view;
    applySidebarViewTitles();
}

export function registerFilterWebviewView(view: vscode.WebviewView): void {
    filterView = view;
    applySidebarViewTitles();
}

export function registerSnippetsWebviewView(view: vscode.WebviewView): void {
    snippetsView = view;
    applySidebarViewTitles();
}

/** 根据扩展内语言设置更新侧边栏视图标题（不依赖 VS Code 界面语言） */
export function applySidebarViewTitles(): void {
    if (treeView) {
        treeView.title = I18n.t("views.database", "Database");
    }
    if (filterView) {
        filterView.title = I18n.t("views.filter", "Filter");
    }
    if (snippetsView) {
        snippetsView.title = I18n.t("views.snippets", "Snippets");
    }
}
