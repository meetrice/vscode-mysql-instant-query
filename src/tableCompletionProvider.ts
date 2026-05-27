import * as vscode from "vscode";
import { SqlStatementConnectionManager } from "./sqlStatementConnectionManager";
import { DbDriver, TableInfo } from "./common/dbDriver";
import { IConnection } from "./model/connection";
import { Global } from "./common/global";

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

        const connection = this.getConnectionForPosition(document, position);
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
            const needsBacktick = !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t.TABLE_NAME);
            item.insertText = needsBacktick ? `\`${t.TABLE_NAME}\`` : t.TABLE_NAME;
            return item;
        });
    }

    private getConnectionForPosition(document: vscode.TextDocument, position: vscode.Position): IConnection | undefined {
        const statementRange = this.findSqlStatementAtPosition(document, position);
        if (statementRange) {
            const sql = document.getText(statementRange);
            const connection = SqlStatementConnectionManager.getStatementConnection(document, statementRange, sql);
            if (connection) {
                return connection;
            }
        }
        return Global.activeConnection || undefined;
    }

    private findSqlStatementAtPosition(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
        const fullText = document.getText();
        const offset = document.offsetAt(position);

        let startOffset = 0;
        const semicolonPos = fullText.lastIndexOf(';', offset - 1);
        if (semicolonPos !== -1) {
            startOffset = semicolonPos + 1;
        }

        let endOffset = fullText.length;
        const nextSemicolon = fullText.indexOf(';', offset);
        if (nextSemicolon !== -1) {
            endOffset = nextSemicolon + 1;
        }

        const rangeText = fullText.substring(startOffset, endOffset).trim();
        if (!rangeText) {
            return undefined;
        }

        return new vscode.Range(
            document.positionAt(startOffset),
            document.positionAt(endOffset),
        );
    }

    private async getTableList(connection: IConnection): Promise<TableInfo[]> {
        const key = [connection.host, connection.port, connection.database, connection.user].join("|");
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
