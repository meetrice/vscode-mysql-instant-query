import * as vscode from "vscode";
import { DbDriver } from "./common/dbDriver";
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
    color?: string;
    borderWidth?: number;
    borderStyle?: string;
    backgroundColor?: string;
    zIndex?: number;
    opacity?: number;
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

interface CommentData {
    id: string;
    x: number;
    y: number;
    text: string;
    width?: number;
    height?: number;
}

interface TextLabelData {
    id: string;
    x: number;
    y: number;
    text: string;
    fontSize?: number;
    fontFamily?: string;
    color?: string;
    fontWeight?: string;
    fontStyle?: string;
}

interface VectorShapeData {
    id: string;
    type: string;
    x: number;
    y: number;
    width: number;
    height: number;
    x2?: number;
    y2?: number;
    stroke?: string;
    strokeWidth?: number;
    strokeDasharray?: string;
    fill?: string;
    zIndex?: number;
    opacity?: number;
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
    comments?: CommentData[];
    textLabels?: TextLabelData[];
    vectorShapes?: VectorShapeData[];
}

function escapeSqlString(value: string): string {
    return value.replace(/'/g, "''");
}

function isPostgresConnection(connection: any): boolean {
    return connection && connection.driver === "postgresql";
}

function isDuckDbConnection(connection: any): boolean {
    return connection && connection.driver === "duckdb";
}

function getDuckDbTableParts(database: string, tableName: string): { schema: string; table: string } {
    const parts = tableName.split(".");
    if (parts.length > 1) {
        return { schema: parts[0], table: parts.slice(1).join(".") };
    }
    return { schema: database || "main", table: tableName };
}

function isPrimaryKey(row: any): boolean {
    return row.COLUMN_KEY === 'PRI' || row.Key === 'PRI';
}

function isForeignKey(row: any): boolean {
    return row.COLUMN_KEY === 'MUL' || row.COLUMN_KEY === 'FOR' || row.Key === 'MUL' || row.Key === 'FOR';
}

export class ErdWebView {
    private static panels: Map<string, vscode.WebviewPanel> = new Map();
    private static tableData: Map<string, TableData> = new Map();
    public static relationships: Relationship[] = [];
    public static comments: CommentData[] = [];
    public static textLabels: TextLabelData[] = [];
    public static vectorShapes: VectorShapeData[] = [];
    private static currentPanel: vscode.WebviewPanel | null = null;
    private static undoStack: Array<{
        tables: TableData[];
        relationships: Relationship[];
        comments: CommentData[];
        textLabels: TextLabelData[];
        vectorShapes: VectorShapeData[];
    }> = [];
    private static readonly UNDO_MAX = 50;

    // Helper methods for external access
    public static clearInternalData() {
        ErdWebView.tableData.clear();
        ErdWebView.relationships = [];
        ErdWebView.comments = [];
        ErdWebView.textLabels = [];
        ErdWebView.vectorShapes = [];
    }

    private static clearUndoStack() {
        ErdWebView.undoStack = [];
    }

    /** Safe JSON for embedding in webview inline scripts. */
    private static jsonForWebviewScript(value: unknown): string {
        return JSON.stringify(value)
            .replace(/</g, '\\u003c')
            .replace(/>/g, '\\u003e')
            .replace(/&/g, '\\u0026')
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029');
    }

    private static pushUndoSnapshot(snapshot: {
        tables: TableData[];
        relationships: Relationship[];
        comments: CommentData[];
        textLabels: TextLabelData[];
        vectorShapes: VectorShapeData[];
    }) {
        if (!snapshot) {
            return;
        }
        const json = JSON.stringify(snapshot);
        const last = ErdWebView.undoStack[ErdWebView.undoStack.length - 1];
        if (last && JSON.stringify(last) === json) {
            return;
        }
        ErdWebView.undoStack.push(snapshot);
        if (ErdWebView.undoStack.length > ErdWebView.UNDO_MAX) {
            ErdWebView.undoStack.shift();
        }
    }

    private static async restoreFromSnapshot(snapshot: {
        tables: TableData[];
        relationships: Relationship[];
        comments: CommentData[];
        textLabels: TextLabelData[];
        vectorShapes: VectorShapeData[];
    }) {
        ErdWebView.clearInternalData();
        (snapshot.tables || []).forEach(table => {
            ErdWebView.loadTable(table);
        });
        ErdWebView.relationships = JSON.parse(JSON.stringify(snapshot.relationships || []));
        ErdWebView.comments = JSON.parse(JSON.stringify(snapshot.comments || []));
        ErdWebView.textLabels = JSON.parse(JSON.stringify(snapshot.textLabels || []));
        ErdWebView.vectorShapes = JSON.parse(JSON.stringify(snapshot.vectorShapes || []));

        const panel = Array.from(ErdWebView.panels.values())[0];
        if (panel) {
            panel.webview.html = ErdWebView.getWebviewContent('', '');
        }
    }

    private static async performUndo() {
        if (ErdWebView.undoStack.length === 0) {
            return;
        }
        const snapshot = ErdWebView.undoStack.pop()!;
        await ErdWebView.restoreFromSnapshot(snapshot);
    }

    public static loadTable(table: TableData) {
        ErdWebView.tableData.set(`${table.database || ''}.${table.tableName}`, table);
    }

    public static loadRelationships(relationships: Relationship[]) {
        ErdWebView.relationships = relationships;
    }

    private static stateSyncResolvers: Map<string, () => void> = new Map();

    private static findTableByName(tableName: string, database?: string): TableData | null {
        let found: TableData | null = null;
        ErdWebView.tableData.forEach((table) => {
            if (table.tableName === tableName) {
                if (!database || table.database === database) {
                    found = table;
                }
            }
        });
        return found;
    }

    private static applyWebviewTablesState(webviewTables: any[]) {
        webviewTables.forEach((webviewTable: any) => {
            const foundTable = ErdWebView.findTableByName(webviewTable.tableName, webviewTable.database);
            if (!foundTable) {
                return;
            }
            if (webviewTable.width !== undefined) {
                foundTable.width = webviewTable.width;
            }
            if (webviewTable.height !== undefined) {
                foundTable.height = webviewTable.height;
            }
            if (webviewTable.x !== undefined) {
                foundTable.x = webviewTable.x;
            }
            if (webviewTable.y !== undefined) {
                foundTable.y = webviewTable.y;
            }
            if (webviewTable.color !== undefined && webviewTable.color !== '') {
                foundTable.color = webviewTable.color;
            }
            if (webviewTable.borderWidth !== undefined) {
                foundTable.borderWidth = webviewTable.borderWidth;
            }
            if (webviewTable.borderStyle !== undefined) {
                foundTable.borderStyle = webviewTable.borderStyle;
            }
            if (webviewTable.backgroundColor !== undefined) {
                foundTable.backgroundColor = webviewTable.backgroundColor;
            }
            if (webviewTable.zIndex !== undefined) {
                foundTable.zIndex = webviewTable.zIndex;
            }
            if (webviewTable.opacity !== undefined) {
                foundTable.opacity = webviewTable.opacity;
            }
        });
    }

    private static async syncWebviewTableState(panel: vscode.WebviewPanel): Promise<void> {
        if (ErdWebView.tableData.size === 0) {
            return;
        }

        const requestId = `sync_${Date.now()}`;
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                ErdWebView.stateSyncResolvers.delete(requestId);
                resolve();
            }, 500);

            ErdWebView.stateSyncResolvers.set(requestId, () => {
                clearTimeout(timeout);
                resolve();
            });

            panel.webview.postMessage({ command: 'collectTableState', requestId });
        });
    }

    private static async handleWebviewMessage(message: any) {
        switch (message.command) {
            case 'newErd':
                await ErdWebView.clearCanvas();
                break;
            case 'selectTable100': {
                const tableName = message.tableName;
                const database = message.database;
                if (tableName && database) {
                    const sql = `SELECT * FROM \`${database}\`.\`${tableName}\` LIMIT 100;`;
                    await Utility.appendSQLToEditor(sql);
                }
                break;
            }
            case 'updateTableColor': {
                const foundTable = ErdWebView.findTableByName(message.tableName, message.database);
                if (foundTable && message.color) {
                    foundTable.color = message.color;
                }
                break;
            }
            case 'tableState':
                if (message.tables) {
                    ErdWebView.applyWebviewTablesState(message.tables);
                }
                if (message.requestId) {
                    const resolve = ErdWebView.stateSyncResolvers.get(message.requestId);
                    if (resolve) {
                        ErdWebView.stateSyncResolvers.delete(message.requestId);
                        resolve();
                    }
                }
                break;
            case 'save':
                if (message.relationships) {
                    ErdWebView.relationships = message.relationships;
                }
                if (message.tables) {
                    ErdWebView.applyWebviewTablesState(message.tables);
                }
                if (message.comments) {
                    ErdWebView.comments = message.comments;
                }
                if (message.textLabels) {
                    ErdWebView.textLabels = message.textLabels;
                }
                if (message.vectorShapes) {
                    ErdWebView.vectorShapes = message.vectorShapes;
                }
                await ErdWebView.saveToFile();
                break;
            case 'open':
                await ErdWebView.openFromFile();
                break;
            case 'exportImage':
                await ErdWebView.exportImage(message.format, message.data, message.width, message.height);
                break;
            case 'pushUndo':
                ErdWebView.pushUndoSnapshot(message.snapshot);
                break;
            case 'undo':
                await ErdWebView.performUndo();
                break;
        }
    }

    public static async renderPanel() {
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

            // Register message handlers
            ErdWebView.registerMessageHandlers(panel);

            panel.onDidDispose(() => {
                ErdWebView.panels.clear();
                ErdWebView.tableData.clear();
                ErdWebView.relationships = [];
                ErdWebView.currentPanel = null;
            });

            ErdWebView.panels.set('global', panel);
        } else {
            panel.reveal();
        }

        ErdWebView.currentPanel = panel;
        return panel;
    }

    public static async updatePanelContent(database: string, mainTable: string, canvasData?: any) {
        if (ErdWebView.currentPanel) {
            ErdWebView.currentPanel.webview.html = ErdWebView.getWebviewContent(database, mainTable, canvasData);
        }
    }

    private static registerMessageHandlers(panel: vscode.WebviewPanel) {
        panel.webview.onDidReceiveMessage(async (message) => {
            await ErdWebView.handleWebviewMessage(message);
        }, undefined);
    }

    public static async clearCanvas() {
        // Clear existing data
        ErdWebView.clearInternalData();
        ErdWebView.clearUndoStack();

        // Get or create panel
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

            ErdWebView.registerMessageHandlers(panel);

            panel.onDidDispose(() => {
                ErdWebView.panels.clear();
                ErdWebView.tableData.clear();
                ErdWebView.relationships = [];
                ErdWebView.comments = [];
            });

            ErdWebView.panels.set('global', panel);
        } else {
            panel.reveal();
        }

        // Render empty ERD
        panel.webview.html = ErdWebView.getWebviewContent('', '');
    }

    public static async showTableErd(tableNode: TableNode, currentDatabase: string) {
        const tableName = tableNode.table;
        const database = currentDatabase;

        const connection = tableNode.getConnectionOptions();
        if (!connection) {
            vscode.window.showWarningMessage("No active connection");
            return;
        }

        try {
            const results = await ErdWebView.getTableColumns(connection, database, tableName);

            if (!results || results.length === 0) {
                vscode.window.showWarningMessage(`Failed to get table structure for ${tableName}`);
                return;
            }

            const tableComment = await ErdWebView.getTableComment(connection, database, tableName);

            // Parse table structure
            const columns: ColumnData[] = [];
            for (const row of results) {
                const field = row.COLUMN_NAME || row.Field;
                const type = row.COLUMN_TYPE || row.Type;
                const comment = row.COLUMN_COMMENT || row.Comment || '';

                console.log('[ERD] Column:', field, 'Type:', type, 'Comment:', comment);

                columns.push({
                    name: field,
                    type: type,
                    isPrimaryKey: isPrimaryKey(row),
                    isForeignKey: isForeignKey(row),
                    comment: comment
                });
            }

            // Get foreign keys
            const fkResults = await ErdWebView.getForeignKeys(connection, database, tableName);

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
            const headerHeight = 28;
            const padding = 10;

            // Find a non-overlapping position
            const tableKey = `${database}.${tableName}`;
            const existingTable = ErdWebView.tableData.get(tableKey);
            const defaultHeight = headerHeight + columns.length * rowHeight + padding * 2;
            const position = ErdWebView.findNonOverlappingPosition(tableName, database, columnWidth, defaultHeight);

            const tableData: TableData = {
                tableName: tableName,
                columns: columns,
                x: existingTable?.x ?? position.x,
                y: existingTable?.y ?? position.y,
                width: existingTable?.width ?? columnWidth,
                height: existingTable?.height ?? defaultHeight,
                database: database,
                comment: tableComment,
                color: existingTable?.color
            };

            ErdWebView.tableData.set(tableKey, tableData);

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

                ErdWebView.registerMessageHandlers(panel);

                panel.onDidDispose(() => {
                    ErdWebView.panels.clear();
                    ErdWebView.tableData.clear();
                    ErdWebView.relationships = [];
                });

                ErdWebView.panels.set('global', panel);
            } else {
                panel.reveal();
                await ErdWebView.syncWebviewTableState(panel);
            }

            ErdWebView.clearUndoStack();
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
                const results = await ErdWebView.getTableColumns(connection, database, refTable);

                if (!results || results.length === 0) continue;

                const tableComment = await ErdWebView.getTableComment(connection, database, refTable);

                const refColumns: ColumnData[] = [];
                for (const row of results) {
                    const field = row.COLUMN_NAME || row.Field;
                    const type = row.COLUMN_TYPE || row.Type;
                    const comment = row.COLUMN_COMMENT || row.Comment || '';

                    refColumns.push({
                        name: field,
                        type: type,
                        isPrimaryKey: isPrimaryKey(row),
                        isForeignKey: isForeignKey(row),
                        comment: comment
                    });
                }

                const columnWidth = 220;
                const rowHeight = 30;
                const headerHeight = 28;
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

    private static async getTableColumns(connection: any, database: string, tableName: string): Promise<any[]> {
        const rows = await DbDriver.listColumns(connection, database, tableName);
        const primaryKeys = await ErdWebView.getPrimaryKeys(connection, database, tableName);
        const foreignKeys = await ErdWebView.getForeignKeys(connection, database, tableName);
        const primaryKeySet = new Set(primaryKeys.map((row) => row.COLUMN_NAME));
        const foreignKeySet = new Set(foreignKeys.map((row) => row.COLUMN_NAME));

        return rows.map((row) => ({
            ...row,
            COLUMN_KEY: primaryKeySet.has(row.COLUMN_NAME) ? 'PRI' : (foreignKeySet.has(row.COLUMN_NAME) ? 'MUL' : (row.COLUMN_KEY || '')),
        }));
    }

    private static async getPrimaryKeys(connection: any, database: string, tableName: string): Promise<any[]> {
        const safeDatabase = escapeSqlString(database);
        const safeTable = escapeSqlString(tableName);
        if (isDuckDbConnection(connection)) {
            const parts = getDuckDbTableParts(database, tableName);
            const safeSchema = escapeSqlString(parts.schema);
            const safeDuckTable = escapeSqlString(parts.table);
            try {
                return await Utility.queryPromise<any[]>(connection,
                    `SELECT unnest(constraint_column_names) AS "COLUMN_NAME"
                     FROM duckdb_constraints()
                     WHERE constraint_type = 'PRIMARY KEY'
                       AND schema_name = '${safeSchema}'
                       AND table_name = '${safeDuckTable}';`);
            } catch {
                return [];
            }
        }
        const query = isPostgresConnection(connection)
            ? `SELECT k.column_name AS "COLUMN_NAME"
               FROM information_schema.table_constraints t
               JOIN information_schema.key_column_usage k
                 ON t.constraint_name = k.constraint_name
                AND t.table_schema = k.table_schema
                AND t.table_name = k.table_name
               WHERE t.constraint_type = 'PRIMARY KEY'
                 AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
                 AND t.table_name = '${safeTable}'
               ORDER BY k.ordinal_position;`
            : `SELECT k.COLUMN_NAME
               FROM information_schema.table_constraints t
               JOIN information_schema.key_column_usage k
                 ON t.CONSTRAINT_NAME = k.CONSTRAINT_NAME
                AND t.TABLE_SCHEMA = k.TABLE_SCHEMA
                AND t.TABLE_NAME = k.TABLE_NAME
               WHERE t.CONSTRAINT_TYPE = 'PRIMARY KEY'
                 AND t.TABLE_SCHEMA = '${safeDatabase}'
                 AND t.TABLE_NAME = '${safeTable}'
               ORDER BY k.ORDINAL_POSITION;`;
        return Utility.queryPromise<any[]>(connection, query);
    }

    private static async getForeignKeys(connection: any, database: string, tableName: string): Promise<any[]> {
        const safeDatabase = escapeSqlString(database);
        const safeTable = escapeSqlString(tableName);
        if (isDuckDbConnection(connection)) {
            const parts = getDuckDbTableParts(database, tableName);
            const safeSchema = escapeSqlString(parts.schema);
            const safeDuckTable = escapeSqlString(parts.table);
            try {
                return await Utility.queryPromise<any[]>(connection,
                    `SELECT constraint_column_names[1] AS "COLUMN_NAME",
                            referenced_table AS "REFERENCED_TABLE_NAME",
                            referenced_column_names[1] AS "REFERENCED_COLUMN_NAME"
                     FROM duckdb_constraints()
                     WHERE constraint_type = 'FOREIGN KEY'
                       AND schema_name = '${safeSchema}'
                       AND table_name = '${safeDuckTable}'
                       AND referenced_table IS NOT NULL;`);
            } catch {
                return [];
            }
        }
        const query = isPostgresConnection(connection)
            ? `SELECT kcu.column_name AS "COLUMN_NAME",
                      ccu.table_name AS "REFERENCED_TABLE_NAME",
                      ccu.column_name AS "REFERENCED_COLUMN_NAME"
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu
                 ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema = kcu.table_schema
               JOIN information_schema.constraint_column_usage ccu
                 ON ccu.constraint_name = tc.constraint_name
                AND ccu.constraint_schema = tc.constraint_schema
               WHERE tc.constraint_type = 'FOREIGN KEY'
                 AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
                 AND tc.table_name = '${safeTable}'
               ORDER BY kcu.ordinal_position;`
            : `SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
               FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
               WHERE TABLE_SCHEMA = '${safeDatabase}'
                 AND TABLE_NAME = '${safeTable}'
                 AND REFERENCED_TABLE_NAME IS NOT NULL;`;
        return Utility.queryPromise<any[]>(connection, query);
    }

    private static async getTableComment(connection: any, database: string, tableName: string): Promise<string> {
        if (isDuckDbConnection(connection)) {
            return '';
        }
        const safeDatabase = escapeSqlString(database);
        const safeTable = escapeSqlString(tableName);
        const query = isPostgresConnection(connection)
            ? `SELECT COALESCE(obj_description(c.oid, 'pg_class'), '') AS "TABLE_COMMENT"
               FROM pg_catalog.pg_class c
               JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
                 AND c.relname = '${safeTable}'
               LIMIT 1;`
            : `SELECT TABLE_COMMENT
               FROM INFORMATION_SCHEMA.TABLES
               WHERE TABLE_SCHEMA = '${safeDatabase}'
                 AND TABLE_NAME = '${safeTable}';`;
        const result = await Utility.queryPromise<any[]>(connection, query);
        return result && result.length > 0 ? result[0].TABLE_COMMENT || '' : '';
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
        if (ErdWebView.tableData.size === 0 && ErdWebView.comments.length === 0 &&
            ErdWebView.textLabels.length === 0 && ErdWebView.vectorShapes.length === 0) {
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
            // Get tables from tableData (already updated with actual dimensions from save handler)
            const tables = Array.from(ErdWebView.tableData.values());

            console.log('[saveToFile] Saving', tables.length, 'tables');
            tables.forEach(table => {
                console.log('[saveToFile] Table:', table.tableName, 'width:', table.width, 'x:', table.x, 'y:', table.y);
            });

            // Get canvas dimensions from tables and comments
            let maxX = 0, maxY = 0;
            tables.forEach(table => {
                maxX = Math.max(maxX, table.x + table.width);
                maxY = Math.max(maxY, table.y + table.height);
            });
            
            ErdWebView.comments.forEach(comment => {
                maxX = Math.max(maxX, comment.x + (comment.width || 200));
                maxY = Math.max(maxY, comment.y + (comment.height || 100));
            });

            ErdWebView.textLabels.forEach(label => {
                maxX = Math.max(maxX, label.x + 200);
                maxY = Math.max(maxY, label.y + 40);
            });

            ErdWebView.vectorShapes.forEach(shape => {
                maxX = Math.max(maxX, shape.x + (shape.width || 80));
                maxY = Math.max(maxY, shape.y + (shape.height || 80));
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
                relationships: ErdWebView.relationships,
                comments: ErdWebView.comments,
                textLabels: ErdWebView.textLabels,
                vectorShapes: ErdWebView.vectorShapes
            };

            const json = JSON.stringify(merdData, null, 2);
            const data = Buffer.from(json, 'utf-8');

            await vscode.workspace.fs.writeFile(uri, data);
            vscode.window.showInformationMessage(`ERD saved to ${uri.fsPath}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Error saving ERD: ${error}`);
        }
    }

    public static async exportImage(format: 'jpg' | 'pdf', dataUrl: string, width: number, height: number) {
        if (!dataUrl) {
            vscode.window.showWarningMessage("没有可导出的图像数据");
            return;
        }

        const isJpg = format === 'jpg';
        const uri = await vscode.window.showSaveDialog({
            filters: isJpg
                ? { 'JPEG 图片': ['jpg', 'jpeg'] }
                : { 'PDF 文档': ['pdf'] },
            defaultUri: vscode.Uri.file(isJpg ? 'erd.jpg' : 'erd.pdf')
        });

        if (!uri) {
            return;
        }

        try {
            const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
            const imageBuffer = Buffer.from(base64, 'base64');

            if (isJpg) {
                await vscode.workspace.fs.writeFile(uri, imageBuffer);
            } else {
                const pdfBuffer = ErdWebView.createPdfFromJpeg(imageBuffer, width, height);
                await vscode.workspace.fs.writeFile(uri, pdfBuffer);
            }

            vscode.window.showInformationMessage(`已导出到 ${uri.fsPath}`);
        } catch (error) {
            vscode.window.showErrorMessage(`导出失败: ${error}`);
        }
    }

    private static createPdfFromJpeg(jpegBuffer: Buffer, widthPx: number, heightPx: number): Buffer {
        const widthPt = Math.max(1, Math.round(widthPx * 0.75));
        const heightPt = Math.max(1, Math.round(heightPx * 0.75));
        const chunks: Buffer[] = [];
        const offsets: number[] = [0];
        let offset = 0;

        const append = (content: string | Buffer) => {
            const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'binary');
            chunks.push(buf);
            offset += buf.length;
        };

        append('%PDF-1.4\n');

        offsets.push(offset);
        append('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

        offsets.push(offset);
        append('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

        offsets.push(offset);
        append(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);

        offsets.push(offset);
        append(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${widthPx} /Height ${heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBuffer.length} >>\nstream\n`);
        chunks.push(jpegBuffer);
        offset += jpegBuffer.length;
        append('\nendstream\nendobj\n');

        const contentStream = `q ${widthPt} 0 0 ${heightPt} 0 0 cm /Im1 Do Q`;
        offsets.push(offset);
        append(`5 0 obj\n<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream\nendobj\n`);

        const xrefOffset = offset;
        append(`xref\n0 ${offsets.length}\n`);
        append('0000000000 65535 f \n');
        for (let i = 1; i < offsets.length; i++) {
            const padded = ('0000000000' + offsets[i]).slice(-10);
            append(`${padded} 00000 n \n`);
        }
        append('trailer\n');
        append(`<< /Size ${offsets.length} /Root 1 0 R >>\n`);
        append('startxref\n');
        append(`${xrefOffset}\n`);
        append('%%EOF');

        return Buffer.concat(chunks);
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
            const json = Buffer.from(fileData.buffer).toString('utf-8');
            const merdData: MerdFileData = JSON.parse(json);

            // Validate version
            if (!merdData.version || merdData.version !== "1.0") {
                vscode.window.showWarningMessage("Unsupported MERD file version");
                return;
            }

            // Clear existing data
            ErdWebView.tableData.clear();
            ErdWebView.relationships = [];
            ErdWebView.clearUndoStack();

            // Load tables
            console.log('[openFromFile] Loading', merdData.tables.length, 'tables from MERD file');
            merdData.tables.forEach(table => {
                console.log('[openFromFile] Loading table:', table.tableName, 'width:', table.width, 'position:', table.x, ',', table.y);
                ErdWebView.tableData.set(`${table.database || ''}.${table.tableName}`, table);
            });

            // Load relationships
            ErdWebView.relationships = merdData.relationships || [];
            
            // Load comments
            ErdWebView.comments = merdData.comments || [];
            ErdWebView.textLabels = merdData.textLabels || [];
            ErdWebView.vectorShapes = merdData.vectorShapes || [];

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

                ErdWebView.registerMessageHandlers(panel);

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

            panel.webview.html = ErdWebView.getWebviewContent(database, mainTable, merdData.canvas);
            vscode.window.showInformationMessage(`ERD loaded from ${uri[0].fsPath}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Error opening ERD: ${error}`);
        }
    }

    private static getWebviewContent(database: string, mainTable: string, canvasData?: any): string {
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
            padding-top: 52px;
        }
        body.panning {
            cursor: grabbing;
        }
        body.vector-resizing {
            user-select: none;
        }
        body.vector-resizing .vector-shape-resize-handle {
            pointer-events: auto;
        }
        #canvas-container {
            width: 100%;
            height: calc(100vh - 52px);
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
        #relationships {
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
            cursor: default;
            transition: box-shadow 0.2s, border-color 0.2s;
        }
        .table-header {
            cursor: move;
            user-select: none;
        }
        .table-body {
            cursor: text;
            user-select: text;
        }
        .table-node:hover {
            box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.28);
        }
        .table-node.selected {
            border-color: var(--vscode-focusBorder, #007acc);
        }
        .table-node.main-table {
            border-color: #007acc;
        }
        .table-header {
            background: linear-gradient(135deg, #007acc 0%, #005a9e 100%);
            color: white;
            padding: 6px 28px 6px 10px;
            font-size: 13px;
            line-height: 1.2;
            border-radius: 6px 6px 0 0;
            position: relative;
            z-index: 2;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .table-node.menu-open {
            z-index: 2000 !important;
        }
        .table-header.related {
            background: linear-gradient(135deg, #4caf50 0%, #388e3c 100%);
        }
        .table-header-center {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            max-width: 100%;
            min-width: 0;
            text-align: center;
        }
        .table-name {
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            flex-shrink: 0;
        }
        .table-header .table-comment {
            font-size: 9px;
            color: rgba(255, 255, 255, 0.75);
            font-weight: normal;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            flex-shrink: 1;
            max-width: 140px;
        }
        .table-node.hide-table-name-comment .table-header .table-comment {
            display: none;
        }
        .table-menu-wrapper {
            position: absolute;
            right: 4px;
            top: 50%;
            transform: translateY(-50%);
            flex-shrink: 0;
        }
        .table-menu-btn {
            background: transparent;
            border: none;
            border-radius: 4px;
            padding: 0 4px;
            font-size: 16px;
            line-height: 1;
            color: white;
            cursor: pointer;
            transition: background 0.2s;
            letter-spacing: -2px;
        }
        .table-menu-btn:hover {
            background: rgba(255, 255, 255, 0.15);
        }
        .table-dropdown {
            position: fixed;
            display: none;
            min-width: 168px;
            padding: 4px 0;
            background-color: var(--vscode-menu-background, var(--vscode-editor-background));
            border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
            z-index: 10001;
            pointer-events: auto;
        }
        .table-dropdown.show {
            display: block;
        }
        .table-dropdown-item {
            display: block;
            width: 100%;
            padding: 8px 14px;
            border: none;
            background: transparent;
            color: var(--vscode-menu-foreground, var(--vscode-editor-foreground));
            font-size: 12px;
            text-align: left;
            cursor: pointer;
            white-space: nowrap;
        }
        .table-dropdown-item:hover {
            background-color: var(--vscode-menu-selectionBackground, var(--vscode-toolbar-hoverBackground));
        }
        .table-color-panel {
            display: none;
            padding: 8px 10px 10px;
            border-top: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
        }
        .table-color-panel.show {
            display: block;
        }
        .table-color-swatches {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            align-items: center;
        }
        .color-swatch {
            width: 22px;
            height: 22px;
            border-radius: 4px;
            border: 2px solid transparent;
            cursor: pointer;
            padding: 0;
        }
        .color-swatch:hover {
            border-color: var(--vscode-focusBorder, #fff);
            transform: scale(1.08);
        }
        .color-picker-label {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 22px;
            height: 22px;
            border-radius: 4px;
            border: 1px solid var(--vscode-panel-border);
            cursor: pointer;
            overflow: hidden;
            background: conic-gradient(red, yellow, lime, aqua, blue, magenta, red);
        }
        .table-color-input {
            width: 28px;
            height: 28px;
            padding: 0;
            border: none;
            cursor: pointer;
            opacity: 0;
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
        /* Resize handles */
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
        .resize-handle-vertical {
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            height: 8px;
            cursor: ns-resize;
            background: transparent;
            z-index: 5;
        }
        .resize-handle:hover,
        .table-node:hover .resize-handle,
        .resize-handle-vertical:hover,
        .table-node:hover .resize-handle-vertical {
            background: rgba(0, 122, 204, 0.2);
        }
        .resize-handle.dragging,
        .resize-handle-vertical.dragging {
            background: rgba(0, 122, 204, 0.4);
        }
        .resize-handle-corner {
            position: absolute;
            width: 10px;
            height: 10px;
            z-index: 6;
        }
        .resize-handle-corner-tl {
            top: -5px;
            left: -5px;
            cursor: nwse-resize;
        }
        .resize-handle-corner-tr {
            top: -5px;
            right: -5px;
            cursor: nesw-resize;
        }
        .resize-handle-corner-bl {
            bottom: -5px;
            left: -5px;
            cursor: nesw-resize;
        }
        .resize-handle-corner-br {
            bottom: -5px;
            right: -5px;
            cursor: nwse-resize;
        }
        .resize-handle-corner:hover,
        .table-node:hover .resize-handle-corner {
            background: rgba(0, 122, 204, 0.2);
        }
        .resize-handle-corner.dragging {
            background: rgba(0, 122, 204, 0.4);
        }
         /* Table body scrollable */
         .table-body {
             padding: 8px;
             overflow-y: auto;
         }
        .table-node {
            /* Ensure table has minimum and maximum height constraints */
            min-height: 100px;
        }
        .relationship-line {
            stroke: #007acc;
            stroke-width: 2;
            fill: none;
            cursor: pointer;
            transition: all 0.3s ease;
            pointer-events: auto;
        }
        .relationship-hit-area {
            stroke: transparent;
            stroke-width: 20;
            fill: none;
            cursor: pointer;
            transition: all 0.3s ease;
            pointer-events: auto;
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
        /* Selection box around relationship */
        .relationship-selection-box {
            stroke: #ff6b6b;
            stroke-width: 2;
            stroke-dasharray: 5, 5;
            fill: transparent;
            pointer-events: none;
            transition: all 0.3s ease;
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
        .relationship-arrow { fill: #007acc; }
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
        .zoom-btn .toolbar-icon {
            width: 18px;
            height: 18px;
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
        /* Top toolbar */
        .erd-toolbar {
            position: fixed;
            top: 8px;
            left: 50%;
            transform: translateX(-50%);
            display: flex;
            flex-direction: row;
            align-items: center;
            gap: 2px;
            padding: 4px 8px;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
            z-index: 1000;
        }
        .toolbar-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            height: 32px;
            padding: 0 10px;
            border: none;
            border-radius: 4px;
            background: transparent;
            color: var(--vscode-editor-foreground);
            font-size: 12px;
            cursor: pointer;
            white-space: nowrap;
            transition: background 0.15s;
        }
        .toolbar-btn:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }
        .toolbar-btn.active {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        body.add-text-mode {
            cursor: crosshair;
        }
        body.add-text-mode #canvas-container {
            cursor: crosshair;
        }
        .toolbar-icon {
            display: block;
            width: 16px;
            height: 16px;
            flex-shrink: 0;
            position: static;
            stroke: currentColor;
            fill: none;
            stroke-width: 2;
            stroke-linecap: round;
            stroke-linejoin: round;
            pointer-events: none;
        }
        .toolbar-btn span {
            line-height: 1;
        }
        .toolbar-divider {
            width: 1px;
            height: 20px;
            margin: 0 4px;
            background-color: var(--vscode-panel-border);
        }
        .toolbar-menu-wrapper {
            position: relative;
        }
        .toolbar-dropdown {
            position: absolute;
            top: calc(100% + 6px);
            left: 50%;
            transform: translateX(-50%);
            display: none;
            min-width: 120px;
            padding: 4px 0;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
            z-index: 1001;
        }
        .toolbar-dropdown.show {
            display: block;
        }
        .toolbar-dropdown-item {
            display: block;
            width: 100%;
            padding: 8px 14px;
            border: none;
            background: transparent;
            color: var(--vscode-editor-foreground);
            font-size: 12px;
            text-align: left;
            cursor: pointer;
        }
        .toolbar-dropdown-item:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }
        .vector-shape-menu {
            min-width: 220px;
            padding: 6px;
        }
        .vector-shape-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 2px;
        }
        .vector-shape-menu-item {
            display: flex;
            align-items: center;
            gap: 8px;
            width: 100%;
            padding: 8px 10px;
            border: none;
            border-radius: 4px;
            background: transparent;
            color: var(--vscode-editor-foreground);
            font-size: 12px;
            text-align: left;
            cursor: pointer;
        }
        .vector-shape-menu-item:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }
        .vector-shape-menu-item.active {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .vector-shape-menu-icon {
            width: 18px;
            height: 18px;
            flex-shrink: 0;
            stroke: currentColor;
            fill: none;
            stroke-width: 2;
            stroke-linecap: round;
            stroke-linejoin: round;
        }
        .vector-shape-menu-divider {
            grid-column: 1 / -1;
            height: 1px;
            margin: 4px 2px;
            background-color: var(--vscode-panel-border);
        }
        /* Vector shapes on canvas */
        .vector-shape-node {
            position: absolute;
            cursor: move;
            z-index: 40;
            color: var(--vscode-editor-foreground);
            pointer-events: auto;
            border-radius: 3px;
            box-sizing: border-box;
            border: 1px solid transparent;
            overflow: visible;
        }
        .vector-shape-node:hover {
            box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.28);
        }
        .vector-shape-node svg {
            display: block;
            width: 100%;
            height: 100%;
            overflow: visible;
            pointer-events: none !important;
        }
        .vector-shape-handles {
            position: absolute;
            inset: 0;
            pointer-events: none;
            overflow: visible;
            z-index: 30;
        }
        .vector-shape-handles .vector-shape-resize-handle {
            pointer-events: auto;
        }
        .vector-shape-node:not(.resize-active) .vector-shape-resize-handle {
            visibility: hidden;
            pointer-events: none;
        }
        .vector-shape-node.resize-active .vector-shape-resize-handle {
            visibility: visible;
            pointer-events: auto;
        }
        .vector-shape-node.resize-active {
            cursor: default;
            box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007acc),
                        0 0 0 4px rgba(0, 122, 204, 0.18);
            border-color: var(--vscode-focusBorder, #007acc);
        }
        .vector-shape-resize-handle {
            position: absolute;
            width: 12px;
            height: 12px;
            background: var(--vscode-focusBorder, #007acc);
            border: 1px solid var(--vscode-editor-background, #fff);
            border-radius: 1px;
            pointer-events: auto;
            box-sizing: border-box;
            z-index: 20;
            touch-action: none;
        }
        .vector-shape-resize-handle::before {
            content: '';
            position: absolute;
            inset: -10px;
        }
        .vector-shape-resize-handle.nw { top: -6px; left: -6px; cursor: nwse-resize; }
        .vector-shape-resize-handle.n  { top: -6px; left: 50%; transform: translateX(-50%); cursor: ns-resize; }
        .vector-shape-resize-handle.ne { top: -6px; right: -6px; cursor: nesw-resize; }
        .vector-shape-resize-handle.e  { top: 50%; right: -6px; transform: translateY(-50%); cursor: ew-resize; }
        .vector-shape-resize-handle.se { bottom: -6px; right: -6px; cursor: nwse-resize; }
        .vector-shape-resize-handle.s  { bottom: -6px; left: 50%; transform: translateX(-50%); cursor: ns-resize; }
        .vector-shape-resize-handle.sw { bottom: -6px; left: -6px; cursor: nesw-resize; }
        .vector-shape-resize-handle.w  { top: 50%; left: -6px; transform: translateY(-50%); cursor: ew-resize; }
        .vector-shape-resize-handle.start,
        .vector-shape-resize-handle.end {
            transform: translate(-50%, -50%);
            border-radius: 50%;
            width: 10px;
            height: 10px;
        }
        .vector-shape-resize-handle.dragging {
            background: #005a9e;
        }
        .vector-shape-resize-handle.start.dragging,
        .vector-shape-resize-handle.end.dragging {
            transform: translate(-50%, -50%) scale(1.2);
        }
        .vector-shape-resize-handle.nw.dragging,
        .vector-shape-resize-handle.ne.dragging,
        .vector-shape-resize-handle.se.dragging,
        .vector-shape-resize-handle.sw.dragging {
            transform: scale(1.2);
        }
        .vector-shape-resize-handle.n.dragging,
        .vector-shape-resize-handle.s.dragging {
            transform: translateX(-50%) scale(1.2);
        }
        .vector-shape-resize-handle.e.dragging,
        .vector-shape-resize-handle.w.dragging {
            transform: translateY(-50%) scale(1.2);
        }
        body.add-vector-mode {
            cursor: crosshair;
        }
        body.add-vector-mode #canvas-container {
            cursor: crosshair;
        }
        body.selection-mode {
            cursor: default;
        }
        body.selection-mode #canvas-container {
            cursor: default;
        }
        .vector-shape-preview {
            position: absolute;
            pointer-events: none;
            z-index: 39;
            color: var(--vscode-editor-foreground);
            opacity: 0.7;
        }
        .marquee-selection {
            position: absolute;
            border: 1px dashed var(--vscode-focusBorder, #007acc);
            background-color: rgba(0, 122, 204, 0.12);
            pointer-events: none;
            z-index: 45;
            box-sizing: border-box;
        }
        
        /* Comment sticky notes */
        .comment-node {
            position: absolute;
            background-color: #fff3cd;
            border: 2px solid #ffc107;
            border-radius: 8px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            cursor: move;
            user-select: none;
            padding: 12px;
            min-width: 200px;
            max-width: 500px;
            min-height: 100px;
            max-height: 600px;
            z-index: 500;
            transition: box-shadow 0.2s, border-color 0.2s;
        }
        .comment-resize-handle {
            position: absolute;
            right: 4px;
            bottom: 4px;
            width: 12px;
            height: 12px;
            background-color: #ffc107;
            border-radius: 50%;
            cursor: nwse-resize;
            z-index: 10;
            transition: transform 0.2s;
        }
        .comment-resize-handle:hover {
            transform: scale(1.2);
        }
        .comment-resize-handle.dragging {
            transform: scale(1.3);
            background-color: #ffb300;
        }
        .comment-node:hover {
            box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.28);
        }
        .comment-node.selected {
            border-color: var(--vscode-focusBorder, #007acc);
        }
        .comment-textarea {
            width: 100%;
            min-height: 80px;
            border: none;
            background: transparent;
            resize: none;
            font-family: inherit;
            font-size: 13px;
            color: var(--vscode-editor-foreground);
            outline: none;
        }
        .comment-delete-btn {
            position: absolute;
            top: 4px;
            right: 4px;
            width: 24px;
            height: 24px;
            background-color: rgba(255, 107, 107, 0.2);
            border: 1px solid rgba(255, 107, 107, 0.3);
            border-radius: 4px;
            color: #ff6b6b;
            font-size: 12px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background 0.2s;
            opacity: 0;
        }
        .comment-node:hover .comment-delete-btn {
            opacity: 1;
        }
        .comment-delete-btn:hover {
            background-color: rgba(255, 107, 107, 0.3);
        }
        /* Comment connection points on all four sides */
        .comment-connector-top {
            position: absolute;
            top: -7px;
            left: 50%;
            transform: translateX(-50%);
        }
        .comment-connector-bottom {
            position: absolute;
            bottom: -7px;
            left: 50%;
            transform: translateX(-50%);
        }
        .comment-connector-left {
            position: absolute;
            left: -7px;
            top: 50%;
            transform: translateY(-50%);
        }
        .comment-connector-right {
            position: absolute;
            right: -7px;
            top: 50%;
            transform: translateY(-50%);
        }
        .comment-node:hover .connection-point,
        .comment-node.selected .connection-point {
            opacity: 0.6;
        }
        /* Text labels */
        .text-label-node {
            position: absolute;
            min-width: 20px;
            min-height: 20px;
            padding: 2px 4px;
            cursor: move;
            z-index: 50;
            white-space: pre-wrap;
            word-break: break-word;
            outline: none;
            background: transparent;
            border: 1px solid transparent;
            border-radius: 3px;
            box-sizing: border-box;
        }
        .text-label-node:hover {
            box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.28);
        }
        .text-label-node:focus {
            border-color: var(--vscode-focusBorder, #007acc);
            background-color: rgba(0, 122, 204, 0.06);
        }
        .text-label-node:empty::before {
            content: '输入文本...';
            color: var(--vscode-descriptionForeground);
            pointer-events: none;
        }
        /* Unified selection highlight for all canvas objects */
        .table-node.selected,
        .comment-node.selected,
        .text-label-node.selected,
        .vector-shape-node.selected {
            box-shadow: 0 0 0 2px var(--vscode-focusBorder, #007acc),
                        0 0 0 5px rgba(0, 122, 204, 0.22),
                        0 0 14px rgba(0, 122, 204, 0.45);
        }
        .text-label-node.selected,
        .vector-shape-node.selected {
            border-color: var(--vscode-focusBorder, #007acc);
            background-color: rgba(0, 122, 204, 0.1);
        }
        /* Text label context menu */
        .text-label-context-menu {
            position: fixed;
            display: none;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            z-index: 10001;
            min-width: 140px;
        }
        .context-menu-item.has-submenu {
            position: relative;
            justify-content: space-between;
        }
        .context-menu-item.has-submenu::after {
            content: '▸';
            font-size: 11px;
            opacity: 0.7;
        }
        .context-submenu {
            position: absolute;
            left: 100%;
            top: 0;
            display: none;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            z-index: 10002;
            min-width: 160px;
            max-height: 280px;
            overflow-y: auto;
        }
        .context-menu-item.has-submenu:hover > .context-submenu {
            display: block;
        }
        .context-submenu-item {
            padding: 8px 16px;
            cursor: pointer;
            font-size: 13px;
            color: var(--vscode-editor-foreground);
            white-space: nowrap;
        }
        .context-submenu-item:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }
        .context-submenu-item.active {
            background-color: var(--vscode-menu-selectionBackground, var(--vscode-toolbar-hoverBackground));
        }
        .context-menu-item.active {
            background-color: var(--vscode-menu-selectionBackground, var(--vscode-toolbar-hoverBackground));
        }
        .context-menu-item.menu-bold {
            font-weight: bold;
        }
        .context-menu-item.menu-italic {
            font-style: italic;
        }
        .text-label-color-swatches {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            padding: 8px 12px;
            align-items: center;
        }
        .text-label-color-swatches .color-swatch,
        .text-label-color-submenu .color-swatch {
            width: 22px;
            height: 22px;
        }
        .text-label-color-submenu {
            display: none;
            flex-wrap: wrap;
            gap: 6px;
            padding: 8px 12px;
            min-width: 120px;
            max-width: 160px;
        }
        .context-menu-item.has-submenu:hover > .text-label-color-submenu {
            display: flex;
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
        .context-menu-item.disabled {
            opacity: 0.45;
            pointer-events: none;
        }
        .context-menu-separator {
            height: 1px;
            background-color: var(--vscode-panel-border);
            margin: 4px 0;
        }
        /* Thumbnail toggle button */
        .thumbnail-toggle {
            position: fixed;
            bottom: 20px;
            left: 20px;
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
            z-index: 1000;
            transition: background 0.2s;
        }
        .thumbnail-toggle:hover {
            background-color: var(--vscode-toolbar-hoverBackground);
        }
        .thumbnail-toggle .toolbar-icon {
            width: 18px;
            height: 18px;
        }
        /* Thumbnail panel */
        .thumbnail-panel {
            position: fixed;
            bottom: 70px;
            left: 20px;
            width: 300px;
            height: 200px;
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            z-index: 999;
            display: none;
            overflow: hidden;
        }
        .thumbnail-panel.show {
            display: block;
        }
        .thumbnail-canvas {
            width: 100%;
            height: 100%;
            position: relative;
            background-color: var(--vscode-editor-background);
        }
        .thumbnail-viewport-indicator {
            position: absolute;
            border: 2px solid #007acc;
            background-color: transparent;
            cursor: move;
            pointer-events: all;
            z-index: 100;
        }
        .thumbnail-table {
            position: absolute;
            background-color: var(--vscode-editor-selectionBackground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 2px;
            z-index: 1;
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

        // Add comment nodes
        ErdWebView.comments.forEach(comment => {
            const commentHtml = '                <div class="comment-node" data-comment-id="' +
                comment.id + '" style="left: ' + comment.x + 'px; top: ' + comment.y +
                'px; width: ' + (comment.width || 200) + 'px; height: ' + (comment.height || 100) + 'px;">' +
                '<button class="comment-delete-btn" title="Delete comment">×</button>' +
                '<textarea class="comment-textarea" placeholder="Enter comment...">' +
                ErdWebView.escapeHtml(comment.text) + '</textarea>' +
                // Connection points on all four sides
                '<div class="comment-connector-top connection-point" data-comment="' + comment.id + '" title="Comment top"></div>' +
                '<div class="comment-connector-bottom connection-point" data-comment="' + comment.id + '" title="Comment bottom"></div>' +
                '<div class="comment-connector-left connection-point" data-comment="' + comment.id + '" title="Comment left"></div>' +
                '<div class="comment-connector-right connection-point" data-comment="' + comment.id + '" title="Comment right"></div>' +
                '</div>';
            html += commentHtml;
        });

        // Add text label nodes
        ErdWebView.textLabels.forEach(label => {
            const fontSize = label.fontSize || 16;
            const fontFamily = (label.fontFamily || '').replace(/"/g, "'");
            const color = label.color || 'var(--vscode-editor-foreground)';
            const styleParts = [
                'left: ' + label.x + 'px',
                'top: ' + label.y + 'px',
                'font-size: ' + fontSize + 'px',
                'color: ' + color
            ];
            if (fontFamily) {
                styleParts.push('font-family: ' + fontFamily);
            }
            if (label.fontWeight) {
                styleParts.push('font-weight: ' + label.fontWeight);
            }
            if (label.fontStyle) {
                styleParts.push('font-style: ' + label.fontStyle);
            }
            const labelHtml = '                <div class="text-label-node" contenteditable="true" data-label-id="' +
                label.id + '" style="' + styleParts.join('; ') + ';">' +
                ErdWebView.escapeHtml(label.text) + '</div>';
            html += labelHtml;
        });

        html += `        </div>
    </div>

    <!-- Zoom controls -->
    <div class="zoom-controls">
        <button class="zoom-btn" id="zoomInBtn" title="Zoom In">+</button>
        <button class="zoom-btn" id="zoomOutBtn" title="Zoom Out">−</button>
        <button class="zoom-btn" id="resetZoomBtn" title="重置缩放并居中">
            <svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/><path d="m16 16-1.9-1.9"/></svg>
        </button>
    </div>
    <div class="zoom-level" id="zoomLevel">100%</div>

    <!-- Toolbar -->
    <div class="erd-toolbar">
        <button class="toolbar-btn" id="newErdBtn" title="新建 ERD">
            <svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>
            <span>新建</span>
        </button>
        <button class="toolbar-btn" id="saveBtn" title="保存 ERD 到文件">
            <svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v8"/><path d="m16 6-4 4-4-4"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 18h.01"/><path d="M10 18h.01"/></svg>
            <span>保存</span>
        </button>
        <button class="toolbar-btn" id="openBtn" title="打开 ERD 文件">
            <svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m16 6-4-4-4 4"/><path d="M12 2v8"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 18h.01"/><path d="M10 18h.01"/></svg>
            <span>打开</span>
        </button>
        <div class="toolbar-divider"></div>
        <button class="toolbar-btn active" id="selectToolBtn" title="选择/框选">
            <svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="m13 13 6 6"/></svg>
            <span>选择</span>
        </button>
        <button class="toolbar-btn" id="addCommentBtn" title="添加注释">
            <svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/><path d="M7 11h10"/><path d="M7 15h6"/><path d="M7 7h8"/></svg>
            <span>注释</span>
        </button>
        <button class="toolbar-btn" id="addTextLabelBtn" title="添加文本标签">
            <svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 16.5a.5.5 0 0 0 .5.5h.5a2 2 0 0 1 0 4H9a2 2 0 0 1 0-4h.5a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-3a.5.5 0 0 0-.5.5V8a2 2 0 0 1-4 0V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v3a2 2 0 0 1-4 0v-.5a.5.5 0 0 0-.5-.5h-3a.5.5 0 0 0-.5.5Z"/></svg>
            <span>文本</span>
        </button>
        <div class="toolbar-menu-wrapper">
            <button class="toolbar-btn" id="vectorShapeBtn" title="添加矢量图形">
                <svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 7a24 24 0 0 1 0 10"/><path d="M4.5 7a24 24 0 0 0 0 10"/><path d="M7 19.5a24 24 0 0 0 10 0"/><path d="M7 4.5a24 24 0 0 1 10 0"/><rect width="5" height="5" x="17" y="17" rx="1"/><rect width="5" height="5" x="17" y="2" rx="1"/><rect width="5" height="5" x="2" y="17" rx="1"/><rect width="5" height="5" x="2" y="2" rx="1"/></svg>
                <span>矢量</span>
            </button>
            <div class="toolbar-dropdown vector-shape-menu" id="vectorShapeMenu">
                <div class="vector-shape-grid" id="vectorShapeGrid"></div>
            </div>
        </div>
        <div class="toolbar-divider"></div>
        <div class="toolbar-menu-wrapper">
            <button class="toolbar-btn" id="exportBtn" title="导出">
                <svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10l-3.1-3.1a2 2 0 0 0-2.814.014L6 21"/><path d="m14 19 3 3v-5.5"/><path d="m17 22 3-3"/><circle cx="9" cy="9" r="2"/></svg>
                <span>导出</span>
            </button>
            <div class="toolbar-dropdown" id="exportMenu">
                <button class="toolbar-dropdown-item" data-format="jpg">导出 JPG</button>
                <button class="toolbar-dropdown-item" data-format="pdf">导出 PDF</button>
            </div>
        </div>
    </div>

    <!-- Context menu -->
    <div class="context-menu" id="contextMenu">
        <div class="context-menu-item" id="ctxSelect100">📋 选择前100条</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" id="ctxTableResizeMenu">调整大小</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item has-submenu" id="ctxTableBorderWidthMenu">
            边框粗细
            <div class="context-submenu" id="ctxTableBorderWidthSubmenu"></div>
        </div>
        <div class="context-menu-item has-submenu" id="ctxTableBorderStyleMenu">
            边框样式
            <div class="context-submenu" id="ctxTableBorderStyleSubmenu">
                <div class="context-submenu-item" data-style="solid">实线</div>
                <div class="context-submenu-item" data-style="dashed">虚线</div>
                <div class="context-submenu-item" data-style="dotted">点线</div>
            </div>
        </div>
        <div class="context-menu-separator"></div>
        <div class="text-label-color-swatches" id="ctxTableBorderColorSwatches"></div>
        <div class="context-menu-item has-submenu" id="ctxTableBorderMoreColorMenu">
            边框更多颜色
            <div class="context-submenu text-label-color-submenu" id="ctxTableBorderMoreColorSubmenu"></div>
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" id="ctxTableBackgroundNoneMenu">无背景</div>
        <div class="text-label-color-swatches" id="ctxTableBackgroundColorSwatches"></div>
        <div class="context-menu-item has-submenu" id="ctxTableBackgroundMoreColorMenu">
            背景更多颜色
            <div class="context-submenu text-label-color-submenu" id="ctxTableBackgroundMoreColorSubmenu"></div>
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item has-submenu" id="ctxTableOpacityMenu">
            透明度
            <div class="context-submenu" id="ctxTableOpacitySubmenu"></div>
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" id="ctxTableBringToFront">置于顶层</div>
        <div class="context-menu-item" id="ctxTableBringForward">上移一层</div>
        <div class="context-menu-item" id="ctxTableSendBackward">下移一层</div>
        <div class="context-menu-item" id="ctxTableSendToBack">置于底层</div>
        <div class="context-menu-separator"></div>
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

    <!-- Text label context menu -->
    <div class="text-label-context-menu" id="textLabelContextMenu">
        <div class="context-menu-item has-submenu" id="textLabelSizeMenu">
            大小
            <div class="context-submenu" id="textLabelSizeSubmenu"></div>
        </div>
        <div class="context-menu-item has-submenu" id="textLabelFontMenu">
            字体
            <div class="context-submenu" id="textLabelFontSubmenu"></div>
        </div>
        <div class="context-menu-item menu-bold" id="textLabelBoldMenu">加粗</div>
        <div class="context-menu-item menu-italic" id="textLabelItalicMenu">斜体</div>
        <div class="context-menu-separator"></div>
        <div class="text-label-color-swatches" id="textLabelColorSwatches"></div>
        <div class="context-menu-item has-submenu" id="textLabelMoreColorMenu">
            更多颜色
            <div class="context-submenu text-label-color-submenu" id="textLabelMoreColorSubmenu"></div>
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item danger" id="textLabelDeleteMenu">删除</div>
    </div>

    <!-- Vector shape context menu -->
    <div class="text-label-context-menu" id="vectorShapeContextMenu">
        <div class="context-menu-item" id="vectorShapeResizeMenu">调整大小</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item has-submenu" id="vectorStrokeWidthMenu">
            边框粗细
            <div class="context-submenu" id="vectorStrokeWidthSubmenu"></div>
        </div>
        <div class="context-menu-item has-submenu" id="vectorStrokeStyleMenu">
            边框样式
            <div class="context-submenu" id="vectorStrokeStyleSubmenu">
                <div class="context-submenu-item" data-style="solid">实线</div>
                <div class="context-submenu-item" data-style="dashed">虚线</div>
                <div class="context-submenu-item" data-style="dotted">点线</div>
            </div>
        </div>
        <div class="context-menu-separator"></div>
        <div class="text-label-color-swatches" id="vectorStrokeColorSwatches"></div>
        <div class="context-menu-item has-submenu" id="vectorStrokeMoreColorMenu">
            边框更多颜色
            <div class="context-submenu text-label-color-submenu" id="vectorStrokeMoreColorSubmenu"></div>
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" id="vectorFillNoneMenu">无背景</div>
        <div class="text-label-color-swatches" id="vectorFillColorSwatches"></div>
        <div class="context-menu-item has-submenu" id="vectorFillMoreColorMenu">
            背景更多颜色
            <div class="context-submenu text-label-color-submenu" id="vectorFillMoreColorSubmenu"></div>
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item has-submenu" id="vectorOpacityMenu">
            透明度
            <div class="context-submenu" id="vectorOpacitySubmenu"></div>
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" id="vectorBringToFront">置于顶层</div>
        <div class="context-menu-item" id="vectorBringForward">上移一层</div>
        <div class="context-menu-item" id="vectorSendBackward">下移一层</div>
        <div class="context-menu-item" id="vectorSendToBack">置于底层</div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item danger" id="vectorShapeDeleteMenu">删除</div>
    </div>

    <!-- Thumbnail toggle button -->
    <button class="thumbnail-toggle" id="thumbnailToggle" title="缩略图">
        <svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/></svg>
    </button>

    <!-- Thumbnail panel -->
    <div class="thumbnail-panel" id="thumbnailPanel">
        <div class="thumbnail-canvas" id="thumbnailCanvas">
            <div class="thumbnail-viewport-indicator" id="viewportIndicator"></div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const tables = ${ErdWebView.jsonForWebviewScript(tables)};
        const relationships = ${ErdWebView.jsonForWebviewScript(relationships)};
        let comments = ${ErdWebView.jsonForWebviewScript(ErdWebView.comments)};
        let textLabels = ${ErdWebView.jsonForWebviewScript(ErdWebView.textLabels)};
        let vectorShapes = ${ErdWebView.jsonForWebviewScript(ErdWebView.vectorShapes)};

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
        let isMarqueeSelecting = false;
        let marqueeStart = null;
        let marqueeEl = null;
        let marqueeJustFinished = false;
        let selectionModeActive = true;

        function deactivateSelectionMode() {
            selectionModeActive = false;
            const selectBtn = document.getElementById('selectToolBtn');
            if (selectBtn) {
                selectBtn.classList.remove('active');
            }
            document.body.classList.remove('selection-mode');
        }

        function activateSelectionMode() {
            selectionModeActive = true;
            const selectBtn = document.getElementById('selectToolBtn');
            if (selectBtn) {
                selectBtn.classList.add('active');
            }
            document.body.classList.add('selection-mode');
            addTextLabelMode = false;
            if (addTextLabelBtn) {
                addTextLabelBtn.classList.remove('active');
            }
            document.body.classList.remove('add-text-mode');
            if (addVectorShapeType !== null) {
                addVectorShapeType = null;
                pendingVectorLineStart = null;
                isDrawingVectorRect = false;
                pendingVectorRectStart = null;
                if (typeof clearVectorShapePreview === 'function') {
                    clearVectorShapePreview();
                }
                if (vectorShapeBtn) {
                    vectorShapeBtn.classList.remove('active');
                }
                document.body.classList.remove('add-vector-mode');
                if (vectorShapeGrid) {
                    vectorShapeGrid.querySelectorAll('.vector-shape-menu-item').forEach(function(item) {
                        item.classList.remove('active');
                    });
                }
            }
            const vectorMenu = document.getElementById('vectorShapeMenu');
            if (vectorMenu) {
                vectorMenu.classList.remove('show');
            }
        }

        function canvasCoordsFromEvent(e) {
            const container = document.getElementById('canvas-container');
            const rect = container.getBoundingClientRect();
            return {
                x: (e.clientX - rect.left - panX) / zoom,
                y: (e.clientY - rect.top - panY) / zoom
            };
        }

        function getBoxBounds(x1, y1, x2, y2) {
            const x = Math.min(x1, x2);
            const y = Math.min(y1, y2);
            return {
                x: x,
                y: y,
                width: Math.max(Math.abs(x2 - x1), 1),
                height: Math.max(Math.abs(y2 - y1), 1)
            };
        }

        function isCanvasBackground(target) {
            if (!target) {
                return false;
            }
            return target.id === 'canvas-container' ||
                target.id === 'canvas' ||
                target.id === 'relationships';
        }

        function clearMarqueeOverlay() {
            if (marqueeEl) {
                marqueeEl.remove();
                marqueeEl = null;
            }
        }

        function clearVectorShapeResizeMode() {
            document.querySelectorAll('.vector-shape-node.resize-active').forEach(function(el) {
                el.classList.remove('resize-active');
            });
        }

        function clearAllObjectSelections() {
            document.querySelectorAll('.table-node.selected, .comment-node.selected, .text-label-node.selected, .vector-shape-node.selected').forEach(function(el) {
                el.classList.remove('selected');
            });
            clearVectorShapeResizeMode();
            if (selectedTable) {
                selectedTable.classList.remove('selected');
                selectedTable = null;
            }
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
            document.querySelectorAll('.relationship-selection-box').forEach(function(box) {
                box.remove();
            });
        }

        function rectsIntersect(a, b) {
            return a.x < b.x + b.width &&
                a.x + a.width > b.x &&
                a.y < b.y + b.height &&
                a.y + a.height > b.y;
        }

        function applyMarqueeSelection(box) {
            clearAllObjectSelections();
            let lastTable = null;
            document.querySelectorAll('.table-node, .comment-node, .text-label-node, .vector-shape-node').forEach(function(el) {
                const itemRect = {
                    x: parseFloat(el.style.left) || 0,
                    y: parseFloat(el.style.top) || 0,
                    width: el.offsetWidth,
                    height: el.offsetHeight
                };
                if (rectsIntersect(box, itemRect)) {
                    el.classList.add('selected');
                    if (el.classList.contains('table-node')) {
                        lastTable = el;
                    }
                    if (el.classList.contains('vector-shape-node')) {
                        initVectorShapeResizeHandles(el);
                        updateVectorShapeLineHandles(el);
                    }
                }
            });
            selectedTable = lastTable;
        }

        function updateMarqueePreview(startX, startY, endX, endY) {
            const box = getBoxBounds(startX, startY, endX, endY);
            if (!marqueeEl) {
                marqueeEl = document.createElement('div');
                marqueeEl.className = 'marquee-selection';
                document.getElementById('canvas').appendChild(marqueeEl);
            }
            marqueeEl.style.left = box.x + 'px';
            marqueeEl.style.top = box.y + 'px';
            marqueeEl.style.width = box.width + 'px';
            marqueeEl.style.height = box.height + 'px';
            return box;
        }

        function updateZoom() {
            updateCanvasTransform();
            document.getElementById('zoomLevel').textContent = Math.round(zoom * 100) + '%';
            if (thumbnailVisible) {
                updateThumbnail();
            }
        }

        function updateCanvasTransform() {
            const canvas = document.getElementById('canvas');
            canvas.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + zoom + ')';
        }

        function getDiagramBounds() {
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;

            document.querySelectorAll('.table-node, .comment-node, .text-label-node, .vector-shape-node').forEach(function(el) {
                const x = parseFloat(el.style.left) || 0;
                const y = parseFloat(el.style.top) || 0;
                const w = el.offsetWidth;
                const h = el.offsetHeight;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x + w);
                maxY = Math.max(maxY, y + h);
            });

            const svg = document.getElementById('relationships');
            if (svg && svg.childNodes.length > 0) {
                try {
                    const bbox = svg.getBBox();
                    if (bbox.width > 0 && bbox.height > 0) {
                        minX = Math.min(minX, bbox.x);
                        minY = Math.min(minY, bbox.y);
                        maxX = Math.max(maxX, bbox.x + bbox.width);
                        maxY = Math.max(maxY, bbox.y + bbox.height);
                    }
                } catch (e) {
                    // ignore empty or invalid svg bbox
                }
            }

            if (minX === Infinity) {
                return null;
            }

            return {
                minX: minX,
                minY: minY,
                maxX: maxX,
                maxY: maxY,
                centerX: (minX + maxX) / 2,
                centerY: (minY + maxY) / 2
            };
        }

        function resetViewAndCenter() {
            zoom = 1;
            const bounds = getDiagramBounds();
            const container = document.getElementById('canvas-container');
            if (bounds && container) {
                panX = container.clientWidth / 2 - bounds.centerX * zoom;
                panY = container.clientHeight / 2 - bounds.centerY * zoom;
            } else {
                panX = 0;
                panY = 0;
            }
            updateZoom();
        }

        // Initialize canvas panning and marquee selection
        function initCanvasPanning() {
            const container = document.getElementById('canvas-container');

            container.addEventListener('mousedown', function(e) {
                if (addTextLabelMode || addVectorShapeType || !selectionModeActive) {
                    return;
                }
                const onBackground = isCanvasBackground(e.target);
                if (!onBackground) {
                    return;
                }
                if (e.button === 1) {
                    isPanning = true;
                    panStartX = e.clientX - panX;
                    panStartY = e.clientY - panY;
                    document.body.classList.add('panning');
                    e.preventDefault();
                    return;
                }
                if (e.button !== 0) {
                    return;
                }
                isMarqueeSelecting = true;
                marqueeStart = canvasCoordsFromEvent(e);
                e.preventDefault();
            });

            document.addEventListener('mousemove', function(e) {
                if (isMarqueeSelecting && marqueeStart) {
                    const coords = canvasCoordsFromEvent(e);
                    updateMarqueePreview(marqueeStart.x, marqueeStart.y, coords.x, coords.y);
                    return;
                }
                if (isPanning) {
                    panX = e.clientX - panStartX;
                    panY = e.clientY - panStartY;
                    updateCanvasTransform();
                    if (thumbnailVisible) {
                        updateThumbnail();
                    }
                }
            });

            document.addEventListener('mouseup', function(e) {
                if (isMarqueeSelecting && marqueeStart) {
                    const coords = canvasCoordsFromEvent(e);
                    const box = getBoxBounds(marqueeStart.x, marqueeStart.y, coords.x, coords.y);
                    if (box.width >= 4 && box.height >= 4) {
                        applyMarqueeSelection(box);
                    } else {
                        clearAllObjectSelections();
                    }
                    clearMarqueeOverlay();
                    isMarqueeSelecting = false;
                    marqueeStart = null;
                    marqueeJustFinished = true;
                    setTimeout(function() {
                        marqueeJustFinished = false;
                    }, 0);
                    return;
                }
                if (isPanning) {
                    isPanning = false;
                    document.body.classList.remove('panning');
                }
            });

            // Add mouse wheel scrolling and zooming support
            container.addEventListener('wheel', function(e) {
                // Check if event is from table-body, if so, let it scroll normally
                if (e.target.closest('.table-body')) {
                    return; // Do not prevent default or handle canvas scrolling
                }
                
                e.preventDefault();
                const scrollSpeed = 50; // Adjust scroll sensitivity
                const zoomSpeed = 0.05; // Adjust zoom sensitivity
                
                // Check if Ctrl or Command key is pressed (for zooming)
                if (e.ctrlKey || e.metaKey) {
                    // Zoom in or out based on wheel direction
                    if (e.deltaY < 0) {
                        zoom = Math.min(zoom + zoomSpeed, 2); // Zoom in
                    } else {
                        zoom = Math.max(zoom - zoomSpeed, 0.3); // Zoom out
                    }
                    updateZoom();
                } else {
                    // Normal scrolling
                    panY -= e.deltaY * (scrollSpeed / 100);
                    updateCanvasTransform();
                    if (thumbnailVisible) {
                        updateThumbnail();
                    }
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
            resetViewAndCenter();
        });

        // Save button - send current state to extension
        document.getElementById('saveBtn').addEventListener('click', function() {
            // Collect actual table dimensions from DOM
            const tableElements = document.querySelectorAll('.table-node');
            const tablesData = [];

            console.log('[Save Button] Collecting data from', tableElements.length, 'tables');

            tableElements.forEach(function(tableEl) {
                const tableName = tableEl.getAttribute('data-table');
                if (tableName) {
                    const actualWidth = tableEl.offsetWidth;
                       const actualHeight = tableEl.offsetHeight;
                       const styleWidth = tableEl.style.width;
                       const styleHeight = tableEl.style.height;
                       const x = parseFloat(tableEl.style.left) || 0;
                       const y = parseFloat(tableEl.style.top) || 0;
   
                       console.log('[Save Button] Table:', tableName, 'offsetWidth:', actualWidth, 'offsetHeight:', actualHeight, 'style.width:', styleWidth, 'style.height:', styleHeight, 'position:', x, ',', y);
   
                       const tableColor = tableEl.dataset.color || undefined;
                       tablesData.push({
                           tableName: tableName,
                           x: x,
                           y: y,
                           width: actualWidth,
                           height: actualHeight,
                           color: tableColor
                       });
                }
            });

            // Collect comment card dimensions from DOM
            const commentElements = document.querySelectorAll('.comment-node');
            const commentsData = [];

            commentElements.forEach(function(commentEl) {
                const commentId = commentEl.dataset.commentId;
                const x = parseFloat(commentEl.style.left) || 0;
                const y = parseFloat(commentEl.style.top) || 0;
                const width = parseFloat(commentEl.style.width) || 200;
                const height = parseFloat(commentEl.style.height) || 100;
                const textarea = commentEl.querySelector('.comment-textarea');
                const text = textarea ? textarea.value : '';

                commentsData.push({
                    id: commentId,
                    x: x,
                    y: y,
                    width: width,
                    height: height,
                    text: text
                });
            });

            const textLabelsData = [];
            document.querySelectorAll('.text-label-node').forEach(function(labelEl) {
                const labelId = labelEl.dataset.labelId;
                const x = parseFloat(labelEl.style.left) || 0;
                const y = parseFloat(labelEl.style.top) || 0;
                const text = labelEl.textContent || '';
                const fontSize = parseInt(labelEl.style.fontSize, 10) || 16;
                const fontFamily = labelEl.style.fontFamily || '';
                const color = labelEl.style.color || '';
                const fontWeight = labelEl.style.fontWeight || '';
                const fontStyle = labelEl.style.fontStyle || '';

                textLabelsData.push({
                    id: labelId,
                    x: x,
                    y: y,
                    text: text,
                    fontSize: fontSize,
                    fontFamily: fontFamily,
                    color: color,
                    fontWeight: fontWeight,
                    fontStyle: fontStyle
                });
            });

            const vectorShapesData = collectVectorShapesData();

            vscode.postMessage({
                command: 'save',
                relationships: relationships,
                tables: tablesData,
                comments: commentsData,
                textLabels: textLabelsData,
                vectorShapes: vectorShapesData
            });
        });

        // Open button - trigger file open dialog
        document.getElementById('openBtn').addEventListener('click', function() {
            vscode.postMessage({
                command: 'open'
            });
        });

        // New ERD button - clear canvas
        document.getElementById('newErdBtn').addEventListener('click', function() {
            vscode.postMessage({
                command: 'newErd'
            });
        });

        // Add comment button - create new comment
        document.getElementById('addCommentBtn').addEventListener('click', function() {
            pushUndoSnapshot();
            const newComment = {
                id: 'comment_' + Date.now(),
                x: 100 + (comments.length * 50),
                y: 100 + (comments.length * 50),
                text: '',
                width: 200,
                height: 100
            };
            
            comments.push(newComment);
            
            // Create DOM element
            const commentEl = document.createElement('div');
            commentEl.className = 'comment-node';
            commentEl.dataset.commentId = newComment.id;
            commentEl.style.left = newComment.x + 'px';
            commentEl.style.top = newComment.y + 'px';
            commentEl.style.width = newComment.width + 'px';
            commentEl.style.height = newComment.height + 'px';
            commentEl.innerHTML =
                '<button class="comment-delete-btn" title="Delete comment">×</button>' +
                '<textarea class="comment-textarea" placeholder="Enter comment..."></textarea>';
            
            document.getElementById('canvas').appendChild(commentEl);
            
            // Initialize events for new comment
            initCommentEvents(commentEl);
            
            // Focus on the textarea
            const textarea = commentEl.querySelector('.comment-textarea');
            if (textarea) {
                textarea.focus();
            }
        });

        // Text label mode and creation
        let addTextLabelMode = false;
        const addTextLabelBtn = document.getElementById('addTextLabelBtn');
        const TEXT_LABEL_FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 48];
        const TEXT_LABEL_FONTS = [
            { label: '默认', value: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
            { label: 'Arial', value: 'Arial, sans-serif' },
            { label: 'Helvetica', value: 'Helvetica, sans-serif' },
            { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
            { label: 'Georgia', value: 'Georgia, serif' },
            { label: 'Courier New', value: '"Courier New", Courier, monospace' },
            { label: 'Consolas', value: 'Consolas, monospace' },
            { label: '微软雅黑', value: '"Microsoft YaHei", "微软雅黑", sans-serif' },
            { label: '宋体', value: 'SimSun, "宋体", serif' },
            { label: '黑体', value: 'SimHei, "黑体", sans-serif' },
            { label: 'PingFang SC', value: '"PingFang SC", "Hiragino Sans GB", sans-serif' }
        ];
        const TEXT_LABEL_QUICK_COLORS = ['#f44336', '#007acc', '#ffd700', '#4caf50'];
        const TEXT_LABEL_MORE_COLORS = ['#cccccc', '#ffffff', '#e91e63', '#ff9800', '#9c27b0', '#00bcd4'];

        function setAddTextLabelMode(enabled) {
            addTextLabelMode = enabled;
            addTextLabelBtn.classList.toggle('active', enabled);
            document.body.classList.toggle('add-text-mode', enabled);
            if (enabled) {
                deactivateSelectionMode();
                if (addVectorShapeType !== null) {
                    setAddVectorShapeType(null, true);
                }
            }
        }

        if (addTextLabelBtn) {
            addTextLabelBtn.addEventListener('click', function() {
                setAddTextLabelMode(!addTextLabelMode);
            });
        }

        function createTextLabel(x, y, options) {
            pushUndoSnapshot();
            options = options || {};
            const newLabel = {
                id: 'label_' + Date.now(),
                x: x,
                y: y,
                text: options.text || '',
                fontSize: options.fontSize || 16,
                fontFamily: options.fontFamily || '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                color: options.color || '',
                fontWeight: options.fontWeight || '',
                fontStyle: options.fontStyle || ''
            };

            textLabels.push(newLabel);

            const labelEl = document.createElement('div');
            labelEl.className = 'text-label-node';
            labelEl.contentEditable = 'true';
            labelEl.dataset.labelId = newLabel.id;
            labelEl.style.left = newLabel.x + 'px';
            labelEl.style.top = newLabel.y + 'px';
            labelEl.style.fontSize = newLabel.fontSize + 'px';
            labelEl.style.fontFamily = newLabel.fontFamily;
            if (newLabel.color) {
                labelEl.style.color = newLabel.color;
            }
            if (newLabel.fontWeight) {
                labelEl.style.fontWeight = newLabel.fontWeight;
            }
            if (newLabel.fontStyle) {
                labelEl.style.fontStyle = newLabel.fontStyle;
            }
            if (newLabel.text) {
                labelEl.textContent = newLabel.text;
            }

            document.getElementById('canvas').appendChild(labelEl);
            initTextLabelEvents(labelEl);

            labelEl.focus();
            return labelEl;
        }

        document.getElementById('canvas-container').addEventListener('click', function(e) {
            if (!addTextLabelMode) {
                return;
            }
            if (e.target.closest('.table-node') || e.target.closest('.comment-node') ||
                e.target.closest('.text-label-node') || e.target.closest('.erd-toolbar') ||
                e.target.closest('.zoom-controls')) {
                return;
            }

            e.preventDefault();
            e.stopPropagation();

            const coords = canvasCoordsFromEvent(e);
            createTextLabel(coords.x, coords.y);
        }, true);

        let textLabelContextTarget = null;
        const textLabelContextMenu = document.getElementById('textLabelContextMenu');
        const textLabelSizeSubmenu = document.getElementById('textLabelSizeSubmenu');
        const textLabelFontSubmenu = document.getElementById('textLabelFontSubmenu');
        const textLabelColorSwatches = document.getElementById('textLabelColorSwatches');
        const textLabelMoreColorSubmenu = document.getElementById('textLabelMoreColorSubmenu');
        const textLabelBoldMenu = document.getElementById('textLabelBoldMenu');
        const textLabelItalicMenu = document.getElementById('textLabelItalicMenu');

        function applyTextLabelColor(color) {
            if (textLabelContextTarget) {
                textLabelContextTarget.style.color = color;
                syncTextLabelData(textLabelContextTarget);
            }
            hideTextLabelContextMenu();
        }

        function appendTextLabelColorSwatch(container, color) {
            const swatch = document.createElement('button');
            swatch.type = 'button';
            swatch.className = 'color-swatch';
            swatch.style.backgroundColor = color;
            swatch.title = color;
            swatch.addEventListener('click', function(e) {
                e.stopPropagation();
                applyTextLabelColor(color);
            });
            container.appendChild(swatch);
        }

        TEXT_LABEL_QUICK_COLORS.forEach(function(color) {
            appendTextLabelColorSwatch(textLabelColorSwatches, color);
        });

        TEXT_LABEL_MORE_COLORS.forEach(function(color) {
            appendTextLabelColorSwatch(textLabelMoreColorSubmenu, color);
        });

        function isTextLabelBold(labelEl) {
            const weight = labelEl.style.fontWeight || '';
            return weight === 'bold' || parseInt(weight, 10) >= 700;
        }

        function isTextLabelItalic(labelEl) {
            return (labelEl.style.fontStyle || '') === 'italic';
        }

        function updateTextLabelStyleMenuState() {
            if (!textLabelContextTarget) {
                return;
            }
            textLabelBoldMenu.classList.toggle('active', isTextLabelBold(textLabelContextTarget));
            textLabelItalicMenu.classList.toggle('active', isTextLabelItalic(textLabelContextTarget));
        }

        textLabelBoldMenu.addEventListener('click', function(e) {
            e.stopPropagation();
            if (textLabelContextTarget) {
                const isBold = isTextLabelBold(textLabelContextTarget);
                textLabelContextTarget.style.fontWeight = isBold ? 'normal' : 'bold';
                syncTextLabelData(textLabelContextTarget);
                updateTextLabelStyleMenuState();
            }
        });

        textLabelItalicMenu.addEventListener('click', function(e) {
            e.stopPropagation();
            if (textLabelContextTarget) {
                const isItalic = isTextLabelItalic(textLabelContextTarget);
                textLabelContextTarget.style.fontStyle = isItalic ? 'normal' : 'italic';
                syncTextLabelData(textLabelContextTarget);
                updateTextLabelStyleMenuState();
            }
        });

        TEXT_LABEL_FONT_SIZES.forEach(function(size) {
            const item = document.createElement('div');
            item.className = 'context-submenu-item';
            item.textContent = size + 'px';
            item.dataset.size = String(size);
            item.addEventListener('click', function(e) {
                e.stopPropagation();
                if (textLabelContextTarget) {
                    textLabelContextTarget.style.fontSize = size + 'px';
                    syncTextLabelData(textLabelContextTarget);
                }
                hideTextLabelContextMenu();
            });
            textLabelSizeSubmenu.appendChild(item);
        });

        TEXT_LABEL_FONTS.forEach(function(font) {
            const item = document.createElement('div');
            item.className = 'context-submenu-item';
            item.textContent = font.label;
            item.dataset.font = font.value;
            item.style.fontFamily = font.value;
            item.addEventListener('click', function(e) {
                e.stopPropagation();
                if (textLabelContextTarget) {
                    textLabelContextTarget.style.fontFamily = font.value;
                    syncTextLabelData(textLabelContextTarget);
                }
                hideTextLabelContextMenu();
            });
            textLabelFontSubmenu.appendChild(item);
        });

        function syncTextLabelData(labelEl) {
            const labelId = labelEl.dataset.labelId;
            const label = textLabels.find(function(l) { return l.id === labelId; });
            if (!label) {
                return;
            }
            label.x = parseFloat(labelEl.style.left) || 0;
            label.y = parseFloat(labelEl.style.top) || 0;
            label.text = labelEl.textContent || '';
            label.fontSize = parseInt(labelEl.style.fontSize, 10) || 16;
            label.fontFamily = labelEl.style.fontFamily || '';
            label.color = labelEl.style.color || '';
            label.fontWeight = labelEl.style.fontWeight || '';
            label.fontStyle = labelEl.style.fontStyle || '';
        }

        function hideTextLabelContextMenu() {
            textLabelContextMenu.style.display = 'none';
            textLabelContextTarget = null;
        }

        document.addEventListener('mousedown', function(e) {
            if (e.button !== 0) {
                return;
            }
            if (!e.target.closest('.text-label-context-menu')) {
                hideTextLabelContextMenu();
            }
        }, true);

        document.getElementById('textLabelSizeMenu').addEventListener('mouseenter', function() {
            const currentSize = textLabelContextTarget ?
                (parseInt(textLabelContextTarget.style.fontSize, 10) || 16) : 0;
            textLabelSizeSubmenu.querySelectorAll('.context-submenu-item').forEach(function(item) {
                item.classList.toggle('active', parseInt(item.dataset.size, 10) === currentSize);
            });
        });
        document.getElementById('textLabelFontMenu').addEventListener('mouseenter', function() {
            const currentFont = textLabelContextTarget ? (textLabelContextTarget.style.fontFamily || '') : '';
            textLabelFontSubmenu.querySelectorAll('.context-submenu-item').forEach(function(item) {
                item.classList.toggle('active', item.dataset.font === currentFont);
            });
        });

        function isTextLabelEmpty(labelEl) {
            return !(labelEl.textContent || '').trim();
        }

        function deleteTextLabel(labelEl) {
            if (!labelEl || !labelEl.isConnected) {
                return;
            }
            const labelId = labelEl.dataset.labelId;
            const idx = textLabels.findIndex(function(l) { return l.id === labelId; });
            if (idx !== -1) {
                textLabels.splice(idx, 1);
            }
            labelEl.remove();
            hideTextLabelContextMenu();
        }

        document.getElementById('textLabelDeleteMenu').addEventListener('click', function(e) {
            e.stopPropagation();
            deleteTextLabel(textLabelContextTarget);
        });

        function initTextLabelEvents(labelEl) {
            labelEl.addEventListener('input', function() {
                syncTextLabelData(labelEl);
            });

            labelEl.addEventListener('blur', function() {
                if (isTextLabelEmpty(labelEl)) {
                    deleteTextLabel(labelEl);
                }
            });

            labelEl.addEventListener('contextmenu', function(e) {
                e.preventDefault();
                e.stopPropagation();
                textLabelContextTarget = labelEl;
                document.querySelectorAll('.text-label-node').forEach(function(node) {
                    node.classList.remove('selected');
                });
                labelEl.classList.add('selected');

                textLabelContextMenu.style.left = e.clientX + 'px';
                textLabelContextMenu.style.top = e.clientY + 'px';
                textLabelContextMenu.style.display = 'block';
                updateTextLabelStyleMenuState();
            });

            labelEl.addEventListener('dblclick', function(e) {
                e.stopPropagation();
                labelDragPending = false;
                isLabelDragging = false;
                labelEl.style.zIndex = '';
                document.body.classList.remove('panning');
                labelEl.focus();
            });

            labelEl.addEventListener('mousedown', function(e) {
                if (e.button !== 0) {
                    return;
                }
                if (addTextLabelMode) {
                    e.stopPropagation();
                }
            });

            let isLabelDragging = false;
            let labelDragPending = false;
            let labelDragStartX = 0;
            let labelDragStartY = 0;
            let labelDragStartLeft = 0;
            let labelDragStartTop = 0;

            labelEl.addEventListener('mousedown', function(e) {
                if (e.button !== 0 || document.activeElement === labelEl) {
                    return;
                }
                pushUndoSnapshot();
                labelDragPending = true;
                labelDragStartX = e.clientX;
                labelDragStartY = e.clientY;
                labelDragStartLeft = parseFloat(labelEl.style.left) || 0;
                labelDragStartTop = parseFloat(labelEl.style.top) || 0;
            });

            document.addEventListener('mousemove', function labelDragMove(e) {
                if (labelDragPending && !isLabelDragging) {
                    const dx = Math.abs(e.clientX - labelDragStartX);
                    const dy = Math.abs(e.clientY - labelDragStartY);
                    if (dx > 4 || dy > 4) {
                        isLabelDragging = true;
                        labelDragPending = false;
                        labelEl.style.zIndex = '1000';
                        labelEl.classList.add('selected');
                        document.body.classList.add('panning');
                    }
                }
                if (!isLabelDragging) {
                    return;
                }
                const deltaX = e.clientX - labelDragStartX;
                const deltaY = e.clientY - labelDragStartY;
                const x = (deltaX / zoom) + labelDragStartLeft;
                const y = (deltaY / zoom) + labelDragStartTop;
                labelEl.style.left = x + 'px';
                labelEl.style.top = y + 'px';
                syncTextLabelData(labelEl);
            });

            document.addEventListener('mouseup', function labelDragUp() {
                labelDragPending = false;
                if (isLabelDragging) {
                    isLabelDragging = false;
                    labelEl.style.zIndex = '';
                    document.body.classList.remove('panning');
                }
            });

            labelEl.addEventListener('click', function(e) {
                e.stopPropagation();
                document.querySelectorAll('.text-label-node').forEach(function(node) {
                    node.classList.remove('selected');
                });
                labelEl.classList.add('selected');
            });

            labelEl.addEventListener('keydown', function(e) {
                if (e.key === 'Delete' || e.key === 'Backspace') {
                    if (isTextLabelEmpty(labelEl) && document.activeElement === labelEl) {
                        e.preventDefault();
                        deleteTextLabel(labelEl);
                    }
                }
            });
        }

        document.querySelectorAll('.text-label-node').forEach(initTextLabelEvents);
        let addVectorShapeType = null;
        let pendingVectorLineStart = null;
        let isDrawingVectorRect = false;
        let pendingVectorRectStart = null;
        let vectorShapePreviewEl = null;
        const vectorShapeBtn = document.getElementById('vectorShapeBtn');
        const vectorShapeMenu = document.getElementById('vectorShapeMenu');
        const vectorShapeGrid = document.getElementById('vectorShapeGrid');

        const VECTOR_SHAPE_DEFS = [
            { type: 'line', label: '直线', icon: '<line x1="3" y1="21" x2="21" y2="3"/>' },
            { type: 'arrow-line', label: '箭头线', icon: '<line x1="3" y1="12" x2="19" y2="12"/><polyline points="14 7 19 12 14 17"/>' },
            { type: 'curve', label: '曲线', icon: '<path d="M4 18 Q12 4 20 18"/>' },
            { type: 'rounded-rect', label: '圆角矩形', icon: '<rect x="3" y="5" width="18" height="14" rx="3"/>' },
            { type: 'circle', label: '圆形', icon: '<circle cx="12" cy="12" r="9"/>' },
            { type: '_divider', label: '' },
            { type: 'user', label: '头像', icon: '<circle cx="12" cy="8" r="4"/><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/>' },
            { type: 'cloud', label: '云', icon: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>' },
            { type: 'database', label: '数据库', icon: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>' },
            { type: 'monitor', label: '电脑', icon: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>' },
            { type: 'smartphone', label: '手机', icon: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>' },
            { type: 'bot', label: 'AI', icon: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>' }
        ];

        function isVectorLineType(type) {
            return type === 'line' || type === 'arrow-line' || type === 'curve';
        }

        function isVectorRectDrawType(type) {
            return type === 'rounded-rect' || type === 'circle';
        }

        function isVectorIconType(type) {
            return type === 'user' || type === 'cloud' || type === 'database' ||
                type === 'monitor' || type === 'smartphone' || type === 'bot';
        }

        function getVectorLineBounds(x1, y1, x2, y2) {
            const pad = 6;
            const minX = Math.min(x1, x2) - pad;
            const minY = Math.min(y1, y2) - pad;
            const maxX = Math.max(x1, x2) + pad;
            const maxY = Math.max(y1, y2) + pad;
            return {
                x: minX,
                y: minY,
                width: Math.max(maxX - minX, 1),
                height: Math.max(maxY - minY, 1),
                lx1: x1 - minX,
                ly1: y1 - minY,
                lx2: x2 - minX,
                ly2: y2 - minY
            };
        }

        function getVectorShapeStyle(shape) {
            return {
                stroke: shape.stroke || '',
                strokeWidth: shape.strokeWidth || 2,
                fill: shape.fill !== undefined ? shape.fill : 'none',
                strokeDasharray: shape.strokeDasharray || ''
            };
        }

        function getVectorStrokeDasharray(styleName) {
            if (styleName === 'dashed') {
                return '8,4';
            }
            if (styleName === 'dotted') {
                return '2,3';
            }
            return '';
        }

        function getVectorStrokeStyleName(dasharray) {
            if (dasharray === '8,4') {
                return 'dashed';
            }
            if (dasharray === '2,3') {
                return 'dotted';
            }
            return 'solid';
        }

        function buildVectorShapeSvgMarkup(type, shapeId, width, height, lx1, ly1, lx2, ly2, style) {
            style = style || {};
            const sw = style.strokeWidth || 2;
            const stroke = style.stroke || 'currentColor';
            const fill = style.fill !== undefined ? style.fill : 'none';
            const dash = style.strokeDasharray || '';
            const dashAttr = dash ? ' stroke-dasharray="' + dash + '"' : '';
            let bgRect = '';
            if (fill && fill !== 'none' && isVectorIconType(type)) {
                bgRect = '<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="' + fill + '" rx="4"/>';
            }
            if (type === 'line') {
                return bgRect + '<line x1="' + lx1 + '" y1="' + ly1 + '" x2="' + lx2 + '" y2="' + ly2 + '" stroke="' + stroke + '" stroke-width="' + sw + '" stroke-linecap="round"' + dashAttr + '/>';
            }
            if (type === 'arrow-line') {
                const markerId = 'arrow-' + shapeId;
                return bgRect + '<defs><marker id="' + markerId + '" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="' + stroke + '"/></marker></defs>' +
                    '<line x1="' + lx1 + '" y1="' + ly1 + '" x2="' + lx2 + '" y2="' + ly2 + '" stroke="' + stroke + '" stroke-width="' + sw + '" stroke-linecap="round"' + dashAttr + ' marker-end="url(#' + markerId + ')"/>';
            }
            if (type === 'curve') {
                const cpx = (lx1 + lx2) / 2;
                const cpy = Math.min(ly1, ly2) - Math.max(20, Math.abs(lx2 - lx1) * 0.35);
                return bgRect + '<path d="M ' + lx1 + ' ' + ly1 + ' Q ' + cpx + ' ' + cpy + ' ' + lx2 + ' ' + ly2 + '" fill="none" stroke="' + stroke + '" stroke-width="' + sw + '" stroke-linecap="round"' + dashAttr + '/>';
            }
            if (type === 'rounded-rect') {
                return bgRect + '<rect x="2" y="2" width="' + Math.max(width - 4, 1) + '" height="' + Math.max(height - 4, 1) + '" rx="8" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + sw + '"' + dashAttr + '/>';
            }
            if (type === 'circle') {
                const r = Math.max(Math.min(width, height) / 2 - 2, 1);
                return bgRect + '<circle cx="' + (width / 2) + '" cy="' + (height / 2) + '" r="' + r + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + sw + '"' + dashAttr + '/>';
            }
            const iconPaths = {
                user: '<circle cx="12" cy="8" r="4"/><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/>',
                cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
                database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
                monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
                smartphone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
                bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>'
            };
            if (iconPaths[type]) {
                return bgRect + iconPaths[type];
            }
            return '';
        }

        function getVectorShapeByEl(shapeEl) {
            return vectorShapes.find(function(s) { return s.id === shapeEl.dataset.shapeId; });
        }

        function getVectorShapeOpacity(shape) {
            if (shape.opacity !== undefined && shape.opacity !== null) {
                return shape.opacity;
            }
            return 1;
        }

        function applyVectorShapeVisualStyles(shapeEl, shape) {
            if (shape.stroke) {
                shapeEl.style.color = shape.stroke;
            } else {
                shapeEl.style.removeProperty('color');
            }
            if (shape.zIndex !== undefined && shape.zIndex !== null) {
                shapeEl.style.zIndex = String(shape.zIndex);
            }
            const opacity = getVectorShapeOpacity(shape);
            if (opacity < 1) {
                shapeEl.style.opacity = String(opacity);
            } else {
                shapeEl.style.removeProperty('opacity');
            }
        }

        function refreshVectorShapeElementContent(shapeEl, shape, lineBounds) {
            shape = shape || getVectorShapeByEl(shapeEl);
            if (!shape) {
                return;
            }
            const type = shape.type;
            const style = getVectorShapeStyle(shape);
            let lx1 = 0;
            let ly1 = 0;
            let lx2 = shapeEl.offsetWidth;
            let ly2 = shapeEl.offsetHeight;
            let vbW = shapeEl.offsetWidth;
            let vbH = shapeEl.offsetHeight;
            if (lineBounds) {
                lx1 = lineBounds.lx1;
                ly1 = lineBounds.ly1;
                lx2 = lineBounds.lx2;
                ly2 = lineBounds.ly2;
                vbW = lineBounds.width;
                vbH = lineBounds.height;
            } else if (isVectorLineType(type) && shape.x2 !== undefined && shape.y2 !== undefined) {
                const bounds = getVectorLineBounds(shape.x, shape.y, shape.x2, shape.y2);
                lx1 = bounds.lx1;
                ly1 = bounds.ly1;
                lx2 = bounds.lx2;
                ly2 = bounds.ly2;
                vbW = bounds.width;
                vbH = bounds.height;
            }
            const viewBox = isVectorIconType(type) ? '0 0 24 24' : ('0 0 ' + vbW + ' ' + vbH);
            const preserve = isVectorIconType(type) ? 'xMidYMid meet' : 'none';
            const inner = buildVectorShapeSvgMarkup(type, shape.id, vbW, vbH, lx1, ly1, lx2, ly2, style);
            const svgEl = shapeEl.querySelector('svg');
            if (svgEl) {
                svgEl.setAttribute('viewBox', viewBox);
                svgEl.setAttribute('preserveAspectRatio', preserve);
                if (isVectorIconType(type)) {
                    svgEl.innerHTML = '<g fill="none" stroke="' + (style.stroke || 'currentColor') + '" stroke-width="' + style.strokeWidth + '" stroke-linecap="round" stroke-linejoin="round"' +
                        (style.strokeDasharray ? ' stroke-dasharray="' + style.strokeDasharray + '"' : '') + '>' + inner + '</g>';
                } else {
                    svgEl.innerHTML = inner;
                }
            }
            applyVectorShapeVisualStyles(shapeEl, shape);
            updateVectorShapeLineHandles(shapeEl, lineBounds);
        }

        function repositionVectorLineElement(shapeEl, shape) {
            const bounds = getVectorLineBounds(shape.x, shape.y, shape.x2, shape.y2);
            shapeEl.style.left = bounds.x + 'px';
            shapeEl.style.top = bounds.y + 'px';
            shapeEl.style.width = bounds.width + 'px';
            shapeEl.style.height = bounds.height + 'px';
            shape.width = bounds.width;
            shape.height = bounds.height;
            refreshVectorShapeElementContent(shapeEl, shape, bounds);
        }

        function updateVectorShapeLineHandles(shapeEl, lineBounds) {
            const type = shapeEl.dataset.shapeType;
            if (!isVectorLineType(type)) {
                return;
            }
            const startHandle = shapeEl.querySelector('.vector-shape-resize-handle.start');
            const endHandle = shapeEl.querySelector('.vector-shape-resize-handle.end');
            if (!startHandle || !endHandle) {
                return;
            }
            const shape = getVectorShapeByEl(shapeEl);
            if (!shape || shape.x2 === undefined || shape.y2 === undefined) {
                return;
            }
            const bounds = lineBounds || getVectorLineBounds(shape.x, shape.y, shape.x2, shape.y2);
            startHandle.style.left = bounds.lx1 + 'px';
            startHandle.style.top = bounds.ly1 + 'px';
            endHandle.style.left = bounds.lx2 + 'px';
            endHandle.style.top = bounds.ly2 + 'px';
        }

        let vectorShapeResizing = null;
        let vectorShapeDragState = null;

        function debugVectorShapeResize(eventName, detail) {
            if (detail === undefined) {
                console.log('[ERD Vector Resize]', eventName);
                return;
            }
            console.log('[ERD Vector Resize]', eventName, detail);
        }

        function finishVectorShapeResize() {
            if (vectorShapeResizing) {
                debugVectorShapeResize('finish', {
                    kind: vectorShapeResizing.kind,
                    shapeId: vectorShapeResizing.shapeEl && vectorShapeResizing.shapeEl.dataset ? vectorShapeResizing.shapeEl.dataset.shapeId : undefined
                });
                if (vectorShapeResizing.handle) {
                    vectorShapeResizing.handle.classList.remove('dragging');
                }
                const shape = getVectorShapeByEl(vectorShapeResizing.shapeEl);
                vectorShapeResizing.shapeEl.style.zIndex = shape && shape.zIndex !== undefined ?
                    String(shape.zIndex) : '';
                vectorShapeResizing = null;
            }
            document.body.classList.remove('vector-resizing');
        }

        function applyVectorBoxResize(resizeState, clientX, clientY) {
            const shapeEl = resizeState.shapeEl;
            const direction = resizeState.direction;
            const minSize = 16;
            const dx = (clientX - resizeState.startX) / zoom;
            const dy = (clientY - resizeState.startY) / zoom;
            let newLeft = resizeState.startLeft;
            let newTop = resizeState.startTop;
            let newWidth = resizeState.startWidth;
            let newHeight = resizeState.startHeight;
            if (direction.indexOf('e') >= 0) {
                newWidth = Math.max(minSize, resizeState.startWidth + dx);
            }
            if (direction.indexOf('w') >= 0) {
                newWidth = Math.max(minSize, resizeState.startWidth - dx);
                newLeft = resizeState.startLeft + (resizeState.startWidth - newWidth);
            }
            if (direction.indexOf('s') >= 0) {
                newHeight = Math.max(minSize, resizeState.startHeight + dy);
            }
            if (direction.indexOf('n') >= 0) {
                newHeight = Math.max(minSize, resizeState.startHeight - dy);
                newTop = resizeState.startTop + (resizeState.startHeight - newHeight);
            }
            shapeEl.style.left = newLeft + 'px';
            shapeEl.style.top = newTop + 'px';
            shapeEl.style.width = newWidth + 'px';
            shapeEl.style.height = newHeight + 'px';
            refreshVectorShapeElementContent(shapeEl);
            syncVectorShapeData(shapeEl);
            debugVectorShapeResize('box move', {
                shapeId: shapeEl.dataset.shapeId,
                direction: direction,
                left: Math.round(newLeft * 100) / 100,
                top: Math.round(newTop * 100) / 100,
                width: Math.round(newWidth * 100) / 100,
                height: Math.round(newHeight * 100) / 100,
                zoom: zoom
            });
        }

        function applyVectorLineEndpointResize(resizeState, e) {
            const shapeEl = resizeState.shapeEl;
            const shape = resizeState.shape;
            const coords = canvasCoordsFromEvent(e);
            if (resizeState.role === 'start') {
                shape.x = coords.x;
                shape.y = coords.y;
            } else {
                shape.x2 = coords.x;
                shape.y2 = coords.y;
            }
            repositionVectorLineElement(shapeEl, shape);
            syncVectorShapeData(shapeEl);
            debugVectorShapeResize('line endpoint move', {
                shapeId: shapeEl.dataset.shapeId,
                role: resizeState.role,
                x: Math.round(coords.x * 100) / 100,
                y: Math.round(coords.y * 100) / 100,
                x2: shape.x2 !== undefined ? Math.round(shape.x2 * 100) / 100 : undefined,
                y2: shape.y2 !== undefined ? Math.round(shape.y2 * 100) / 100 : undefined,
                zoom: zoom
            });
        }

        function findVectorShapeHandleAt(shapeEl, clientX, clientY) {
            if (!shapeEl || !shapeEl.classList.contains('resize-active')) {
                return null;
            }
            const handles = shapeEl.querySelectorAll('.vector-shape-resize-handle');
            for (let i = 0; i < handles.length; i++) {
                const handle = handles[i];
                const rect = handle.getBoundingClientRect();
                if (rect.width <= 0 && rect.height <= 0) {
                    continue;
                }
                const pad = 10;
                if (clientX >= rect.left - pad && clientX <= rect.right + pad &&
                    clientY >= rect.top - pad && clientY <= rect.bottom + pad) {
                    return handle;
                }
            }
            return null;
        }

        function startVectorShapeResize(handle, shapeEl, clientX, clientY) {
            finishVectorShapeResize();
            vectorShapeDragState = null;

            const direction = handle.dataset.handle;
            if (!direction) {
                debugVectorShapeResize('start ignored: missing handle direction', {
                    shapeId: shapeEl.dataset.shapeId,
                    handleClass: handle.className
                });
                return;
            }
            pushUndoSnapshot();
            if (!shapeEl.classList.contains('resize-active')) {
                enterVectorShapeResizeMode(shapeEl);
            }

            if (isVectorLineType(shapeEl.dataset.shapeType)) {
                const shape = getVectorShapeByEl(shapeEl);
                if (!shape || shape.x2 === undefined || shape.y2 === undefined) {
                    return;
                }
                vectorShapeResizing = {
                    kind: 'line',
                    shapeEl: shapeEl,
                    role: direction,
                    shape: shape,
                    handle: handle,
                    startX: clientX,
                    startY: clientY
                };
                debugVectorShapeResize('start line', {
                    shapeId: shapeEl.dataset.shapeId,
                    role: direction,
                    clientX: clientX,
                    clientY: clientY,
                    shape: {
                        x: shape.x,
                        y: shape.y,
                        x2: shape.x2,
                        y2: shape.y2
                    }
                });
            } else {
                vectorShapeResizing = {
                    kind: 'box',
                    shapeEl: shapeEl,
                    direction: direction,
                    handle: handle,
                    startX: clientX,
                    startY: clientY,
                    startLeft: parseFloat(shapeEl.style.left) || 0,
                    startTop: parseFloat(shapeEl.style.top) || 0,
                    startWidth: shapeEl.offsetWidth,
                    startHeight: shapeEl.offsetHeight
                };
                debugVectorShapeResize('start box', {
                    shapeId: shapeEl.dataset.shapeId,
                    direction: direction,
                    clientX: clientX,
                    clientY: clientY,
                    left: vectorShapeResizing.startLeft,
                    top: vectorShapeResizing.startTop,
                    width: vectorShapeResizing.startWidth,
                    height: vectorShapeResizing.startHeight,
                    zoom: zoom
                });
            }
            handle.classList.add('dragging');
            shapeEl.style.zIndex = '1000';
            document.body.classList.add('vector-resizing');
        }

        function bindVectorShapeResizeHandle(handle, shapeEl) {
            if (handle.dataset.bound === '1') {
                return;
            }
            handle.dataset.bound = '1';

            function onHandlePointerDown(e) {
                debugVectorShapeResize('handle mousedown', {
                    shapeId: shapeEl.dataset.shapeId,
                    handle: handle.dataset.handle,
                    button: e.button,
                    addVectorShapeType: addVectorShapeType
                });
                if (e.button !== 0) {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                if (typeof e.stopImmediatePropagation === 'function') {
                    e.stopImmediatePropagation();
                }
                startVectorShapeResize(handle, shapeEl, e.clientX, e.clientY);
            }

            handle.addEventListener('mousedown', onHandlePointerDown, true);
        }

        function ensureVectorShapeResizeDocumentListeners() {
            if (window.__vectorShapeResizeDocumentListeners) {
                document.removeEventListener('mousedown', window.__vectorShapeResizeDocumentListeners.onMouseDown, true);
                document.removeEventListener('mousemove', window.__vectorShapeResizeDocumentListeners.onMouseMove, true);
                document.removeEventListener('mouseup', window.__vectorShapeResizeDocumentListeners.onMouseUp, true);
                debugVectorShapeResize('rebind document listeners');
            } else {
                debugVectorShapeResize('bind document listeners');
            }

            function onMouseDown(e) {
                const target = e.target;
                if (!target || !target.closest) {
                    return;
                }
                const handle = target.closest('.vector-shape-resize-handle');
                const shapeEl = target.closest('.vector-shape-node') || (handle ? handle.closest('.vector-shape-node') : null);
                if (!shapeEl && !handle) {
                    return;
                }
                debugVectorShapeResize('document mousedown', {
                    button: e.button,
                    shapeId: shapeEl && shapeEl.dataset ? shapeEl.dataset.shapeId : undefined,
                    targetClass: target.className,
                    handle: handle && handle.dataset ? handle.dataset.handle : undefined,
                    resizeActive: !!(shapeEl && shapeEl.classList && shapeEl.classList.contains('resize-active'))
                });
                if (e.button !== 0 || !handle) {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                if (typeof e.stopImmediatePropagation === 'function') {
                    e.stopImmediatePropagation();
                }
                startVectorShapeResize(handle, shapeEl, e.clientX, e.clientY);
            }

            function onMouseMove(e) {
                if (vectorShapeResizing) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (vectorShapeResizing.kind === 'box') {
                        applyVectorBoxResize(vectorShapeResizing, e.clientX, e.clientY);
                    } else if (vectorShapeResizing.kind === 'line') {
                        applyVectorLineEndpointResize(vectorShapeResizing, e);
                    }
                    return;
                }
                if (!vectorShapeDragState) {
                    return;
                }
                const dx = e.clientX - vectorShapeDragState.startX;
                const dy = e.clientY - vectorShapeDragState.startY;
                if (!vectorShapeDragState.moved) {
                    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) {
                        return;
                    }
                    vectorShapeDragState.moved = true;
                    if (!vectorShapeDragState.undoPushed) {
                        pushUndoSnapshot();
                        vectorShapeDragState.undoPushed = true;
                    }
                    vectorShapeDragState.shapeEl.style.zIndex = '1000';
                    document.body.classList.add('panning');
                }
                vectorShapeDragState.shapeEl.style.left = (vectorShapeDragState.startLeft + dx / zoom) + 'px';
                vectorShapeDragState.shapeEl.style.top = (vectorShapeDragState.startTop + dy / zoom) + 'px';
                syncVectorShapeData(vectorShapeDragState.shapeEl);
            }

            function onMouseUp() {
                if (vectorShapeResizing) {
                    finishVectorShapeResize();
                }
                if (vectorShapeDragState) {
                    if (vectorShapeDragState.moved) {
                        const shape = getVectorShapeByEl(vectorShapeDragState.shapeEl);
                        vectorShapeDragState.shapeEl.style.zIndex = shape && shape.zIndex !== undefined ?
                            String(shape.zIndex) : vectorShapeDragState.prevZIndex;
                        document.body.classList.remove('panning');
                    }
                    vectorShapeDragState = null;
                }
            }

            document.addEventListener('mousedown', onMouseDown, true);
            document.addEventListener('mousemove', onMouseMove, true);
            document.addEventListener('mouseup', onMouseUp, true);
            window.__vectorShapeResizeDocumentListeners = {
                onMouseDown: onMouseDown,
                onMouseMove: onMouseMove,
                onMouseUp: onMouseUp
            };
        }

        function initGlobalVectorShapeInteraction() {
            ensureVectorShapeResizeDocumentListeners();

            const canvasContainer = document.getElementById('canvas-container');
            if (!canvasContainer) {
                debugVectorShapeResize('global interaction skipped: missing canvas-container');
                return;
            }

            if (window.__vectorShapeInteractionListener && window.__vectorShapeInteractionContainer) {
                window.__vectorShapeInteractionContainer.removeEventListener('mousedown', window.__vectorShapeInteractionListener, true);
                debugVectorShapeResize('rebind canvas mousedown listener');
            } else {
                debugVectorShapeResize('bind canvas mousedown listener');
            }

            function onCanvasVectorShapeMouseDown(e) {
                const targetHandle = e.target.closest && e.target.closest('.vector-shape-resize-handle');
                const targetShape = e.target.closest && e.target.closest('.vector-shape-node');
                if (e.button !== 0 || (addVectorShapeType && !targetHandle && !targetShape)) {
                    return;
                }
                if (e.target.closest('.erd-toolbar') || e.target.closest('#vectorShapeContextMenu')) {
                    return;
                }

                const shapeEl = e.target.closest && e.target.closest('.vector-shape-node');
                if (shapeEl) {
                    const handle = (e.target.closest && e.target.closest('.vector-shape-resize-handle')) ||
                        findVectorShapeHandleAt(shapeEl, e.clientX, e.clientY);
                    if (handle) {
                        debugVectorShapeResize('canvas mousedown hit handle', {
                            shapeId: shapeEl.dataset.shapeId,
                            handle: handle.dataset.handle,
                            targetClass: e.target.className
                        });
                        e.preventDefault();
                        e.stopPropagation();
                        if (typeof e.stopImmediatePropagation === 'function') {
                            e.stopImmediatePropagation();
                        }
                        startVectorShapeResize(handle, shapeEl, e.clientX, e.clientY);
                        return;
                    }
                    if (e.target.closest('.vector-shape-resize-handle')) {
                        return;
                    }
                } else if (e.target.closest('.vector-shape-resize-handle')) {
                    return;
                }

                if (!shapeEl) {
                    return;
                }

                e.preventDefault();
                e.stopPropagation();

                selectVectorShape(shapeEl);
                debugVectorShapeResize('start drag pending', {
                    shapeId: shapeEl.dataset.shapeId,
                    clientX: e.clientX,
                    clientY: e.clientY,
                    left: parseFloat(shapeEl.style.left) || 0,
                    top: parseFloat(shapeEl.style.top) || 0
                });
                vectorShapeDragState = {
                    shapeEl: shapeEl,
                    startX: e.clientX,
                    startY: e.clientY,
                    startLeft: parseFloat(shapeEl.style.left) || 0,
                    startTop: parseFloat(shapeEl.style.top) || 0,
                    prevZIndex: shapeEl.style.zIndex || '',
                    moved: false,
                    undoPushed: false
                };
            }

            canvasContainer.addEventListener('mousedown', onCanvasVectorShapeMouseDown, true);
            window.__vectorShapeInteractionContainer = canvasContainer;
            window.__vectorShapeInteractionListener = onCanvasVectorShapeMouseDown;
        }

        function getVectorShapeHandlesLayer(shapeEl) {
            let layer = shapeEl.querySelector('.vector-shape-handles');
            if (!layer) {
                layer = document.createElement('div');
                layer.className = 'vector-shape-handles';
                shapeEl.appendChild(layer);
            }
            return layer;
        }

        function initVectorShapeResizeHandles(shapeEl) {
            ensureVectorShapeResizeDocumentListeners();
            const handlesLayer = getVectorShapeHandlesLayer(shapeEl);
            const type = shapeEl.dataset.shapeType;
            debugVectorShapeResize('init handles', {
                shapeId: shapeEl.dataset.shapeId,
                type: type,
                existingHandles: handlesLayer.querySelectorAll('.vector-shape-resize-handle').length
            });
            if (isVectorLineType(type)) {
                if (!handlesLayer.querySelector('.vector-shape-resize-handle.start')) {
                    ['start', 'end'].forEach(function(role) {
                        const handle = document.createElement('div');
                        handle.className = 'vector-shape-resize-handle ' + role;
                        handle.dataset.handle = role;
                        handlesLayer.appendChild(handle);
                        bindVectorShapeResizeHandle(handle, shapeEl);
                    });
                } else {
                    handlesLayer.querySelectorAll('.vector-shape-resize-handle').forEach(function(handle) {
                        bindVectorShapeResizeHandle(handle, shapeEl);
                    });
                }
                updateVectorShapeLineHandles(shapeEl);
                return;
            }
            if (!handlesLayer.querySelector('.vector-shape-resize-handle')) {
                ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(function(dir) {
                    const handle = document.createElement('div');
                    handle.className = 'vector-shape-resize-handle ' + dir;
                    handle.dataset.handle = dir;
                    handlesLayer.appendChild(handle);
                    bindVectorShapeResizeHandle(handle, shapeEl);
                });
            } else {
                handlesLayer.querySelectorAll('.vector-shape-resize-handle').forEach(function(handle) {
                    bindVectorShapeResizeHandle(handle, shapeEl);
                });
            }
        }

        function selectVectorShape(shapeEl) {
            clearVectorShapeResizeMode();
            document.querySelectorAll('.vector-shape-node').forEach(function(node) {
                node.classList.remove('selected');
            });
            shapeEl.classList.add('selected');
            initVectorShapeResizeHandles(shapeEl);
            updateVectorShapeLineHandles(shapeEl);
            debugVectorShapeResize('select shape', {
                shapeId: shapeEl.dataset.shapeId,
                type: shapeEl.dataset.shapeType
            });
        }

        function enterVectorShapeResizeMode(shapeEl) {
            if (!shapeEl) {
                return;
            }
            if (addVectorShapeType) {
                debugVectorShapeResize('clear add-vector mode before resize', {
                    activeType: addVectorShapeType,
                    shapeId: shapeEl.dataset.shapeId
                });
                setAddVectorShapeType(null, true);
                activateSelectionMode();
            }
            document.querySelectorAll('.vector-shape-node').forEach(function(node) {
                node.classList.remove('selected');
                node.classList.remove('resize-active');
            });
            shapeEl.classList.add('resize-active');
            initVectorShapeResizeHandles(shapeEl);
            updateVectorShapeLineHandles(shapeEl);
            debugVectorShapeResize('enter resize mode', {
                shapeId: shapeEl.dataset.shapeId,
                type: shapeEl.dataset.shapeType,
                handles: shapeEl.querySelectorAll('.vector-shape-resize-handle').length
            });
        }

        function createVectorShapeElement(shape) {
            const shapeEl = document.createElement('div');
            shapeEl.className = 'vector-shape-node';
            shapeEl.dataset.shapeId = shape.id;
            shapeEl.dataset.shapeType = shape.type;
            shapeEl.style.left = shape.x + 'px';
            shapeEl.style.top = shape.y + 'px';
            shapeEl.style.width = shape.width + 'px';
            shapeEl.style.height = shape.height + 'px';

            let lx1 = 0;
            let ly1 = 0;
            let lx2 = shape.width;
            let ly2 = shape.height;
            let vbW = shape.width;
            let vbH = shape.height;
            if (isVectorLineType(shape.type) && shape.x2 !== undefined && shape.y2 !== undefined) {
                const bounds = getVectorLineBounds(shape.x, shape.y, shape.x2, shape.y2);
                shapeEl.style.left = bounds.x + 'px';
                shapeEl.style.top = bounds.y + 'px';
                shapeEl.style.width = bounds.width + 'px';
                shapeEl.style.height = bounds.height + 'px';
                lx1 = bounds.lx1;
                ly1 = bounds.ly1;
                lx2 = bounds.lx2;
                ly2 = bounds.ly2;
                vbW = bounds.width;
                vbH = bounds.height;
            }

            const viewBox = isVectorIconType(shape.type) ? '0 0 24 24' : ('0 0 ' + vbW + ' ' + vbH);
            const preserve = isVectorIconType(shape.type) ? 'xMidYMid meet' : 'none';
            shapeEl.innerHTML = '<svg viewBox="' + viewBox + '" preserveAspectRatio="' + preserve + '" aria-hidden="true"></svg>';
            document.getElementById('canvas').appendChild(shapeEl);
            applyVectorShapeVisualStyles(shapeEl, shape);
            const lineBounds = isVectorLineType(shape.type) && shape.x2 !== undefined && shape.y2 !== undefined
                ? getVectorLineBounds(shape.x, shape.y, shape.x2, shape.y2)
                : null;
            refreshVectorShapeElementContent(shapeEl, shape, lineBounds);
            initVectorShapeEvents(shapeEl);
            initVectorShapeResizeHandles(shapeEl);
            debugVectorShapeResize('create shape element', {
                shapeId: shape.id,
                type: shape.type,
                x: shape.x,
                y: shape.y,
                width: shape.width,
                height: shape.height
            });
            return shapeEl;
        }

        function addVectorShapeToCanvas(shape) {
            vectorShapes.push(shape);
            return createVectorShapeElement(shape);
        }

        function appendVectorShapeStyleFields(entry, stored) {
            if (!stored) {
                return entry;
            }
            if (stored.stroke) {
                entry.stroke = stored.stroke;
            }
            if (stored.strokeWidth !== undefined) {
                entry.strokeWidth = stored.strokeWidth;
            }
            if (stored.strokeDasharray) {
                entry.strokeDasharray = stored.strokeDasharray;
            }
            if (stored.fill !== undefined) {
                entry.fill = stored.fill;
            }
            if (stored.zIndex !== undefined) {
                entry.zIndex = stored.zIndex;
            }
            if (stored.opacity !== undefined && stored.opacity !== 1) {
                entry.opacity = stored.opacity;
            }
            return entry;
        }

        function collectVectorShapesData() {
            const data = [];
            document.querySelectorAll('.vector-shape-node').forEach(function(el) {
                const shapeId = el.dataset.shapeId;
                const type = el.dataset.shapeType;
                const left = parseFloat(el.style.left) || 0;
                const top = parseFloat(el.style.top) || 0;
                const width = el.offsetWidth;
                const height = el.offsetHeight;
                const stored = vectorShapes.find(function(s) { return s.id === shapeId; });
                if (isVectorLineType(type) && stored && stored.x2 !== undefined && stored.y2 !== undefined) {
                    const oldBounds = getVectorLineBounds(stored.x, stored.y, stored.x2, stored.y2);
                    const dx = left - oldBounds.x;
                    const dy = top - oldBounds.y;
                    data.push(appendVectorShapeStyleFields({
                        id: shapeId,
                        type: type,
                        x: stored.x + dx,
                        y: stored.y + dy,
                        x2: stored.x2 + dx,
                        y2: stored.y2 + dy,
                        width: width,
                        height: height
                    }, stored));
                    return;
                }
                data.push(appendVectorShapeStyleFields({
                    id: shapeId,
                    type: type,
                    x: left,
                    y: top,
                    width: width,
                    height: height
                }, stored));
            });
            return data;
        }

        function syncVectorShapeData(shapeEl) {
            const shape = getVectorShapeByEl(shapeEl);
            if (!shape) {
                return;
            }
            const left = parseFloat(shapeEl.style.left) || 0;
            const top = parseFloat(shapeEl.style.top) || 0;
            const width = shapeEl.offsetWidth;
            const height = shapeEl.offsetHeight;
            if (isVectorLineType(shape.type) && shape.x2 !== undefined && shape.y2 !== undefined) {
                const oldBounds = getVectorLineBounds(shape.x, shape.y, shape.x2, shape.y2);
                const dx = left - oldBounds.x;
                const dy = top - oldBounds.y;
                shape.x += dx;
                shape.y += dy;
                shape.x2 += dx;
                shape.y2 += dy;
            } else {
                shape.x = left;
                shape.y = top;
            }
            shape.width = width;
            shape.height = height;
            const zIndexParsed = parseInt(shapeEl.style.zIndex, 10);
            if (!isNaN(zIndexParsed)) {
                shape.zIndex = zIndexParsed;
            }
        }

        function deleteVectorShape(shapeEl) {
            if (!shapeEl || !shapeEl.isConnected) {
                return;
            }
            const shapeId = shapeEl.dataset.shapeId;
            const idx = vectorShapes.findIndex(function(s) { return s.id === shapeId; });
            if (idx !== -1) {
                vectorShapes.splice(idx, 1);
            }
            shapeEl.remove();
        }

        function clearVectorShapePreview() {
            if (vectorShapePreviewEl) {
                vectorShapePreviewEl.remove();
                vectorShapePreviewEl = null;
            }
        }

        function getVectorBoxDrawBounds(type, x1, y1, x2, y2) {
            if (type !== 'circle') {
                return getBoxBounds(x1, y1, x2, y2);
            }
            const size = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
            return {
                x: x2 < x1 ? x1 - size : x1,
                y: y2 < y1 ? y1 - size : y1,
                width: size,
                height: size
            };
        }

        function updateVectorShapePreview(endX, endY) {
            if (!addVectorShapeType) {
                return;
            }
            let bounds;
            let lx1 = 0;
            let ly1 = 0;
            let lx2 = 0;
            let ly2 = 0;
            if (isDrawingVectorRect && pendingVectorRectStart) {
                bounds = getVectorBoxDrawBounds(addVectorShapeType, pendingVectorRectStart.x, pendingVectorRectStart.y, endX, endY);
                lx2 = bounds.width;
                ly2 = bounds.height;
            } else if (pendingVectorLineStart && isVectorLineType(addVectorShapeType)) {
                bounds = getVectorLineBounds(
                    pendingVectorLineStart.x,
                    pendingVectorLineStart.y,
                    endX,
                    endY
                );
                lx1 = bounds.lx1;
                ly1 = bounds.ly1;
                lx2 = bounds.lx2;
                ly2 = bounds.ly2;
            } else {
                return;
            }
            if (!vectorShapePreviewEl) {
                vectorShapePreviewEl = document.createElement('div');
                vectorShapePreviewEl.className = 'vector-shape-preview';
                document.getElementById('canvas').appendChild(vectorShapePreviewEl);
            }
            vectorShapePreviewEl.style.left = bounds.x + 'px';
            vectorShapePreviewEl.style.top = bounds.y + 'px';
            vectorShapePreviewEl.style.width = bounds.width + 'px';
            vectorShapePreviewEl.style.height = bounds.height + 'px';
            const inner = buildVectorShapeSvgMarkup(
                addVectorShapeType,
                'preview',
                bounds.width,
                bounds.height,
                lx1,
                ly1,
                lx2,
                ly2
            );
            vectorShapePreviewEl.innerHTML = '<svg viewBox="0 0 ' + bounds.width + ' ' + bounds.height + '" preserveAspectRatio="none" aria-hidden="true">' + inner + '</svg>';
        }

        function placeVectorBoxAt(type, x1, y1, x2, y2) {
            const bounds = getVectorBoxDrawBounds(type, x1, y1, x2, y2);
            if (bounds.width < 8 || bounds.height < 8) {
                return;
            }
            pushUndoSnapshot();
            const shape = {
                id: 'vshape_' + Date.now(),
                type: type,
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height
            };
            addVectorShapeToCanvas(shape);
        }

        function placeVectorShapeAt(type, x, y, x2, y2) {
            pushUndoSnapshot();
            const defaultSize = 72;
            let shape;
            if (isVectorLineType(type)) {
                const bounds = getVectorLineBounds(x, y, x2, y2);
                shape = {
                    id: 'vshape_' + Date.now(),
                    type: type,
                    x: x,
                    y: y,
                    x2: x2,
                    y2: y2,
                    width: bounds.width,
                    height: bounds.height
                };
            } else {
                shape = {
                    id: 'vshape_' + Date.now(),
                    type: type,
                    x: x - defaultSize / 2,
                    y: y - defaultSize / 2,
                    width: defaultSize,
                    height: defaultSize
                };
            }
            addVectorShapeToCanvas(shape);
        }

        function setAddVectorShapeType(type, skipSelectionRestore) {
            addVectorShapeType = type;
            pendingVectorLineStart = null;
            isDrawingVectorRect = false;
            pendingVectorRectStart = null;
            clearVectorShapePreview();
            if (vectorShapeBtn) {
                vectorShapeBtn.classList.toggle('active', !!type);
            }
            document.body.classList.toggle('add-vector-mode', !!type);
            if (vectorShapeGrid) {
                vectorShapeGrid.querySelectorAll('.vector-shape-menu-item').forEach(function(item) {
                    item.classList.toggle('active', item.dataset.shapeType === type);
                });
            }
            if (type) {
                deactivateSelectionMode();
                addTextLabelMode = false;
                if (addTextLabelBtn) {
                    addTextLabelBtn.classList.remove('active');
                }
                document.body.classList.remove('add-text-mode');
            } else if (!skipSelectionRestore) {
                activateSelectionMode();
            }
        }

        function initVectorShapeToolbar() {
            const selectToolBtn = document.getElementById('selectToolBtn');
            if (selectToolBtn) {
                selectToolBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    activateSelectionMode();
                    if (vectorShapeMenu) {
                        vectorShapeMenu.classList.remove('show');
                    }
                });
            }

            if (vectorShapeBtn && vectorShapeMenu) {
                vectorShapeBtn.addEventListener('mousedown', function(e) {
                    if (e.button !== 0) {
                        return;
                    }
                    e.stopPropagation();
                    if (typeof e.stopImmediatePropagation === 'function') {
                        e.stopImmediatePropagation();
                    }
                }, true);

                vectorShapeBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    vectorShapeMenu.classList.toggle('show');
                    const exportMenuEl = document.getElementById('exportMenu');
                    if (exportMenuEl) {
                        exportMenuEl.classList.remove('show');
                    }
                });
            }

            if (!vectorShapeGrid || vectorShapeGrid.querySelector('.vector-shape-menu-item')) {
                return;
            }

            VECTOR_SHAPE_DEFS.forEach(function(def) {
                if (def.type === '_divider') {
                    const divider = document.createElement('div');
                    divider.className = 'vector-shape-menu-divider';
                    vectorShapeGrid.appendChild(divider);
                    return;
                }
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'vector-shape-menu-item';
                btn.dataset.shapeType = def.type;
                btn.innerHTML = '<svg class="vector-shape-menu-icon" viewBox="0 0 24 24" aria-hidden="true">' + def.icon + '</svg><span>' + def.label + '</span>';
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    vectorShapeMenu.classList.remove('show');
                    if (addVectorShapeType === def.type) {
                        setAddVectorShapeType(null);
                    } else {
                        setAddVectorShapeType(def.type);
                    }
                });
                vectorShapeGrid.appendChild(btn);
            });
        }

        document.getElementById('canvas-container').addEventListener('mousemove', function(e) {
            if (isDrawingVectorRect && pendingVectorRectStart) {
                const coords = canvasCoordsFromEvent(e);
                updateVectorShapePreview(coords.x, coords.y);
                return;
            }
            if (!pendingVectorLineStart || !addVectorShapeType || !isVectorLineType(addVectorShapeType)) {
                return;
            }
            const coords = canvasCoordsFromEvent(e);
            updateVectorShapePreview(coords.x, coords.y);
        });

        document.getElementById('canvas-container').addEventListener('mousedown', function(e) {
            if (e.button !== 0 || !isVectorRectDrawType(addVectorShapeType)) {
                return;
            }
            if (e.target.closest('.table-node') || e.target.closest('.comment-node') ||
                e.target.closest('.text-label-node') || e.target.closest('.vector-shape-node') ||
                e.target.closest('.erd-toolbar') || e.target.closest('.zoom-controls')) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            isDrawingVectorRect = true;
            pendingVectorRectStart = canvasCoordsFromEvent(e);
        }, true);

        document.addEventListener('mouseup', function(e) {
            if (!isDrawingVectorRect || !pendingVectorRectStart || !isVectorRectDrawType(addVectorShapeType)) {
                return;
            }
            const coords = canvasCoordsFromEvent(e);
            placeVectorBoxAt(addVectorShapeType, pendingVectorRectStart.x, pendingVectorRectStart.y, coords.x, coords.y);
            isDrawingVectorRect = false;
            pendingVectorRectStart = null;
            clearVectorShapePreview();
        });

        document.getElementById('canvas-container').addEventListener('click', function(e) {
            if (!addVectorShapeType || isVectorRectDrawType(addVectorShapeType)) {
                return;
            }
            if (e.target.closest('.table-node') || e.target.closest('.comment-node') ||
                e.target.closest('.text-label-node') || e.target.closest('.vector-shape-node') ||
                e.target.closest('.erd-toolbar') || e.target.closest('.zoom-controls')) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            const coords = canvasCoordsFromEvent(e);
            if (isVectorLineType(addVectorShapeType)) {
                if (!pendingVectorLineStart) {
                    pendingVectorLineStart = coords;
                    return;
                }
                placeVectorShapeAt(addVectorShapeType, pendingVectorLineStart.x, pendingVectorLineStart.y, coords.x, coords.y);
                pendingVectorLineStart = null;
                clearVectorShapePreview();
                return;
            }
            placeVectorShapeAt(addVectorShapeType, coords.x, coords.y);
        }, true);

        function initVectorShapeEvents(shapeEl) {
            shapeEl.addEventListener('click', function(e) {
                e.stopPropagation();
                selectVectorShape(shapeEl);
            });

            shapeEl.addEventListener('contextmenu', function(e) {
                e.preventDefault();
                e.stopPropagation();
                showVectorShapeContextMenu(shapeEl, e.clientX, e.clientY);
            });
        }

        let vectorShapeContextTarget = null;
        const vectorShapeContextMenu = document.getElementById('vectorShapeContextMenu');
        const vectorStrokeWidthSubmenu = document.getElementById('vectorStrokeWidthSubmenu');
        const vectorStrokeColorSwatches = document.getElementById('vectorStrokeColorSwatches');
        const vectorStrokeMoreColorSubmenu = document.getElementById('vectorStrokeMoreColorSubmenu');
        const vectorFillColorSwatches = document.getElementById('vectorFillColorSwatches');
        const vectorFillMoreColorSubmenu = document.getElementById('vectorFillMoreColorSubmenu');
        const vectorOpacitySubmenu = document.getElementById('vectorOpacitySubmenu');
        const tableContextMenu = document.getElementById('contextMenu');
        const tableBorderWidthSubmenu = document.getElementById('ctxTableBorderWidthSubmenu');
        const tableBorderColorSwatches = document.getElementById('ctxTableBorderColorSwatches');
        const tableBorderMoreColorSubmenu = document.getElementById('ctxTableBorderMoreColorSubmenu');
        const tableBackgroundColorSwatches = document.getElementById('ctxTableBackgroundColorSwatches');
        const tableBackgroundMoreColorSubmenu = document.getElementById('ctxTableBackgroundMoreColorSubmenu');
        const tableOpacitySubmenu = document.getElementById('ctxTableOpacitySubmenu');

        const VECTOR_OPACITY_OPTIONS = [
            { label: '100%', value: 1 },
            { label: '75%', value: 0.75 },
            { label: '50%', value: 0.5 },
            { label: '25%', value: 0.25 },
            { label: '10%', value: 0.1 }
        ];

        let tableContextTarget = null;

        function hideVectorShapeContextMenu() {
            vectorShapeContextMenu.style.display = 'none';
            vectorShapeContextTarget = null;
        }

        function getCanvasLayerElements() {
            return Array.from(document.querySelectorAll('.table-node, .comment-node, .text-label-node, .vector-shape-node'));
        }

        function getEffectiveZIndex(el) {
            const parsed = parseInt(el.style.zIndex, 10);
            if (!isNaN(parsed)) {
                return parsed;
            }
            if (el.classList.contains('comment-node')) {
                return 500;
            }
            if (el.classList.contains('text-label-node')) {
                return 50;
            }
            if (el.classList.contains('vector-shape-node')) {
                return 40;
            }
            return 1;
        }

        function setVectorShapeZIndex(shapeEl, zIndex) {
            shapeEl.style.zIndex = String(zIndex);
            const shape = getVectorShapeByEl(shapeEl);
            if (shape) {
                shape.zIndex = zIndex;
            }
        }

        function bringVectorShapeToFront(shapeEl) {
            const all = getCanvasLayerElements();
            let maxZ = 0;
            all.forEach(function(el) {
                maxZ = Math.max(maxZ, getEffectiveZIndex(el));
            });
            setVectorShapeZIndex(shapeEl, maxZ + 1);
        }

        function sendVectorShapeToBack(shapeEl) {
            const all = getCanvasLayerElements();
            let minZ = Infinity;
            all.forEach(function(el) {
                minZ = Math.min(minZ, getEffectiveZIndex(el));
            });
            setVectorShapeZIndex(shapeEl, Math.max(1, minZ - 1));
        }

        function bringVectorShapeForward(shapeEl) {
            setVectorShapeZIndex(shapeEl, getEffectiveZIndex(shapeEl) + 1);
        }

        function sendVectorShapeBackward(shapeEl) {
            setVectorShapeZIndex(shapeEl, Math.max(1, getEffectiveZIndex(shapeEl) - 1));
        }

        function getTableDataByEl(tableEl) {
            if (!tableEl) {
                return null;
            }
            const tableName = tableEl.dataset.table;
            const database = tableEl.dataset.database || '';
            return tables.find(function(t) {
                return t.tableName === tableName && (t.database || '') === database;
            }) || tables.find(function(t) { return t.tableName === tableName; }) || null;
        }

        function applyTableBorderWidth(tableEl, width) {
            if (!tableEl) {
                return;
            }
            tableEl.style.borderWidth = width + 'px';
            const tableData = getTableDataByEl(tableEl);
            if (tableData) {
                tableData.borderWidth = width;
            }
        }

        function applyTableBorderStyle(tableEl, styleName) {
            if (!tableEl) {
                return;
            }
            tableEl.style.borderStyle = styleName || 'solid';
            const tableData = getTableDataByEl(tableEl);
            if (tableData) {
                tableData.borderStyle = styleName || 'solid';
            }
        }

        function applyTableBackgroundColor(tableEl, color) {
            if (!tableEl) {
                return;
            }
            const tableBody = tableEl.querySelector('.table-body');
            const value = color || '';
            if (value) {
                tableEl.dataset.backgroundColor = value;
                tableEl.style.backgroundColor = value;
                if (tableBody) {
                    tableBody.style.backgroundColor = value;
                }
            } else {
                delete tableEl.dataset.backgroundColor;
                tableEl.style.removeProperty('background-color');
                if (tableBody) {
                    tableBody.style.removeProperty('background-color');
                }
            }
            const tableData = getTableDataByEl(tableEl);
            if (tableData) {
                if (value) {
                    tableData.backgroundColor = value;
                } else {
                    delete tableData.backgroundColor;
                }
            }
        }

        function getTableOpacity(tableEl) {
            const parsed = parseFloat(tableEl.style.opacity);
            return isNaN(parsed) ? 1 : parsed;
        }

        function applyTableOpacity(tableEl, opacity) {
            if (!tableEl) {
                return;
            }
            if (opacity >= 1) {
                tableEl.style.removeProperty('opacity');
            } else {
                tableEl.style.opacity = String(opacity);
            }
            const tableData = getTableDataByEl(tableEl);
            if (tableData) {
                if (opacity >= 1) {
                    delete tableData.opacity;
                } else {
                    tableData.opacity = opacity;
                }
            }
        }

        function setTableZIndex(tableEl, zIndex) {
            if (!tableEl) {
                return;
            }
            tableEl.style.zIndex = String(zIndex);
            const tableData = getTableDataByEl(tableEl);
            if (tableData) {
                tableData.zIndex = zIndex;
            }
        }

        function bringTableToFront(tableEl) {
            let maxZ = 0;
            getCanvasLayerElements().forEach(function(el) {
                maxZ = Math.max(maxZ, getEffectiveZIndex(el));
            });
            setTableZIndex(tableEl, maxZ + 1);
        }

        function sendTableToBack(tableEl) {
            let minZ = Infinity;
            getCanvasLayerElements().forEach(function(el) {
                minZ = Math.min(minZ, getEffectiveZIndex(el));
            });
            setTableZIndex(tableEl, Math.max(1, minZ - 1));
        }

        function bringTableForward(tableEl) {
            setTableZIndex(tableEl, getEffectiveZIndex(tableEl) + 1);
        }

        function sendTableBackward(tableEl) {
            setTableZIndex(tableEl, Math.max(1, getEffectiveZIndex(tableEl) - 1));
        }

        function showTableContextMenu(tableEl, clientX, clientY) {
            tableContextTarget = tableEl;
            const tableData = getTableDataByEl(tableEl) || {};
            tableContextMenu.dataset.tableName = tableEl.dataset.table || '';
            tableContextMenu.dataset.database = tableEl.dataset.database || '';
            const borderWidth = parseFloat(tableEl.style.borderWidth) || tableData.borderWidth || 2;
            tableBorderWidthSubmenu.querySelectorAll('.context-submenu-item').forEach(function(item) {
                item.classList.toggle('active', parseInt(item.dataset.width, 10) === borderWidth);
            });
            const borderStyle = tableEl.style.borderStyle || tableData.borderStyle || 'solid';
            document.getElementById('ctxTableBorderStyleSubmenu').querySelectorAll('.context-submenu-item').forEach(function(item) {
                item.classList.toggle('active', item.dataset.style === borderStyle);
            });
            const opacity = getTableOpacity(tableEl);
            tableOpacitySubmenu.querySelectorAll('.context-submenu-item').forEach(function(item) {
                item.classList.toggle('active', parseFloat(item.dataset.opacity) === opacity);
            });
            tableContextMenu.style.left = clientX + 'px';
            tableContextMenu.style.top = clientY + 'px';
            tableContextMenu.style.display = 'block';
        }

        function applyStoredTableStyles(tableEl) {
            const tableData = getTableDataByEl(tableEl);
            if (!tableData) {
                return;
            }
            if (tableData.borderWidth !== undefined) {
                tableEl.style.borderWidth = tableData.borderWidth + 'px';
            }
            if (tableData.borderStyle) {
                tableEl.style.borderStyle = tableData.borderStyle;
            }
            if (tableData.backgroundColor) {
                applyTableBackgroundColor(tableEl, tableData.backgroundColor);
            }
            if (tableData.opacity !== undefined) {
                applyTableOpacity(tableEl, tableData.opacity);
            }
            if (tableData.zIndex !== undefined) {
                tableEl.style.zIndex = String(tableData.zIndex);
            }
        }

        function applyVectorShapeStrokeColor(color) {
            if (!vectorShapeContextTarget) {
                return;
            }
            const shape = getVectorShapeByEl(vectorShapeContextTarget);
            if (shape) {
                shape.stroke = color;
                refreshVectorShapeElementContent(vectorShapeContextTarget, shape);
            }
            hideVectorShapeContextMenu();
        }

        function applyVectorShapeFillColor(color) {
            if (!vectorShapeContextTarget) {
                return;
            }
            const shape = getVectorShapeByEl(vectorShapeContextTarget);
            if (shape) {
                shape.fill = color;
                refreshVectorShapeElementContent(vectorShapeContextTarget, shape);
            }
            hideVectorShapeContextMenu();
        }

        function appendVectorColorSwatch(container, color, handler) {
            const swatch = document.createElement('button');
            swatch.type = 'button';
            swatch.className = 'color-swatch';
            swatch.style.backgroundColor = color;
            swatch.title = color;
            swatch.addEventListener('click', function(e) {
                e.stopPropagation();
                handler(color);
            });
            container.appendChild(swatch);
        }

        function getTableContextTarget() {
            if (tableContextTarget && tableContextTarget.isConnected) {
                return tableContextTarget;
            }
            const tableName = tableContextMenu.dataset.tableName;
            const database = tableContextMenu.dataset.database || '';
            if (!tableName) {
                return null;
            }
            const nodes = document.querySelectorAll('.table-node');
            for (let i = 0; i < nodes.length; i++) {
                if (nodes[i].dataset.table === tableName && (nodes[i].dataset.database || '') === database) {
                    return nodes[i];
                }
            }
            return findTableElementByName(tableName);
        }

        function hideTableContextMenu() {
            tableContextMenu.style.display = 'none';
            tableContextTarget = null;
        }

        function applyTableContextBorderColor(color) {
            const tableEl = getTableContextTarget();
            if (!tableEl) {
                return;
            }
            pushUndoSnapshot();
            applyTableColor(tableEl, color);
            drawRelationships();
            hideTableContextMenu();
        }

        function applyTableContextBackgroundColor(color) {
            const tableEl = getTableContextTarget();
            if (!tableEl) {
                return;
            }
            pushUndoSnapshot();
            applyTableBackgroundColor(tableEl, color);
            hideTableContextMenu();
        }

        [1, 2, 3, 4, 6].forEach(function(width) {
            const item = document.createElement('div');
            item.className = 'context-submenu-item';
            item.textContent = width + 'px';
            item.dataset.width = String(width);
            item.addEventListener('click', function(e) {
                e.stopPropagation();
                const tableEl = getTableContextTarget();
                if (tableEl) {
                    pushUndoSnapshot();
                    applyTableBorderWidth(tableEl, width);
                    drawRelationships();
                }
                hideTableContextMenu();
            });
            tableBorderWidthSubmenu.appendChild(item);
        });

        TEXT_LABEL_QUICK_COLORS.forEach(function(color) {
            appendVectorColorSwatch(tableBorderColorSwatches, color, applyTableContextBorderColor);
            appendVectorColorSwatch(tableBackgroundColorSwatches, color, applyTableContextBackgroundColor);
        });
        TEXT_LABEL_MORE_COLORS.forEach(function(color) {
            appendVectorColorSwatch(tableBorderMoreColorSubmenu, color, applyTableContextBorderColor);
            appendVectorColorSwatch(tableBackgroundMoreColorSubmenu, color, applyTableContextBackgroundColor);
        });

        document.getElementById('ctxTableBorderStyleSubmenu').querySelectorAll('.context-submenu-item').forEach(function(item) {
            item.addEventListener('click', function(e) {
                e.stopPropagation();
                const tableEl = getTableContextTarget();
                if (tableEl) {
                    pushUndoSnapshot();
                    applyTableBorderStyle(tableEl, item.dataset.style);
                    drawRelationships();
                }
                hideTableContextMenu();
            });
        });

        document.getElementById('ctxTableBackgroundNoneMenu').addEventListener('click', function(e) {
            e.stopPropagation();
            applyTableContextBackgroundColor('');
        });

        VECTOR_OPACITY_OPTIONS.forEach(function(opt) {
            const item = document.createElement('div');
            item.className = 'context-submenu-item';
            item.textContent = opt.label;
            item.dataset.opacity = String(opt.value);
            item.addEventListener('click', function(e) {
                e.stopPropagation();
                const tableEl = getTableContextTarget();
                if (tableEl) {
                    pushUndoSnapshot();
                    applyTableOpacity(tableEl, opt.value);
                }
                hideTableContextMenu();
            });
            tableOpacitySubmenu.appendChild(item);
        });

        document.getElementById('ctxTableResizeMenu').addEventListener('click', function(e) {
            e.stopPropagation();
            const tableEl = getTableContextTarget();
            if (tableEl) {
                selectTable(tableEl);
                tableEl.classList.add('selected');
            }
            hideTableContextMenu();
        });

        document.getElementById('ctxTableBringToFront').addEventListener('click', function(e) {
            e.stopPropagation();
            const tableEl = getTableContextTarget();
            if (tableEl) {
                pushUndoSnapshot();
                bringTableToFront(tableEl);
            }
            hideTableContextMenu();
        });
        document.getElementById('ctxTableBringForward').addEventListener('click', function(e) {
            e.stopPropagation();
            const tableEl = getTableContextTarget();
            if (tableEl) {
                pushUndoSnapshot();
                bringTableForward(tableEl);
            }
            hideTableContextMenu();
        });
        document.getElementById('ctxTableSendBackward').addEventListener('click', function(e) {
            e.stopPropagation();
            const tableEl = getTableContextTarget();
            if (tableEl) {
                pushUndoSnapshot();
                sendTableBackward(tableEl);
            }
            hideTableContextMenu();
        });
        document.getElementById('ctxTableSendToBack').addEventListener('click', function(e) {
            e.stopPropagation();
            const tableEl = getTableContextTarget();
            if (tableEl) {
                pushUndoSnapshot();
                sendTableToBack(tableEl);
            }
            hideTableContextMenu();
        });

        [1, 2, 3, 4, 6].forEach(function(width) {
            const item = document.createElement('div');
            item.className = 'context-submenu-item';
            item.textContent = width + 'px';
            item.dataset.width = String(width);
            item.addEventListener('click', function(e) {
                e.stopPropagation();
                if (vectorShapeContextTarget) {
                    const shape = getVectorShapeByEl(vectorShapeContextTarget);
                    if (shape) {
                        shape.strokeWidth = width;
                        refreshVectorShapeElementContent(vectorShapeContextTarget, shape);
                    }
                }
                hideVectorShapeContextMenu();
            });
            vectorStrokeWidthSubmenu.appendChild(item);
        });

        TEXT_LABEL_QUICK_COLORS.forEach(function(color) {
            appendVectorColorSwatch(vectorStrokeColorSwatches, color, applyVectorShapeStrokeColor);
            appendVectorColorSwatch(vectorFillColorSwatches, color, applyVectorShapeFillColor);
        });
        TEXT_LABEL_MORE_COLORS.forEach(function(color) {
            appendVectorColorSwatch(vectorStrokeMoreColorSubmenu, color, applyVectorShapeStrokeColor);
            appendVectorColorSwatch(vectorFillMoreColorSubmenu, color, applyVectorShapeFillColor);
        });

        document.getElementById('vectorStrokeStyleSubmenu').querySelectorAll('.context-submenu-item').forEach(function(item) {
            item.addEventListener('click', function(e) {
                e.stopPropagation();
                if (vectorShapeContextTarget) {
                    const shape = getVectorShapeByEl(vectorShapeContextTarget);
                    if (shape) {
                        shape.strokeDasharray = getVectorStrokeDasharray(item.dataset.style);
                        refreshVectorShapeElementContent(vectorShapeContextTarget, shape);
                    }
                }
                hideVectorShapeContextMenu();
            });
        });

        document.getElementById('vectorFillNoneMenu').addEventListener('click', function(e) {
            e.stopPropagation();
            applyVectorShapeFillColor('none');
        });

        VECTOR_OPACITY_OPTIONS.forEach(function(opt) {
            const item = document.createElement('div');
            item.className = 'context-submenu-item';
            item.textContent = opt.label;
            item.dataset.opacity = String(opt.value);
            item.addEventListener('click', function(e) {
                e.stopPropagation();
                if (vectorShapeContextTarget) {
                    const shape = getVectorShapeByEl(vectorShapeContextTarget);
                    if (shape) {
                        if (opt.value === 1) {
                            delete shape.opacity;
                        } else {
                            shape.opacity = opt.value;
                        }
                        applyVectorShapeVisualStyles(vectorShapeContextTarget, shape);
                    }
                }
                hideVectorShapeContextMenu();
            });
            vectorOpacitySubmenu.appendChild(item);
        });

        document.getElementById('vectorShapeResizeMenu').addEventListener('click', function(e) {
            e.stopPropagation();
            if (vectorShapeContextTarget) {
                enterVectorShapeResizeMode(vectorShapeContextTarget);
            }
            hideVectorShapeContextMenu();
        });

        document.getElementById('vectorBringToFront').addEventListener('click', function(e) {
            e.stopPropagation();
            if (vectorShapeContextTarget) {
                bringVectorShapeToFront(vectorShapeContextTarget);
            }
            hideVectorShapeContextMenu();
        });
        document.getElementById('vectorBringForward').addEventListener('click', function(e) {
            e.stopPropagation();
            if (vectorShapeContextTarget) {
                bringVectorShapeForward(vectorShapeContextTarget);
            }
            hideVectorShapeContextMenu();
        });
        document.getElementById('vectorSendBackward').addEventListener('click', function(e) {
            e.stopPropagation();
            if (vectorShapeContextTarget) {
                sendVectorShapeBackward(vectorShapeContextTarget);
            }
            hideVectorShapeContextMenu();
        });
        document.getElementById('vectorSendToBack').addEventListener('click', function(e) {
            e.stopPropagation();
            if (vectorShapeContextTarget) {
                sendVectorShapeToBack(vectorShapeContextTarget);
            }
            hideVectorShapeContextMenu();
        });
        document.getElementById('vectorShapeDeleteMenu').addEventListener('click', function(e) {
            e.stopPropagation();
            deleteVectorShape(vectorShapeContextTarget);
            hideVectorShapeContextMenu();
        });

        function showVectorShapeContextMenu(shapeEl, clientX, clientY) {
            vectorShapeContextTarget = shapeEl;
            const resizeMenuItem = document.getElementById('vectorShapeResizeMenu');
            if (resizeMenuItem) {
                resizeMenuItem.classList.toggle('active', shapeEl.classList.contains('resize-active'));
            }
            const shape = getVectorShapeByEl(shapeEl);
            const currentWidth = shape && shape.strokeWidth ? shape.strokeWidth : 2;
            vectorStrokeWidthSubmenu.querySelectorAll('.context-submenu-item').forEach(function(item) {
                item.classList.toggle('active', parseInt(item.dataset.width, 10) === currentWidth);
            });
            const styleName = shape ? getVectorStrokeStyleName(shape.strokeDasharray || '') : 'solid';
            document.getElementById('vectorStrokeStyleSubmenu').querySelectorAll('.context-submenu-item').forEach(function(item) {
                item.classList.toggle('active', item.dataset.style === styleName);
            });
            const currentOpacity = shape ? getVectorShapeOpacity(shape) : 1;
            vectorOpacitySubmenu.querySelectorAll('.context-submenu-item').forEach(function(item) {
                item.classList.toggle('active', parseFloat(item.dataset.opacity) === currentOpacity);
            });
            vectorShapeContextMenu.style.left = clientX + 'px';
            vectorShapeContextMenu.style.top = clientY + 'px';
            vectorShapeContextMenu.style.display = 'block';
        }

        function deleteTableElement(tableEl) {
            const tableName = tableEl.dataset.table;
            if (!tableName) {
                return;
            }
            for (let i = relationships.length - 1; i >= 0; i--) {
                if (relationships[i].fromTable === tableName || relationships[i].toTable === tableName) {
                    relationships.splice(i, 1);
                }
            }
            const tableIndex = tables.findIndex(function(t) { return t.tableName === tableName; });
            if (tableIndex !== -1) {
                tables.splice(tableIndex, 1);
            }
            tableEl.remove();
        }

        function deleteCommentElement(commentEl) {
            const commentId = commentEl.dataset.commentId;
            const commentIndex = comments.findIndex(function(c) { return c.id === commentId; });
            if (commentIndex !== -1) {
                comments.splice(commentIndex, 1);
            }
            commentEl.remove();
        }

        function isEditingCanvasObject() {
            const active = document.activeElement;
            if (!active) {
                return false;
            }
            if (active.classList && active.classList.contains('text-label-node')) {
                return true;
            }
            if (active.classList && active.classList.contains('comment-textarea')) {
                return true;
            }
            const tag = active.tagName;
            return tag === 'TEXTAREA' || tag === 'INPUT';
        }

        function findTableElementByName(tableName) {
            const nodes = document.querySelectorAll('.table-node');
            for (let i = 0; i < nodes.length; i++) {
                if (nodes[i].getAttribute('data-table') === tableName) {
                    return nodes[i];
                }
            }
            return null;
        }

        function captureCanvasSnapshot() {
            document.querySelectorAll('.text-label-node').forEach(function(el) {
                syncTextLabelData(el);
            });

            const tablesSnapshot = [];
            tables.forEach(function(table) {
                const el = findTableElementByName(table.tableName);
                const copy = JSON.parse(JSON.stringify(table));
                if (el) {
                    copy.x = parseFloat(el.style.left) || copy.x || 0;
                    copy.y = parseFloat(el.style.top) || copy.y || 0;
                    copy.width = el.offsetWidth || copy.width;
                    copy.height = el.offsetHeight || copy.height;
                    if (el.dataset.color) {
                        copy.color = el.dataset.color;
                    }
                    const borderWidth = parseFloat(el.style.borderWidth);
                    if (!isNaN(borderWidth)) {
                        copy.borderWidth = borderWidth;
                    }
                    if (el.style.borderStyle) {
                        copy.borderStyle = el.style.borderStyle;
                    }
                    if (el.dataset.backgroundColor) {
                        copy.backgroundColor = el.dataset.backgroundColor;
                    } else {
                        delete copy.backgroundColor;
                    }
                    const zIndex = parseInt(el.style.zIndex, 10);
                    if (!isNaN(zIndex)) {
                        copy.zIndex = zIndex;
                    }
                    const opacity = parseFloat(el.style.opacity);
                    if (!isNaN(opacity) && opacity < 1) {
                        copy.opacity = opacity;
                    } else {
                        delete copy.opacity;
                    }
                    if (el.dataset.database) {
                        copy.database = el.dataset.database;
                    }
                }
                tablesSnapshot.push(copy);
            });

            const commentsSnapshot = [];
            document.querySelectorAll('.comment-node').forEach(function(commentEl) {
                const textarea = commentEl.querySelector('.comment-textarea');
                commentsSnapshot.push({
                    id: commentEl.dataset.commentId,
                    x: parseFloat(commentEl.style.left) || 0,
                    y: parseFloat(commentEl.style.top) || 0,
                    width: parseFloat(commentEl.style.width) || commentEl.offsetWidth || 200,
                    height: parseFloat(commentEl.style.height) || commentEl.offsetHeight || 100,
                    text: textarea ? textarea.value : ''
                });
            });

            return {
                tables: tablesSnapshot,
                relationships: JSON.parse(JSON.stringify(relationships)),
                comments: commentsSnapshot,
                textLabels: JSON.parse(JSON.stringify(textLabels)),
                vectorShapes: collectVectorShapesData()
            };
        }

        function pushUndoSnapshot() {
            vscode.postMessage({
                command: 'pushUndo',
                snapshot: captureCanvasSnapshot()
            });
        }

        function deleteAllSelectedObjects() {
            const selectedTables = Array.from(document.querySelectorAll('.table-node.selected'));
            const selectedComments = Array.from(document.querySelectorAll('.comment-node.selected'));
            const selectedLabels = Array.from(document.querySelectorAll('.text-label-node.selected'));
            const selectedShapes = Array.from(document.querySelectorAll('.vector-shape-node.selected'));

            if (selectedTables.length === 0 && selectedComments.length === 0 &&
                selectedLabels.length === 0 && selectedShapes.length === 0) {
                return false;
            }

            pushUndoSnapshot();

            selectedTables.forEach(function(tableEl) {
                deleteTableElement(tableEl);
            });
            selectedComments.forEach(function(commentEl) {
                deleteCommentElement(commentEl);
            });
            selectedLabels.forEach(function(labelEl) {
                deleteTextLabel(labelEl);
            });
            selectedShapes.forEach(function(shapeEl) {
                deleteVectorShape(shapeEl);
            });

            selectedTable = null;
            hideTextLabelContextMenu();
            drawRelationships();
            return true;
        }

        document.addEventListener('keydown', function(e) {
            if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
                if (isEditingCanvasObject()) {
                    return;
                }
                e.preventDefault();
                vscode.postMessage({ command: 'undo' });
                return;
            }
            if (e.key === 'Delete' || e.key === 'Backspace') {
                const active = document.activeElement;
                if (active && active.classList && active.classList.contains('text-label-node') &&
                    isTextLabelEmpty(active)) {
                    e.preventDefault();
                    deleteTextLabel(active);
                    return;
                }
                if (isEditingCanvasObject()) {
                    return;
                }
                if (deleteAllSelectedObjects()) {
                    e.preventDefault();
                }
            }
            if (e.key === 'Escape') {
                if (addVectorShapeType) {
                    setAddVectorShapeType(null);
                    pendingVectorLineStart = null;
                    clearVectorShapePreview();
                } else if (addTextLabelMode) {
                    setAddTextLabelMode(false);
                } else {
                    activateSelectionMode();
                }
            }
        });

        vectorShapes.forEach(function(shape) {
            createVectorShapeElement(shape);
        });

        // Export menu
        const exportMenu = document.getElementById('exportMenu');
        document.getElementById('exportBtn').addEventListener('click', function(e) {
            e.stopPropagation();
            exportMenu.classList.toggle('show');
        });

        exportMenu.querySelectorAll('.toolbar-dropdown-item').forEach(function(item) {
            item.addEventListener('click', function(e) {
                e.stopPropagation();
                exportMenu.classList.remove('show');
                exportErd(item.dataset.format);
            });
        });

        function getExportBounds() {
            const padding = 40;
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;

            document.querySelectorAll('.table-node, .comment-node, .text-label-node, .vector-shape-node').forEach(function(el) {
                const x = parseFloat(el.style.left) || 0;
                const y = parseFloat(el.style.top) || 0;
                const w = el.offsetWidth;
                const h = el.offsetHeight;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x + w);
                maxY = Math.max(maxY, y + h);
            });

            const relSvg = document.getElementById('relationships');
            if (relSvg && relSvg.childNodes.length > 0) {
                try {
                    const bbox = relSvg.getBBox();
                    if (bbox.width > 0 && bbox.height > 0) {
                        minX = Math.min(minX, bbox.x);
                        minY = Math.min(minY, bbox.y);
                        maxX = Math.max(maxX, bbox.x + bbox.width);
                        maxY = Math.max(maxY, bbox.y + bbox.height);
                    }
                } catch (e) {
                    // ignore invalid svg bbox
                }
            }

            if (minX === Infinity) {
                return null;
            }

            return {
                minX: minX - padding,
                minY: minY - padding,
                width: maxX - minX + padding * 2,
                height: maxY - minY + padding * 2
            };
        }

        function escapeXml(text) {
            return String(text || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        function buildRelationshipsSvg(minX, minY) {
            const relSvg = document.getElementById('relationships');
            if (!relSvg) {
                return '';
            }

            let svg = '<g transform="translate(' + (-minX) + ',' + (-minY) + ')">';
            relSvg.querySelectorAll('path, polygon').forEach(function(el) {
                const className = el.getAttribute('class') || '';
                if (className.indexOf('relationship-hit-area') >= 0 ||
                    className.indexOf('relationship-selection-box') >= 0) {
                    return;
                }
                if (className.indexOf('relationship-line') < 0 &&
                    className.indexOf('relationship-arrow') < 0) {
                    return;
                }

                const tag = el.tagName.toLowerCase();
                const d = el.getAttribute('d') || '';
                const points = el.getAttribute('points') || '';
                if (tag === 'path' && className.indexOf('relationship-line') >= 0) {
                    svg += '<path d="' + escapeXml(d) + '" stroke="#007acc" stroke-width="2" fill="none"/>';
                } else if (tag === 'polygon' && className.indexOf('relationship-arrow') >= 0) {
                    svg += '<polygon points="' + escapeXml(points) + '" fill="#007acc"/>';
                }
            });
            svg += '</g>';
            return svg;
        }

        function getExportScale(width, height) {
            const maxDim = Math.max(width, height, 1);
            const maxOutput = 8000;
            let scale = 3;
            if (maxDim * scale > maxOutput) {
                scale = maxOutput / maxDim;
            }
            return Math.max(1, scale);
        }

        function getColumnCommentFromRow(row, tableName) {
            const commentEl = row.querySelector('.column-comment');
            if (commentEl && commentEl.textContent.trim()) {
                return commentEl.textContent.trim();
            }
            const columnName = row.getAttribute('data-column');
            if (!columnName) {
                return '';
            }
            const tableData = tables.find(function(t) { return t.tableName === tableName; });
            if (!tableData) {
                return '';
            }
            const columnData = tableData.columns.find(function(c) { return c.name === columnName; });
            return columnData && columnData.comment ? columnData.comment : '';
        }

        function buildTableSvgFromDom(el, offsetX, offsetY) {
            const x = offsetX;
            const y = offsetY;
            const w = el.offsetWidth;
            const h = el.offsetHeight;
            const headerEl = el.querySelector('.table-header');
            const headerHeight = headerEl ? headerEl.offsetHeight : 28;
            const isMainTable = el.classList.contains('main-table');
            const customColor = el.dataset.color;
            const tableBg = getComputedStyle(document.body).backgroundColor || '#1e1e1e';
            const textColor = getComputedStyle(document.body).color || '#cccccc';
            const mutedColor = '#999999';
            const borderColor = '#555555';
            const headerColor = customColor || (isMainTable ? '#007acc' : '#4caf50');
            const strokeColor = customColor || borderColor;
            const fontFamily = '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif';
            const tableName = el.getAttribute('data-table') || '';

            const nameEl = el.querySelector('.table-name');
            const tableTitle = nameEl ? nameEl.textContent.trim() : tableName;
            const tableCommentEl = el.querySelector('.table-header .table-comment');
            let tableComment = tableCommentEl ? tableCommentEl.textContent.trim() : '';
            if (!tableComment) {
                const tableData = tables.find(function(t) { return t.tableName === tableName; });
                tableComment = tableData && tableData.comment ? tableData.comment : '';
            }
            const hideTableNameComment = el.classList.contains('hide-table-name-comment');
            const showTableNameComment = tableComment && !hideTableNameComment;

            let svg = '<g>';
            svg += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="8" fill="' + escapeXml(tableBg) + '" stroke="' + escapeXml(strokeColor) + '" stroke-width="2"/>';
            svg += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + headerHeight + '" rx="8" fill="' + headerColor + '"/>';
            svg += '<rect x="' + x + '" y="' + (y + headerHeight - 8) + '" width="' + w + '" height="8" fill="' + headerColor + '"/>';
            const headerMidY = y + headerHeight / 2 + 5;
            const headerCenterX = x + w / 2;
            if (showTableNameComment) {
                const approxTitleWidth = tableTitle.length * 7;
                const titleX = headerCenterX - (approxTitleWidth + tableComment.length * 4) / 2;
                svg += '<text x="' + titleX + '" y="' + headerMidY + '" fill="white" font-size="13" font-weight="600" font-family="' + fontFamily + '">' + escapeXml(tableTitle) + '</text>';
                svg += '<text x="' + (titleX + approxTitleWidth + 6) + '" y="' + headerMidY + '" fill="rgba(255,255,255,0.75)" font-size="9" font-family="' + fontFamily + '">' + escapeXml(tableComment) + '</text>';
            } else {
                svg += '<text x="' + headerCenterX + '" y="' + headerMidY + '" fill="white" font-size="13" font-weight="600" text-anchor="middle" font-family="' + fontFamily + '">' + escapeXml(tableTitle) + '</text>';
            }

            let rowY = y + headerHeight + 8;
            el.querySelectorAll('.column-row').forEach(function(row) {
                const rowH = row.offsetHeight || 30;
                const colNameEl = row.querySelector('.column-name-text');
                const typeEl = row.querySelector('.column-type');
                const colName = colNameEl ? colNameEl.textContent.trim() : '';
                const colType = typeEl ? typeEl.textContent.trim() : '';
                const colComment = getColumnCommentFromRow(row, tableName);
                const midY = rowY + rowH / 2 + 4;
                const rightText = colComment ? colType + '  ' + colComment : colType;

                svg += '<text x="' + (x + 12) + '" y="' + midY + '" fill="' + escapeXml(textColor) + '" font-size="13" font-weight="500" font-family="' + fontFamily + '">' + escapeXml(colName) + '</text>';
                svg += '<text x="' + (x + w - 12) + '" y="' + midY + '" fill="' + mutedColor + '" font-size="11" text-anchor="end" font-family="' + fontFamily + '">' + escapeXml(rightText) + '</text>';
                rowY += rowH;
            });
            svg += '</g>';
            return svg;
        }

        function buildCommentSvgFromDom(el, offsetX, offsetY) {
            const x = offsetX;
            const y = offsetY;
            const w = el.offsetWidth;
            const h = el.offsetHeight;
            const textarea = el.querySelector('.comment-textarea');
            const text = textarea ? textarea.value : '';
            const fontFamily = '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif';

            let svg = '<g>';
            svg += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="8" fill="#fff3cd" stroke="#ffc107" stroke-width="2"/>';
            text.split('\\n').forEach(function(line, index) {
                svg += '<text x="' + (x + 12) + '" y="' + (y + 24 + index * 16) + '" fill="#333333" font-size="13" font-family="' + fontFamily + '">' + escapeXml(line) + '</text>';
            });
            svg += '</g>';
            return svg;
        }

        function buildTextLabelSvgFromDom(el, offsetX, offsetY) {
            const x = offsetX;
            const y = offsetY;
            const text = el.textContent || '';
            const fontSize = parseInt(el.style.fontSize, 10) || 16;
            const fontFamily = el.style.fontFamily || '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif';
            const color = el.style.color || getComputedStyle(document.body).color || '#cccccc';
            const fontWeight = el.style.fontWeight || 'normal';
            const fontStyle = el.style.fontStyle || 'normal';

            let svg = '<g>';
            text.split('\\n').forEach(function(line, index) {
                svg += '<text x="' + x + '" y="' + (y + fontSize + index * (fontSize * 1.2)) + '" fill="' + escapeXml(color) + '" font-size="' + fontSize + '" font-family="' + escapeXml(fontFamily) + '" font-weight="' + escapeXml(fontWeight) + '" font-style="' + escapeXml(fontStyle) + '">' + escapeXml(line) + '</text>';
            });
            svg += '</g>';
            return svg;
        }

        function buildVectorShapeSvgFromDom(el, offsetX, offsetY) {
            const w = el.offsetWidth;
            const h = el.offsetHeight;
            const type = el.dataset.shapeType;
            const color = getComputedStyle(el).color || '#cccccc';
            const opacity = parseFloat(getComputedStyle(el).opacity);
            const opacityAttr = !isNaN(opacity) && opacity < 1 ? ' opacity="' + opacity + '"' : '';
            const innerSvg = el.querySelector('svg');
            if (!innerSvg) {
                return '';
            }
            let content = innerSvg.innerHTML.replace(/currentColor/g, color);
            if (isVectorIconType(type)) {
                return '<g transform="translate(' + offsetX + ',' + offsetY + ') scale(' + (w / 24) + ')"' + opacityAttr + '>' +
                    '<g fill="none" stroke="' + escapeXml(color) + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                    content + '</g></g>';
            }
            return '<svg x="' + offsetX + '" y="' + offsetY + '" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" overflow="visible"' + opacityAttr + '>' +
                content.replace(/currentColor/g, color) + '</svg>';
        }

        function buildExportSvg(bounds, exportScale) {
            const bgColor = getComputedStyle(document.body).backgroundColor || '#1e1e1e';
            const pixelWidth = Math.round(bounds.width * exportScale);
            const pixelHeight = Math.round(bounds.height * exportScale);
            let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + pixelWidth + '" height="' + pixelHeight + '" viewBox="0 0 ' + bounds.width + ' ' + bounds.height + '">';
            svg += '<rect x="0" y="0" width="' + bounds.width + '" height="' + bounds.height + '" fill="' + escapeXml(bgColor) + '"/>';
            svg += buildRelationshipsSvg(bounds.minX, bounds.minY);

            document.querySelectorAll('.table-node').forEach(function(el) {
                const x = (parseFloat(el.style.left) || 0) - bounds.minX;
                const y = (parseFloat(el.style.top) || 0) - bounds.minY;
                svg += buildTableSvgFromDom(el, x, y);
            });

            document.querySelectorAll('.comment-node').forEach(function(el) {
                const x = (parseFloat(el.style.left) || 0) - bounds.minX;
                const y = (parseFloat(el.style.top) || 0) - bounds.minY;
                svg += buildCommentSvgFromDom(el, x, y);
            });

            document.querySelectorAll('.text-label-node').forEach(function(el) {
                const x = (parseFloat(el.style.left) || 0) - bounds.minX;
                const y = (parseFloat(el.style.top) || 0) - bounds.minY;
                svg += buildTextLabelSvgFromDom(el, x, y);
            });

            document.querySelectorAll('.vector-shape-node').forEach(function(el) {
                const x = (parseFloat(el.style.left) || 0) - bounds.minX;
                const y = (parseFloat(el.style.top) || 0) - bounds.minY;
                svg += buildVectorShapeSvgFromDom(el, x, y);
            });

            svg += '</svg>';
            return svg;
        }

        function renderSvgToDataUrl(svgString, pixelWidth, pixelHeight, format) {
            return new Promise(function(resolve, reject) {
                const bgColor = getComputedStyle(document.body).backgroundColor || '#1e1e1e';
                const dataUri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);
                const img = new Image();

                img.onload = function() {
                    const canvas = document.createElement('canvas');
                    canvas.width = pixelWidth;
                    canvas.height = pixelHeight;
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = bgColor;
                    ctx.fillRect(0, 0, pixelWidth, pixelHeight);
                    ctx.drawImage(img, 0, 0, pixelWidth, pixelHeight);
                    try {
                        const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
                        resolve(canvas.toDataURL(mime, 0.95));
                    } catch (err) {
                        reject(err);
                    }
                };
                img.onerror = function() {
                    reject(new Error('Failed to render export image'));
                };
                img.src = dataUri;
            });
        }

        function exportErd(format) {
            const bounds = getExportBounds();
            if (!bounds) {
                alert('没有可导出的内容');
                return;
            }

            const exportScale = getExportScale(bounds.width, bounds.height);
            const pixelWidth = Math.round(bounds.width * exportScale);
            const pixelHeight = Math.round(bounds.height * exportScale);
            const svgString = buildExportSvg(bounds, exportScale);
            renderSvgToDataUrl(svgString, pixelWidth, pixelHeight, format === 'pdf' ? 'jpg' : format)
                .then(function(dataUrl) {
                    vscode.postMessage({
                        command: 'exportImage',
                        format: format,
                        data: dataUrl,
                        width: pixelWidth,
                        height: pixelHeight
                    });
                })
                .catch(function(err) {
                    console.error('[Export] Failed:', err);
                    alert('导出失败，请重试');
                });
        }
// Initialize comment events
function initCommentEvents(commentEl) {
    const textarea = commentEl.querySelector('.comment-textarea');
    const deleteBtn = commentEl.querySelector('.comment-delete-btn');
    
    // Set initial textarea height to match comment node height (subtract padding)
    const commentHeight = commentEl.offsetHeight;
    textarea.style.height = (commentHeight - 24) + 'px';
    
    // Add resize handle
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'comment-resize-handle';
    commentEl.appendChild(resizeHandle);
    
    // Add connection points to comment node
    const commentId = commentEl.dataset.commentId;
    const connectorTop = document.createElement('div');
    connectorTop.className = 'comment-connector-top connection-point';
    connectorTop.dataset.comment = commentId;
    connectorTop.title = 'Comment top';
    commentEl.appendChild(connectorTop);
    
    const connectorBottom = document.createElement('div');
    connectorBottom.className = 'comment-connector-bottom connection-point';
    connectorBottom.dataset.comment = commentId;
    connectorBottom.title = 'Comment bottom';
    commentEl.appendChild(connectorBottom);
    
    const connectorLeft = document.createElement('div');
    connectorLeft.className = 'comment-connector-left connection-point';
    connectorLeft.dataset.comment = commentId;
    connectorLeft.title = 'Comment left';
    commentEl.appendChild(connectorLeft);
    
    const connectorRight = document.createElement('div');
    connectorRight.className = 'comment-connector-right connection-point';
    connectorRight.dataset.comment = commentId;
    connectorRight.title = 'Comment right';
    commentEl.appendChild(connectorRight);
    
    // Connection points mouse handlers - same as table nodes
    [connectorTop, connectorBottom, connectorLeft, connectorRight].forEach(function(point) {
        // Set both data-table and data-comment attributes for compatibility
        point.dataset.table = commentId;
        point.dataset.comment = commentId;
        
        point.addEventListener('mousedown', function(e) {
            e.stopPropagation();
            e.preventDefault();

            const pointRect = point.getBoundingClientRect();
            const canvasRect = canvas.getBoundingClientRect();

            connectionStartPoint = {
                table: commentId, // Use commentId as table identifier (starts with 'comment_')
                column: '', // No column for comment connections
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
                    table: commentId,
                    column: ''
                };

                // Don't connect to same point
                if (connectionStartPoint.table !== endPoint.table) {
                    pushUndoSnapshot();
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
    
    // Handle text changes
    textarea.addEventListener('input', function() {
        const commentId = commentEl.dataset.commentId;
        const comment = comments.find(c => c.id === commentId);
        if (comment) {
            comment.text = textarea.value;
            // Auto resize textarea
            textarea.style.height = 'auto';
            textarea.style.height = textarea.scrollHeight + 'px';
        }
    });
    
    // Handle delete
    deleteBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        pushUndoSnapshot();
        const commentId = commentEl.dataset.commentId;
        const commentIndex = comments.findIndex(c => c.id === commentId);
        if (commentIndex !== -1) {
            comments.splice(commentIndex, 1);
            commentEl.remove();
        }
    });
    
    // Handle resize
    let isResizing = false;
    let resizeStartX = 0;
    let resizeStartY = 0;
    let resizeStartWidth = 0;
    let resizeStartHeight = 0;
    
    const handleResizeMove = function(e) {
        if (isResizing) {
            const deltaX = (e.clientX - resizeStartX) / zoom;
            const deltaY = (e.clientY - resizeStartY) / zoom;
            const newWidth = Math.max(200, resizeStartWidth + deltaX);
            const newHeight = Math.max(100, resizeStartHeight + deltaY);
            
            commentEl.style.width = newWidth + 'px';
            commentEl.style.height = newHeight + 'px';
            
            // Update textarea height to match comment node height
            textarea.style.height = (newHeight - 24) + 'px';
            
            // Update comment data
            const commentId = commentEl.dataset.commentId;
            const comment = comments.find(c => c.id === commentId);
            if (comment) {
                comment.width = newWidth;
                comment.height = newHeight;
            }
        }
    };
    
    const handleResizeUp = function() {
        if (isResizing) {
            isResizing = false;
            resizeHandle.classList.remove('dragging');
            commentEl.style.zIndex = '';
            document.removeEventListener('mousemove', handleResizeMove);
            document.removeEventListener('mouseup', handleResizeUp);
        }
    };
    
    resizeHandle.addEventListener('mousedown', function(e) {
        e.stopPropagation();
        pushUndoSnapshot();
        isResizing = true;
        resizeStartX = e.clientX;
        resizeStartY = e.clientY;
        resizeStartWidth = commentEl.offsetWidth;
        resizeStartHeight = commentEl.offsetHeight;
        resizeHandle.classList.add('dragging');
        commentEl.style.zIndex = '1000';
        
        document.addEventListener('mousemove', handleResizeMove);
        document.addEventListener('mouseup', handleResizeUp);
    });
    
    // Make comment draggable
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragStartLeft = 0;
    let dragStartTop = 0;
    
    commentEl.addEventListener('mousedown', function(e) {
        // Only start dragging if clicking on the comment background or border
        if (e.target === commentEl || e.target === deleteBtn) {
            pushUndoSnapshot();
            isDragging = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            dragStartLeft = parseFloat(commentEl.style.left) || 0;
            dragStartTop = parseFloat(commentEl.style.top) || 0;
            commentEl.style.zIndex = '1000';
            commentEl.classList.add('selected');
            
            document.body.classList.add('panning');
        }
    });
    
    document.addEventListener('mousemove', function(e) {
        if (isDragging) {
            const deltaX = e.clientX - dragStartX;
            const deltaY = e.clientY - dragStartY;
            
            const canvasRect = document.getElementById('canvas-container').getBoundingClientRect();
            const x = (deltaX / zoom) + dragStartLeft;
            const y = (deltaY / zoom) + dragStartTop;
            
            commentEl.style.left = x + 'px';
            commentEl.style.top = y + 'px';
            
            // Update comment data
            const commentId = commentEl.dataset.commentId;
            const comment = comments.find(c => c.id === commentId);
            if (comment) {
                comment.x = x;
                comment.y = y;
            }
            
            // Redraw relationships to reflect new position
            drawRelationships();
            if (thumbnailVisible) {
                updateThumbnail();
            }
        }
    });
    
    document.addEventListener('mouseup', function() {
        if (isDragging) {
            isDragging = false;
            commentEl.style.zIndex = '';
            commentEl.classList.remove('selected');
            document.body.classList.remove('panning');
        }
    });
    
    // Select comment when clicked
    commentEl.addEventListener('click', function() {
        document.querySelectorAll('.comment-node').forEach(node => {
            node.classList.remove('selected');
        });
        commentEl.classList.add('selected');
    });
}

        // Initialize all comment events
        document.querySelectorAll('.comment-node').forEach(initCommentEvents);

        const PRESET_TABLE_COLORS = ['#007acc', '#4caf50', '#e91e63', '#ff9800', '#9c27b0', '#f44336', '#00bcd4', '#607d8b'];

        function darkenHex(hex, amount) {
            const h = (hex || '').replace('#', '');
            if (h.length !== 6) {
                return hex;
            }
            const r = Math.max(0, parseInt(h.slice(0, 2), 16) - amount);
            const g = Math.max(0, parseInt(h.slice(2, 4), 16) - amount);
            const b = Math.max(0, parseInt(h.slice(4, 6), 16) - amount);
            return '#' + [r, g, b].map(function(v) {
                return v.toString(16).padStart(2, '0');
            }).join('');
        }

        function applyTableColor(tableNode, color) {
            if (!color || !tableNode) {
                return;
            }
            const headerEl = tableNode.querySelector('.table-header');
            const tableName = tableNode.dataset.table;
            tableNode.dataset.color = color;
            tableNode.style.borderColor = color;
            if (headerEl) {
                headerEl.style.background = 'linear-gradient(135deg, ' + color + ' 0%, ' + darkenHex(color, 30) + ' 100%)';
            }
            const tableData = tables.find(function(t) { return t.tableName === tableName; });
            if (tableData) {
                tableData.color = color;
            }
            vscode.postMessage({
                command: 'updateTableColor',
                tableName: tableName,
                database: tableNode.dataset.database || '',
                color: color
            });
        }

        window.addEventListener('message', function(event) {
            const message = event.data;
            if (!message || !message.command) {
                return;
            }
            if (message.command === 'collectTableState') {
                const tablesState = [];
                document.querySelectorAll('.table-node').forEach(function(el) {
                    const name = el.getAttribute('data-table');
                    if (!name) {
                        return;
                    }
                    tablesState.push({
                        tableName: name,
                        database: el.getAttribute('data-database') || '',
                        x: parseFloat(el.style.left) || 0,
                        y: parseFloat(el.style.top) || 0,
                        width: el.offsetWidth,
                        height: el.offsetHeight,
                        color: el.dataset.color || undefined,
                        borderWidth: parseFloat(el.style.borderWidth) || undefined,
                        borderStyle: el.style.borderStyle || undefined,
                        backgroundColor: el.dataset.backgroundColor || undefined,
                        zIndex: parseInt(el.style.zIndex, 10) || undefined,
                        opacity: parseFloat(el.style.opacity) || undefined
                    });
                });
                vscode.postMessage({
                    command: 'tableState',
                    tables: tablesState,
                    requestId: message.requestId
                });
            }
        });

        function getCommentsHidden(tableNode) {
            const tableBody = tableNode.querySelector('.table-body');
            return tableBody && tableBody.classList.contains('hide-comments');
        }

        function updateToggleCommentsLabel(tableNode) {
            const btn = tableNode._toggleCommentsBtn;
            if (btn) {
                btn.textContent = getCommentsHidden(tableNode) ? '显示注释' : '隐藏注释';
            }
        }

        function getTableNameCommentHidden(tableNode) {
            return tableNode.classList.contains('hide-table-name-comment');
        }

        function updateToggleTableNameCommentLabel(tableNode) {
            const btn = tableNode._toggleTableCommentBtn;
            if (btn) {
                btn.textContent = getTableNameCommentHidden(tableNode) ? '显示表名注释' : '隐藏表名注释';
            }
        }

        function toggleTableNameComment(tableNode) {
            tableNode.classList.toggle('hide-table-name-comment');
            updateToggleTableNameCommentLabel(tableNode);
        }

        function positionTableDropdown(dropdown, menuBtn) {
            const rect = menuBtn.getBoundingClientRect();
            const menuWidth = dropdown.offsetWidth || 168;
            let left = rect.right - menuWidth;
            left = Math.max(4, Math.min(left, window.innerWidth - menuWidth - 4));
            let top = rect.bottom + 4;
            const menuHeight = dropdown.offsetHeight || 120;
            if (top + menuHeight > window.innerHeight - 4) {
                top = Math.max(4, rect.top - menuHeight - 4);
            }
            dropdown.style.top = top + 'px';
            dropdown.style.left = left + 'px';
            dropdown.style.right = 'auto';
        }

        function resetTableDropdown(dropdown) {
            dropdown.style.top = '';
            dropdown.style.left = '';
            dropdown.style.right = '';
        }

        function attachTableDropdown(dropdown, menuBtn, tableNode) {
            document.body.appendChild(dropdown);
            dropdown.classList.add('show');
            positionTableDropdown(dropdown, menuBtn);
            if (tableNode) {
                updateToggleCommentsLabel(tableNode);
                updateToggleTableNameCommentLabel(tableNode);
            }
        }

        function closeTableMenus() {
            document.querySelectorAll('.table-dropdown').forEach(function(menu) {
                menu.classList.remove('show');
                resetTableDropdown(menu);
                if (menu._menuWrapper && menu.parentNode !== menu._menuWrapper) {
                    menu._menuWrapper.appendChild(menu);
                }
            });
            document.querySelectorAll('.table-color-panel').forEach(function(panel) {
                panel.classList.remove('show');
            });
            document.querySelectorAll('.table-node.menu-open').forEach(function(node) {
                node.classList.remove('menu-open');
                if (node.style.zIndex === '2000') {
                    node.style.zIndex = '';
                }
            });
        }

        function toggleComments(tableNode) {
            const tableBody = tableNode.querySelector('.table-body');
            const columnRows = tableBody.querySelectorAll('.column-row');
            const isHidden = tableBody.classList.toggle('hide-comments');

            if (isHidden) {
                columnRows.forEach(function(row) {
                    row.classList.add('hide-comments');
                });
            } else {
                columnRows.forEach(function(row) {
                    row.classList.remove('hide-comments');
                });
            }

            updateToggleCommentsLabel(tableNode);
            drawRelationships();
        }

        function initTableMenu(table) {
            const wrapper = table.querySelector('.table-menu-wrapper');
            if (!wrapper || wrapper.dataset.initialized === 'true') {
                return;
            }
            wrapper.dataset.initialized = 'true';

            const menuBtn = wrapper.querySelector('.table-menu-btn');
            const dropdown = wrapper.querySelector('.table-dropdown');
            dropdown._menuWrapper = wrapper;
            const toggleItem = wrapper.querySelector('.table-menu-toggle-comments');
            const toggleTableCommentItem = wrapper.querySelector('.table-menu-toggle-table-comment');
            table._toggleCommentsBtn = toggleItem;
            table._toggleTableCommentBtn = toggleTableCommentItem;
            const setColorItem = wrapper.querySelector('.table-menu-set-color');
            const colorPanel = wrapper.querySelector('.table-color-panel');

            if (colorPanel && !colorPanel.innerHTML) {
                let swatchHtml = '<div class="table-color-swatches">';
                PRESET_TABLE_COLORS.forEach(function(c) {
                    swatchHtml += '<button type="button" class="color-swatch" data-color="' + c + '" style="background-color:' + c + '" title="' + c + '"></button>';
                });
                swatchHtml += '<label class="color-picker-label" title="调色盘"><input type="color" class="table-color-input" value="#007acc"/></label>';
                swatchHtml += '</div>';
                colorPanel.innerHTML = swatchHtml;

                colorPanel.querySelectorAll('.color-swatch').forEach(function(swatch) {
                    swatch.addEventListener('click', function(e) {
                        e.stopPropagation();
                        applyTableColor(table, swatch.dataset.color);
                        closeTableMenus();
                        drawRelationships();
                    });
                });

                const colorInput = colorPanel.querySelector('.table-color-input');
                if (colorInput) {
                    colorInput.addEventListener('input', function(e) {
                        e.stopPropagation();
                        applyTableColor(table, colorInput.value);
                    });
                    colorInput.addEventListener('change', function(e) {
                        e.stopPropagation();
                        closeTableMenus();
                        drawRelationships();
                    });
                }
            }

            const tableName = table.dataset.table;
            const tableData = tables.find(function(t) { return t.tableName === tableName; });
            if (tableData && tableData.color) {
                applyTableColor(table, tableData.color);
            }
            applyStoredTableStyles(table);
            updateToggleCommentsLabel(table);
            updateToggleTableNameCommentLabel(table);

            menuBtn.addEventListener('mousedown', function(e) {
                e.stopPropagation();
            });

            menuBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                e.preventDefault();
                const isOpen = dropdown.classList.contains('show') && dropdown.parentNode === document.body;
                closeTableMenus();
                if (!isOpen) {
                    table.classList.add('menu-open');
                    table.style.zIndex = '2000';
                    colorPanel.classList.remove('show');
                    setTimeout(function() {
                        attachTableDropdown(dropdown, menuBtn, table);
                    }, 0);
                }
            });

            toggleItem.addEventListener('click', function(e) {
                e.stopPropagation();
                toggleComments(table);
                closeTableMenus();
            });

            if (toggleTableCommentItem) {
                toggleTableCommentItem.addEventListener('click', function(e) {
                    e.stopPropagation();
                    toggleTableNameComment(table);
                    closeTableMenus();
                });
            }

            setColorItem.addEventListener('click', function(e) {
                e.stopPropagation();
                colorPanel.classList.toggle('show');
                if (dropdown.classList.contains('show') && dropdown.parentNode === document.body) {
                    requestAnimationFrame(function() {
                        positionTableDropdown(dropdown, menuBtn);
                    });
                }
            });
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
                let fromX, fromY, toX, toY;
                let fromEl, toEl;

                // Check if from is a comment
                if (rel.fromTable && rel.fromTable.startsWith('comment_')) {
                    fromEl = document.querySelector('[data-comment-id="' + rel.fromTable + '"]');
                    if (fromEl) {
                        const fromRect = fromEl.getBoundingClientRect();
                        
                        // Determine which side to connect to based on target position
                        if (rel.toTable && !rel.toTable.startsWith('comment_')) {
                            // From comment to table - determine optimal connection side
                            const toTable = tables.find(function(t) { return t.tableName === rel.toTable; });
                            if (toTable) {
                                const toElTemp = document.querySelector('[data-table="' + rel.toTable + '"]');
                                if (toElTemp) {
                                    const toRect = toElTemp.getBoundingClientRect();
                                    const commentCenterX = fromRect.left + fromRect.width / 2;
                                    const commentCenterY = fromRect.top + fromRect.height / 2;
                                    const tableCenterX = toRect.left + toRect.width / 2;
                                    const tableCenterY = toRect.top + toRect.height / 2;
                                    
                                    // Determine which side of the comment is closest to the table
                                    const dx = tableCenterX - commentCenterX;
                                    const dy = tableCenterY - commentCenterY;
                                    
                                    if (Math.abs(dx) > Math.abs(dy)) {
                                        // Horizontal connection
                                        if (dx > 0) {
                                            // Connect to right side
                                            fromX = (fromRect.right - containerRect.left - panX) / zoom;
                                            fromY = (commentCenterY - containerRect.top - panY) / zoom;
                                        } else {
                                            // Connect to left side
                                            fromX = (fromRect.left - containerRect.left - panX) / zoom;
                                            fromY = (commentCenterY - containerRect.top - panY) / zoom;
                                        }
                                    } else {
                                        // Vertical connection
                                        if (dy > 0) {
                                            // Connect to bottom side
                                            fromX = (commentCenterX - containerRect.left - panX) / zoom;
                                            fromY = (fromRect.bottom - containerRect.top - panY) / zoom;
                                        } else {
                                            // Connect to top side
                                            fromX = (commentCenterX - containerRect.left - panX) / zoom;
                                            fromY = (fromRect.top - containerRect.top - panY) / zoom;
                                        }
                                    }
                                } else {
                                    // Fallback to center
                                    fromX = (fromRect.left + fromRect.width / 2 - containerRect.left - panX) / zoom;
                                    fromY = (fromRect.top + fromRect.height / 2 - containerRect.top - panY) / zoom;
                                }
                            } else {
                                // Fallback to center
                                fromX = (fromRect.left + fromRect.width / 2 - containerRect.left - panX) / zoom;
                                fromY = (fromRect.top + fromRect.height / 2 - containerRect.top - panY) / zoom;
                            }
                        } else if (rel.toTable && rel.toTable.startsWith('comment_')) {
                            // From comment to comment - determine optimal connection side
                            const toElTemp = document.querySelector('[data-comment-id="' + rel.toTable + '"]');
                            if (toElTemp) {
                                const toRect = toElTemp.getBoundingClientRect();
                                const fromCenterX = fromRect.left + fromRect.width / 2;
                                const fromCenterY = fromRect.top + fromRect.height / 2;
                                const toCenterX = toRect.left + toRect.width / 2;
                                const toCenterY = toRect.top + toRect.height / 2;
                                
                                const dx = toCenterX - fromCenterX;
                                const dy = toCenterY - fromCenterY;
                                
                                if (Math.abs(dx) > Math.abs(dy)) {
                                    // Horizontal connection
                                    if (dx > 0) {
                                        fromX = (fromRect.right - containerRect.left - panX) / zoom;
                                        fromY = (fromCenterY - containerRect.top - panY) / zoom;
                                    } else {
                                        fromX = (fromRect.left - containerRect.left - panX) / zoom;
                                        fromY = (fromCenterY - containerRect.top - panY) / zoom;
                                    }
                                } else {
                                    // Vertical connection
                                    if (dy > 0) {
                                        fromX = (fromCenterX - containerRect.left - panX) / zoom;
                                        fromY = (fromRect.bottom - containerRect.top - panY) / zoom;
                                    } else {
                                        fromX = (fromCenterX - containerRect.left - panX) / zoom;
                                        fromY = (fromRect.top - containerRect.top - panY) / zoom;
                                    }
                                }
                            } else {
                                fromX = (fromRect.left + fromRect.width / 2 - containerRect.left - panX) / zoom;
                                fromY = (fromRect.top + fromRect.height / 2 - containerRect.top - panY) / zoom;
                            }
                        } else {
                            fromX = (fromRect.left + fromRect.width / 2 - containerRect.left - panX) / zoom;
                            fromY = (fromRect.top + fromRect.height / 2 - containerRect.top - panY) / zoom;
                        }
                    }
                } else {
                    // From is a table
                    const fromTable = tables.find(function(t) { return t.tableName === rel.fromTable; });
                    if (fromTable) {
                        fromEl = document.querySelector('[data-table="' + rel.fromTable + '"]');
                        if (fromEl) {
                            if (rel.fromColumn) {
                                const fromColumnPoint = fromEl.querySelector('.column-connector-right[data-column="' + rel.fromColumn + '"]');
                                if (fromColumnPoint) {
                                    const fromPointRect = fromColumnPoint.getBoundingClientRect();
                                    fromX = (fromPointRect.left + fromPointRect.width / 2 - containerRect.left - panX) / zoom;
                                    fromY = (fromPointRect.top + fromPointRect.height / 2 - containerRect.top - panY) / zoom;
                                }
                            } else {
                                const fromRect = fromEl.getBoundingClientRect();
                                fromX = (fromRect.right - containerRect.left - panX) / zoom;
                                fromY = (fromRect.top + fromRect.height / 2 - containerRect.top - panY) / zoom;
                            }
                        }
                    }
                }

                // Check if to is a comment
                if (rel.toTable && rel.toTable.startsWith('comment_')) {
                    toEl = document.querySelector('[data-comment-id="' + rel.toTable + '"]');
                    if (toEl) {
                        const toRect = toEl.getBoundingClientRect();
                        
                        if (rel.fromTable && !rel.fromTable.startsWith('comment_')) {
                            // From table to comment - determine optimal connection side
                            const fromTable = tables.find(function(t) { return t.tableName === rel.fromTable; });
                            if (fromTable) {
                                const fromElTemp = document.querySelector('[data-table="' + rel.fromTable + '"]');
                                if (fromElTemp) {
                                    const fromRect = fromElTemp.getBoundingClientRect();
                                    const tableCenterX = fromRect.left + fromRect.width / 2;
                                    const tableCenterY = fromRect.top + fromRect.height / 2;
                                    const commentCenterX = toRect.left + toRect.width / 2;
                                    const commentCenterY = toRect.top + toRect.height / 2;
                                    
                                    const dx = commentCenterX - tableCenterX;
                                    const dy = commentCenterY - tableCenterY;
                                    
                                    if (Math.abs(dx) > Math.abs(dy)) {
                                        if (dx > 0) {
                                            toX = (toRect.left - containerRect.left - panX) / zoom;
                                            toY = (commentCenterY - containerRect.top - panY) / zoom;
                                        } else {
                                            toX = (toRect.right - containerRect.left - panX) / zoom;
                                            toY = (commentCenterY - containerRect.top - panY) / zoom;
                                        }
                                    } else {
                                        if (dy > 0) {
                                            toX = (commentCenterX - containerRect.left - panX) / zoom;
                                            toY = (toRect.top - containerRect.top - panY) / zoom;
                                        } else {
                                            toX = (commentCenterX - containerRect.left - panX) / zoom;
                                            toY = (toRect.bottom - containerRect.top - panY) / zoom;
                                        }
                                    }
                                } else {
                                    toX = (toRect.left + toRect.width / 2 - containerRect.left - panX) / zoom;
                                    toY = (toRect.top + toRect.height / 2 - containerRect.top - panY) / zoom;
                                }
                            } else {
                                toX = (toRect.left + toRect.width / 2 - containerRect.left - panX) / zoom;
                                toY = (toRect.top + toRect.height / 2 - containerRect.top - panY) / zoom;
                            }
                        } else if (rel.fromTable && rel.fromTable.startsWith('comment_')) {
                            // From comment to comment - determine optimal connection side
                            const fromElTemp = document.querySelector('[data-comment-id="' + rel.fromTable + '"]');
                            if (fromElTemp) {
                                const fromRect = fromElTemp.getBoundingClientRect();
                                const fromCenterX = fromRect.left + fromRect.width / 2;
                                const fromCenterY = fromRect.top + fromRect.height / 2;
                                const toCenterX = toRect.left + toRect.width / 2;
                                const toCenterY = toRect.top + toRect.height / 2;
                                
                                const dx = toCenterX - fromCenterX;
                                const dy = toCenterY - fromCenterY;
                                
                                if (Math.abs(dx) > Math.abs(dy)) {
                                    if (dx > 0) {
                                        toX = (toRect.left - containerRect.left - panX) / zoom;
                                        toY = (toCenterY - containerRect.top - panY) / zoom;
                                    } else {
                                        toX = (toRect.right - containerRect.left - panX) / zoom;
                                        toY = (toCenterY - containerRect.top - panY) / zoom;
                                    }
                                } else {
                                    if (dy > 0) {
                                        toX = (toCenterX - containerRect.left - panX) / zoom;
                                        toY = (toRect.top - containerRect.top - panY) / zoom;
                                    } else {
                                        toX = (toCenterX - containerRect.left - panX) / zoom;
                                        toY = (toRect.bottom - containerRect.top - panY) / zoom;
                                    }
                                }
                            } else {
                                toX = (toRect.left + toRect.width / 2 - containerRect.left - panX) / zoom;
                                toY = (toRect.top + toRect.height / 2 - containerRect.top - panY) / zoom;
                            }
                        } else {
                            toX = (toRect.left + toRect.width / 2 - containerRect.left - panX) / zoom;
                            toY = (toRect.top + toRect.height / 2 - containerRect.top - panY) / zoom;
                        }
                    }
                } else {
                    // To is a table
                    const toTable = tables.find(function(t) { return t.tableName === rel.toTable; });
                    if (toTable) {
                        toEl = document.querySelector('[data-table="' + rel.toTable + '"]');
                        if (toEl) {
                            if (rel.toColumn) {
                                const toColumnPoint = toEl.querySelector('.column-connector-left[data-column="' + rel.toColumn + '"]');
                                if (toColumnPoint) {
                                    const toPointRect = toColumnPoint.getBoundingClientRect();
                                    toX = (toPointRect.left + toPointRect.width / 2 - containerRect.left - panX) / zoom;
                                    toY = (toPointRect.top + toPointRect.height / 2 - containerRect.top - panY) / zoom;
                                }
                            } else {
                                const toRect = toEl.getBoundingClientRect();
                                toX = (toRect.left - containerRect.left - panX) / zoom;
                                toY = (toRect.top + toRect.height / 2 - containerRect.top - panY) / zoom;
                            }
                        }
                    }
                }

                if (!fromX || !fromY || !toX || !toY) return;

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

                // Draw arrows based on relationship type
                if (rel.type === 'one-to-one') {
                    // No arrows for one-to-one relationship
                } else if (rel.type === 'one-to-many') {
                    // Arrow at end (to table) for one-to-many
                    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                    const arrowSize = 8; // Original size
                    const points = toX + ',' + toY + ' ' + (toX - arrowSize) + ',' + (toY - arrowSize/2) + ' ' + (toX - arrowSize) + ',' + (toY + arrowSize/2);
                    arrow.setAttribute('points', points);
                    arrow.setAttribute('class', 'relationship-arrow');
                    arrow.setAttribute('data-rel-index', relIndex);
                    svg.appendChild(arrow);
                } else if (rel.type === 'many-to-many') {
                    // Arrows at both start and end for many-to-many
                    const startArrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                    const startArrowSize = 8;
                    const startPoints = fromX + ',' + fromY + ' ' + (fromX + startArrowSize) + ',' + (fromY - startArrowSize/2) + ' ' + (fromX + startArrowSize) + ',' + (fromY + startArrowSize/2);
                    startArrow.setAttribute('points', startPoints);
                    startArrow.setAttribute('class', 'relationship-arrow');
                    startArrow.setAttribute('data-rel-index', relIndex);
                    svg.appendChild(startArrow);

                    const endArrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                    const endArrowSize = 8;
                    const endPoints = toX + ',' + toY + ' ' + (toX - endArrowSize) + ',' + (toY - endArrowSize/2) + ' ' + (toX - endArrowSize) + ',' + (toY + endArrowSize/2);
                    endArrow.setAttribute('points', endPoints);
                    endArrow.setAttribute('class', 'relationship-arrow');
                    endArrow.setAttribute('data-rel-index', relIndex);
                    svg.appendChild(endArrow);
                }

                // Add context menu event to hit area
                hitArea.addEventListener('contextmenu', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    selectRelationship(relIndex);
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
                    e.stopPropagation();
                    selectRelationship(relIndex);
                    showRelationshipContextMenu(e, relIndex);
                });

                line.addEventListener('click', function(e) {
                    e.stopPropagation();
                    selectRelationship(relIndex);
                });

            });
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
            document.querySelectorAll('.relationship-selection-box').forEach(function(box) {
                box.remove();
            });

            // Select clicked relationship
            const line = document.querySelector('.relationship-line[data-rel-index="' + relIndex + '"]');
            const hitArea = document.querySelector('.relationship-hit-area[data-rel-index="' + relIndex + '"]');
            const arrow = document.querySelector('.relationship-arrow[data-rel-index="' + relIndex + '"]');
            const startMarker = document.querySelector('.relationship-start-marker[data-rel-index="' + relIndex + '"]');

            if (line) {
                line.classList.add('selected');
            }
            if (hitArea) {
                hitArea.classList.add('selected');
            }
            if (arrow) {
                arrow.classList.add('selected');
            }
            if (startMarker) {
                startMarker.classList.add('selected');
            }

            // Create selection box around the relationship
            const svg = document.getElementById('relationships');
            const path = line || hitArea;
            if (path) {
                const bbox = path.getBBox();
                const padding = 10;
                const selectionBox = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                selectionBox.setAttribute('x', (bbox.x - padding) + '');
                selectionBox.setAttribute('y', (bbox.y - padding) + '');
                selectionBox.setAttribute('width', (bbox.width + padding * 2) + '');
                selectionBox.setAttribute('height', (bbox.height + padding * 2) + '');
                selectionBox.setAttribute('class', 'relationship-selection-box');
                svg.appendChild(selectionBox);
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
            let isResizingVertical = false;
            let resizeElement = null;
            let startX = 0;
            let startY = 0;
            let startWidth = 0;
            let startHeight = 0;
            let isResizingCorner = false;
            let resizeCorner = null;
            let startLeft = 0;
            let startTop = 0;

            document.querySelectorAll('.table-node').forEach(function(table) {
                // Handle horizontal resize
                const resizeHandle = document.createElement('div');
                resizeHandle.className = 'resize-handle';
                table.appendChild(resizeHandle);

                resizeHandle.addEventListener('mousedown', function(e) {
                    e.stopPropagation();
                    pushUndoSnapshot();
                    isResizing = true;
                    isResizingVertical = false;
                    resizeElement = table;
                    startX = e.clientX;
                    startWidth = table.offsetWidth;
                    resizeHandle.classList.add('dragging');
                    table.style.zIndex = '1000';
                });

                // Handle vertical resize
                const resizeHandleVertical = table.querySelector('.resize-handle-vertical') || document.createElement('div');
                if (!table.querySelector('.resize-handle-vertical')) {
                    resizeHandleVertical.className = 'resize-handle-vertical';
                    table.appendChild(resizeHandleVertical);
                }

                resizeHandleVertical.addEventListener('mousedown', function(e) {
                    e.stopPropagation();
                    pushUndoSnapshot();
                    isResizing = true;
                    isResizingVertical = true;
                    resizeElement = table;
                    startY = e.clientY;
                    startHeight = table.offsetHeight;
                    resizeHandleVertical.classList.add('dragging');
                    table.style.zIndex = '1000';
                });

                // Create 4 corner resize handles
                ['tl', 'tr', 'bl', 'br'].forEach(function(corner) {
                    const cornerHandle = document.createElement('div');
                    cornerHandle.className = 'resize-handle-corner resize-handle-corner-' + corner;
                    table.appendChild(cornerHandle);

                    cornerHandle.addEventListener('mousedown', function(e) {
                        e.stopPropagation();
                        e.preventDefault();
                        pushUndoSnapshot();
                        isResizing = true;
                        isResizingVertical = false;
                        isResizingCorner = true;
                        resizeCorner = corner;
                        resizeElement = table;
                        startX = e.clientX;
                        startY = e.clientY;
                        startWidth = table.offsetWidth;
                        startHeight = table.offsetHeight;
                        startLeft = parseFloat(table.style.left) || 0;
                        startTop = parseFloat(table.style.top) || 0;
                        cornerHandle.classList.add('dragging');
                        table.style.zIndex = '1000';
                    });
                });

                // Right-click context menu
                table.addEventListener('contextmenu', function(e) {
                    e.preventDefault();

                    // Select this table
                    selectTable(table);
                    selectedTable = table;

                    showTableContextMenu(table, e.clientX, e.clientY);
                });

                table.addEventListener('mousedown', function(e) {
                    if (e.target.closest('.table-menu-wrapper')) return;
                    if (e.target.classList.contains('resize-handle')) return;
                    if (e.target.classList.contains('resize-handle-vertical')) return;
                    if (e.target.classList.contains('resize-handle-corner')) return;
                    if (e.target.classList.contains('connection-point')) return;
                    
                    // 只有在点击 table-header 时才允许拖动
                    const isHeaderClick = e.target.closest('.table-header');
                    if (!isHeaderClick) return;

                    pushUndoSnapshot();
                    draggedElement = table;
                    const rect = table.getBoundingClientRect();
                    offsetX = e.clientX - rect.left;
                    offsetY = e.clientY - rect.top;
                    table.style.zIndex = '1000';
                    selectTable(table);
                });

                 initTableMenu(table);

                 // Column name click to copy
                 table.querySelectorAll('.column-name').forEach(function(columnNameEl) {
                     const columnNameText = columnNameEl.querySelector('.column-name-text');
                     if (columnNameText) {
                         columnNameEl.addEventListener('click', function(e) {
                             e.stopPropagation();
                             const columnName = columnNameText.textContent.trim();
                             // 复制到剪贴板
                             navigator.clipboard.writeText(columnName).then(function() {
                                 console.log('Column name copied:', columnName);
                                 // 可以添加一个短暂的提示反馈
                                 const originalText = columnNameText.textContent;
                                 columnNameText.textContent = '✓ 已复制';
                                 setTimeout(function() {
                                     columnNameText.textContent = originalText;
                                 }, 1000);
                             }).catch(function(err) {
                                 console.error('Failed to copy:', err);
                             });
                         });
                         // 添加点击反馈样式
                         columnNameEl.style.cursor = 'pointer';
                         columnNameEl.style.transition = 'opacity 0.2s';
                         columnNameEl.addEventListener('mouseenter', function() {
                             this.style.opacity = '0.7';
                         });
                         columnNameEl.addEventListener('mouseleave', function() {
                             this.style.opacity = '1';
                         });
                     }
                 });

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

                                pushUndoSnapshot();
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
                    if (thumbnailVisible) {
                        updateThumbnail();
                    }
                }

                // Handle resizing
                if (isResizing && resizeElement) {
                    if (isResizingVertical) {
                        // Vertical resizing
                        const deltaY = (e.clientY - startY) / zoom;
                        // Calculate minimum and maximum height based on content
                        const tableHeader = resizeElement.querySelector('.table-header');
                        const tableBody = resizeElement.querySelector('.table-body');
                        const headerHeight = tableHeader.offsetHeight;
                        
                        // Calculate minimum height (header + 2 rows)
                        const columnRows = tableBody.querySelectorAll('.column-row');
                        const minHeight = headerHeight + (columnRows.length > 0 ? Math.min(columnRows.length, 2) * columnRows[0].offsetHeight : 60) + 16; // 16px padding
                        
                        // Calculate maximum height (all content visible + extra space for better usability)
                        let totalContentHeight = headerHeight + 1; // 16px padding
                        columnRows.forEach(row => {
                            totalContentHeight += row.offsetHeight;
                        });
                        
                        // 增加额外的高度空间（例如增加50%的内容高度或固定值）
                        const extraHeight = 200; // 增加200px的额外空间
                        const maxHeight = totalContentHeight + extraHeight;
                        
                        const newHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + deltaY));
                        resizeElement.style.height = newHeight + 'px';
                        
                        // Set table body height to allow scrolling
                        const bodyHeight = newHeight - headerHeight - 16; // subtract padding (8px top + 8px bottom)
                        tableBody.style.maxHeight = bodyHeight + 'px';
                    } else if (isResizingCorner) {
                        // Corner resizing
                        const deltaX = (e.clientX - startX) / zoom;
                        const deltaY = (e.clientY - startY) / zoom;

                        const tableHeader = resizeElement.querySelector('.table-header');
                        const tableBody = resizeElement.querySelector('.table-body');
                        const headerHeight = tableHeader.offsetHeight;
                        const columnRows = tableBody.querySelectorAll('.column-row');
                        const minHeight = headerHeight + (columnRows.length > 0 ? Math.min(columnRows.length, 2) * columnRows[0].offsetHeight : 60) + 16;
                        let totalContentHeight = headerHeight + 1;
                        columnRows.forEach(function(row) {
                            totalContentHeight += row.offsetHeight;
                        });
                        const maxHeight = totalContentHeight + 200;

                        let newLeft = startLeft;
                        let newTop = startTop;
                        let newWidth = startWidth;
                        let newHeight = startHeight;

                        if (resizeCorner === 'tl' || resizeCorner === 'bl') {
                            const desiredWidth = Math.max(150, startWidth - deltaX);
                            newWidth = desiredWidth;
                            newLeft = startLeft + startWidth - newWidth;
                        }
                        if (resizeCorner === 'tr' || resizeCorner === 'br') {
                            newWidth = Math.max(150, startWidth + deltaX);
                        }
                        if (resizeCorner === 'tl' || resizeCorner === 'tr') {
                            const desiredHeight = Math.max(minHeight, Math.min(maxHeight, startHeight - deltaY));
                            newHeight = desiredHeight;
                            newTop = startTop + startHeight - newHeight;
                        }
                        if (resizeCorner === 'bl' || resizeCorner === 'br') {
                            newHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + deltaY));
                        }

                        resizeElement.style.left = newLeft + 'px';
                        resizeElement.style.top = newTop + 'px';
                        resizeElement.style.width = newWidth + 'px';
                        resizeElement.style.height = newHeight + 'px';

                        const bodyHeight = newHeight - headerHeight - 16;
                        tableBody.style.maxHeight = bodyHeight + 'px';
                    } else {
                        // Horizontal resizing
                        const deltaX = (e.clientX - startX) / zoom;
                        const newWidth = Math.max(150, startWidth + deltaX);
                        resizeElement.style.width = newWidth + 'px';
                    }
                    drawRelationships();
                    if (thumbnailVisible) {
                        updateThumbnail();
                    }
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
                    if (isResizingVertical) {
                        const handle = resizeElement?.querySelector('.resize-handle-vertical');
                        if (handle) handle.classList.remove('dragging');
                    } else if (isResizingCorner) {
                        const handle = resizeElement?.querySelector('.resize-handle-corner.dragging');
                        if (handle) handle.classList.remove('dragging');
                    } else {
                        const handle = resizeElement?.querySelector('.resize-handle');
                        if (handle) handle.classList.remove('dragging');
                    }
                    if (resizeElement) resizeElement.style.zIndex = '';
                    isResizing = false;
                    isResizingVertical = false;
                    isResizingCorner = false;
                    resizeCorner = null;
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
                if (marqueeJustFinished) {
                    return;
                }
                // Hide context menu
                if (!e.target.closest('.context-menu')) {
                    hideTableContextMenu();
                }
                // Hide export menu
                if (!e.target.closest('.toolbar-menu-wrapper')) {
                    exportMenu.classList.remove('show');
                    vectorShapeMenu.classList.remove('show');
                }
                // Hide table menus
                if (!e.target.closest('.table-menu-wrapper') && !e.target.closest('.table-dropdown')) {
                    closeTableMenus();
                }
                // Hide relationship context menu
                if (!e.target.closest('.relationship-context-menu') && !e.target.closest('.relationship-line') && !e.target.closest('.relationship-hit-area')) {
                    document.getElementById('relationshipContextMenu').style.display = 'none';
                }
                // Hide text label context menu
            if (!e.target.closest('.text-label-context-menu') && !e.target.closest('#vectorShapeContextMenu') && !e.target.closest('.context-submenu')) {
                hideTextLabelContextMenu();
                hideVectorShapeContextMenu();
            }

                if (!e.target.closest('.table-node') && !e.target.closest('.zoom-controls') &&
                    !e.target.closest('.comment-node') && !e.target.closest('.text-label-node') &&
                    !e.target.closest('.vector-shape-node')) {
                    clearAllObjectSelections();
                }

                // Deselect relationship if clicking outside relationship elements
                if (!e.target.closest('.relationship-line') && !e.target.closest('.relationship-hit-area') && !e.target.closest('.relationship-context-menu')) {
                    if (selectedRelationshipIndex >= 0) {
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
                        document.querySelectorAll('.relationship-selection-box').forEach(function(box) {
                            box.remove();
                        });
                        selectedRelationshipIndex = -1;
                        currentRelationshipIndex = -1;
                    }
                }
            });

            // Context menu item handlers
            document.getElementById('ctxSelect100').addEventListener('click', function() {
                const contextMenu = document.getElementById('contextMenu');
                const tableName = contextMenu.dataset.tableName;
                const database = contextMenu.dataset.database;

                if (tableName && database) {
                    // Send message to extension to generate SQL and open SQL tab
                    vscode.postMessage({
                        command: 'selectTable100',
                        tableName: tableName,
                        database: database
                    });
                }

                hideTableContextMenu();
            });

            document.getElementById('ctxDelete').addEventListener('click', function() {
                const contextMenu = document.getElementById('contextMenu');
                const tableName = contextMenu.dataset.tableName;

                if (tableName) {
                    pushUndoSnapshot();
                    const tableToRemove = getTableContextTarget();
                    if (tableToRemove) {
                        const initialRelCount = relationships.length;
                        deleteTableElement(tableToRemove);

                        // Clear selection
                        if (selectedTable && selectedTable.dataset.table === tableName) {
                            selectedTable = null;
                        }

                        // Redraw relationships
                        drawRelationships();

                        console.log('[ContextMenu Delete] Removed table:', tableName, 'and', initialRelCount - relationships.length, 'relationships');
                    }
                }

                hideTableContextMenu();
            });

            // Relationship context menu item handlers
            document.getElementById('relTypeOneToOne').addEventListener('click', function() {
                if (currentRelationshipIndex >= 0 && currentRelationshipIndex < relationships.length) {
                    pushUndoSnapshot();
                    relationships[currentRelationshipIndex].type = 'one-to-one';
                    drawRelationships();
                    console.log('[Relationship Menu] Changed to one-to-one');
                }
                document.getElementById('relationshipContextMenu').style.display = 'none';
            });

            document.getElementById('relTypeOneToMany').addEventListener('click', function() {
                if (currentRelationshipIndex >= 0 && currentRelationshipIndex < relationships.length) {
                    pushUndoSnapshot();
                    relationships[currentRelationshipIndex].type = 'one-to-many';
                    drawRelationships();
                    console.log('[Relationship Menu] Changed to one-to-many');
                }
                document.getElementById('relationshipContextMenu').style.display = 'none';
            });

            document.getElementById('relTypeManyToMany').addEventListener('click', function() {
                if (currentRelationshipIndex >= 0 && currentRelationshipIndex < relationships.length) {
                    pushUndoSnapshot();
                    relationships[currentRelationshipIndex].type = 'many-to-many';
                    drawRelationships();
                    console.log('[Relationship Menu] Changed to many-to-many');
                }
                document.getElementById('relationshipContextMenu').style.display = 'none';
            });

            document.getElementById('relDelete').addEventListener('click', function() {
                if (currentRelationshipIndex >= 0 && currentRelationshipIndex < relationships.length) {
                    pushUndoSnapshot();
                    const rel = relationships[currentRelationshipIndex];
                    console.log('[Relationship Menu] Deleting relationship:', rel.fromTable, '->', rel.toTable);
                    relationships.splice(currentRelationshipIndex, 1);
                    drawRelationships();
                }
                document.getElementById('relationshipContextMenu').style.display = 'none';
            });

        }

        // Thumbnail functionality
        let thumbnailVisible = false;
        const thumbnailToggle = document.getElementById('thumbnailToggle');
        const thumbnailPanel = document.getElementById('thumbnailPanel');
        const thumbnailCanvas = document.getElementById('thumbnailCanvas');
        const viewportIndicator = document.getElementById('viewportIndicator');

        // Toggle thumbnail panel
        thumbnailToggle.addEventListener('click', function() {
            thumbnailVisible = !thumbnailVisible;
            if (thumbnailVisible) {
                thumbnailPanel.classList.add('show');
                updateThumbnail();
            } else {
                thumbnailPanel.classList.remove('show');
            }
        });

        // Update thumbnail content
        function updateThumbnail() {
            if (!thumbnailVisible) return;

            // Clear previous thumbnail tables
            const oldTables = thumbnailCanvas.querySelectorAll('.thumbnail-table');
            oldTables.forEach(t => t.remove());

            // Get canvas container dimensions
            const containerRect = document.getElementById('canvas-container').getBoundingClientRect();
            const containerWidth = containerRect.width;
            const containerHeight = containerRect.height;

            // Calculate scale factor for thumbnail
            const canvasBounds = {
                minX: Infinity,
                minY: Infinity,
                maxX: -Infinity,
                maxY: -Infinity
            };

            // Find bounds of all tables
            tables.forEach(function(table) {
                canvasBounds.minX = Math.min(canvasBounds.minX, table.x);
                canvasBounds.minY = Math.min(canvasBounds.minY, table.y);
                canvasBounds.maxX = Math.max(canvasBounds.maxX, table.x + table.width);
                canvasBounds.maxY = Math.max(canvasBounds.maxY, table.y + table.height);
            });

            // If no tables, use default bounds
            if (canvasBounds.minX === Infinity) {
                canvasBounds.minX = 0;
                canvasBounds.minY = 0;
                canvasBounds.maxX = 1000;
                canvasBounds.maxY = 1000;
            }

            // Add padding
            const padding = 100;
            canvasBounds.minX -= padding;
            canvasBounds.minY -= padding;
            canvasBounds.maxX += padding;
            canvasBounds.maxY += padding;

            const boundsWidth = canvasBounds.maxX - canvasBounds.minX;
            const boundsHeight = canvasBounds.maxY - canvasBounds.minY;

            // Calculate scale to fit in thumbnail panel
            const thumbnailWidth = thumbnailCanvas.offsetWidth;
            const thumbnailHeight = thumbnailCanvas.offsetHeight;
            const scaleX = thumbnailWidth / boundsWidth;
            const scaleY = thumbnailHeight / boundsHeight;
            const scale = Math.min(scaleX, scaleY);

            // Draw thumbnail tables
            tables.forEach(function(table) {
                const thumbTable = document.createElement('div');
                thumbTable.className = 'thumbnail-table';
                thumbTable.style.left = ((table.x - canvasBounds.minX) * scale) + 'px';
                thumbTable.style.top = ((table.y - canvasBounds.minY) * scale) + 'px';
                thumbTable.style.width = (table.width * scale) + 'px';
                thumbTable.style.height = (table.height * scale) + 'px';
                thumbnailCanvas.appendChild(thumbTable);
            });

            // Update viewport indicator
            updateViewportIndicator(scale, canvasBounds, boundsWidth, boundsHeight);
        }

        // Update viewport indicator position and size
        function updateViewportIndicator(scale, canvasBounds, boundsWidth, boundsHeight) {
            if (!thumbnailVisible) return;

            // Get current viewport in canvas coordinates
            const viewX = (-panX / zoom);
            const viewY = (-panY / zoom);
            const viewWidth = (window.innerWidth / zoom);
            const viewHeight = (window.innerHeight / zoom);

            // Calculate indicator position in thumbnail
            const indicatorLeft = Math.max(0, (viewX - canvasBounds.minX) * scale);
            const indicatorTop = Math.max(0, (viewY - canvasBounds.minY) * scale);
            const indicatorWidth = Math.min(viewWidth * scale, (thumbnailCanvas.offsetWidth - indicatorLeft));
            const indicatorHeight = Math.min(viewHeight * scale, (thumbnailCanvas.offsetHeight - indicatorTop));

            viewportIndicator.style.left = indicatorLeft + 'px';
            viewportIndicator.style.top = indicatorTop + 'px';
            viewportIndicator.style.width = indicatorWidth + 'px';
            viewportIndicator.style.height = indicatorHeight + 'px';
        }

        // Drag viewport indicator to pan
        let isDraggingIndicator = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let dragStartPanX = 0;
        let dragStartPanY = 0;

        viewportIndicator.addEventListener('mousedown', function(e) {
            isDraggingIndicator = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            dragStartPanX = panX;
            dragStartPanY = panY;
            e.preventDefault();
            e.stopPropagation();
        });

        document.addEventListener('mousemove', function(e) {
            if (!isDraggingIndicator) return;

            const deltaX = e.clientX - dragStartX;
            const deltaY = e.clientY - dragStartY;

            // Calculate thumbnail bounds
            const canvasBounds = {
                minX: Infinity,
                minY: Infinity,
                maxX: -Infinity,
                maxY: -Infinity
            };

            tables.forEach(function(table) {
                canvasBounds.minX = Math.min(canvasBounds.minX, table.x);
                canvasBounds.minY = Math.min(canvasBounds.minY, table.y);
                canvasBounds.maxX = Math.max(canvasBounds.maxX, table.x + table.width);
                canvasBounds.maxY = Math.max(canvasBounds.maxY, table.y + table.height);
            });

            if (canvasBounds.minX === Infinity) {
                canvasBounds.minX = 0;
                canvasBounds.minY = 0;
                canvasBounds.maxX = 1000;
                canvasBounds.maxY = 1000;
            }

            const padding = 100;
            canvasBounds.minX -= padding;
            canvasBounds.minY -= padding;
            canvasBounds.maxX += padding;
            canvasBounds.maxY += padding;

            const boundsWidth = canvasBounds.maxX - canvasBounds.minX;
            const boundsHeight = canvasBounds.maxY - canvasBounds.minY;

            const thumbnailWidth = thumbnailCanvas.offsetWidth;
            const thumbnailHeight = thumbnailCanvas.offsetHeight;
            const scaleX = thumbnailWidth / boundsWidth;
            const scaleY = thumbnailHeight / boundsHeight;
            const scale = Math.min(scaleX, scaleY);

            // Convert thumbnail delta to canvas delta
            const canvasDeltaX = (deltaX / scale) * zoom;
            const canvasDeltaY = (deltaY / scale) * zoom;

            panX = dragStartPanX + canvasDeltaX;
            panY = dragStartPanY + canvasDeltaY;

            updateCanvasTransform();
            updateViewportIndicator(scale, canvasBounds, boundsWidth, boundsHeight);
        });

        document.addEventListener('mouseup', function() {
            if (isDraggingIndicator) {
                isDraggingIndicator = false;
            }
        });

        // Initialize
        function initializeErdWebview() {
            if (window.__erdWebviewInitialized) {
                console.log('[ERD Init] Initialization skipped: already initialized');
                return;
            }
            window.__erdWebviewInitialized = true;
            console.log('[ERD Init] Page loaded');
            document.body.classList.add('selection-mode');
            console.log('[ERD Init] Number of tables:', document.querySelectorAll('.table-node').length);
            console.log('[ERD Init] Number of vector shapes:', document.querySelectorAll('.vector-shape-node').length);
            document.querySelectorAll('.table-node').forEach(function(table) {
                initTableMenu(table);
            });

            drawRelationships();
            initCanvasPanning();
            initDraggable();
            initVectorShapeToolbar();
            initGlobalVectorShapeInteraction();
            console.log('[ERD Init] Initialization complete');
        }

        console.log('[ERD Init] Script loaded, readyState:', document.readyState);
        if (document.readyState === 'loading') {
            window.addEventListener('load', initializeErdWebview);
            document.addEventListener('DOMContentLoaded', initializeErdWebview);
        } else {
            initializeErdWebview();
        }

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
        console.log('[renderTableNode] Rendering table:', table.tableName, 'with dimensions:', table.width, 'x', table.height, 'at position:', table.x, ',', table.y);
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
                        <span class="column-name-text">${this.escapeHtml(col.name)}</span>
                        <div class="column-connector-left connection-point" data-table="${this.escapeHtml(table.tableName)}" data-column="${this.escapeHtml(col.name)}" title="${this.escapeHtml(col.name)} connector"></div>
                        <div class="column-connector-right connection-point" data-table="${this.escapeHtml(table.tableName)}" data-column="${this.escapeHtml(col.name)}" title="${this.escapeHtml(col.name)} connector"></div>
                    </span>
                    <span class="column-type">${this.escapeHtml(col.type)}</span>
                    ${comment}
                </div>
            `;
        }

        // Calculate max height for table body (subtract header height and padding)
        const headerHeight = 28; // Fixed header height from CSS
        const padding = 16; // 8px top + 8px bottom padding
        const maxBodyHeight = table.height - headerHeight - padding;

        const tableColorAttr = table.color ? ` data-color="${this.escapeHtml(table.color)}"` : '';
        const tableBackgroundAttr = table.backgroundColor ? ` data-background-color="${this.escapeHtml(table.backgroundColor)}"` : '';
        const tableBorderStyle = table.color ? ` border-color: ${table.color};` : '';
        const tableExtraStyle =
            (table.borderWidth !== undefined ? ` border-width: ${table.borderWidth}px;` : '') +
            (table.borderStyle ? ` border-style: ${table.borderStyle};` : '') +
            (table.backgroundColor ? ` background-color: ${table.backgroundColor};` : '') +
            (table.zIndex !== undefined ? ` z-index: ${table.zIndex};` : '') +
            (table.opacity !== undefined ? ` opacity: ${table.opacity};` : '');
        const headerStyle = table.color
            ? ` style="background: linear-gradient(135deg, ${table.color} 0%, ${ErdWebView.darkenHex(table.color)} 100%);"`
            : '';
        const bodyBackgroundStyle = table.backgroundColor ? ` background-color: ${table.backgroundColor};` : '';

        return `
            <div class="table-node ${isMainTable ? 'main-table' : ''}"
                  data-table="${this.escapeHtml(table.tableName)}"
                  data-database="${this.escapeHtml(table.database || '')}"${tableColorAttr}${tableBackgroundAttr}
                  style="left: ${table.x}px; top: ${table.y}px; width: ${table.width}px; height: ${table.height}px;${tableBorderStyle}${tableExtraStyle}">
                <div class="table-header"${headerStyle}>
                    <div class="table-header-center">
                        <span class="table-name">${this.escapeHtml(table.tableName)}</span>
                        ${table.comment ? `<span class="table-comment">${this.escapeHtml(table.comment)}</span>` : ''}
                    </div>
                    <div class="table-menu-wrapper">
                        <button type="button" class="table-menu-btn" title="更多选项" aria-label="更多选项">&#8942;</button>
                        <div class="table-dropdown">
                            <button type="button" class="table-dropdown-item table-menu-toggle-comments">隐藏注释</button>
                            <button type="button" class="table-dropdown-item table-menu-toggle-table-comment">隐藏表名注释</button>
                            <button type="button" class="table-dropdown-item table-menu-set-color">设置颜色</button>
                            <div class="table-color-panel"></div>
                        </div>
                    </div>
                </div>
                <div class="table-body" style="max-height: ${maxBodyHeight}px; overflow-y: auto;${bodyBackgroundStyle}">
                    ${columns}
                </div>
                <!-- Connection points on all four sides -->
                <div class="table-connector-top connection-point" data-table="${this.escapeHtml(table.tableName)}" title="${this.escapeHtml(table.tableName)} top"></div>
                <div class="table-connector-bottom connection-point" data-table="${this.escapeHtml(table.tableName)}" title="${this.escapeHtml(table.tableName)} bottom"></div>
                <div class="table-connector-left connection-point" data-table="${this.escapeHtml(table.tableName)}" title="${this.escapeHtml(table.tableName)} left"></div>
                <div class="table-connector-right connection-point" data-table="${this.escapeHtml(table.tableName)}" title="${this.escapeHtml(table.tableName)} right"></div>
                <!-- Vertical resize handle -->
                <div class="resize-handle-vertical"></div>
            </div>
        `;
    }

    private static hexByte(n: number): string {
        const s = n.toString(16);
        return s.length < 2 ? '0' + s : s;
    }

    private static darkenHex(hex: string, amount: number = 30): string {
        const h = hex.replace('#', '');
        if (h.length !== 6) {
            return hex;
        }
        const r = Math.max(0, parseInt(h.slice(0, 2), 16) - amount);
        const g = Math.max(0, parseInt(h.slice(2, 4), 16) - amount);
        const b = Math.max(0, parseInt(h.slice(4, 6), 16) - amount);
        return '#' + ErdWebView.hexByte(r) + ErdWebView.hexByte(g) + ErdWebView.hexByte(b);
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
