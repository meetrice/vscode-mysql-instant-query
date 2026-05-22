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
    private static currentPanel: vscode.WebviewPanel | null = null;

    // Helper methods for external access
    public static clearInternalData() {
        ErdWebView.tableData.clear();
        ErdWebView.relationships = [];
        ErdWebView.comments = [];
    }

    public static loadTable(table: TableData) {
        ErdWebView.tableData.set(`${table.database || ''}.${table.tableName}`, table);
    }

    public static loadRelationships(relationships: Relationship[]) {
        ErdWebView.relationships = relationships;
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
                case 'save':
                       if (message.relationships) {
                           ErdWebView.relationships = message.relationships;
                       }
                       if (message.tables) {
                           message.tables.forEach((webviewTable: any) => {
                               let foundTable = null;
                               ErdWebView.tableData.forEach((table, key) => {
                                   if (table.tableName === webviewTable.tableName) {
                                       foundTable = table;
                                   }
                               });
   
                               if (foundTable) {
                                   foundTable.width = webviewTable.width;
                                   foundTable.height = webviewTable.height;
                                   foundTable.x = webviewTable.x;
                                   foundTable.y = webviewTable.y;
                               }
                           });
                       }
                       if (message.comments) {
                           ErdWebView.comments = message.comments;
                       }
                       await ErdWebView.saveToFile();
                       break;
                case 'open':
                    await ErdWebView.openFromFile();
                    break;
                case 'exportImage':
                    await ErdWebView.exportImage(message.format, message.data, message.width, message.height);
                    break;
            }
        }, undefined);
    }

    public static async clearCanvas() {
        // Clear existing data
        ErdWebView.tableData.clear();
        ErdWebView.relationships = [];
        ErdWebView.comments = [];

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

            // Handle messages from webview
            panel.webview.onDidReceiveMessage(async (message) => {
                switch (message.command) {
                    case 'selectTable100': {
                            const tableName = message.tableName;
                            const database = message.database;
                            if (tableName && database) {
                                const sql = `SELECT * FROM \`${database}\`.\`${tableName}\` LIMIT 100;`;
                                // 追加SQL到现有的SQL编辑器
                                await Utility.appendSQLToEditor(sql);
                            }
                        break;
                    }
                    case 'save':
                        // Update relationships from current webview state
                        if (message.relationships) {
                            ErdWebView.relationships = message.relationships;
                        }
                        // Update table dimensions from webview
                        if (message.tables) {
                            message.tables.forEach((webviewTable: any) => {
                                // Find the table by iterating through the Map
                                let foundTable = null;
                                let foundKey = null;

                                ErdWebView.tableData.forEach((table, key) => {
                                    if (table.tableName === webviewTable.tableName) {
                                        foundTable = table;
                                        foundKey = key;
                                    }
                                });

                                if (foundTable) {
                                    console.log('[Save Handler] Updating table:', webviewTable.tableName,
                                                'old width:', foundTable.width, 'new width:', webviewTable.width,
                                                'old height:', foundTable.height, 'new height:', webviewTable.height,
                                                'old pos:', foundTable.x, ',', foundTable.y,
                                                'new pos:', webviewTable.x, ',', webviewTable.y);
                                    foundTable.width = webviewTable.width;
                                    foundTable.height = webviewTable.height;
                                    foundTable.x = webviewTable.x;
                                    foundTable.y = webviewTable.y;
                                } else {
                                    console.log('[Save Handler] Table not found:', webviewTable.tableName);
                                }
                            });
                        }
                        await ErdWebView.saveToFile();
                        break;
                    case 'open':
                        await ErdWebView.openFromFile();
                        break;
                    case 'exportImage':
                        await ErdWebView.exportImage(message.format, message.data, message.width, message.height);
                        break;
                }
            }, undefined);

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
                        case 'newErd':
                            await ErdWebView.clearCanvas();
                            break;
                        case 'selectTable100': {
                            const tableName = message.tableName;
                            const database = message.database;
                            if (tableName && database) {
                                const sql = `SELECT * FROM \`${database}\`.\`${tableName}\` LIMIT 100;`;
                                // 追加SQL到现有的SQL编辑器
                                await Utility.appendSQLToEditor(sql);
                            }
                            break;
                        }
                        case 'save':
                            // Update relationships from current webview state
                            if (message.relationships) {
                                ErdWebView.relationships = message.relationships;
                            }
                            // Update table dimensions from webview
                            if (message.tables) {
                                message.tables.forEach((webviewTable: any) => {
                                    // Find the table by iterating through the Map
                                    let foundTable = null;
                                    let foundKey = null;

                                    ErdWebView.tableData.forEach((table, key) => {
                                        if (table.tableName === webviewTable.tableName) {
                                            foundTable = table;
                                            foundKey = key;
                                        }
                                    });

                                    if (foundTable) {
                                        console.log('[Save Handler] Updating table:', webviewTable.tableName,
                                                    'old width:', foundTable.width, 'new width:', webviewTable.width,
                                                    'old height:', foundTable.height, 'new height:', webviewTable.height,
                                                    'old pos:', foundTable.x, ',', foundTable.y,
                                                    'new pos:', webviewTable.x, ',', webviewTable.y);
                                        foundTable.width = webviewTable.width;
                                        foundTable.height = webviewTable.height;
                                        foundTable.x = webviewTable.x;
                                        foundTable.y = webviewTable.y;
                                    } else {
                                        console.log('[Save Handler] Table not found:', webviewTable.tableName);
                                    }
                                });
                            }
                            // Update comments from webview
                            if (message.comments) {
                                ErdWebView.comments = message.comments;
                            }
                            await ErdWebView.saveToFile();
                            break;
                        case 'open':
                            await ErdWebView.openFromFile();
                            break;
                        case 'exportImage':
                            await ErdWebView.exportImage(message.format, message.data, message.width, message.height);
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
        if (ErdWebView.tableData.size === 0 && ErdWebView.comments.length === 0) {
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
                comments: ErdWebView.comments
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
                        case 'newErd':
                            await ErdWebView.clearCanvas();
                            break;
                        case 'selectTable100': {
                            const tableName = message.tableName;
                            const database = message.database;
                            if (tableName && database) {
                                const sql = `SELECT * FROM \`${database}\`.\`${tableName}\` LIMIT 100;`;
                                // 追加SQL到现有的SQL编辑器
                                await Utility.appendSQLToEditor(sql);
                            }
                            break;
                        }
                        case 'save':
                           // Update relationships from current webview state
                           if (message.relationships) {
                               ErdWebView.relationships = message.relationships;
                           }
                           // Update table dimensions from webview
                           if (message.tables) {
                               message.tables.forEach((webviewTable: any) => {
                                   // Find the table by iterating through the Map
                                   let foundTable = null;

                                   ErdWebView.tableData.forEach((table, key) => {
                                       if (table.tableName === webviewTable.tableName) {
                                           foundTable = table;
                                       }
                                   });

                                   if (foundTable) {
                                       console.log('[Save from open file] Updating table:', webviewTable.tableName,
                                                   'old width:', foundTable.width, 'new width:', webviewTable.width,
                                                   'old height:', foundTable.height, 'new height:', webviewTable.height,
                                                   'old pos:', foundTable.x, ',', foundTable.y,
                                                   'new pos:', webviewTable.x, ',', webviewTable.y);
                                       foundTable.width = webviewTable.width;
                                       foundTable.height = webviewTable.height;
                                       foundTable.x = webviewTable.x;
                                       foundTable.y = webviewTable.y;
                                   } else {
                                       console.log('[Save from open file] Table not found:', webviewTable.tableName);
                                   }
                               });
                           }
                           // Update comments from webview
                           if (message.comments) {
                               ErdWebView.comments = message.comments;
                           }
                           await ErdWebView.saveToFile();
                           break;
                        case 'open':
                            await ErdWebView.openFromFile();
                            break;
                        case 'exportImage':
                            await ErdWebView.exportImage(message.format, message.data, message.width, message.height);
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
            background: transparent;
            border: none;
            border-radius: 4px;
            padding: 2px 8px;
            font-size: 12px;
            cursor: pointer;
            transition: background 0.2s;
        }
        .toggle-comments-btn:hover {
            background: rgba(255, 255, 255, 0.1);
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
            box-shadow: 0 0 0 3px rgba(255, 193, 7, 0.3);
        }
        .comment-node.selected {
            box-shadow: 0 0 0 3px rgba(255, 193, 7, 0.5);
            border-color: #ffb300;
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
        <button class="toolbar-btn" id="addCommentBtn" title="添加注释">
            <svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/><path d="M7 11h10"/><path d="M7 15h6"/><path d="M7 7h8"/></svg>
            <span>注释</span>
        </button>
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
        const tables = ${JSON.stringify(tables)};
        const relationships = ${JSON.stringify(relationships)};
        let comments = ${JSON.stringify(ErdWebView.comments)};

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

            document.querySelectorAll('.table-node, .comment-node').forEach(function(el) {
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
                    if (thumbnailVisible) {
                        updateThumbnail();
                    }
                }
            });

            document.addEventListener('mouseup', function() {
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
   
                       tablesData.push({
                           tableName: tableName,
                           x: x,
                           y: y,
                           width: actualWidth,
                           height: actualHeight
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

            console.log('[Save Button] Sending data to extension:', tablesData, commentsData);

            vscode.postMessage({
                command: 'save',
                relationships: relationships,
                tables: tablesData,
                comments: commentsData
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

            document.querySelectorAll('.table-node, .comment-node').forEach(function(el) {
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
            const headerHeight = headerEl ? headerEl.offsetHeight : 40;
            const isMainTable = el.classList.contains('main-table');
            const headerColor = isMainTable ? '#007acc' : '#4caf50';
            const tableBg = getComputedStyle(document.body).backgroundColor || '#1e1e1e';
            const textColor = getComputedStyle(document.body).color || '#cccccc';
            const mutedColor = '#999999';
            const borderColor = '#555555';
            const fontFamily = '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif';
            const tableName = el.getAttribute('data-table') || '';

            const nameEl = el.querySelector('.table-header-left > span');
            const tableTitle = nameEl ? nameEl.textContent.trim() : tableName;
            const tableCommentEl = el.querySelector('.table-comment');
            let tableComment = tableCommentEl ? tableCommentEl.textContent.trim() : '';
            if (!tableComment) {
                const tableData = tables.find(function(t) { return t.tableName === tableName; });
                tableComment = tableData && tableData.comment ? tableData.comment : '';
            }

            let svg = '<g>';
            svg += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="8" fill="' + escapeXml(tableBg) + '" stroke="' + borderColor + '" stroke-width="2"/>';
            svg += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + headerHeight + '" rx="8" fill="' + headerColor + '"/>';
            svg += '<rect x="' + x + '" y="' + (y + headerHeight - 8) + '" width="' + w + '" height="8" fill="' + headerColor + '"/>';
            const headerMidY = y + headerHeight / 2 + 5;
            svg += '<text x="' + (x + 12) + '" y="' + headerMidY + '" fill="white" font-size="14" font-weight="600" font-family="' + fontFamily + '">' + escapeXml(tableTitle) + '</text>';
            if (tableComment) {
                svg += '<text x="' + (x + w - 12) + '" y="' + headerMidY + '" fill="rgba(255,255,255,0.85)" font-size="11" text-anchor="end" font-family="' + fontFamily + '">' + escapeXml(tableComment) + '</text>';
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

            document.querySelectorAll('.table-node').forEach(function(table) {
                // Handle horizontal resize
                const resizeHandle = document.createElement('div');
                resizeHandle.className = 'resize-handle';
                table.appendChild(resizeHandle);

                resizeHandle.addEventListener('mousedown', function(e) {
                    e.stopPropagation();
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
                    isResizing = true;
                    isResizingVertical = true;
                    resizeElement = table;
                    startY = e.clientY;
                    startHeight = table.offsetHeight;
                    resizeHandleVertical.classList.add('dragging');
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

                    // Store reference to the table for actions
                    contextMenu.dataset.tableName = table.dataset.table;
                    contextMenu.dataset.database = table.dataset.database;
                });

                table.addEventListener('mousedown', function(e) {
                    if (e.target.classList.contains('toggle-comments-btn')) return;
                    if (e.target.classList.contains('resize-handle')) return;
                    if (e.target.classList.contains('connection-point')) return;
                    
                    // 只有在点击 table-header 时才允许拖动
                    const isHeaderClick = e.target.closest('.table-header');
                    if (!isHeaderClick) return;

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
                    } else {
                        const handle = resizeElement?.querySelector('.resize-handle');
                        if (handle) handle.classList.remove('dragging');
                    }
                    if (resizeElement) resizeElement.style.zIndex = '';
                    isResizing = false;
                    isResizingVertical = false;
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
                // Hide export menu
                if (!e.target.closest('.toolbar-menu-wrapper')) {
                    exportMenu.classList.remove('show');
                }
                // Hide relationship context menu
                if (!e.target.closest('.relationship-context-menu') && !e.target.closest('.relationship-line') && !e.target.closest('.relationship-hit-area')) {
                    document.getElementById('relationshipContextMenu').style.display = 'none';
                }

                if (!e.target.closest('.table-node') && !e.target.closest('.zoom-controls')) {
                    if (selectedTable) {
                        selectedTable.classList.remove('selected');
                        selectedTable = null;
                    }
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

                // Hide context menu
                contextMenu.style.display = 'none';
            });

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
        const headerHeight = 40; // Fixed header height from CSS
        const padding = 16; // 8px top + 8px bottom padding
        const maxBodyHeight = table.height - headerHeight - padding;

        return `
            <div class="table-node ${isMainTable ? 'main-table' : ''}"
                 data-table="${this.escapeHtml(table.tableName)}"
                 data-database="${this.escapeHtml(table.database || '')}"
                 style="left: ${table.x}px; top: ${table.y}px; width: ${table.width}px; height: ${table.height}px;">
                <div class="table-header">
                    <div class="table-header-left">
                        <span>${this.escapeHtml(table.tableName)}</span>
                        ${table.comment ? `<span class="table-comment">${this.escapeHtml(table.comment)}</span>` : ''}
                        ${isMainTable ? '<span>⭐</span>' : ''}
                    </div>
                    <button class="toggle-comments-btn" title="Toggle comments">📝</button>
                </div>
                <div class="table-body" style="max-height: ${maxBodyHeight}px; overflow-y: auto;">
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
