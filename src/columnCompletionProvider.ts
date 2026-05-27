import * as vscode from "vscode";
import { DbDriver } from "./common/dbDriver";
import { IConnection } from "./model/connection";
import {
    formatSqlIdentifier,
    formatSelectListColumnText,
    getConnectionCacheKey,
    getConnectionForPosition,
    parseSelectFromContext,
    SelectFromContext,
} from "./sqlCompletionUtils";

const CACHE_TTL = 60000;
const MULTI_SELECT_LABEL = "$(list-selection) 多选字段…";

interface ColumnQuickPickItem extends vscode.QuickPickItem {
    columnName: string;
    searchText: string;
}

const columnListCache = new Map<string, { columns: any[]; timestamp: number }>();

let activeColumnQuickPick: vscode.QuickPick<ColumnQuickPickItem> | undefined;
let suppressColumnCompletionUntil = 0;

function suppressColumnCompletion(durationMs = 1000): void {
    suppressColumnCompletionUntil = Date.now() + durationMs;
}

function isColumnCompletionSuppressed(): boolean {
    return Date.now() < suppressColumnCompletionUntil;
}

function buildColumnQuickPickItems(columns: any[]): ColumnQuickPickItem[] {
    return columns.map((column) => {
        const columnName = column.COLUMN_NAME as string;
        const comment = (column.COLUMN_COMMENT || "").trim();
        const columnType = (column.COLUMN_TYPE || "").trim();
        return {
            label: columnName,
            description: comment || undefined,
            columnName,
            searchText: [columnName, comment, columnType].filter(Boolean).join(" "),
        };
    });
}

function getFilteredQuickPickItems(items: ColumnQuickPickItem[], filterValue: string): ColumnQuickPickItem[] {
    const keyword = filterValue.trim().toLowerCase();
    if (!keyword) {
        return items;
    }
    return items.filter((item) => item.searchText.toLowerCase().includes(keyword));
}

async function getColumnList(connection: IConnection, tableName: string): Promise<any[]> {
    const key = `${getConnectionCacheKey(connection)}|${tableName}`;
    const cached = columnListCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.columns;
    }

    try {
        const columns = await DbDriver.listColumns(connection, connection.database!, tableName);
        columnListCache.set(key, { columns, timestamp: Date.now() });
        return columns;
    } catch {
        return [];
    }
}

export class ColumnCompletionProvider implements vscode.CompletionItemProvider {
    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext,
    ): Promise<vscode.CompletionItem[] | vscode.CompletionList> {
        const selectContext = parseSelectFromContext(document, position);
        if (!selectContext) {
            return [];
        }

        const connection = getConnectionForPosition(document, position);
        if (!connection?.database) {
            return [];
        }

        const columns = await getColumnList(connection, selectContext.tableName);
        if (columns.length === 0) {
            return [];
        }

        if (context.triggerKind === vscode.CompletionTriggerKind.Invoke && !isColumnCompletionSuppressed()) {
            this.showColumnMultiSelectQuickPick(document, selectContext, columns, selectContext.partialColumn);
            return [];
        }

        const lowerPartial = selectContext.partialColumn.toLowerCase();
        const filtered = lowerPartial
            ? columns.filter((column) => (column.COLUMN_NAME || "").toLowerCase().includes(lowerPartial))
            : columns;

        const items: vscode.CompletionItem[] = [];

        const multiSelectItem = new vscode.CompletionItem(MULTI_SELECT_LABEL, vscode.CompletionItemKind.Event);
        multiSelectItem.sortText = "0";
        multiSelectItem.filterText = selectContext.partialColumn;
        multiSelectItem.insertText = "";
        multiSelectItem.command = {
            command: "mysqlInstantQuery.selectColumnsMultiPick",
            title: "Select columns",
            arguments: [document.uri.toString(), [
                selectContext.selectListRange.start.line,
                selectContext.selectListRange.start.character,
                selectContext.selectListRange.end.line,
                selectContext.selectListRange.end.character,
            ], selectContext.tableName, connection.database],
        };
        items.push(multiSelectItem);

        for (const column of filtered) {
            const columnName = column.COLUMN_NAME as string;
            const item = new vscode.CompletionItem(columnName, vscode.CompletionItemKind.Field);
            item.detail = column.COLUMN_TYPE || undefined;
            item.documentation = column.COLUMN_COMMENT || undefined;
            item.filterText = columnName;

            const formattedName = formatSqlIdentifier(columnName);
            item.insertText = `${selectContext.columnInsertPrefix}${formattedName}`;
            item.range = selectContext.partialRange;

            items.push(item);
        }

        return items;
    }

    public static async showColumnMultiSelectQuickPickForRange(
        documentUri: vscode.Uri,
        rangeData: number[],
        tableName: string,
        _database: string,
        partialFilter = "",
    ) {
        const document = await vscode.workspace.openTextDocument(documentUri);
        const selectListRange = new vscode.Range(rangeData[0], rangeData[1], rangeData[2], rangeData[3]);
        const position = selectListRange.end;
        const connection = getConnectionForPosition(document, position);
        if (!connection?.database) {
            return;
        }

        const provider = new ColumnCompletionProvider();
        const columns = await getColumnList(connection, tableName);
        if (columns.length === 0) {
            return;
        }

        const selectContext: SelectFromContext = {
            tableName,
            partialColumn: partialFilter,
            selectListRange,
            partialRange: new vscode.Range(position, position),
            hasExistingColumns: false,
            columnInsertPrefix: "",
        };
        provider.showColumnMultiSelectQuickPick(document, selectContext, columns, partialFilter);
    }

    private showColumnMultiSelectQuickPick(
        document: vscode.TextDocument,
        selectContext: SelectFromContext,
        columns: any[],
        initialFilter = selectContext.partialColumn,
    ): void {
        if (activeColumnQuickPick) {
            return;
        }

        const allItems = buildColumnQuickPickItems(columns);
        const quickPick = vscode.window.createQuickPick<ColumnQuickPickItem>();
        activeColumnQuickPick = quickPick;

        quickPick.canSelectMany = true;
        quickPick.matchOnDescription = true;
        quickPick.placeholder = `选择字段 · ${selectContext.tableName}（可多选，Enter 确认）`;
        quickPick.items = allItems;
        quickPick.buttons = [
            { iconPath: new vscode.ThemeIcon("checklist"), tooltip: "全选" },
            { iconPath: new vscode.ThemeIcon("clear-all"), tooltip: "取消全选" },
        ];

        if (initialFilter) {
            quickPick.value = initialFilter;
        }

        quickPick.onDidTriggerButton((button) => {
            const filteredItems = getFilteredQuickPickItems(allItems, quickPick.value);
            if (button.tooltip === "全选") {
                const selected = new Map(quickPick.selectedItems.map((item) => [item.columnName, item]));
                filteredItems.forEach((item) => selected.set(item.columnName, item));
                quickPick.selectedItems = Array.from(selected.values());
                return;
            }
            if (button.tooltip === "取消全选") {
                if (quickPick.value.trim()) {
                    const filteredNames = new Set(filteredItems.map((item) => item.columnName));
                    quickPick.selectedItems = quickPick.selectedItems.filter((item) => !filteredNames.has(item.columnName));
                    return;
                }
                quickPick.selectedItems = [];
            }
        });

        quickPick.onDidHide(() => {
            if (activeColumnQuickPick === quickPick) {
                activeColumnQuickPick = undefined;
            }
            quickPick.dispose();
        });

        quickPick.onDidAccept(async () => {
            const selectedNames = quickPick.selectedItems.map((item) => item.columnName);
            if (selectedNames.length === 0) {
                quickPick.hide();
                return;
            }

            suppressColumnCompletion();
            quickPick.hide();

            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.uri.toString() !== document.uri.toString()) {
                return;
            }

            const columnText = formatSelectListColumnText(selectedNames);
            await editor.edit((editBuilder) => {
                editBuilder.replace(selectContext.selectListRange, columnText);
            });

            const newPosition = selectContext.selectListRange.start.with(
                undefined,
                selectContext.selectListRange.start.character + columnText.length,
            );
            editor.selection = new vscode.Selection(newPosition, newPosition);
        });

        quickPick.show();
    }
}

export function registerColumnCompletionFeatures(context: vscode.ExtensionContext) {
    let suggestTimer: ReturnType<typeof setTimeout> | undefined;

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document !== event.document || editor.document.languageId !== "sql") {
                return;
            }

            const change = event.contentChanges.find((item) => item.text.length > 0);
            if (!change || isColumnCompletionSuppressed()) {
                return;
            }

            const changePosition = change.range.end;
            const selectContext = parseSelectFromContext(event.document, changePosition);
            if (!selectContext) {
                return;
            }

            if (suggestTimer) {
                clearTimeout(suggestTimer);
            }
            suggestTimer = setTimeout(() => {
                if (vscode.window.activeTextEditor === editor) {
                    void vscode.commands.executeCommand("editor.action.triggerSuggest");
                }
            }, 150);
        }),
    );
}
