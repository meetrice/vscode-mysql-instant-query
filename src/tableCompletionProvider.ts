import * as vscode from "vscode";
import { DbDriver, TableInfo } from "./common/dbDriver";
import { IConnection } from "./model/connection";
import {
    formatSqlIdentifier,
    getConnectionCacheKey,
    getConnectionForPosition,
} from "./sqlCompletionUtils";

const CACHE_TTL = 60000;

const tableListCache = new Map<string, { tables: TableInfo[]; timestamp: number }>();

export class TableCompletionProvider implements vscode.CompletionItemProvider {
    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
    ): Promise<vscode.CompletionItem[]> {
        const textBeforeCursor = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
        const fromMatch = textBeforeCursor.match(/(?:FROM|from)\s+`?(\w*)$/);
        if (!fromMatch) {
            return [];
        }

        const partialName = fromMatch[1] || "";

        const connection = getConnectionForPosition(document, position);
        if (!connection || !connection.database) {
            return [];
        }

        const tables = await this.getTableList(connection);
        if (tables.length === 0) {
            return [];
        }

        const lowerPartial = partialName.toLowerCase();
        const filtered = lowerPartial
            ? tables.filter(t => t.TABLE_NAME.toLowerCase().includes(lowerPartial))
            : tables;

        return filtered.map(t => {
            const item = new vscode.CompletionItem(t.TABLE_NAME, vscode.CompletionItemKind.Struct);
            item.detail = connection.database;
            item.documentation = t.TABLE_COMMENT || undefined;
            item.insertText = formatSqlIdentifier(t.TABLE_NAME);
            return item;
        });
    }

    private async getTableList(connection: IConnection): Promise<TableInfo[]> {
        const key = getConnectionCacheKey(connection);
        const cached = tableListCache.get(key);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            return cached.tables;
        }

        try {
            const tables = await DbDriver.listTables(connection, connection.database!);
            tableListCache.set(key, { tables, timestamp: Date.now() });
            return tables;
        } catch {
            return [];
        }
    }
}
