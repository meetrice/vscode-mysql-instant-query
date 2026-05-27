import * as vscode from "vscode";
import { DbDriver } from "./common/dbDriver";
import { IConnection } from "./model/connection";
import {
    buildSelectWithWhereSql,
    findSqlStatementAtPosition,
    formatSqlIdentifier,
    formatSelectListColumnText,
    getConnectionCacheKey,
    getConnectionForPosition,
    parseSelectFromContext,
    parseTableReferenceFromStatement,
    SelectFromContext,
} from "./sqlCompletionUtils";

const CACHE_TTL = 60000;
const MULTI_SELECT_LABEL = "$(list-selection) 多选字段…";
const FILTER_VALUE_BUTTON = "设置筛选值";
const CLOSE_BUTTON = "关闭";
const DOUBLE_CLICK_MS = 450;

interface ColumnQuickPickItem extends vscode.QuickPickItem {
    columnName: string;
    columnType: string;
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

function formatColumnQuickPickLabel(columnName: string, filterValue?: string): string {
    if (!filterValue) {
        return columnName;
    }
    const displayValue = filterValue.replace(/'/g, "''");
    return `${columnName} like '%${displayValue}%'`;
}

function buildColumnQuickPickItems(
    columns: any[],
    filterValues: Map<string, string> = new Map(),
): ColumnQuickPickItem[] {
    return columns.map((column) => {
        const columnName = column.COLUMN_NAME as string;
        const comment = (column.COLUMN_COMMENT || "").trim();
        const columnType = (column.COLUMN_TYPE || "").trim();
        const filterValue = filterValues.get(columnName);
        return {
            label: formatColumnQuickPickLabel(columnName, filterValue),
            description: comment || undefined,
            columnName,
            columnType,
            searchText: [columnName, comment, columnType, filterValue || ""].filter(Boolean).join(" "),
        };
    });
}

function fuzzyIncludes(text: string, pattern: string): boolean {
    const source = text.toLowerCase();
    const query = pattern.toLowerCase().trim();
    if (!query) {
        return true;
    }
    if (source.includes(query)) {
        return true;
    }
    let queryIndex = 0;
    for (let i = 0; i < source.length && queryIndex < query.length; i++) {
        if (source[i] === query[queryIndex]) {
            queryIndex++;
        }
    }
    return queryIndex === query.length;
}

function filterColumnItems(items: ColumnQuickPickItem[], keyword: string): ColumnQuickPickItem[] {
    const query = keyword.trim();
    if (!query) {
        return items;
    }
    return items.filter((item) => fuzzyIncludes(item.searchText, query));
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
        const filterValues = new Map<string, string>();
        const columnTypeByName = new Map(allItems.map((item) => [item.columnName, item.columnType]));
        const quickPick = vscode.window.createQuickPick<ColumnQuickPickItem>();
        activeColumnQuickPick = quickPick;

        let baseItems = allItems;
        let suppressItemEvents = false;
        let promptingFilter = false;
        let suppressAcceptUntil = 0;
        let lastActiveTap: { columnName: string; time: number } | undefined;
        let lastPointerSelectionAt = 0;

        const ensureItemSelected = (item: ColumnQuickPickItem) => {
            if (quickPick.selectedItems.some((selected) => selected.columnName === item.columnName)) {
                return;
            }
            suppressItemEvents = true;
            const selected = new Map(quickPick.selectedItems.map((entry) => [entry.columnName, entry]));
            selected.set(item.columnName, item);
            quickPick.selectedItems = quickPick.items.filter((entry) => selected.has(entry.columnName));
            suppressItemEvents = false;
        };

        const applySearchFilter = () => {
            suppressItemEvents = true;
            const selectedNames = new Set(quickPick.selectedItems.map((item) => item.columnName));
            for (const [columnName, filterValue] of filterValues.entries()) {
                if (filterValue.trim()) {
                    selectedNames.add(columnName);
                }
            }
            const activeName = quickPick.activeItems[0]?.columnName;
            const keyword = quickPick.value.trim();
            const filtered = filterColumnItems(baseItems, keyword);
            quickPick.items = filtered.map((item) => ({
                ...item,
                alwaysShow: keyword.length > 0,
            }));
            quickPick.selectedItems = quickPick.items.filter((item) => selectedNames.has(item.columnName));
            if (activeName) {
                const activeItem = quickPick.items.find((item) => item.columnName === activeName);
                if (activeItem) {
                    quickPick.activeItems = [activeItem];
                }
            }
            suppressItemEvents = false;
        };

        const refreshItems = () => {
            baseItems = buildColumnQuickPickItems(columns, filterValues);
            applySearchFilter();
        };

        const promptFilterValue = async (item: ColumnQuickPickItem) => {
            if (promptingFilter) {
                return;
            }
            promptingFilter = true;
            try {
                const value = await new Promise<string | undefined>((resolve) => {
                    const inputBox = vscode.window.createInputBox();
                    inputBox.title = item.columnName;
                    inputBox.prompt = `为字段 ${item.columnName} 输入筛选值（留空则清除，Esc 取消）`;
                    inputBox.placeholder = "输入字符或数字";
                    inputBox.value = filterValues.get(item.columnName) || "";
                    inputBox.ignoreFocusOut = true;

                    let settled = false;
                    const finish = (result: string | undefined) => {
                        if (settled) {
                            return;
                        }
                        settled = true;
                        inputBox.dispose();
                        resolve(result);
                    };

                    inputBox.onDidAccept(() => {
                        finish(inputBox.value);
                    });

                    inputBox.onDidHide(() => {
                        finish(undefined);
                    });

                    inputBox.show();
                });

                if (value === undefined) {
                    return;
                }
                if (value.trim()) {
                    filterValues.set(item.columnName, value.trim());
                } else {
                    filterValues.delete(item.columnName);
                }
                refreshItems();
            } finally {
                promptingFilter = false;
                suppressAcceptUntil = Date.now() + 300;
                quickPick.show();
            }
        };

        quickPick.canSelectMany = true;
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;
        quickPick.ignoreFocusOut = true;
        quickPick.placeholder = `搜索字段名/类型/注释 · ${selectContext.tableName}（单击勾选；双击输入筛选值；Enter 确认）`;
        refreshItems();
        quickPick.buttons = [
            { iconPath: new vscode.ThemeIcon("checklist"), tooltip: "全选" },
            { iconPath: new vscode.ThemeIcon("clear-all"), tooltip: "取消全选" },
            { iconPath: new vscode.ThemeIcon("edit"), tooltip: FILTER_VALUE_BUTTON },
            { iconPath: new vscode.ThemeIcon("close"), tooltip: CLOSE_BUTTON },
        ];

        if (initialFilter) {
            quickPick.value = initialFilter;
            applySearchFilter();
        }

        quickPick.onDidChangeValue(() => {
            applySearchFilter();
        });

        quickPick.onDidChangeSelection(() => {
            if (suppressItemEvents || promptingFilter) {
                return;
            }
            lastPointerSelectionAt = Date.now();
        });

        quickPick.onDidChangeActive(async (items) => {
            if (suppressItemEvents || promptingFilter) {
                return;
            }

            const active = items[0];
            if (!active) {
                return;
            }

            const now = Date.now();
            const isDoubleClick = lastActiveTap?.columnName === active.columnName
                && now - lastActiveTap.time <= DOUBLE_CLICK_MS
                && now - lastPointerSelectionAt <= DOUBLE_CLICK_MS;

            if (isDoubleClick) {
                lastActiveTap = undefined;
                const latestItem = quickPick.items.find((item) => item.columnName === active.columnName) || active;
                ensureItemSelected(latestItem);
                await promptFilterValue(latestItem);
                return;
            }

            lastActiveTap = { columnName: active.columnName, time: now };
        });

        quickPick.onDidTriggerButton(async (button) => {
            if (button.tooltip === CLOSE_BUTTON) {
                quickPick.hide();
                return;
            }
            if (button.tooltip === FILTER_VALUE_BUTTON) {
                const active = quickPick.activeItems[0];
                if (!active) {
                    void vscode.window.showWarningMessage("请先用方向键选中要设置筛选值的字段");
                    return;
                }
                await promptFilterValue(active);
                return;
            }

            const filteredItems = filterColumnItems(baseItems, quickPick.value);
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
            if (promptingFilter || Date.now() < suppressAcceptUntil) {
                return;
            }
            if (activeColumnQuickPick === quickPick) {
                activeColumnQuickPick = undefined;
            }
            quickPick.dispose();
        });

        quickPick.onDidAccept(async () => {
            if (promptingFilter || Date.now() < suppressAcceptUntil) {
                return;
            }
            const selectedItems = quickPick.selectedItems;
            if (selectedItems.length === 0) {
                quickPick.hide();
                return;
            }

            suppressColumnCompletion();
            quickPick.hide();

            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.uri.toString() !== document.uri.toString()) {
                return;
            }

            const selectedNames = selectedItems.map((item) => item.columnName);
            const filters = [...filterValues.entries()]
                .filter(([, value]) => value.trim())
                .map(([columnName, value]) => ({
                    columnName,
                    columnType: columnTypeByName.get(columnName) || "",
                    value: value.trim(),
                }));

            const statementRange = findSqlStatementAtPosition(document, editor.selection.active);
            if (!statementRange) {
                return;
            }
            const statementText = document.getText(statementRange);
            const tableReference = parseTableReferenceFromStatement(statementText, selectContext.tableName);
            const sql = buildSelectWithWhereSql(tableReference, selectedNames, filters);

            await editor.edit((editBuilder) => {
                editBuilder.replace(statementRange, sql);
            });
            const endPosition = statementRange.start.with(undefined, statementRange.start.character + sql.length);
            editor.selection = new vscode.Selection(endPosition, endPosition);
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
