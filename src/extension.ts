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
import { Global } from "./common/global";
import { I18n } from "./common/i18n";
import { SqlResultWebView } from "./sqlResultWebView";
import { RunNowCodeLensProvider } from "./runButtonProvider";
import { ErdWebView } from "./erdWebView";

export function activate(context: vscode.ExtensionContext) {
    // Initialize i18n
    I18n.init(context);

    AppInsightsClient.sendEvent("loadExtension");

    const mysqlTreeDataProvider = new MySQLTreeDataProvider(context);

    Global.secrets = context.secrets;

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

    // Initialize filter input panel FIRST (before tree view) so it appears above
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

    // Track last clicked node and time for double-click detection
    let lastClickedNode: { node: INode, timestamp: number } | undefined = undefined;
    const DOUBLE_CLICK_THRESHOLD = 500; // milliseconds

    const treeView = vscode.window.createTreeView("mysqlInstantQuery", {
        treeDataProvider: mysqlTreeDataProvider
    });
    context.subscriptions.push(treeView);

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
        // Force refresh by triggering tree data change event
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
        await vscode.commands.executeCommand('setContext', 'mysqlInstantQueryTreeAllExpanded', false);
        // Force refresh by triggering tree data change event
        mysqlTreeDataProvider.refresh();
    }));

    treeView.onDidChangeSelection(async (e) => {
        if (e.selection.length === 1) {
            const node = e.selection[0];
            const now = Date.now();

            // Check node type using contextValue instead of instanceof for better compatibility
            const treeItem = await node.getTreeItem();
            const contextValue = treeItem.contextValue || "";

            // Handle TableNode double-click
            if (contextValue === "table" || contextValue === "pinnedTable") {
                const isDoubleClick = lastClickedNode &&
                    lastClickedNode.node === node &&
                    (now - lastClickedNode.timestamp) < DOUBLE_CLICK_THRESHOLD;

                if (isDoubleClick) {
                    // Double click: execute Select Top 100
                    await vscode.commands.executeCommand("mysqlInstantQuery.selectTop1000", node);
                    lastClickedNode = undefined;
                } else {
                    // Single click: just track it
                    lastClickedNode = { node, timestamp: now };
                    setTimeout(() => {
                        if (lastClickedNode && (Date.now() - lastClickedNode.timestamp) >= DOUBLE_CLICK_THRESHOLD) {
                            lastClickedNode = undefined;
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

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.deleteConnection", (connectionNode: ConnectionNode) => {
        connectionNode.deleteConnection(context, mysqlTreeDataProvider);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.editDisplayName", (connectionNode: ConnectionNode) => {
        connectionNode.editDisplayName(context, mysqlTreeDataProvider);
    }));

    context.subscriptions.push(vscode.commands.registerCommand("mysqlInstantQuery.runQuery", (sql?: string, updateSQLEditor: boolean = true) => {
        Utility.runQuery(sql, undefined, undefined, updateSQLEditor);
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
        const connection = Global.activeConnection;
        if (!connection) {
            vscode.window.showWarningMessage("No active connection");
            return;
        }
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

        // Show confirmation dialog
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete ${rows.length} row(s)?`,
            { modal: true },
            "Yes", "No"
        );

        if (confirm !== "Yes") {
            return;
        }

        // Generate DELETE statements for each row
        const database = queryInfo.database;
        const table = queryInfo.table;

        // Find primary key column (usually 'id')
        const columns = Object.keys(rows[0]);
        const primaryKeyColumn = columns.find(col => col.toLowerCase() === 'id') || columns[0];

        // Build WHERE clauses for each row using only primary key
        const deleteStatements = [];
        for (const row of rows) {
            const value = row[primaryKeyColumn];
            let whereCondition = '';

            if (value === null || value === undefined) {
                whereCondition = `\`${primaryKeyColumn}\` IS NULL`;
            } else {
                // Check if the value looks like a number
                const isNumeric = typeof value === 'number' || (typeof value === 'string' && !isNaN(Number(value)) && value !== '');
                if (isNumeric) {
                    whereCondition = `\`${primaryKeyColumn}\` = ${value}`;
                } else {
                    // Escape single quotes for string values
                    const escapedValue = String(value).replace(/'/g, "''");
                    whereCondition = `\`${primaryKeyColumn}\` = '${escapedValue}'`;
                }
            }

            const sql = `DELETE FROM \`${database}\`.\`${table}\` WHERE ${whereCondition};`;
            deleteStatements.push(sql);
        }

        // Create SQL document with all DELETE statements
        const fullSql = deleteStatements.join('\n\n');
        await Utility.createSQLTextDocument(fullSql);

        vscode.window.showInformationMessage(`Generated ${deleteStatements.length} DELETE statement(s) in SQL editor`);
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

        // Generate UPDATE SQL (single line)
        const sql = `UPDATE \`${database}\`.\`${table}\` SET ${setCondition} WHERE ${whereCondition};`;

        // Create SQL document with the UPDATE statement
        await Utility.createSQLTextDocument(sql);

        vscode.window.showInformationMessage("Generated UPDATE statement in SQL editor");
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
            Global.activeConnection.certPath
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
                const conn = Utility.createConnection({
                    host: Global.activeConnection.host,
                    user: Global.activeConnection.user,
                    password: Global.activeConnection.password,
                    port: Global.activeConnection.port,
                    certPath: Global.activeConnection.certPath,
                });
                const databases = await Utility.queryPromise<any[]>(conn, "SHOW DATABASES");
                const systemDatabases = ["information_schema", "mysql", "performance_schema", "sys"];
                const userDatabases = databases.filter((db: any) => !systemDatabases.includes(db.Database));
                if (userDatabases.length > 0) {
                    Global.activeConnection = {
                        ...Global.activeConnection,
                        database: userDatabases[0].Database,
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
        };

        try {
            // Get all tables with comments from current database
            const connection = Utility.createConnection(connectionOptions);
            const tables = await Utility.queryPromise<any[]>(connection,
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
                        Global.activeConnection.certPath
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
            const connection = Utility.createConnection({
                host: tableNode.getHost(),
                user: tableNode.getUser(),
                password: tableNode.getPassword(),
                port: tableNode.getPort(),
                database: databaseName,
                certPath: tableNode.getCertPath(),
            });

            await Utility.queryPromise(connection, `DROP TABLE \`${databaseName}\`.\`${tableName}\`;`);
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
            const conn1 = Utility.createConnection(connectionOptions);
            await Utility.queryPromise(conn1, `CREATE TABLE \`${databaseName}\`.\`${backupTableName}\` LIKE \`${databaseName}\`.\`${tableName}\`;`);

            // Copy data
            const conn2 = Utility.createConnection(connectionOptions);
            await Utility.queryPromise(conn2, `INSERT INTO \`${databaseName}\`.\`${backupTableName}\` SELECT * FROM \`${databaseName}\`.\`${tableName}\`;`);

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
