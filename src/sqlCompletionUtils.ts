import * as vscode from "vscode";
import { SqlStatementConnectionManager } from "./sqlStatementConnectionManager";
import { Global } from "./common/global";
import { IConnection } from "./model/connection";

export interface SelectFromContext {
    tableName: string;
    partialColumn: string;
    selectListRange: vscode.Range;
    partialRange: vscode.Range;
    hasExistingColumns: boolean;
    columnInsertPrefix: string;
}

export function findSqlStatementAtPosition(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
    const fullText = document.getText();
    const offset = document.offsetAt(position);

    let startOffset = 0;
    const semicolonPos = fullText.lastIndexOf(";", offset - 1);
    if (semicolonPos !== -1) {
        startOffset = semicolonPos + 1;
    }

    let endOffset = fullText.length;
    const nextSemicolon = fullText.indexOf(";", offset);
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

export function getConnectionForPosition(document: vscode.TextDocument, position: vscode.Position): IConnection | undefined {
    const statementRange = findSqlStatementAtPosition(document, position);
    if (statementRange) {
        const sql = document.getText(statementRange);
        const connection = SqlStatementConnectionManager.getStatementConnection(document, statementRange, sql);
        if (connection) {
            return connection;
        }
    }
    return Global.activeConnection || undefined;
}

export function formatSqlIdentifier(name: string): string {
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ? name : `\`${name}\``;
}

export function formatSelectListColumnText(columnNames: string[]): string {
    return ` ${columnNames.map(formatSqlIdentifier).join(", ")} `;
}

export function parseTableFromFromClause(fromClause: string): string | undefined {
    const match = fromClause.match(/\bFROM\b\s+((?:`[^`]+`|\w+)(?:\.(?:`[^`]+`|\w+))?)/i);
    if (!match) {
        return undefined;
    }
    const tableRef = match[1].replace(/`/g, "");
    const parts = tableRef.split(".");
    return parts[parts.length - 1];
}

export function parseSelectFromContext(document: vscode.TextDocument, position: vscode.Position): SelectFromContext | undefined {
    const statementRange = findSqlStatementAtPosition(document, position);
    if (!statementRange) {
        return undefined;
    }

    const statementText = document.getText(statementRange);
    const cursorOffset = document.offsetAt(position) - document.offsetAt(statementRange.start);

    const selectMatch = statementText.match(/\bSELECT\b/i);
    const fromMatch = statementText.match(/\bFROM\b/i);
    if (!selectMatch || !fromMatch || selectMatch.index === undefined || fromMatch.index === undefined) {
        return undefined;
    }

    const selectEndOffset = selectMatch.index + selectMatch[0].length;
    const fromStartOffset = fromMatch.index;
    if (cursorOffset <= selectEndOffset || cursorOffset > fromStartOffset) {
        return undefined;
    }

    const tableName = parseTableFromFromClause(statementText.substring(fromStartOffset));
    if (!tableName) {
        return undefined;
    }

    const selectListText = statementText.substring(selectEndOffset, fromStartOffset);
    const trimmedSelectList = selectListText.trim();
    const hasExistingColumns = trimmedSelectList.length > 0 && trimmedSelectList !== "*";

    const textBeforeCursorInSelectList = statementText.substring(selectEndOffset, cursorOffset);
    const partialMatch = textBeforeCursorInSelectList.match(/(?:^|[,\s])([`"]?[\w]*)$/);
    const partialColumn = (partialMatch?.[1] || "").replace(/[`"]/g, "");
    const textBeforePartial = textBeforeCursorInSelectList.substring(
        0,
        textBeforeCursorInSelectList.length - partialColumn.length,
    );
    const columnInsertPrefix = getColumnInsertPrefix(textBeforePartial, hasExistingColumns);

    const partialStartInStatement = selectEndOffset + textBeforeCursorInSelectList.length - partialColumn.length;
    const partialStart = document.positionAt(document.offsetAt(statementRange.start) + partialStartInStatement);
    const partialRange = new vscode.Range(partialStart, position);

    const selectListStart = document.positionAt(document.offsetAt(statementRange.start) + selectEndOffset);
    const selectListEnd = document.positionAt(document.offsetAt(statementRange.start) + fromStartOffset);
    const selectListRange = new vscode.Range(selectListStart, selectListEnd);

    return {
        tableName,
        partialColumn,
        selectListRange,
        partialRange,
        hasExistingColumns,
        columnInsertPrefix,
    };
}

function getColumnInsertPrefix(textBeforePartial: string, hasExistingColumns: boolean): string {
    if (!hasExistingColumns) {
        return "";
    }
    const trimmed = textBeforePartial.trim();
    if (!trimmed || trimmed === "*") {
        return "";
    }
    return /,\s*$/.test(textBeforePartial) ? "" : ", ";
}

export function getConnectionCacheKey(connection: IConnection): string {
    return [connection.host, connection.port, connection.database, connection.user].join("|");
}
