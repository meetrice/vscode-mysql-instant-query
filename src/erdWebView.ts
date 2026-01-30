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

            const tableData: TableData = {
                tableName: tableName,
                columns: columns,
                x: 100,
                y: 100,
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

                // Position related table to the right
                const x = 400 + ErdWebView.tableData.size * 240;
                const y = 100;

                ErdWebView.tableData.set(refTableKey, {
                    tableName: refTable,
                    columns: refColumns,
                    x: x,
                    y: y,
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
            font-style: italic;
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
            font-style: italic;
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
        }
        .relationship-arrow { fill: #007acc; }

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

            relationships.forEach(function(rel) {
                const fromTable = tables.find(function(t) { return t.tableName === rel.fromTable; });
                const toTable = tables.find(function(t) { return t.tableName === rel.toTable; });

                if (!fromTable || !toTable) return;

                const fromEl = document.querySelector('[data-table="' + rel.fromTable + '"]');
                const toEl = document.querySelector('[data-table="' + rel.toTable + '"]');

                if (!fromEl || !toEl) return;

                const fromRect = fromEl.getBoundingClientRect();
                const toRect = toEl.getBoundingClientRect();

                const fromX = fromRect.right;
                const fromY = fromRect.top + fromRect.height / 2;
                const toX = toRect.left;
                const toY = toRect.top + toRect.height / 2;

                const midX = (fromX + toX) / 2;
                const path = 'M ' + fromX + ' ' + fromY + ' C ' + midX + ' ' + fromY + ', ' + midX + ' ' + toY + ', ' + toX + ' ' + toY;

                const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                line.setAttribute('d', path);
                line.setAttribute('class', 'relationship-line');
                svg.appendChild(line);

                const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                const arrowSize = 8;
                const points = toX + ',' + toY + ' ' + (toX - arrowSize) + ',' + (toY - arrowSize/2) + ' ' + (toX - arrowSize) + ',' + (toY + arrowSize/2);
                arrow.setAttribute('points', points);
                arrow.setAttribute('class', 'relationship-arrow');
                svg.appendChild(arrow);
            });
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

            // Click outside to deselect
            document.addEventListener('click', function(e) {
                if (!e.target.closest('.table-node') && !e.target.closest('.zoom-controls')) {
                    if (selectedTable) {
                        selectedTable.classList.remove('selected');
                        selectedTable = null;
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
                <div class="table-header ${isMainTable ? '' : 'related'}">
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
