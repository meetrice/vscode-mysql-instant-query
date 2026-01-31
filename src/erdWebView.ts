import * as vscode from "vscode";
import { Utility } from "./common/utility";
import { TableNode } from "./model/tableNode";
import { Global } from "./common/global";
import * as mysql from "mysql2";

interface TableData {
    tableName: string;
    columns: ColumnData[];
    x: number;
    y: number;
    width: number;
    height: number;
    database?: string;
    comment?: string;
}

interface ColumnData {
    name: string;
    type: string;
    isPrimaryKey: boolean;
    isForeignKey: boolean;
    references?: {
        table: string;
        column: string;
    };
    comment?: string;
}

interface Relationship {
    fromTable: string;
    fromColumn: string;
    toTable: string;
    toColumn: string;
    type: 'one-to-one' | 'one-to-many' | 'many-to-many';
}

interface MerdFileData {
    version: string;
    canvas: {
        width: number;
        height: number;
        zoom: number;
        panX: number;
        panY: number;
    };
    tables: TableData[];
    relationships: Relationship[];
}

export class ErdWebView {
    private static panels: Map<string, vscode.WebviewPanel> = new Map();
    private static tableData: Map<string, TableData> = new Map();
    private static relationships: Relationship[] = [];

    public static async showTableErd(tableNode: TableNode, currentDatabase: string) {
        const tableName = tableNode.table;
        const database = currentDatabase;

        const connection = Global.activeConnection;
        if (!connection) {
            vscode.window.showWarningMessage("No active connection");
            return;
        }

        try {
            // Get table structure with column comments from INFORMATION_SCHEMA
            const columnQuery = `
                SELECT
                    COLUMN_NAME as Field,
                    COLUMN_TYPE as Type,
                    COLUMN_KEY as \`Key\`,
                    COLUMN_COMMENT as Comment,
                    EXTRA as Extra
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = '${database}'
                AND TABLE_NAME = '${tableName}'
                ORDER BY ORDINAL_POSITION;
            `;
            const conn1 = Utility.createConnection(connection);
            const results: any[] = await Utility.queryPromise(conn1, columnQuery);

            if (!results || results.length === 0) {
                vscode.window.showWarningMessage(`Failed to get table structure for ${tableName}`);
                return;
            }

            // Get table comment
            const tableCommentQuery = `
                SELECT TABLE_COMMENT
                FROM INFORMATION_SCHEMA.TABLES
                WHERE TABLE_SCHEMA = '${database}'
                AND TABLE_NAME = '${tableName}';
            `;
            const conn2 = Utility.createConnection(connection);
            const tableCommentResult: any[] = await Utility.queryPromise(conn2, tableCommentQuery);
            const tableComment = tableCommentResult && tableCommentResult.length > 0 ? tableCommentResult[0].TABLE_COMMENT || '' : '';

            // Parse table structure
            const columns: ColumnData[] = [];
            for (const row of results) {
                const field = row.Field;
                const type = row.Type;
                const key = row.Key || '';
                const comment = row.Comment || '';

                console.log('[ERD] Column:', field, 'Type:', type, 'Comment:', comment);

                columns.push({
                    name: field,
                    type: type,
                    isPrimaryKey: key === 'PRI',
                    isForeignKey: key === 'MUL' || key === 'FOR',
                    comment: comment
                });
            }

            // Get foreign keys
            const fkQuery = `
                SELECT
                    COLUMN_NAME,
                    REFERENCED_TABLE_NAME,
                    REFERENCED_COLUMN_NAME
                FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
                WHERE TABLE_SCHEMA = '${database}'
                AND TABLE_NAME = '${tableName}'
                AND REFERENCED_TABLE_NAME IS NOT NULL;
            `;

            const conn3 = Utility.createConnection(connection);
            const fkResults: any[] = await Utility.queryPromise(conn3, fkQuery);

            if (fkResults && fkResults.length > 0) {
                for (const row of fkResults) {
                    const col = columns.find(c => c.name === row.COLUMN_NAME);
                    if (col) {
                        col.isForeignKey = true;
                        col.references = {
                            table: row.REFERENCED_TABLE_NAME,
                            column: row.REFERENCED_COLUMN_NAME
                        };

                        // Add relationship
                        ErdWebView.relationships.push({
                            fromTable: tableName,
                            fromColumn: row.COLUMN_NAME,
                            toTable: row.REFERENCED_TABLE_NAME,
                            toColumn: row.REFERENCED_COLUMN_NAME,
                            type: 'one-to-many'
                        });
                    }
                }
            }

            // Calculate table dimensions
            const columnWidth = 220;
            const rowHeight = 30;
            const headerHeight = 40;
            const padding = 10;

            // Find a non-overlapping position
            const position = ErdWebView.findNonOverlappingPosition(tableName, database, columnWidth, headerHeight + columns.length * rowHeight + padding * 2);

            const tableData: TableData = {
                tableName: tableName,
                columns: columns,
                x: position.x,
                y: position.y,
                width: columnWidth,
                height: headerHeight + columns.length * rowHeight + padding * 2,
                database: database,
                comment: tableComment
            };

            ErdWebView.tableData.set(`${database}.${tableName}`, tableData);

            // Also load related tables
            await ErdWebView.loadRelatedTables(database, tableName, columns, connection);

            // Use single global ERD panel
            let panel = Array.from(ErdWebView.panels.values())[0];

            if (!panel) {
                panel = vscode.window.createWebviewPanel(
                    'mysqlErd',
                    `ERD`,
                    vscode.ViewColumn.One,
                    {
                        enableScripts: true,
                        retainContextWhenHidden: true,
                        localResourceRoots: []
                    }
                );

                // Handle messages from webview
                panel.webview.onDidReceiveMessage(async (message) => {
                    switch (message.command) {
                        case 'save':
                            // Update relationships from current webview state
                            if (message.relationships) {
                                ErdWebView.relationships = message.relationships;
                            }
                            await ErdWebView.saveToFile();
                            break;
                        case 'open':
                            await ErdWebView.openFromFile();
                            break;
                    }
                }, undefined);

                panel.onDidDispose(() => {
                    ErdWebView.panels.clear();
                    ErdWebView.tableData.clear();
                    ErdWebView.relationships = [];
                });

                ErdWebView.panels.set('global', panel);
            } else {
                panel.reveal();
            }

            panel.webview.html = ErdWebView.getWebviewContent(database, tableName);

        } catch (error) {
            vscode.window.showErrorMessage(`Error loading ERD: ${error}`);
        }
    }

    private static async loadRelatedTables(database: string, tableName: string, columns: ColumnData[], connection: any) {
        // Get foreign key tables
        const foreignKeys = columns.filter(c => c.isForeignKey && c.references);

        for (const fk of foreignKeys) {
            if (!fk.references) continue;

            const refTable = fk.references.table;
            const refTableKey = `${database}.${refTable}`;

            if (ErdWebView.tableData.has(refTableKey)) continue;

            try {
                // Get table structure with column comments from INFORMATION_SCHEMA
                const columnQuery = `
                    SELECT
                        COLUMN_NAME as Field,
                        COLUMN_TYPE as Type,
                        COLUMN_KEY as \`Key\`,
                        COLUMN_COMMENT as Comment,
                        EXTRA as Extra
                    FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_SCHEMA = '${database}'
                    AND TABLE_NAME = '${refTable}'
                    ORDER BY ORDINAL_POSITION;
                `;
                const conn1 = Utility.createConnection(connection);
                const results: any[] = await Utility.queryPromise(conn1, columnQuery);

                if (!results || results.length === 0) continue;

                // Get table comment
                const tableCommentQuery = `
                    SELECT TABLE_COMMENT
                    FROM INFORMATION_SCHEMA.TABLES
                    WHERE TABLE_SCHEMA = '${database}'
                    AND TABLE_NAME = '${refTable}';
                `;
                const conn2 = Utility.createConnection(connection);
                const tableCommentResult: any[] = await Utility.queryPromise(conn2, tableCommentQuery);
                const tableComment = tableCommentResult && tableCommentResult.length > 0 ? tableCommentResult[0].TABLE_COMMENT || '' : '';

                const refColumns: ColumnData[] = [];
                for (const row of results) {
                    const field = row.Field;
                    const type = row.Type;
                    const key = row.Key || '';
                    const comment = row.Comment || '';

                    refColumns.push({
                        name: field,
                        type: type,
                        isPrimaryKey: key === 'PRI',
                        isForeignKey: key === 'MUL' || key === 'FOR',
                        comment: comment
                    });
                }

                const columnWidth = 220;
                const rowHeight = 30;
                const headerHeight = 40;
                const padding = 10;

                // Find a non-overlapping position for related table
                const position = ErdWebView.findNonOverlappingPosition(refTable, database, columnWidth, headerHeight + refColumns.length * rowHeight + padding * 2);

                ErdWebView.tableData.set(refTableKey, {
                    tableName: refTable,
                    columns: refColumns,
                    x: position.x,
                    y: position.y,
                    width: columnWidth,
                    height: headerHeight + refColumns.length * rowHeight + padding * 2,
                    database: database,
                    comment: tableComment
                });

            } catch (error) {
                console.error(`Error loading related table ${refTable}:`, error);
            }
        }
    }

    private static findNonOverlappingPosition(tableName: string, database: string, width: number, height: number): { x: number; y: number } {
        const existingTables = Array.from(ErdWebView.tableData.values());
        const startX = 100;
        const startY = 100;
        const gap = 50; // Gap between tables

        // If no tables exist, return default position
        if (existingTables.length === 0) {
            return { x: startX, y: startY };
        }

        // Try different positions
        let x = startX;
        let y = startY;
        let attempts = 0;
        const maxAttempts = 100;

        while (attempts < maxAttempts) {
            let overlaps = false;

            for (const existing of existingTables) {
                // Check if this position would overlap with existing table
                if (!(x + width < existing.x ||
                      x > existing.x + existing.width ||
                      y + height < existing.y ||
                      y > existing.y + existing.height)) {
                    overlaps = true;
                    break;
                }
            }

            if (!overlaps) {
                return { x, y };
            }

            // Try next position in a grid pattern
            attempts++;
            const gridCols = 3;
            const col = attempts % gridCols;
            const row = Math.floor(attempts / gridCols);
            x = startX + col * (width + gap);
            y = startY + row * (height + gap);
        }

        // If we couldn't find a non-overlapping position, return a position far to the right
        return { x: startX + existingTables.length * (width + gap), y: startY };
    }

    public static async saveToFile() {
        if (ErdWebView.tableData.size === 0) {
            vscode.window.showWarningMessage("No ERD data to save");
            return;
        }

        const uri = await vscode.window.showSaveDialog({
            filters: {
                'MERD Files': ['merd']
            },
            defaultUri: vscode.Uri.file('erd.merd')
        });

        if (!uri) {
            return;
        }

        try {
            // Get current canvas state from the webview
            const panel = Array.from(ErdWebView.panels.values())[0];
            if (!panel) {
                vscode.window.showWarningMessage("No ERD panel open");
                return;
            }

            // Get canvas dimensions from tables
            const tables = Array.from(ErdWebView.tableData.values());
            let maxX = 0, maxY = 0;
            tables.forEach(table => {
                maxX = Math.max(maxX, table.x + table.width);
                maxY = Math.max(maxY, table.y + table.height);
            });

            const merdData: MerdFileData = {
                version: "1.0",
                canvas: {
                    width: maxX + 100,
                    height: maxY + 100,
                    zoom: 1,
                    panX: 0,
                    panY: 0
                },
                tables: tables,
                relationships: ErdWebView.relationships
            };

            const json = JSON.stringify(merdData, null, 2);
            const data = Buffer.from(json, 'utf-8');

            await vscode.workspace.fs.writeFile(uri, data);
            vscode.window.showInformationMessage(`ERD saved to ${uri.fsPath}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Error saving ERD: ${error}`);
        }
    }

    public static async openFromFile() {
        const uri = await vscode.window.showOpenDialog({
            filters: {
                'MERD Files': ['merd']
            },
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false
        });

        if (!uri || uri.length === 0) {
            return;
        }

        try {
            const fileData = await vscode.workspace.fs.readFile(uri[0]);
            const json = Buffer.from(fileData).toString('utf-8');
            const merdData: MerdFileData = JSON.parse(json);

            // Validate version
            if (!merdData.version || merdData.version !== "1.0") {
                vscode.window.showWarningMessage("Unsupported MERD file version");
                return;
            }

            // Clear existing data
            ErdWebView.tableData.clear();
            ErdWebView.relationships = [];

            // Load tables
            merdData.tables.forEach(table => {
                ErdWebView.tableData.set(`${table.database || ''}.${table.tableName}`, table);
            });

            // Load relationships
            ErdWebView.relationships = merdData.relationships || [];

            // Create or reuse panel
            let panel = Array.from(ErdWebView.panels.values())[0];
            if (!panel) {
                panel = vscode.window.createWebviewPanel(
                    'mysqlErd',
                    `ERD - ${uri[0].fsPath}`,
                    vscode.ViewColumn.One,
                    {
                        enableScripts: true,
                        retainContextWhenHidden: true,
                        localResourceRoots: []
                    }
                );

                // Handle messages from webview for open file panel too
                panel.webview.onDidReceiveMessage(async (message) => {
                    switch (message.command) {
                        case 'save':
                            // Update relationships from current webview state
                            if (message.relationships) {
                                ErdWebView.relationships = message.relationships;
                            }
                            await ErdWebView.saveToFile();
                            break;
                        case 'open':
                            await ErdWebView.openFromFile();
                            break;
                    }
                }, undefined);

                panel.onDidDispose(() => {
                    ErdWebView.panels.clear();
                    ErdWebView.tableData.clear();
                    ErdWebView.relationships = [];
                });

                ErdWebView.panels.set('global', panel);
            } else {
                panel.reveal();
            }

            // Render with loaded data, use first table as main table
            const mainTable = merdData.tables.length > 0 ? merdData.tables[0].tableName : '';
            const database = merdData.tables.length > 0 ? (merdData.tables[0].database || '') : '';

            panel.webview.html = ErdWebView.getWebviewContent(database, mainTable);
            vscode.window.showInformationMessage(`ERD loaded from ${uri[0].fsPath}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Error opening ERD: ${error}`);
        }
    }

    private static getWebviewContent(database: string, mainTable: string): string {
        const tables = Array.from(ErdWebView.tableData.values());
        const relationships = ErdWebView.relationships;

        // Build HTML
        let html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ERD</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            overflow: hidden;
            cursor: grab;
        }
        body.panning {
            cursor: grabbing;
        }
        #canvas-container {
            width: 100%;
            height: 100vh;
            overflow: hidden;
            position: relative;
        }
        #canvas {
            width: 100%;
            height: 100%;
            position: absolute;
            transform-origin: 0 0;
            transition: transform 0.1s ease-out;
        }
        svg {
            position: absolute; top: 0; left: 0; width: 100%; height: 100%;
            pointer-events: none;
            z-index: 1;
        }
        .table-node {
            position: absolute;
            background-color: var(--vscode-editor-background);
            border: 2px solid var(--vscode-panel-border);
            border-radius: 8px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            cursor: move;
            user-select: none;
            transition: box-shadow 0.2s, border-color 0.2s;
        }
        .table-node:hover {
            box-shadow: 0 0 0 3px rgba(0, 122, 204, 0.3);
        }
        .table-node.selected {
            box-shadow: 0 0 0 3px rgba(0, 122, 204, 0.5);
            border-color: #007acc;
        }
        .table-node.main-table {
            border-color: #007acc;
        }
        .table-header {
            background: linear-gradient(135deg, #007acc 0%, #005a9e 100%);
            color: white;
            padding: 12px;
            font-weight: 600;
            font-size: 14px;
            border-radius: 6px 6px 0 0;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .table-header.related {
            background: linear-gradient(135deg, #4caf50 0%, #388e3c 100%);
        }
        .table-header-left {
            display: flex;
            align-items: center;
            gap: 8px;
            flex: 1;
        }
        .table-comment {
            font-size: 11px;
            color: rgba(255, 255, 255, 0.8);
            font-weight: normal;
            margin-left: 8px;
        }
        .toggle-comments-btn {
            background: rgba(255, 255, 255, 0.2);
            border: 1px solid rgba(255, 255, 255, 0.3);
            border-radius: 4px;
            padding: 2px 8px;
            font-size: 12px;
            cursor: pointer;
            transition: background 0.2s;
        }
        .toggle-comments-btn:hover {
            background: rgba(255, 255, 255, 0.3);
        }
        .table-body { padding: 8px; }
        .column-row {
            display: flex;
            align-items: center;
            padding: 6px 8px;
            border-bottom: 1px solid var(--vscode-widget-border);
            font-size: 13px;
            position: relative;
        }
        .column-row:last-child { border-bottom: none; }
        .column-icon { width: 20px; margin-right: 8px; text-align: center; }
        .pk-icon { color: #ffd700; }
        .fk-icon { color: #4caf50; }
        .column-name {
            flex: 1;
            font-weight: 500;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .column-type {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .column-comment {
            display: inline-block;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-left: 8px;
            opacity: 0.8;
            flex-shrink: 0;
        }
        .hide-comments .column-comment,
        .column-row.hide-comments .column-comment {
            display: none;
        }
        .connection-point {
            position: absolute;
            width: 10px;
            height: 10px;
            background-color: #007acc;
            border-radius: 50%;
            opacity: 0;
            transition: opacity 0.2s;
            pointer-events: auto;
            cursor: crosshair;
            z-index: 10;
        }
        .table-node:hover .connection-point,
        .table-node.selected .connection-point {
            opacity: 0.6;
        }
        .connection-point:hover {
            opacity: 1 !important;
            transform: scale(1.3);
        }
        .connection-point.dragging {
            opacity: 1 !important;
            background-color: #ff6b6b;
            transform: scale(1.5);
        }
        /* Table connection points on all four sides */
        .table-connector-top {
            position: absolute;
            top: -7px;
            left: 50%;
            transform: translateX(-50%);
        }
        .table-connector-bottom {
            position: absolute;
            bottom: -7px;
            left: 50%;
            transform: translateX(-50%);
        }
        .table-connector-left {
            position: absolute;
            left: -7px;
            top: 50%;
            transform: translateY(-50%);
        }
        .table-connector-right {
            position: absolute;
            right: -7px;
            top: 50%;
            transform: translateY(-50%);
        }
        .column-connector-left {
            position: absolute;
            left: 2px;
            top: 50%;
            transform: translateY(-50%);
        }
        .column-connector-right {
            position: absolute;
            right: 2px;
            top: 50%;
            transform: translateY(-50%);
        }
        /* Resize handle */
        .resize-handle {
            position: absolute;
            right: 0;
            top: 0;
            bottom: 0;
            width: 8px;
            cursor: ew-resize;
            background: transparent;
            z-index: 5;
        }
        .resize-handle:hover,
        .table-node:hover .resize-handle {
            background: rgba(0, 122, 204, 0.2);
        }
        .resize-handle.dragging {
            background: rgba(0, 122, 204, 0.4);
        }
        .relationship-line {
            stroke: #007acc;
            stroke-width: 2;
            fill: none;
            cursor: pointer;
            transition: all 0.3s ease;
            pointer-events: none;
        }
        .relationship-hit-area {
            stroke: transparent;
            stroke-width: 20;
            fill: none;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        .relationship-hit-area:hover {
            stroke-width: 25;
            stroke: rgba(0, 122, 204, 0.1);
        }
        .relationship-hit-area.selected {
            stroke: rgba(255, 107, 107, 0.2);
            stroke-width: 28;
            filter: drop-shadow(0 0 8px rgba(255, 107, 107, 0.4));
        }
        .relationship-line:hover {
            stroke-width: 4;
            stroke: #0098ff;
            filter: drop-shadow(0 0 6px rgba(0, 152, 255, 0.5));
        }
        .relationship-line.selected {
            stroke: #ff6b6b;
            stroke-width: 5;
            filter: drop-shadow(0 0 10px rgba(255, 107, 107, 0.8));
            animation: pulse-line 2s ease-in-out infinite;
        }
        @keyframes pulse-line {
            0%, 100% {
                stroke-opacity: 1;
                filter: drop-shadow(0 0 10px rgba(255, 107, 107, 0.8));
            }
            50% {
                stroke-opacity: 0.7;
                filter: drop-shadow(0 0 15px rgba(255, 107, 107, 1));
            }
        }
        .relationship-arrow { fill: #007acc; transition: all 0.3s ease; }
        .relationship-arrow.one-to-one {
            fill: #007acc;
        }
        .relationship-arrow.one-to-many {
            fill: #28a745;
        }
        .relationship-arrow.many-to-many {
            fill: #ffc107;
        }
        .relationship-arrow.selected {
            filter: drop-shadow(0 0 6px rgba(255, 107, 107, 0.8));
        }
        .relationship-start-marker {
            fill: #007acc;
            transition: all 0.3s ease;
        }
        .relationship-start-marker.one-to-one {
            fill: #007acc;
        }
        .relationship-start-marker.one-to-many {
            fill: #28a745;
        }
        .relationship-start-marker.many-to-many {
            fill: #ffc107;
        }
        .relationship-start-marker.selected {
            filter: drop-shadow(0 0 6px rgba(255, 107, 107, 0.8));
        }
        /* Relationship context menu */
        .relationship-context-menu {
            position: fixed;
            background: var(--vscode-menu-background);
            border: 1px solid var(--vscode-menu-border);
            border-radius: 6px;
            padding: 8px 0;
            min-width: 200px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            z-index: 2000;
            display: none;
        }
        .relationship-context-menu-item {
            padding: 8px 16px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
            color: var(--vscode-menu-foreground);
            font-size: 13px;
            transition: background 0.1s;
        }
        .relationship-context-menu-item:hover {
            background: var(--vscode-menu-selectionBackground);
        }
        .relationship-context-menu-item.danger {
            color: #ff6b6b;
        }
        .relationship-context-menu-separator {
            height: 1px;
            background: var(--vscode-menu-separatorBackground);
            margin: 4px 0;
        }

        /* Zoom controls */
        .zoom-controls {
            position: fixed;
            bottom: 20px;
            right: 20px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            z-index: 1000;
        }
        .zoom-btn {
            width: 40px;
            height: 40px;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-button-border);
            border-radius: 6px;
            color: var(--vscode-editor-foreground);
            font-size: 20px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background 0.2s;
        }
        .zoom-btn:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }
        .zoom-level {
            position: fixed;
            bottom: 170px;
            right: 20px;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 6px 10px;
            font-size: 12px;
            color: var(--vscode-editor-foreground);
            z-index: 1000;
        }
        /* Action buttons */
        .action-buttons {
            position: fixed;
            top: 20px;
            right: 20px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            z-index: 1000;
        }
        .action-btn {
            padding: 8px 16px;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-button-border);
            border-radius: 6px;
            color: var(--vscode-editor-foreground);
            font-size: 13px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: background 0.2s;
        }
        .action-btn:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }
        /* Context menu */
        .context-menu {
            position: fixed;
            display: none;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            z-index: 10000;
            min-width: 150px;
        }
        .context-menu-item {
            padding: 8px 16px;
            cursor: pointer;
            font-size: 13px;
            color: var(--vscode-editor-foreground);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .context-menu-item:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }
        .context-menu-item.danger {
            color: var(--vscode-errorForeground);
        }
        .context-menu-separator {
            height: 1px;
            background-color: var(--vscode-panel-border);
            margin: 4px 0;
        }
    </style>
</head>
<body>
    <div id="canvas-container">
        <div id="canvas">
            <svg id="relationships"></svg>
`;

        // Add table nodes
        for (const table of tables) {
            html += ErdWebView.renderTableNode(table, table.tableName === mainTable);
        }

        html += `        </div>
    </div>

    <!-- Zoom controls -->
    <div class="zoom-controls">
        <button class="zoom-btn" id="zoomInBtn" title="Zoom In">+</button>
        <button class="zoom-btn" id="zoomOutBtn" title="Zoom Out">−</button>
        <button class="zoom-btn" id="resetZoomBtn" title="Reset">⟲</button>
    </div>
    <div class="zoom-level" id="zoomLevel">100%</div>

    <!-- Action buttons -->
    <div class="action-buttons">
        <button class="action-btn" id="saveBtn" title="Save ERD to file">💾 Save</button>
        <button class="action-btn" id="openBtn" title="Open ERD from file">📂 Open</button>
    </div>

    <!-- Context menu -->
    <div class="context-menu" id="contextMenu">
        <div class="context-menu-item danger" id="ctxDelete">🗑️ Delete</div>
    </div>

    <!-- Relationship context menu -->
    <div class="relationship-context-menu" id="relationshipContextMenu">
        <div class="relationship-context-menu-item" id="relTypeOneToOne">1:1 一对一</div>
        <div class="relationship-context-menu-item" id="relTypeOneToMany">1:N 一对多</div>
        <div class="relationship-context-menu-item" id="relTypeManyToMany">N:N 多对多</div>
        <div class="relationship-context-menu-separator"></div>
        <div class="relationship-context-menu-item danger" id="relDelete">🗑️ 删除关系</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const tables = ${JSON.stringify(tables)};
        const relationships = ${JSON.stringify(relationships)};

        let zoom = 1;
        let selectedTable = null;
        let isDraggingConnection = false;
        let connectionStartPoint = null;
        let tempLine = null;
        let panX = 0;
        let panY = 0;
        let isPanning = false;
        let panStartX = 0;
        let panStartY = 0;

        function updateZoom() {
            updateCanvasTransform();
            document.getElementById('zoomLevel').textContent = Math.round(zoom * 100) + '%';
        }

        function updateCanvasTransform() {
            const canvas = document.getElementById('canvas');
            canvas.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + zoom + ')';
        }

        // Initialize canvas panning
        function initCanvasPanning() {
            const container = document.getElementById('canvas-container');

            container.addEventListener('mousedown', function(e) {
                // Only pan if clicking on background, not on tables or controls
                if (e.target === container || e.target === document.getElementById('canvas')) {
                    isPanning = true;
                    panStartX = e.clientX - panX;
                    panStartY = e.clientY - panY;
                    document.body.classList.add('panning');
                }
            });

            document.addEventListener('mousemove', function(e) {
                if (isPanning) {
                    panX = e.clientX - panStartX;
                    panY = e.clientY - panStartY;
                    updateCanvasTransform();
                }
            });

            document.addEventListener('mouseup', function() {
                if (isPanning) {
                    isPanning = false;
                    document.body.classList.remove('panning');
                }
            });
        }

        document.getElementById('zoomInBtn').addEventListener('click', function() {
            zoom = Math.min(zoom + 0.1, 2);
            updateZoom();
        });

        document.getElementById('zoomOutBtn').addEventListener('click', function() {
            zoom = Math.max(zoom - 0.1, 0.3);
            updateZoom();
        });

        document.getElementById('resetZoomBtn').addEventListener('click', function() {
            zoom = 1;
            updateZoom();
        });

        // Save button - send current state to extension
        document.getElementById('saveBtn').addEventListener('click', function() {
            vscode.postMessage({
                command: 'save',
                relationships: relationships
            });
        });

        // Open button - trigger file open dialog
        document.getElementById('openBtn').addEventListener('click', function() {
            vscode.postMessage({
                command: 'open'
            });
        });

        function toggleComments(tableNode) {
            console.log('[toggleComments] Function called');
            console.log('[toggleComments] tableNode:', tableNode);

            const tableBody = tableNode.querySelector('.table-body');
            console.log('[toggleComments] tableBody:', tableBody);

            const columnRows = tableBody.querySelectorAll('.column-row');
            console.log('[toggleComments] columnRows found:', columnRows.length);

            const isHidden = tableBody.classList.toggle('hide-comments');
            console.log('[toggleComments] isHidden:', isHidden);
            console.log('[toggleComments] tableBody.classList after toggle:', tableBody.classList.toString());

            const btn = tableNode.querySelector('.toggle-comments-btn');
            console.log('[toggleComments] btn:', btn);

            if (isHidden) {
                console.log('[toggleComments] Hiding comments - setting button to 📋');
                btn.textContent = '📋';
                // Add hide-comments class to each column-row
                columnRows.forEach(function(row) {
                    row.classList.add('hide-comments');
                });
            } else {
                console.log('[toggleComments] Showing comments - setting button to 📝');
                btn.textContent = '📝';
                // Remove hide-comments class from each column-row
                columnRows.forEach(function(row) {
                    row.classList.remove('hide-comments');
                });
            }

            console.log('[toggleComments] Final columnRows classes:');
            columnRows.forEach(function(row, index) {
                console.log('[toggleComments]   Row', index, 'classes:', row.classList.toString());
            });

            drawRelationships();
        }

        function selectTable(tableNode) {
            if (selectedTable && selectedTable !== tableNode) {
                selectedTable.classList.remove('selected');
            }

            selectedTable = tableNode;
            tableNode.classList.add('selected');
        }

        function drawRelationships() {
            const svg = document.getElementById('relationships');
            svg.innerHTML = '';

            // Get canvas container to transform coordinates
            const canvasContainer = document.getElementById('canvas-container');
            const containerRect = canvasContainer.getBoundingClientRect();

            relationships.forEach(function(rel, relIndex) {
                const fromTable = tables.find(function(t) { return t.tableName === rel.fromTable; });
                const toTable = tables.find(function(t) { return t.tableName === rel.toTable; });

                if (!fromTable || !toTable) return;

                const fromEl = document.querySelector('[data-table="' + rel.fromTable + '"]');
                const toEl = document.querySelector('[data-table="' + rel.toTable + '"]');

                if (!fromEl || !toEl) return;

                let fromX, fromY, toX, toY;

                // Check if this is a column-to-column relationship
                if (rel.fromColumn && rel.toColumn) {
                    // Find the specific column connection points
                    const fromColumnPoint = fromEl.querySelector('.column-connector-right[data-column="' + rel.fromColumn + '"]');
                    const toColumnPoint = toEl.querySelector('.column-connector-left[data-column="' + rel.toColumn + '"]');

                    if (fromColumnPoint && toColumnPoint) {
                        const fromPointRect = fromColumnPoint.getBoundingClientRect();
                        const toPointRect = toColumnPoint.getBoundingClientRect();

                        // Transform screen coordinates to canvas coordinates
                        fromX = (fromPointRect.left + fromPointRect.width / 2 - containerRect.left - panX) / zoom;
                        fromY = (fromPointRect.top + fromPointRect.height / 2 - containerRect.top - panY) / zoom;
                        toX = (toPointRect.left + toPointRect.width / 2 - containerRect.left - panX) / zoom;
                        toY = (toPointRect.top + toPointRect.height / 2 - containerRect.top - panY) / zoom;
                    } else {
                        // Fallback to table-level connection
                        const fromRect = fromEl.getBoundingClientRect();
                        const toRect = toEl.getBoundingClientRect();

                        fromX = (fromRect.right - containerRect.left - panX) / zoom;
                        fromY = (fromRect.top + fromRect.height / 2 - containerRect.top - panY) / zoom;
                        toX = (toRect.left - containerRect.left - panX) / zoom;
                        toY = (toRect.top + toRect.height / 2 - containerRect.top - panY) / zoom;
                    }
                } else {
                    // Table-level connection (no specific columns)
                    const fromRect = fromEl.getBoundingClientRect();
                    const toRect = toEl.getBoundingClientRect();

                    fromX = (fromRect.right - containerRect.left - panX) / zoom;
                    fromY = (fromRect.top + fromRect.height / 2 - containerRect.top - panY) / zoom;
                    toX = (toRect.left - containerRect.left - panX) / zoom;
                    toY = (toRect.top + toRect.height / 2 - containerRect.top - panY) / zoom;
                }

                const midX = (fromX + toX) / 2;
                const path = 'M ' + fromX + ' ' + fromY + ' C ' + midX + ' ' + fromY + ', ' + midX + ' ' + toY + ', ' + toX + ' ' + toY;

                // Create invisible thick line for easier clicking (hit area)
                const hitArea = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                hitArea.setAttribute('d', path);
                hitArea.setAttribute('class', 'relationship-hit-area');
                hitArea.setAttribute('data-rel-index', relIndex);
                hitArea.setAttribute('data-from-table', rel.fromTable);
                hitArea.setAttribute('data-to-table', rel.toTable);
                svg.appendChild(hitArea);

                // Create visible line with relationship data
                const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                line.setAttribute('d', path);
                line.setAttribute('class', 'relationship-line');
                line.setAttribute('data-rel-index', relIndex);
                line.setAttribute('data-from-table', rel.fromTable);
                line.setAttribute('data-to-table', rel.toTable);
                svg.appendChild(line);

                // Calculate angle for arrow rotation
                const angle = Math.atan2(toY - fromY, toX - fromX);

                // Draw start marker (from table) based on relationship type
                const startMarker = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                const startMarkerSize = 6;

                if (rel.type === 'one-to-one') {
                    // Single line for "one" (no marker)
                    // No start marker for one-to-one
                } else if (rel.type === 'one-to-many') {
                    // Single vertical line for "one"
                    const startPoints = calculatePerpendicularLine(fromX, fromY, angle, startMarkerSize, 'single');
                    startMarker.setAttribute('points', startPoints);
                    startMarker.setAttribute('class', 'relationship-start-marker one-to-many');
                    svg.appendChild(startMarker);
                } else if (rel.type === 'many-to-many') {
                    // Double vertical lines for "many"
                    const startPoints = calculatePerpendicularLine(fromX, fromY, angle, startMarkerSize, 'double');
                    startMarker.setAttribute('points', startPoints);
                    startMarker.setAttribute('class', 'relationship-start-marker many-to-many');
                    svg.appendChild(startMarker);
                }

                // Draw end marker (to table) based on relationship type
                const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                const arrowSize = 8;

                if (rel.type === 'one-to-one') {
                    // Single line for "one" (no arrow, just line)
                    const endPoints = calculatePerpendicularLine(toX, toY, angle, arrowSize, 'single');
                    arrow.setAttribute('points', endPoints);
                    arrow.setAttribute('class', 'relationship-arrow one-to-one');
                } else if (rel.type === 'one-to-many') {
                    // Crow's foot (triangle) for "many"
                    const endPoints = calculateCrowsFoot(toX, toY, angle, arrowSize);
                    arrow.setAttribute('points', endPoints);
                    arrow.setAttribute('class', 'relationship-arrow one-to-many');
                } else if (rel.type === 'many-to-many') {
                    // Double crow's foot for "many-to-many"
                    const endPoints = calculateDoubleCrowsFoot(toX, toY, angle, arrowSize);
                    arrow.setAttribute('points', endPoints);
                    arrow.setAttribute('class', 'relationship-arrow many-to-many');
                }

                svg.appendChild(arrow);

                // Add context menu event to hit area
                hitArea.addEventListener('contextmenu', function(e) {
                    e.preventDefault();
                    showRelationshipContextMenu(e, relIndex);
                });

                // Add click event to hit area to select relationship
                hitArea.addEventListener('click', function(e) {
                    e.stopPropagation();
                    selectRelationship(relIndex);
                });

                // Also add events to visible line for compatibility
                line.addEventListener('contextmenu', function(e) {
                    e.preventDefault();
                    showRelationshipContextMenu(e, relIndex);
                });

                line.addEventListener('click', function(e) {
                    e.stopPropagation();
                    selectRelationship(relIndex);
                });
            });
        }

        // Helper function to calculate perpendicular line markers (for "one")
        function calculatePerpendicularLine(x, y, angle, size, type) {
            const perpAngle = angle + Math.PI / 2;
            const halfSize = size / 2;

            if (type === 'single') {
                // Single perpendicular line
                const x1 = x - Math.cos(perpAngle) * halfSize;
                const y1 = y - Math.sin(perpAngle) * halfSize;
                const x2 = x + Math.cos(perpAngle) * halfSize;
                const y2 = y + Math.sin(perpAngle) * halfSize;
                return x1 + ',' + y1 + ' ' + x2 + ',' + y2;
            } else if (type === 'double') {
                // Double perpendicular lines
                const offset = 3;
                const x1 = (x - Math.cos(angle) * offset) - Math.cos(perpAngle) * halfSize;
                const y1 = (y - Math.sin(angle) * offset) - Math.sin(perpAngle) * halfSize;
                const x2 = (x - Math.cos(angle) * offset) + Math.cos(perpAngle) * halfSize;
                const y2 = (y - Math.sin(angle) * offset) + Math.sin(perpAngle) * halfSize;
                const x3 = (x + Math.cos(angle) * offset) - Math.cos(perpAngle) * halfSize;
                const y3 = (y + Math.sin(angle) * offset) - Math.sin(perpAngle) * halfSize;
                const x4 = (x + Math.cos(angle) * offset) + Math.cos(perpAngle) * halfSize;
                const y4 = (y + Math.sin(angle) * offset) + Math.sin(perpAngle) * halfSize;
                return x1 + ',' + y1 + ' ' + x2 + ',' + y2 + ' ' + x3 + ',' + y3 + ' ' + x4 + ',' + y4;
            }
        }

        // Helper function to calculate crow's foot (for "many")
        function calculateCrowsFoot(x, y, angle, size) {
            const angle1 = angle + Math.PI / 6;
            const angle2 = angle - Math.PI / 6;

            const x1 = x + Math.cos(angle) * size;
            const y1 = y + Math.sin(angle) * size;
            const x2 = x + Math.cos(angle1) * size;
            const y2 = y + Math.sin(angle1) * size;
            const x3 = x + Math.cos(angle2) * size;
            const y3 = y + Math.sin(angle2) * size;

            return x + ',' + y + ' ' + x1 + ',' + y1 + ' ' + x2 + ',' + y2 + ' ' + x3 + ',' + y3;
        }

        // Helper function to calculate double crow's foot (for "many-to-many")
        function calculateDoubleCrowsFoot(x, y, angle, size) {
            const offset = 4;
            const baseX = x - Math.cos(angle) * offset;
            const baseY = y - Math.sin(angle) * offset;

            const angle1 = angle + Math.PI / 6;
            const angle2 = angle - Math.PI / 6;

            const x1 = baseX + Math.cos(angle) * size;
            const y1 = baseY + Math.sin(angle) * size;
            const x2 = baseX + Math.cos(angle1) * size;
            const y2 = baseY + Math.sin(angle1) * size;
            const x3 = baseX + Math.cos(angle2) * size;
            const y3 = baseY + Math.sin(angle2) * size;

            return x + ',' + y + ' ' + baseX + ',' + baseY + ' ' + x1 + ',' + y1 + ' ' + x2 + ',' + y2 + ' ' + x3 + ',' + y3;
        }

        let selectedRelationshipIndex = -1;

        function selectRelationship(relIndex) {
            // Deselect all relationships (lines, hit areas, and markers)
            document.querySelectorAll('.relationship-line').forEach(function(line) {
                line.classList.remove('selected');
            });
            document.querySelectorAll('.relationship-hit-area').forEach(function(hitArea) {
                hitArea.classList.remove('selected');
            });
            document.querySelectorAll('.relationship-arrow').forEach(function(arrow) {
                arrow.classList.remove('selected');
            });
            document.querySelectorAll('.relationship-start-marker').forEach(function(marker) {
                marker.classList.remove('selected');
            });

            // Select clicked relationship
            const line = document.querySelector('.relationship-line[data-rel-index="' + relIndex + '"]');
            const hitArea = document.querySelector('.relationship-hit-area[data-rel-index="' + relIndex + '"]');

            // Find and select the arrows and markers for this relationship
            // We need to find the arrows in the SVG - they don't have data-rel-index, so we use order
            const svg = document.getElementById('relationships');
            const allElements = svg.querySelectorAll('path, polygon');
            let currentRelIndex = 0;
            let foundRelationship = false;

            allElements.forEach(function(el) {
                if (el.classList.contains('relationship-line')) {
                    if (foundRelationship) return;
                    currentRelIndex = parseInt(el.getAttribute('data-rel-index'));
                    if (currentRelIndex === relIndex) {
                        foundRelationship = true;
                    }
                } else if (foundRelationship && (el.classList.contains('relationship-arrow') || el.classList.contains('relationship-start-marker'))) {
                    el.classList.add('selected');
                }
            });

            if (line) {
                line.classList.add('selected');
            }
            if (hitArea) {
                hitArea.classList.add('selected');
            }
            selectedRelationshipIndex = relIndex;
        }

        let currentRelationshipIndex = -1;

        function showRelationshipContextMenu(e, relIndex) {
            const contextMenu = document.getElementById('relationshipContextMenu');
            contextMenu.style.left = e.clientX + 'px';
            contextMenu.style.top = e.clientY + 'px';
            contextMenu.style.display = 'block';
            currentRelationshipIndex = relIndex;
        }

        function initDraggable() {
            const canvasContainer = document.getElementById('canvas-container');
            let draggedElement = null;
            let offsetX = 0;
            let offsetY = 0;
            let isResizing = false;
            let resizeElement = null;
            let startX = 0;
            let startWidth = 0;

            document.querySelectorAll('.table-node').forEach(function(table) {
                // Handle resize
                const resizeHandle = document.createElement('div');
                resizeHandle.className = 'resize-handle';
                table.appendChild(resizeHandle);

                resizeHandle.addEventListener('mousedown', function(e) {
                    e.stopPropagation();
                    isResizing = true;
                    resizeElement = table;
                    startX = e.clientX;
                    startWidth = table.offsetWidth;
                    resizeHandle.classList.add('dragging');
                    table.style.zIndex = '1000';
                });

                // Right-click context menu
                table.addEventListener('contextmenu', function(e) {
                    e.preventDefault();

                    // Select this table
                    selectTable(table);
                    selectedTable = table;

                    // Show context menu at mouse position
                    const contextMenu = document.getElementById('contextMenu');
                    contextMenu.style.left = e.clientX + 'px';
                    contextMenu.style.top = e.clientY + 'px';
                    contextMenu.style.display = 'block';

                    // Store reference to the table for delete action
                    contextMenu.dataset.tableName = table.dataset.table;
                });

                table.addEventListener('mousedown', function(e) {
                    if (e.target.classList.contains('toggle-comments-btn')) return;
                    if (e.target.classList.contains('resize-handle')) return;
                    if (e.target.classList.contains('connection-point')) return;

                    draggedElement = table;
                    const rect = table.getBoundingClientRect();
                    offsetX = e.clientX - rect.left;
                    offsetY = e.clientY - rect.top;
                    table.style.zIndex = '1000';
                    selectTable(table);
                });

                // Toggle comments button
                const toggleBtn = table.querySelector('.toggle-comments-btn');
                console.log('[initDraggable] Found toggle button for table', table.dataset.table, ':', toggleBtn);
                if (toggleBtn) {
                    toggleBtn.addEventListener('click', function(e) {
                        console.log('[toggleBtn click] Button clicked!');
                        console.log('[toggleBtn click] Event:', e);
                        console.log('[toggleBtn click] Target:', e.target);
                        console.log('[toggleBtn click] Current target:', e.currentTarget);
                        e.stopPropagation();
                        console.log('[toggleBtn click] About to call toggleComments');
                        toggleComments(table);
                        console.log('[toggleBtn click] toggleComments returned');
                    });
                    console.log('[initDraggable] Button click listener attached for table', table.dataset.table);
                } else {
                    console.log('[initDraggable] ERROR: No toggle button found for table', table.dataset.table);
                }

                // Connection points mouse handlers
                table.querySelectorAll('.connection-point').forEach(function(point) {
                    point.addEventListener('mousedown', function(e) {
                        e.stopPropagation();
                        e.preventDefault();

                        const pointRect = point.getBoundingClientRect();
                        const canvasRect = canvas.getBoundingClientRect();

                        connectionStartPoint = {
                            table: point.dataset.table,
                            column: point.dataset.column,
                            x: (pointRect.left + pointRect.width / 2 - canvasRect.left) / zoom,
                            y: (pointRect.top + pointRect.height / 2 - canvasRect.top) / zoom
                        };

                        isDraggingConnection = true;
                        point.classList.add('dragging');

                        // Create temporary line
                        tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                        tempLine.setAttribute('class', 'relationship-line');
                        tempLine.style.stroke = '#ff6b6b';
                        tempLine.style.strokeDasharray = '5,5';
                        document.getElementById('relationships').appendChild(tempLine);
                    });

                    point.addEventListener('mouseup', function(e) {
                        if (isDraggingConnection && connectionStartPoint) {
                            const endPoint = {
                                table: point.dataset.table,
                                column: point.dataset.column
                            };

                            // Don't connect to same point
                            if (connectionStartPoint.table !== endPoint.table ||
                                connectionStartPoint.column !== endPoint.column) {

                                // Add new relationship
                                const newRel = {
                                    fromTable: connectionStartPoint.table,
                                    fromColumn: connectionStartPoint.column || '',
                                    toTable: endPoint.table,
                                    toColumn: endPoint.column || '',
                                    type: 'one-to-many'
                                };

                                relationships.push(newRel);
                                drawRelationships();
                            }
                        }
                    });
                });
            });

            document.addEventListener('mousemove', function(e) {
                // Handle table dragging
                if (draggedElement) {
                    const canvasRect = document.getElementById('canvas-container').getBoundingClientRect();
                    const x = (e.clientX - canvasRect.left - offsetX - panX) / zoom;
                    const y = (e.clientY - canvasRect.top - offsetY - panY) / zoom;

                    draggedElement.style.left = x + 'px';
                    draggedElement.style.top = y + 'px';
                    drawRelationships();
                }

                // Handle resizing
                if (isResizing && resizeElement) {
                    const deltaX = (e.clientX - startX) / zoom;
                    const newWidth = Math.max(150, startWidth + deltaX);
                    resizeElement.style.width = newWidth + 'px';
                    drawRelationships();
                }

                // Handle connection dragging
                if (isDraggingConnection && connectionStartPoint && tempLine) {
                    const canvasRect = document.getElementById('canvas-container').getBoundingClientRect();
                    const currentX = (e.clientX - canvasRect.left - panX) / zoom;
                    const currentY = (e.clientY - canvasRect.top - panY) / zoom;

                    const midX = (connectionStartPoint.x + currentX) / 2;
                    const path = 'M ' + connectionStartPoint.x + ' ' + connectionStartPoint.y +
                               ' L ' + currentX + ' ' + currentY;
                    tempLine.setAttribute('d', path);
                }
            });

            document.addEventListener('mouseup', function() {
                if (draggedElement) {
                    draggedElement.style.zIndex = '';
                    draggedElement = null;
                }

                if (isResizing) {
                    const handle = resizeElement?.querySelector('.resize-handle');
                    if (handle) handle.classList.remove('dragging');
                    if (resizeElement) resizeElement.style.zIndex = '';
                    isResizing = false;
                    resizeElement = null;
                }

                if (isDraggingConnection) {
                    // Remove dragging class from all connection points
                    document.querySelectorAll('.connection-point.dragging').forEach(function(p) {
                        p.classList.remove('dragging');
                    });

                    // Remove temp line
                    if (tempLine) {
                        tempLine.remove();
                        tempLine = null;
                    }

                    isDraggingConnection = false;
                    connectionStartPoint = null;
                }
            });

            // Click outside to deselect and hide context menu
            document.addEventListener('click', function(e) {
                // Hide context menu
                if (!e.target.closest('.context-menu')) {
                    document.getElementById('contextMenu').style.display = 'none';
                }
                // Hide relationship context menu
                if (!e.target.closest('.relationship-context-menu') && !e.target.closest('.relationship-line')) {
                    document.getElementById('relationshipContextMenu').style.display = 'none';
                }

                if (!e.target.closest('.table-node') && !e.target.closest('.zoom-controls')) {
                    if (selectedTable) {
                        selectedTable.classList.remove('selected');
                        selectedTable = null;
                    }
                }
            });

            // Context menu item handlers
            document.getElementById('ctxDelete').addEventListener('click', function() {
                const contextMenu = document.getElementById('contextMenu');
                const tableName = contextMenu.dataset.tableName;

                if (tableName) {
                    // Find and remove the table
                    const tableToRemove = document.querySelector('[data-table="' + tableName + '"]');
                    if (tableToRemove) {
                        // Remove relationships involving this table
                        const initialRelCount = relationships.length;
                        // Remove elements from const array using splice
                        for (let i = relationships.length - 1; i >= 0; i--) {
                            if (relationships[i].fromTable === tableName || relationships[i].toTable === tableName) {
                                relationships.splice(i, 1);
                            }
                        }

                        // Remove from tables array
                        const tableIndex = tables.findIndex(function(t) { return t.tableName === tableName; });
                        if (tableIndex !== -1) {
                            tables.splice(tableIndex, 1);
                        }

                        // Remove from DOM
                        tableToRemove.remove();

                        // Clear selection
                        if (selectedTable && selectedTable.dataset.table === tableName) {
                            selectedTable = null;
                        }

                        // Redraw relationships
                        drawRelationships();

                        console.log('[ContextMenu Delete] Removed table:', tableName, 'and', initialRelCount - relationships.length, 'relationships');
                    }
                }

                // Hide context menu
                contextMenu.style.display = 'none';
            });

            // Relationship context menu item handlers
            document.getElementById('relTypeOneToOne').addEventListener('click', function() {
                if (currentRelationshipIndex >= 0 && currentRelationshipIndex < relationships.length) {
                    relationships[currentRelationshipIndex].type = 'one-to-one';
                    drawRelationships();
                    console.log('[Relationship Menu] Changed to one-to-one');
                }
                document.getElementById('relationshipContextMenu').style.display = 'none';
            });

            document.getElementById('relTypeOneToMany').addEventListener('click', function() {
                if (currentRelationshipIndex >= 0 && currentRelationshipIndex < relationships.length) {
                    relationships[currentRelationshipIndex].type = 'one-to-many';
                    drawRelationships();
                    console.log('[Relationship Menu] Changed to one-to-many');
                }
                document.getElementById('relationshipContextMenu').style.display = 'none';
            });

            document.getElementById('relTypeManyToMany').addEventListener('click', function() {
                if (currentRelationshipIndex >= 0 && currentRelationshipIndex < relationships.length) {
                    relationships[currentRelationshipIndex].type = 'many-to-many';
                    drawRelationships();
                    console.log('[Relationship Menu] Changed to many-to-many');
                }
                document.getElementById('relationshipContextMenu').style.display = 'none';
            });

            document.getElementById('relDelete').addEventListener('click', function() {
                if (currentRelationshipIndex >= 0 && currentRelationshipIndex < relationships.length) {
                    const rel = relationships[currentRelationshipIndex];
                    console.log('[Relationship Menu] Deleting relationship:', rel.fromTable, '->', rel.toTable);
                    relationships.splice(currentRelationshipIndex, 1);
                    drawRelationships();
                }
                document.getElementById('relationshipContextMenu').style.display = 'none';
            });

            // Delete key handler - remove selected table
            document.addEventListener('keydown', function(e) {
                if (e.key === 'Delete' || e.key === 'Backspace') {
                    if (selectedTable) {
                        const tableName = selectedTable.dataset.table;

                        // Remove relationships involving this table
                        const initialRelCount = relationships.length;
                        // Remove elements from const array using splice
                        for (let i = relationships.length - 1; i >= 0; i--) {
                            if (relationships[i].fromTable === tableName || relationships[i].toTable === tableName) {
                                relationships.splice(i, 1);
                            }
                        }

                        // Remove from tables array
                        const tableIndex = tables.findIndex(function(t) { return t.tableName === tableName; });
                        if (tableIndex !== -1) {
                            tables.splice(tableIndex, 1);
                        }

                        // Remove from DOM
                        selectedTable.remove();
                        selectedTable = null;

                        // Redraw relationships
                        drawRelationships();

                        console.log('[Delete] Removed table:', tableName, 'and', initialRelCount - relationships.length, 'relationships');
                    }
                }
            });
        }

        // Initialize
        window.addEventListener('load', function() {
            console.log('[ERD Init] Page loaded');
            console.log('[ERD Init] Number of tables:', document.querySelectorAll('.table-node').length);
            console.log('[ERD Init] Number of toggle buttons:', document.querySelectorAll('.toggle-comments-btn').length);

            // Log each table and its button
            document.querySelectorAll('.table-node').forEach(function(table, index) {
                console.log('[ERD Init] Table', index, ':', table.dataset.table);
                const btn = table.querySelector('.toggle-comments-btn');
                console.log('[ERD Init]   Has button:', !!btn);
                console.log('[ERD Init]   Button text:', btn ? btn.textContent : 'N/A');
            });

            drawRelationships();
            initCanvasPanning();
            initDraggable();
            console.log('[ERD Init] Initialization complete');
        });

        window.addEventListener('resize', function() {
            drawRelationships();
        });
    </script>
</body>
</html>`;

        return html;
    }

    private static renderTableNode(table: TableData, isMainTable: boolean): string {
        let columns = '';
        console.log('[renderTableNode] Rendering table:', table.tableName);
        for (const col of table.columns) {
            console.log('[renderTableNode] Column:', col.name, 'Comment:', col.comment);
            let icon = '';
            if (col.isPrimaryKey) icon = '<span class="column-icon pk-icon">🔑</span>';
            else if (col.isForeignKey) icon = '<span class="column-icon fk-icon">🔗</span>';

            const comment = col.comment ? `<span class="column-comment">${this.escapeHtml(col.comment)}</span>` : '';
            console.log('[renderTableNode] Generated comment HTML:', comment ? comment.substring(0, 50) + '...' : '(empty)');

            columns += `
                <div class="column-row" data-column="${this.escapeHtml(col.name)}">
                    ${icon}
                    <span class="column-name">
                        ${this.escapeHtml(col.name)}
                        <div class="column-connector-left connection-point" data-table="${this.escapeHtml(table.tableName)}" data-column="${this.escapeHtml(col.name)}" title="${this.escapeHtml(col.name)} connector"></div>
                        <div class="column-connector-right connection-point" data-table="${this.escapeHtml(table.tableName)}" data-column="${this.escapeHtml(col.name)}" title="${this.escapeHtml(col.name)} connector"></div>
                    </span>
                    <span class="column-type">${this.escapeHtml(col.type)}</span>
                    ${comment}
                </div>
            `;
        }

        return `
            <div class="table-node ${isMainTable ? 'main-table' : ''}"
                 data-table="${this.escapeHtml(table.tableName)}"
                 style="left: ${table.x}px; top: ${table.y}px; width: ${table.width}px;">
                <div class="table-header">
                    <div class="table-header-left">
                        <span>${this.escapeHtml(table.tableName)}</span>
                        ${table.comment ? `<span class="table-comment">${this.escapeHtml(table.comment)}</span>` : ''}
                        ${isMainTable ? '<span>⭐</span>' : ''}
                    </div>
                    <button class="toggle-comments-btn" title="Toggle comments">📝</button>
                </div>
                <div class="table-body">
                    ${columns}
                </div>
                <!-- Connection points on all four sides -->
                <div class="table-connector-top connection-point" data-table="${this.escapeHtml(table.tableName)}" title="${this.escapeHtml(table.tableName)} top"></div>
                <div class="table-connector-bottom connection-point" data-table="${this.escapeHtml(table.tableName)}" title="${this.escapeHtml(table.tableName)} bottom"></div>
                <div class="table-connector-left connection-point" data-table="${this.escapeHtml(table.tableName)}" title="${this.escapeHtml(table.tableName)} left"></div>
                <div class="table-connector-right connection-point" data-table="${this.escapeHtml(table.tableName)}" title="${this.escapeHtml(table.tableName)} right"></div>
            </div>
        `;
    }

    private static escapeHtml(text: string): string {
        const map: { [key: string]: string } = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, (m) => map[m]);
    }
}
