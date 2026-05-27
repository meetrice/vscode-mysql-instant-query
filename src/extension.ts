"use strict";
import * as vscode from "vscode";
import { AppInsightsClient } from "./common/appInsightsClient";
import { Utility } from "./common/utility";
import { ConnectionNode } from "./model/connectionNode";
import { DatabaseNode } from "./model/databaseNode";
import { INode } from "./model/INode";
import { TableNode } from "./model/tableNode";
import { ColumnNode } from "./model/columnNode";
import { MySQLTreeDataProvider, TableFilterState } from "./mysqlTreeDataProvider";
import { FilterInputPanel } from "./filterInputPanel";
import { CodeSnippetsPanel } from "./codeSnippetsPanel";
import { Global } from "./common/global";
import { I18n } from "./common/i18n";
import { SqlResultWebView } from "./sqlResultWebView";
import { RunNowCodeLensProvider } from "./runButtonProvider";
import { SqlStatementConnectionManager } from "./sqlStatementConnectionManager";
import { TableCompletionProvider } from "./tableCompletionProvider";
import { ErdWebView } from "./erdWebView";
import { Constants } from "./common/constants";
import { DbDriver } from "./common/dbDriver";
import { OutputChannel } from "./common/outputChannel";
import { SettingsWebView } from "./settingsWebView";
import { applySidebarViewTitles, registerSidebarTreeView } from "./sidebarViewTitles";
import { IConnection, normalizeDriver, normalizeSslMode } from "./model/connection";

export function activate(context: vscode.ExtensionContext) {
    // Initialize i18n
    I18n.init(context);
    I18n.onLocaleChange(applySidebarViewTitles);

    // Initialize custom settings from global state
    const storedLimit = context.globalState.get<number>(Constants.GlobalStateSettingsDataLimit);
    if (storedLimit) {
        Utility.customDataLimit = storedLimit;
    }
    const storedLanguage = context.globalState.get<string>(Constants.GlobalStateSettingsLanguage);
    if (storedLanguage) {
        I18n.setLocale(storedLanguage);
    }

    AppInsightsClient.sendEvent("loadExtension");

    const mysqlTreeDataProvider = new MySQLTreeDataProvider(context);

    Global.secrets = context.secrets;
    SqlStatementConnectionManager.initialize(context);

    // 启动时自动选中第一个连接的第一个用户数据库
    autoSelectFirstDatabase(context);

    // 注册 URI Handler，支持通过外部链接打开表并执行查询
    // 格式: cursor://meetrice.mysql-instant-query/<table>?db=xxx&prefix=xxx&limit=xxx
    context.subscriptions.push(vscode.window.registerUriHandler({
        handleUri(uri: vscode.Uri) {
            handleExternalUri(uri, context);
        }
    }));

    // Set context keys to help prevent other extensions' menus from showing
    vscode.commands.executeCommand('setContext', 'mysqlInstantQuery.sidebarActive', true);
    // Indicate this is not a file tree, which may prevent file sync extensions from showing menus
    vscode.commands.executeCommand('setContext', 'explorerResourceIsFolder', false);
    vscode.commands.executeCommand('setContext', 'explorerResourceIsRoot', false);
    // Additional context keys to prevent file sync/upload menus
    vscode.commands.executeCommand('setContext', 'explorerResourceIsFile', false);
    vscode.commands.executeCommand('setContext', 'filesExplorerFocus', false);
    vscode.commands.executeCommand('setContext', 'inFilesExplorer', false);
    // More context keys to block file sync extensions
    vscode.commands.executeCommand('setContext', 'resourceScheme', undefined);
    vscode.commands.executeCommand('setContext', 'resourcePath', undefined);
    vscode.commands.executeCommand('setContext', 'resourceExtname', undefined);
    vscode.commands.executeCommand('setContext', 'resourceLangId', undefined);

    // Initialize filter panel before tree view so it appears above the tree
    FilterInputPanel.initialize(context);

    // Register CodeLens provider for SQL editor
    const runNowCodeLensProvider = new RunNowCodeLensProvider();
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { language: 'sql', scheme: 'file' },
            runNowCodeLensProvider
        )
    );
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { language: 'sql', scheme: 'untitled' },
            runNowCodeLensProvider
        )
    );

    // Register completion provider for SQL editor (table name suggestions after FROM)
    const tableCompletionProvider = new TableCompletionProvider();
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'sql', scheme: 'file' },
            tableCompletionProvider,
        )
    );
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'sql', scheme: 'untitled' },
            tableCompletionProvider,
        )
    );

    // Track last clicked node and time for double-click detection
    let lastClickedNode: { node: INode, timestamp: number } | undefined = undefined;
    const DOUBLE_CLICK_THRESHOLD = 500; // milliseconds

    const treeView = vscode.window.createTreeView("mysqlInstantQuery", {
        treeDataProvider: mysqlTreeDataProvider
    });
    context.subscriptions.push(treeView);
    registerSidebarTreeView(treeView);
    CodeSnippetsPanel.initialize(context);

    // Make treeView accessible for collapse/expand functionality
    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.expandAll", async () => {
        const warningMessage = I18n.t("warning.collapseExpand");
        const continueLabel = I18n.t("button.continue");
        const cancelLabel = I18n.t("button.cancel");
        const confirm = await vscode.window.showWarningMessage(warningMessage, continueLabel, cancelLabel);
        if (confirm !== continueLabel) {
            return;
        }
        TableFilterState.instance.setAllExpanded(true);
        await vscode.commands.executeCommand('setContext', 'mysqlInstantQueryTreeAllExpanded', true);
        mysqlTreeDataProvider.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.collapseAll", async () => {
        const warningMessage = I18n.t("warning.collapseExpand");
        const continueLabel = I18n.t("button.continue");
        const cancelLabel = I18n.t("button.cancel");
        const confirm = await vscode.window.showWarningMessage(warningMessage, continueLabel, cancelLabel);
        if (confirm !== continueLabel) {
            return;
        }
        TableFilterState.instance.setAllExpanded(false);
        TableFilterState.instance.clearConnectionExpandState();
        TableFilterState.instance.clearDatabaseExpandState();
        TableFilterState.instance.clearTableExpandState();
        await vscode.commands.executeCommand('setContext', 'mysqlInstantQueryTreeAllExpanded', false);
        mysqlTreeDataProvider.refresh();
    }));

    treeView.onDidExpandElement((e) => {
        const node = e.element;
        if (node instanceof ConnectionNode) {
            TableFilterState.instance.setConnectionExpanded(node.getId(), true);
        } else if (node instanceof DatabaseNode) {
            TableFilterState.instance.setDatabaseExpanded(node.getExpandKey(), true);
        } else if (node instanceof TableNode) {
            TableFilterState.instance.setTableExpanded(node.getKey(), true);
        }
    });

    treeView.onDidCollapseElement((e) => {
        const node = e.element;
        if (node instanceof ConnectionNode) {
            TableFilterState.instance.setConnectionExpanded(node.getId(), false);
        } else if (node instanceof DatabaseNode) {
            TableFilterState.instance.setDatabaseExpanded(node.getExpandKey(), false);
        } else if (node instanceof TableNode) {
            TableFilterState.instance.setTableExpanded(node.getKey(), false);
        }
    });

    treeView.onDidChangeSelection(async (e) => {
        console.log('[DEBUG] onDidChangeSelection fired, selection length:', e.selection.length);
        if (e.selection.length === 1) {
            const node = e.selection[0];
            const now = Date.now();

            const treeItem = await node.getTreeItem();
            const contextValue = treeItem.contextValue || "";
            console.log('[DEBUG] node type:', contextValue, 'lastClickedNode:', lastClickedNode ? 'exists' : 'null');

            if (contextValue === "table" || contextValue === "pinnedTable") {
                const isDoubleClick = lastClickedNode &&
                    lastClickedNode.node === node &&
                    (now - lastClickedNode.timestamp) < DOUBLE_CLICK_THRESHOLD;

                console.log('[DEBUG] isDoubleClick:', isDoubleClick, 'timeDiff:', lastClickedNode ? now - lastClickedNode.timestamp : 'N/A');

                if (isDoubleClick) {
                    console.log('[DEBUG] EXECUTING SELECT (double-click)');
                    lastClickedNode = undefined;
                    vscode.commands.executeCommand("mysqlInstantQuery.selectTop1000", node);
                } else {
                    lastClickedNode = { node, timestamp: now };
                    setTimeout(() => {
                        if (lastClickedNode && lastClickedNode.node === node) {
                            console.log('[DEBUG] TIMEOUT: single-click detected, toggling expand');
                            const tableNode = lastClickedNode.node as TableNode;
                            const tableKey = tableNode.getKey();
                            const filterState = mysqlTreeDataProvider.getFilterState();
                            const isExpanded = filterState.toggleTableExpanded(tableKey);
                            treeView.reveal(tableNode, { expand: isExpanded });
                            mysqlTreeDataProvider.refresh(tableNode);
                        } else {
                            console.log('[DEBUG] TIMEOUT: lastClickedNode is null or node mismatch');
                        }
                    }, DOUBLE_CLICK_THRESHOLD);
                }
            }
        }
    });

    context.subscriptions.push(vscode.window.registerTreeDataProvider("mysqlInstantQuery", mysqlTreeDataProvider));

    // Refresh tree when filter changes
    mysqlTreeDataProvider.onFilterChanged(() => {
        mysqlTreeDataProvider.refresh();
    });

    // Filter commands (also available via command palette)
    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.setTableFilter", async () => {
        // Filter panel is always visible in sidebar
        vscode.commands.executeCommand('mysqlInstantQueryFilter.focus');
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.clearTableFilter", () => {
        TableFilterState.instance.clear();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.refresh", (node: INode) => {
        AppInsightsClient.sendEvent("refresh");
        mysqlTreeDataProvider.refresh(node);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.addConnection", () => {
        mysqlTreeDataProvider.addConnection();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.newQueryFromTree", () => {
        Utility.createSQLTextDocument("", false);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.editConnection", (connectionNode: ConnectionNode) => {
        mysqlTreeDataProvider.editConnection(connectionNode);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.deleteConnection", (connectionNode: ConnectionNode) => {
        connectionNode.deleteConnection(context, mysqlTreeDataProvider);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.editDisplayName", (connectionNode: ConnectionNode) => {
        connectionNode.editDisplayName(context, mysqlTreeDataProvider);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.runQuery", (sql?: string, updateSQLEditor: boolean = true, connectionOptions?: IConnection) => {
        if (connectionOptions) {
            Global.activeConnection = connectionOptions;
        }
        Utility.runQuery(sql, connectionOptions, undefined, updateSQLEditor);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.selectStatementConnection", async (documentUri: vscode.Uri, rangeData: number[], sql: string) => {
        await SqlStatementConnectionManager.pickStatementConnection(documentUri, rangeData, sql);
        runNowCodeLensProvider.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.newQuery", (databaseOrConnectionNode: DatabaseNode | ConnectionNode) => {
        databaseOrConnectionNode.newQuery();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.selectDatabase", (databaseNode: DatabaseNode) => {
        databaseNode.selectDatabase();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.selectTop1000", (tableNode: TableNode) => {
        tableNode.selectTop1000();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.copyTableName", (tableNode: TableNode) => {
        tableNode.copyTableName();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.showTableStructure", (tableNode: TableNode) => {
        tableNode.showTableStructure();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.pinTable", async (tableNode: TableNode) => {
        await tableNode.pin();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.unpinTable", async (tableNode: TableNode) => {
        await tableNode.unpin();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.countTable", async (tableNode: TableNode) => {
        await tableNode.countTable();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.addColumn", async (tableNode: TableNode) => {
        await tableNode.addColumn();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.openErd", async (tableNode: TableNode) => {
        // Use database from tableNode instead of connection.database
        const database = tableNode.getDatabase();
        if (!database) {
            vscode.window.showWarningMessage("Cannot determine database for ERD");
            return;
        }
        await ErdWebView.showTableErd(tableNode, database);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.saveErd", async () => {
        await ErdWebView.saveToFile();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.openErdFile", async () => {
        await ErdWebView.openFromFile();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.openSettings", () => {
        SettingsWebView.show(context);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.viewAsErd", async () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            vscode.window.showWarningMessage("No active editor");
            return;
        }

        const document = activeEditor.document;
        const uri = document.uri;

        // Check if it's a .merd file
        if (!uri.fsPath.endsWith('.merd')) {
            vscode.window.showWarningMessage("Please open a .merd file");
            return;
        }

        try {
            // Read the file content
            const fileData = await vscode.workspace.fs.readFile(uri);
            const json = Buffer.from(fileData).toString('utf-8');
            const merdData: any = JSON.parse(json);

            // Validate version
            if (!merdData.version || merdData.version !== "1.0") {
                vscode.window.showWarningMessage("Unsupported MERD file version");
                return;
            }

            // Clear existing data
            ErdWebView.clearInternalData();
            ErdWebView.relationships = [];

            // Load tables
            console.log('[viewAsErd] Loading', merdData.tables.length, 'tables from MERD file');
            merdData.tables.forEach((table: any) => {
                console.log('[viewAsErd] Loading table:', table.tableName, 'width:', table.width, 'position:', table.x, ',', table.y);
                ErdWebView.loadTable(table);
            });

            // Load relationships
            ErdWebView.loadRelationships(merdData.relationships || []);

            // Create or reuse panel and render
            await ErdWebView.renderPanel();

            // Use canvas data from file
            const canvasData = merdData.canvas || { width: 2000, height: 1500, zoom: 1, panX: 0, panY: 0 };
            await ErdWebView.updatePanelContent('', '', canvasData);

            vscode.window.showInformationMessage(`ERD visualized from ${uri.fsPath}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Error visualizing ERD: ${error}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.refreshResults", async () => {
        const queryInfo = SqlResultWebView.getLastQueryInfo();
        if (queryInfo && queryInfo.sql) {
            // Re-execute the query with updatePanel=true
            await Utility.runQueryWithTotal(queryInfo.sql, queryInfo.database, queryInfo.table, true);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.deleteSelectedRows", async (rowsJson: string) => {
        const queryInfo = SqlResultWebView.getLastQueryInfo();
        if (!queryInfo || !queryInfo.database || !queryInfo.table) {
            vscode.window.showWarningMessage("Cannot determine database or table for DELETE operation");
            return;
        }

        const rows = JSON.parse(rowsJson);
        if (!rows || rows.length === 0) {
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete ${rows.length} row(s)?`,
            { modal: true },
            "Yes", "No"
        );

        if (confirm !== "Yes") {
            return;
        }

        if (!Global.activeConnection) {
            vscode.window.showWarningMessage("No active MySQL connection");
            return;
        }

        const database = queryInfo.database;
        const table = queryInfo.table;

        const columns = Object.keys(rows[0]);
        const primaryKeyColumn = columns.find(col => col.toLowerCase() === 'id') || columns[0];

        const deleteStatements = [];
        for (const row of rows) {
            const value = row[primaryKeyColumn];
            let whereCondition = '';

            if (value === null || value === undefined) {
                whereCondition = `\`${primaryKeyColumn}\` IS NULL`;
            } else {
                const isNumeric = typeof value === 'number' || (typeof value === 'string' && !isNaN(Number(value)) && value !== '');
                if (isNumeric) {
                    whereCondition = `\`${primaryKeyColumn}\` = ${value}`;
                } else {
                    const escapedValue = String(value).replace(/'/g, "''");
                    whereCondition = `\`${primaryKeyColumn}\` = '${escapedValue}'`;
                }
            }

            const sql = `DELETE FROM \`${database}\`.\`${table}\` WHERE ${whereCondition}`;
            deleteStatements.push(sql);
        }

        const fullSql = deleteStatements.join(';\n') + ';';

        try {
            await Utility.queryPromise({ ...Global.activeConnection, multipleStatements: true }, fullSql);

            await Utility.appendSQLToEditor(fullSql);
            vscode.window.showInformationMessage(`Successfully deleted ${rows.length} row(s)`);

            // 直接重新查询并更新面板
            if (queryInfo.sql) {
                const refreshedRows = await Utility.queryPromise<any[]>(Global.activeConnection, queryInfo.sql);
                if (Array.isArray(refreshedRows)) {
                    SqlResultWebView.updatePanel(refreshedRows, queryInfo.sql, database, table);
                }
            }
        } catch (err) {
            vscode.window.showErrorMessage(`DELETE failed: ${err}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.generateUpdateSQL", async (message: any) => {
        console.log('[generateUpdateSQL] Called with message:', message);
        const queryInfo = SqlResultWebView.getLastQueryInfo();
        console.log('[generateUpdateSQL] Retrieved queryInfo:', queryInfo);

        if (!queryInfo) {
            console.error('[generateUpdateSQL] No queryInfo found');
            vscode.window.showWarningMessage("Cannot determine database or table for UPDATE operation (no query info)");
            return;
        }

        if (!queryInfo.database) {
            console.error('[generateUpdateSQL] No database in queryInfo:', queryInfo);
            vscode.window.showWarningMessage("Cannot determine database for UPDATE operation");
            return;
        }

        if (!queryInfo.table) {
            console.error('[generateUpdateSQL] No table in queryInfo:', queryInfo);
            vscode.window.showWarningMessage("Cannot determine table for UPDATE operation");
            return;
        }

        const { rowData, columnName, originalValue, newValue } = message;
        const database = queryInfo.database;
        const table = queryInfo.table;

        console.log('[generateUpdateSQL] Using database:', database, 'table:', table);

        // Find primary key column (usually 'id')
        const columns = Object.keys(rowData);
        const primaryKeyColumn = columns.find(col => col.toLowerCase() === 'id') || columns[0];

        // Build WHERE clause using primary key
        const pkValue = rowData[primaryKeyColumn];
        let whereCondition = '';
        if (pkValue === null || pkValue === undefined) {
            whereCondition = `\`${primaryKeyColumn}\` IS NULL`;
        } else {
            const isNumeric = typeof pkValue === 'number' || (typeof pkValue === 'string' && !isNaN(Number(pkValue)) && pkValue !== '');
            if (isNumeric) {
                whereCondition = `\`${primaryKeyColumn}\` = ${pkValue}`;
            } else {
                const escapedValue = String(pkValue).replace(/'/g, "''");
                whereCondition = `\`${primaryKeyColumn}\` = '${escapedValue}'`;
            }
        }

        // Build SET clause
        let setCondition = '';
        if (newValue === '' || newValue === 'NULL') {
            setCondition = `\`${columnName}\` = NULL`;
        } else {
            const isNumeric = !isNaN(Number(newValue)) && newValue !== '';
            if (isNumeric) {
                setCondition = `\`${columnName}\` = ${newValue}`;
            } else {
                const escapedValue = String(newValue).replace(/'/g, "''");
                setCondition = `\`${columnName}\` = '${escapedValue}'`;
            }
        }

        const sql = `UPDATE \`${database}\`.\`${table}\` SET ${setCondition} WHERE ${whereCondition};`;

        if (!Global.activeConnection) {
            vscode.window.showWarningMessage("No active MySQL connection");
            return;
        }

        try {
            await Utility.queryPromise(Global.activeConnection, sql);

            await Utility.appendSQLToEditor(sql);
            vscode.window.showInformationMessage("UPDATE executed successfully");

            // 刷新表格数据
            if (queryInfo.sql) {
                const refreshedRows = await Utility.queryPromise<any[]>(Global.activeConnection, queryInfo.sql);
                if (Array.isArray(refreshedRows)) {
                    SqlResultWebView.updatePanel(refreshedRows, queryInfo.sql, database, table);
                }
            }
        } catch (err) {
            vscode.window.showErrorMessage(`UPDATE failed: ${err}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.generateInsertSQL", async (message: any) => {
        console.log('[generateInsertSQL] Called with message:', JSON.stringify(message));

        const queryInfo = SqlResultWebView.getLastQueryInfo();
        console.log('[generateInsertSQL] Retrieved queryInfo:', queryInfo);

        if (!queryInfo) {
            console.error('[generateInsertSQL] No queryInfo found');
            vscode.window.showWarningMessage("Cannot determine database or table for INSERT operation (no query info)");
            return;
        }

        if (!queryInfo.database) {
            console.error('[generateInsertSQL] No database in queryInfo:', queryInfo);
            vscode.window.showWarningMessage("Cannot determine database for INSERT operation");
            return;
        }

        if (!queryInfo.table) {
            console.error('[generateInsertSQL] No table in queryInfo:', queryInfo);
            vscode.window.showWarningMessage("Cannot determine table for INSERT operation");
            return;
        }

        const { rowData, fields } = message;
        console.log('rowData:', JSON.stringify(rowData));
        console.log('fields:', JSON.stringify(fields));
        console.log('fields.length:', fields.length);

        const database = queryInfo.database;
        const table = queryInfo.table;

        // Filter out empty values and only include fields with values
        const fieldsWithValues: string[] = [];
        const values: string[] = [];

        for (const field of fields) {
            const value = rowData[field];
            console.log(`Processing field: ${field}, value: ${value}, typeof: ${typeof value}`);

            // Skip empty values
            if (value === undefined || value === null || value === '') {
                console.log(`Skipping field ${field} - empty value`);
                continue;
            }

            fieldsWithValues.push(`\`${field}\``);

            // Determine if value is numeric
            const isNumeric = !isNaN(Number(value)) && value !== '';
            if (isNumeric) {
                values.push(String(value));
            } else {
                // Escape single quotes for string values
                const escapedValue = String(value).replace(/'/g, "''");
                values.push(`'${escapedValue}'`);
            }
        }

        console.log('fieldsWithValues:', fieldsWithValues);
        console.log('fieldsWithValues.length:', fieldsWithValues.length);

        if (fieldsWithValues.length === 0) {
            vscode.window.showWarningMessage("No values to insert. Please fill in at least one field.");
            return;
        }

        // Generate INSERT SQL with only fields that have values (single line)
        const columns = fieldsWithValues.join(', ');
        const valuesStr = values.join(', ');
        const sql = `INSERT INTO \`${database}\`.\`${table}\` (${columns}) VALUES (${valuesStr});`;

        console.log('Generated SQL:', sql);

        // Create SQL document with the INSERT statement
        await Utility.createSQLTextDocument(sql);

        vscode.window.showInformationMessage("Generated INSERT statement in SQL editor");
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.viewTableStructureFromEditor", async () => {
        if (!vscode.window.activeTextEditor) {
            vscode.window.showWarningMessage(I18n.t("error.noActiveEditor"));
            return;
        }

        const activeTextEditor = vscode.window.activeTextEditor;
        const selection = activeTextEditor.selection;

        let selectedText: string;
        if (selection.isEmpty) {
            // If no selection, get current word
            const document = activeTextEditor.document;
            const wordRange = document.getWordRangeAtPosition(activeTextEditor.selection.active);
            if (wordRange) {
                selectedText = document.getText(wordRange);
            } else {
                vscode.window.showWarningMessage(I18n.t("warning.selectTableName"));
                return;
            }
        } else {
            selectedText = activeTextEditor.document.getText(selection);
        }

        // Trim the selected text
        selectedText = selectedText.trim();

        // Parse table name from selected text (could be "table" or "database.table")
        let tableName = selectedText;
        let databaseName = "";

        // Remove backticks if present
        tableName = tableName.replace(/`/g, "");

        // Check if contains dot (database.table format)
        const dotIndex = tableName.indexOf('.');
        if (dotIndex !== -1) {
            databaseName = tableName.substring(0, dotIndex);
            tableName = tableName.substring(dotIndex + 1);
        }

        // Check if we have an active connection
        if (!Global.activeConnection) {
            vscode.window.showWarningMessage(I18n.t("warning.noConnection"));
            return;
        }

        // If database name is not in selection, use the one from active connection
        if (!databaseName && Global.activeConnection.database) {
            databaseName = Global.activeConnection.database;
        }

        if (!databaseName) {
            vscode.window.showWarningMessage(I18n.t("warning.cannotDetermineDatabase"));
            return;
        }

        // Create a temporary TableNode and call showTableStructure
        const tempTableNode = new TableNode(
            Global.activeConnection.host,
            Global.activeConnection.user,
            Global.activeConnection.password,
            Global.activeConnection.port,
            databaseName,
            tableName,
            Global.activeConnection.certPath,
            false,
            undefined,
            false,
            Global.activeConnection.driver,
            Global.activeConnection.filePath,
            Global.activeConnection.sslMode,
        );

        await tempTableNode.showTableStructure();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.openTable", async () => {
        if (!Global.activeConnection) {
            vscode.window.showWarningMessage(I18n.t("warning.noDatabaseSelected"));
            return;
        }

        // 如果未选择数据库，自动获取第一个用户数据库
        if (!Global.activeConnection.database) {
            try {
                const connOptions = {
                    host: Global.activeConnection.host,
                    user: Global.activeConnection.user,
                    password: Global.activeConnection.password,
                    port: Global.activeConnection.port,
                    certPath: Global.activeConnection.certPath,
                    driver: Global.activeConnection.driver,
                    filePath: Global.activeConnection.filePath,
                    sslMode: Global.activeConnection.sslMode,
                };
                const databases = await DbDriver.listDatabases(connOptions);
                if (databases.length > 0) {
                    Global.activeConnection = {
                        ...Global.activeConnection,
                        database: databases[0],
                    };
                } else {
                    vscode.window.showWarningMessage(I18n.t("warning.noDatabaseSelected"));
                    return;
                }
            } catch (err) {
                vscode.window.showWarningMessage(I18n.t("warning.noDatabaseSelected"));
                return;
            }
        }

        const connectionOptions = {
            host: Global.activeConnection.host,
            user: Global.activeConnection.user,
            password: Global.activeConnection.password,
            port: Global.activeConnection.port,
            database: Global.activeConnection.database,
            certPath: Global.activeConnection.certPath,
            driver: Global.activeConnection.driver,
            filePath: Global.activeConnection.filePath,
            sslMode: Global.activeConnection.sslMode,
        };

        try {
            // Get all tables with comments from current database
            const tables = await Utility.queryPromise<any[]>(connectionOptions,
                `SELECT TABLE_NAME, TABLE_COMMENT
                 FROM information_schema.TABLES
                 WHERE TABLE_SCHEMA = '${Global.activeConnection.database}'
                 ORDER BY TABLE_NAME;`);

            if (!tables || tables.length === 0) {
                vscode.window.showInformationMessage(I18n.t("info.noTablesFound"));
                return;
            }

            // Create QuickPick items with table name and comment
            interface TableQuickPickItem extends vscode.QuickPickItem {
                tableName: string;
            }

            const items: TableQuickPickItem[] = tables.map((t: any) => {
                const comment = t.TABLE_COMMENT || '';
                const label = comment ? `${t.TABLE_NAME} - ${comment}` : t.TABLE_NAME;
                return {
                    label: label,
                    description: '',
                    tableName: t.TABLE_NAME
                };
            });

            // Create and show QuickPick
            const quickPick = vscode.window.createQuickPick();
            quickPick.placeholder = I18n.t("placeholder.filterTables");
            quickPick.items = items.slice(0, 10); // Initially show first 10
            quickPick.canSelectMany = false;

            // Store all items for filtering
            let allItems: TableQuickPickItem[] = items;

            quickPick.onDidChangeValue(async (value: string) => {
                if (!value) {
                    quickPick.items = allItems.slice(0, 10);
                    return;
                }

                // Filter tables by table name or comment (fuzzy search)
                const filterValue = value.toLowerCase();
                const filtered = allItems.filter((item) => {
                    const tableName = item.tableName.toLowerCase();
                    const label = item.label.toLowerCase();
                    return tableName.includes(filterValue) || label.includes(filterValue);
                });

                quickPick.items = filtered;
            });

            quickPick.onDidAccept(async () => {
                const selected = quickPick.selectedItems[0] as TableQuickPickItem;
                quickPick.hide();

                if (selected) {
                    const tempTableNode = new TableNode(
                        Global.activeConnection.host,
                        Global.activeConnection.user,
                        Global.activeConnection.password,
                        Global.activeConnection.port,
                        Global.activeConnection.database,
                        selected.tableName,
                        Global.activeConnection.certPath,
                        false,
                        undefined,
                        false,
                        Global.activeConnection.driver,
                        Global.activeConnection.filePath,
                        Global.activeConnection.sslMode,
                    );

                    await tempTableNode.showTableStructure();
                }
            });

            quickPick.onDidHide(() => {
                quickPick.dispose();
            });

            quickPick.show();

        } catch (err) {
            vscode.window.showErrorMessage(`Error: ${err}`);
        }
    }));

    // Column node commands
    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.selectColumn", async (columnNode: ColumnNode) => {
        if (columnNode) {
            await columnNode.selectColumn();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.selectFilter", async (columnNode: ColumnNode) => {
        if (columnNode) {
            await columnNode.selectFilter();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.copyColumnName", (columnNode: ColumnNode) => {
        if (columnNode) {
            const columnName = columnNode.getColumnName();
            vscode.env.clipboard.writeText(columnName);
            vscode.window.showInformationMessage(I18n.format("info.copied", [columnName]));
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.insertColumnName", async (columnNode: ColumnNode) => {
        if (columnNode) {
            const columnName = columnNode.getColumnName();
            if (!vscode.window.activeTextEditor) {
                vscode.window.showWarningMessage(I18n.t("warning.noActiveEditorToInsert"));
                return;
            }
            const editor = vscode.window.activeTextEditor;
            const position = editor.selection.active;
            await editor.edit(editBuilder => {
                editBuilder.insert(position, columnName);
            });
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.dropColumn", async (columnNode: ColumnNode) => {
        if (columnNode) {
            await columnNode.dropColumn();
        }
    }));

    // Table node commands - Drop Table
    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.dropTable", async (tableNode: TableNode) => {
        if (!tableNode) {
            return;
        }

        const tableName = tableNode.table;
        const databaseName = tableNode.getDatabase();

        const confirm = await vscode.window.showWarningMessage(
            I18n.format("confirmation.dropTable", [databaseName, tableName]),
            I18n.t("button.yes"),
            I18n.t("button.no")
        );

        if (confirm !== I18n.t("button.yes")) {
            return;
        }

        try {
            await Utility.queryPromise({
                host: tableNode.getHost(),
                user: tableNode.getUser(),
                password: tableNode.getPassword(),
                port: tableNode.getPort(),
                database: databaseName,
                certPath: tableNode.getCertPath(),
            }, `DROP TABLE \`${databaseName}\`.\`${tableName}\`;`);
            vscode.window.showInformationMessage(I18n.format("info.tableDropped", [tableName]));
            mysqlTreeDataProvider.refresh();
        } catch (err) {
            vscode.window.showErrorMessage(I18n.format("error.errorDroppingTable", [err]));
        }
    }));

    // Helper function to pad string with zeros
    function padZero(num: number): string {
        return num < 10 ? "0" + num : String(num);
    }

    // Table node commands - Backup Table
    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.backupTable", async (tableNode: TableNode) => {
        if (!tableNode) {
            return;
        }

        const tableName = tableNode.table;
        const databaseName = tableNode.getDatabase();

        // Generate timestamp: YYYYMMDDHHmmss
        const now = new Date();
        const year = now.getFullYear();
        const month = padZero(now.getMonth() + 1);
        const day = padZero(now.getDate());
        const hours = padZero(now.getHours());
        const minutes = padZero(now.getMinutes());
        const seconds = padZero(now.getSeconds());
        const timestamp = `${year}${month}${day}${hours}${minutes}${seconds}`;

        const backupTableName = `${tableName}_${timestamp}`;

        const connectionOptions = {
            host: tableNode.getHost(),
            user: tableNode.getUser(),
            password: tableNode.getPassword(),
            port: tableNode.getPort(),
            database: databaseName,
            certPath: tableNode.getCertPath(),
        };

        try {
            // Create backup table structure
            await Utility.queryPromise(connectionOptions, `CREATE TABLE \`${databaseName}\`.\`${backupTableName}\` LIKE \`${databaseName}\`.\`${tableName}\`;`);

            await Utility.queryPromise(connectionOptions, `INSERT INTO \`${databaseName}\`.\`${backupTableName}\` SELECT * FROM \`${databaseName}\`.\`${tableName}\`;`);

            vscode.window.showInformationMessage(I18n.format("info.tableBackedUp", [backupTableName]));
            mysqlTreeDataProvider.refresh();
        } catch (err) {
            vscode.window.showErrorMessage(I18n.format("error.errorBackingUpTable", [err]));
        }
    }));
}

export function deactivate() {
    // Clear context keys when extension deactivates
    vscode.commands.executeCommand('setContext', 'mysqlInstantQuery.sidebarActive', undefined);
    vscode.commands.executeCommand('setContext', 'explorerResourceIsFolder', undefined);
    vscode.commands.executeCommand('setContext', 'explorerResourceIsRoot', undefined);
    vscode.commands.executeCommand('setContext', 'explorerResourceIsFile', undefined);
    vscode.commands.executeCommand('setContext', 'filesExplorerFocus', undefined);
    vscode.commands.executeCommand('setContext', 'inFilesExplorer', undefined);
    vscode.commands.executeCommand('setContext', 'resourceScheme', undefined);
    vscode.commands.executeCommand('setContext', 'resourcePath', undefined);
    vscode.commands.executeCommand('setContext', 'resourceExtname', undefined);
    vscode.commands.executeCommand('setContext', 'resourceLangId', undefined);
}

/**
 * 启动时自动选中第一个连接的第一个用户数据库，
 * 无需等待用户点击侧边栏面板激活。
 */
async function autoSelectFirstDatabase(context: vscode.ExtensionContext) {
    try {
        const connections = context.globalState.get<{ [key: string]: IConnection }>(Constants.GlobalStateMySQLConectionsKey);
        if (!connections) {
            return;
        }

        const ids = Object.keys(connections);
        if (ids.length === 0) {
            return;
        }

        const firstId = ids[0];
        const firstConn = connections[firstId];
        const password = await Global.secrets.get(firstId);

        const driver = normalizeDriver(firstConn.driver);
        const connOptions: IConnection = {
            driver,
            host: firstConn.host,
            user: firstConn.user,
            password,
            port: firstConn.port,
            certPath: firstConn.certPath,
            filePath: firstConn.filePath,
            sslMode: driver === "postgresql" ? normalizeSslMode(firstConn.sslMode) : undefined,
        };

        const databases = await DbDriver.listDatabases(connOptions);

        if (databases.length > 0) {
            Global.activeConnection = {
                driver,
                host: firstConn.host,
                user: firstConn.user,
                password,
                port: firstConn.port,
                certPath: firstConn.certPath,
                filePath: firstConn.filePath,
                sslMode: driver === "postgresql" ? normalizeSslMode(firstConn.sslMode) : undefined,
                database: databases[0],
            };
        } else {
            Global.activeConnection = {
                driver,
                host: firstConn.host,
                user: firstConn.user,
                password,
                port: firstConn.port,
                certPath: firstConn.certPath,
                filePath: firstConn.filePath,
                sslMode: driver === "postgresql" ? normalizeSslMode(firstConn.sslMode) : undefined,
            };
        }
    } catch {
        // 启动时静默失败，不影响正常使用（可能数据库未启动等）
    }
}

/**
 * 处理外部 URI 请求，通过链接直接打开表并执行 SELECT 查询。
 *
 * URI 格式: cursor://meetrice.mysql-instant-query/<tableName>
 * 可选参数:
 *   - db: 指定数据库名（默认使用当前活动连接的数据库）
 *   - prefix: 表名前缀（覆盖配置中的 uriTablePrefix）
 *   - limit: 查询行数限制（覆盖配置中的 uriDefaultLimit）
 *   - sql: 自定义完整 SQL（忽略 tableName 和其他参数）
 *
 * 示例:
 *   cursor://meetrice.mysql-instant-query/mediamonitoring
 *     → 当配置 uriTablePrefix = "fa_uran_" 时执行:
 *       SELECT * FROM fa_uran_mediamonitoring LIMIT 100
 *
 *   cursor://meetrice.mysql-instant-query/users?db=mydb&limit=50
 *     → SELECT * FROM mydb.users LIMIT 50
 */
async function handleExternalUri(uri: vscode.Uri, context: vscode.ExtensionContext) {
    AppInsightsClient.sendEvent("uriHandler.open");
    OutputChannel.appendLine("[URI] handleExternalUri called");
    OutputChannel.appendLine("[URI] uri.path = " + uri.path);
    OutputChannel.appendLine("[URI] uri.query = " + uri.query);
    OutputChannel.appendLine("[URI] Global.activeConnection = " + (Global.activeConnection ? "exists" : "null"));

    const config = Utility.getConfiguration();
    const queryParams = parseQueryString(uri.query);
    OutputChannel.appendLine("[URI] queryParams = " + JSON.stringify(queryParams));

    // 支持自定义 SQL 直接执行
    const customSql = queryParams['sql'];
    if (customSql) {
        OutputChannel.appendLine("[URI] Using custom SQL: " + customSql);
        await ensureActiveConnection(context);
        if (!Global.activeConnection) {
            OutputChannel.appendLine("[URI] No active connection, aborting");
            vscode.window.showWarningMessage("没有可用的 MySQL 连接，请先添加连接");
            return;
        }
        OutputChannel.appendLine("[URI] Running custom SQL...");
        await Utility.runQueryWithTotal(customSql, undefined, undefined, false, false);
        OutputChannel.appendLine("[URI] Custom SQL completed");
        return;
    }

    // 从 URI path 中提取表名（去掉前导 /）
    const pathSegment = uri.path.replace(/^\/+/, '').trim();
    OutputChannel.appendLine("[URI] pathSegment = " + pathSegment);
    if (!pathSegment) {
        OutputChannel.appendLine("[URI] No table name in path");
        vscode.window.showWarningMessage("URI 中未指定表名");
        return;
    }

    // 确保有活动连接
    OutputChannel.appendLine("[URI] Calling ensureActiveConnection...");
    await ensureActiveConnection(context);
    OutputChannel.appendLine("[URI] After ensureActiveConnection, Global.activeConnection = " + (Global.activeConnection ? "exists" : "null"));

    if (!Global.activeConnection) {
        OutputChannel.appendLine("[URI] Still no active connection, aborting");
        vscode.window.showWarningMessage("没有可用的 MySQL 连接，请先添加连接");
        return;
    }

    // 解析参数
    const prefix = queryParams['prefix'] || config.get<string>("uriTablePrefix", "");
    const limit = parseInt(queryParams['limit'] || String(config.get<number>("uriDefaultLimit", 100)), 10);
    const dbParam = queryParams['db'];

    const fullTableName = prefix + pathSegment;
    const database = dbParam || Global.activeConnection.database;

    OutputChannel.appendLine("[URI] fullTableName = " + fullTableName);
    OutputChannel.appendLine("[URI] database = " + database);

    if (!database) {
        OutputChannel.appendLine("[URI] No database specified");
        vscode.window.showWarningMessage("未指定数据库，请通过 ?db= 参数指定或先选择一个数据库");
        return;
    }

    const sql = `SELECT * FROM \`${database}\`.\`${fullTableName}\` LIMIT ${limit}`;
    OutputChannel.appendLine("[URI] Executing SQL: " + sql);

    await Utility.runQueryWithTotal(sql, database, fullTableName, false, false);
    OutputChannel.appendLine("[URI] runQueryWithTotal completed");
}

function parseQueryString(queryString: string): { [key: string]: string } {
    const params: { [key: string]: string } = {};
    if (!queryString) {
        return params;
    }
    queryString.split('&').forEach(pair => {
        const [key, ...rest] = pair.split('=');
        if (key) {
            params[decodeURIComponent(key)] = decodeURIComponent(rest.join('=') || '');
        }
    });
    return params;
}

/**
 * 确保存在活动连接，若没有则尝试自动选中第一个连接。
 * 等待最多 2 秒让 autoSelectFirstDatabase 完成。
 */
async function ensureActiveConnection(context: vscode.ExtensionContext) {
    if (Global.activeConnection) {
        return;
    }
    // 尝试触发自动选择
    await autoSelectFirstDatabase(context);

    // 再等待一小段时间
    let retries = 10;
    while (!Global.activeConnection && retries > 0) {
        await new Promise(r => setTimeout(r, 200));
        retries--;
    }
}
