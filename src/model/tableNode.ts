import * as mysql from "mysql2";
import * as path from "path";
import * as vscode from "vscode";
import { AppInsightsClient } from "../common/appInsightsClient";
import { DbDriver } from "../common/dbDriver";
import { Global } from "../common/global";
import { OutputChannel } from "../common/outputChannel";
import { Utility } from "../common/utility";
import { I18n } from "../common/i18n";
import { ColumnNode } from "./columnNode";
import { DatabaseDriver } from "./connection";
import { InfoNode } from "./infoNode";
import { INode } from "./INode";
import { MySQLTreeDataProvider } from "../mysqlTreeDataProvider";

// Polyfill for padEnd (not available in older TypeScript)
function padEnd(str: string, targetLength: number, padString: string = " "): string {
    const length = str.length;
    if (length >= targetLength) {
        return str;
    }
    const paddedLength = targetLength - length;
    let padding = "";
    for (let i = 0; i < paddedLength; i++) {
        padding += padString;
    }
    return str + padding.substring(0, paddedLength);
}

export class TableNode implements INode {
    private treeDataProvider?: MySQLTreeDataProvider;
    private tableComment: string = "";
    private autoExpand: boolean = false;

    constructor(private readonly host: string, private readonly user: string, private readonly password: string,
                private readonly port: string, private readonly database: string, public readonly table: string,
                private readonly certPath: string,
                public pinned: boolean = false,
                treeDataProvider?: MySQLTreeDataProvider,
                autoExpand: boolean = false,
                private readonly driver: DatabaseDriver = "mysql",
                private readonly filePath?: string) {
        this.treeDataProvider = treeDataProvider;
        this.autoExpand = autoExpand;
    }

    private getConnectionOptions() {
        return DbDriver.getConnectionOptionsFromNode(
            this.host,
            this.user,
            this.password,
            this.port,
            this.certPath,
            this.driver,
            this.filePath,
            this.database,
        );
    }

    public setAutoExpand(value: boolean): void {
        this.autoExpand = value;
    }

    public setTreeDataProvider(treeDataProvider: MySQLTreeDataProvider): void {
        this.treeDataProvider = treeDataProvider;
    }

    // Set table comment for display and filtering
    public setTableComment(comment: string): void {
        this.tableComment = comment;
    }

    // Get unique key for this table (used for pinning)
    public getKey(): string {
        return `${this.host}:${this.port}:${this.database}:${this.table}`;
    }

    public getTreeItem(): vscode.TreeItem {
        let label = this.pinned ? `⭐ ${this.table}` : this.table;
        // Add comment as tooltip
        const tooltip = this.tableComment ? `${this.table} - ${this.tableComment}` : this.table;

        // Get expand version to force TreeItem recreation
        let expandVersion = 0;
        try {
            if (this.treeDataProvider && (this.treeDataProvider as any).getExpandVersion) {
                expandVersion = (this.treeDataProvider as any).getExpandVersion() || 0;
            }
        } catch (e) {
            // Ignore
        }

        // Get expand state from TableFilterState (per-table toggle)
        const isExpanded = (() => {
            try {
                if (this.treeDataProvider && (this.treeDataProvider as any).filterState) {
                    const filterState = (this.treeDataProvider as any).filterState;
                    return filterState.getTableExpanded(this.getKey());
                }
            } catch (e) {
                // Ignore
            }
            return false;
        })();

        const collapsibleState = isExpanded ?
            vscode.TreeItemCollapsibleState.Expanded :
            vscode.TreeItemCollapsibleState.Collapsed;
        const treeItem = new vscode.TreeItem(label, collapsibleState);
        treeItem.contextValue = this.pinned ? "pinnedTable" : "table";
        treeItem.iconPath = path.join(__filename, "..", "..", "..", "resources", "table.svg");
        // Add version to id to force TreeView to recreate the item when expand state changes
        treeItem.id = `${this.getKey()}#v${expandVersion}`;
        treeItem.tooltip = tooltip;
        // Set description to show comment (visible in tree view)
        treeItem.description = this.tableComment || "";
        // Set a non-file URI to prevent SFTP extension from showing menus
        // Use a custom scheme that SFTP won't recognize
        treeItem.resourceUri = vscode.Uri.parse(`mysql://${this.host}/${this.database}/${this.table}`);
        return treeItem;
    }

    public async pin() {
        if (this.treeDataProvider) {
            await this.treeDataProvider.addPinnedTable(this.getKey());
            this.pinned = true;
            // Refresh the parent database node to show updated order
            this.refreshParent();
        }
    }

    public async unpin() {
        if (this.treeDataProvider) {
            await this.treeDataProvider.removePinnedTable(this.getKey());
            this.pinned = false;
            // Refresh the parent database node to show updated order
            this.refreshParent();
        }
    }

    private refreshParent() {
        if (this.treeDataProvider) {
            // Refresh the tree to update the display
            this.treeDataProvider.refresh();
        }
    }

    public async getChildren(): Promise<INode[]> {
        const options = this.getConnectionOptions();

        let columnFilter = "";
        if (this.treeDataProvider && (this.treeDataProvider as any).getColumnFilterText) {
            columnFilter = (this.treeDataProvider as any).getColumnFilterText() || "";
        }

        return DbDriver.listColumns(options, this.database, this.table)
            .then((columns) => {
                const filterLower = columnFilter.toLowerCase().trim();
                const filteredColumns = columns.filter((column) => {
                    if (!filterLower) return true;
                    const columnName = (column.COLUMN_NAME || "").toLowerCase();
                    const columnComment = (column.COLUMN_COMMENT || "").toLowerCase();
                    const columnType = (column.COLUMN_TYPE || "").toLowerCase();
                    return columnName.includes(filterLower) ||
                           columnComment.includes(filterLower) ||
                           columnType.includes(filterLower);
                });
                return filteredColumns.map<ColumnNode>((column) => {
                    return new ColumnNode(this.host, this.user, this.password, this.port, this.database, column, this.table, this.certPath);
                });
            })
            .catch((err) => {
                return [new InfoNode(err)];
            });
    }

    public async selectTop1000() {
        AppInsightsClient.sendEvent("selectTop1000");
        const sql = `SELECT * FROM \`${this.database}\`.\`${this.table}\` LIMIT 100;`;

        const connection = {
            host: this.host,
            user: this.user,
            password: this.password,
            port: this.port,
            database: this.database,
            certPath: this.certPath,
        };
        Global.activeConnection = connection;

        // Use runQueryWithTotal to get total row count and pass database/table info
        // Append SQL to existing editor instead of replacing
        Utility.runQueryWithTotal(sql, this.database, this.table, false, true);
    }

    public async copyTableName() {
        await vscode.env.clipboard.writeText(this.table);
        vscode.window.showInformationMessage(`Copied: ${this.table}`);
    }

    public async showTableStructure() {
        AppInsightsClient.sendEvent("showTableStructure");
        const connectionOptions = this.getConnectionOptions();

        try {
            const columns = await Utility.queryPromise<any[]>(connectionOptions,
                `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
                 FROM information_schema.columns
                 WHERE table_schema = '${this.database}' AND table_name = '${this.table}'
                 ORDER BY ORDINAL_POSITION;`);

            const primaryKeys = await Utility.queryPromise<any[]>(connectionOptions,
                `SELECT k.COLUMN_NAME
                 FROM information_schema.table_constraints t
                 JOIN information_schema.key_column_usage k
                 ON t.CONSTRAINT_NAME = k.CONSTRAINT_NAME
                 AND t.TABLE_SCHEMA = k.TABLE_SCHEMA
                 AND t.TABLE_NAME = k.TABLE_NAME
                 WHERE t.CONSTRAINT_TYPE = 'PRIMARY KEY'
                 AND t.TABLE_SCHEMA = '${this.database}'
                 AND t.TABLE_NAME = '${this.table}'
                 ORDER BY k.ORDINAL_POSITION;`);

            const foreignKeys = await Utility.queryPromise<any[]>(connectionOptions,
                `SELECT k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME
                 FROM information_schema.table_constraints t
                 JOIN information_schema.key_column_usage k
                 ON t.CONSTRAINT_NAME = k.CONSTRAINT_NAME
                 AND t.TABLE_SCHEMA = k.TABLE_SCHEMA
                 AND t.TABLE_NAME = k.TABLE_NAME
                 WHERE t.CONSTRAINT_TYPE = 'FOREIGN KEY'
                 AND t.TABLE_SCHEMA = '${this.database}'
                 AND t.TABLE_NAME = '${this.table}'
                 ORDER BY k.ORDINAL_POSITION;`);

            const indexes = await Utility.queryPromise<any[]>(connectionOptions,
                `SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE
                 FROM information_schema.statistics
                 WHERE TABLE_SCHEMA = '${this.database}' AND TABLE_NAME = '${this.table}'
                 ORDER BY INDEX_NAME, SEQ_IN_INDEX;`);

            const tableInfo = await Utility.queryPromise<any[]>(connectionOptions,
                `SELECT TABLE_COMMENT
                 FROM information_schema.TABLES
                 WHERE TABLE_SCHEMA = '${this.database}' AND TABLE_NAME = '${this.table}';`);
            const tableComment = tableInfo && tableInfo[0] && tableInfo[0].TABLE_COMMENT ? tableInfo[0].TABLE_COMMENT : '';

            // Format output
            let output = `Table: ${this.database}.${this.table}`;
            if (tableComment) {
                output += ` [${tableComment}]`;
            }
            output += `\n`;
            output += `${"=".repeat(80)}\n\n`;

            // Columns section
            output += `-- Columns --\n`;
            const structureSql = `SELECT COLUMN_NAME AS '字段', COLUMN_TYPE AS '类型', IS_NULLABLE AS '允许空', COLUMN_KEY AS '键', COLUMN_DEFAULT AS '默认值', EXTRA AS '额外信息', COLUMN_COMMENT AS '注释' FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '${this.database}' AND TABLE_NAME = '${this.table}';`;
            output += `${structureSql}\n\n`;

            if (columns.length > 0) {
                // Calculate column widths
                const nameWidth = Math.max(15, ...columns.map(c => c.COLUMN_NAME.length));
                const typeWidth = Math.max(20, ...columns.map(c => c.COLUMN_TYPE.length));
                const nullableWidth = 8;
                const defaultWidth = Math.max(15, ...columns.map(c => String(c.COLUMN_DEFAULT || '').length));
                const commentWidth = Math.max(10, ...columns.map(c => (c.COLUMN_COMMENT || '').length));

                output += `${padEnd("Field", nameWidth)}  ${padEnd("Type", typeWidth)}  ${padEnd("Null", nullableWidth)}  ${padEnd("Default", defaultWidth)}  ${padEnd("Comment", commentWidth)}\n`;
                output += `${"-".repeat(nameWidth)}  ${"-".repeat(typeWidth)}  ${"-".repeat(nullableWidth)}  ${"-".repeat(defaultWidth)}  ${"-".repeat(commentWidth)}\n`;

                for (const col of columns) {
                    const defaultValue = String(col.COLUMN_DEFAULT || 'NULL');
                    const commentValue = col.COLUMN_COMMENT || '';
                    output += `${padEnd(col.COLUMN_NAME, nameWidth)}  ` +
                              `${padEnd(col.COLUMN_TYPE, typeWidth)}  ` +
                              `${padEnd(col.IS_NULLABLE, nullableWidth)}  ` +
                              `${padEnd(defaultValue, defaultWidth)}  ` +
                              `${padEnd(commentValue, commentWidth)}\n`;
                }
            } else {
                output += "No columns found.\n";
            }
            output += `\n`;

            // Primary keys section
            if (primaryKeys.length > 0) {
                output += `-- Primary Key --\n`;
                output += `Primary Key(${primaryKeys.map(pk => pk.COLUMN_NAME).join(', ')})\n\n`;
            }

            // Foreign keys section
            if (foreignKeys.length > 0) {
                output += `-- Foreign Keys --\n`;
                for (const fk of foreignKeys) {
                    output += `FOREIGN KEY (${fk.COLUMN_NAME}) REFERENCES ${fk.REFERENCED_TABLE_NAME}(${fk.REFERENCED_COLUMN_NAME})\n`;
                }
                output += `\n`;
            }

            // Indexes section
            if (indexes.length > 0) {
                output += `-- Indexes --\n`;
                const indexGroups: { [key: string]: any[] } = {};
                for (const idx of indexes) {
                    if (!indexGroups[idx.INDEX_NAME]) {
                        indexGroups[idx.INDEX_NAME] = [];
                    }
                    indexGroups[idx.INDEX_NAME].push(idx);
                }
                for (const indexName in indexGroups) {
                    const idxs = indexGroups[indexName];
                    const columns = idxs.map(i => i.COLUMN_NAME).join(', ');
                    const unique = idxs[0].NON_UNIQUE === 0 ? 'UNIQUE ' : '';
                    output += `${unique}INDEX ${indexName} (${columns})\n`;
                }
            }

            // Sample data section - get 5 rows ordered by id desc (if id column exists)
            output += `\n-- Sample Data (5 rows) --\n`;

            const hasIdColumn = columns.some(c => c.COLUMN_NAME.toLowerCase() === 'id');

            let orderByColumn = '';
            if (primaryKeys.length > 0) {
                orderByColumn = primaryKeys[0].COLUMN_NAME;
            } else if (hasIdColumn) {
                orderByColumn = 'id';
            }

            let orderClause = '';
            if (orderByColumn) {
                orderClause = `ORDER BY \`${orderByColumn}\` DESC`;
            }

            const sqlText = `SELECT * FROM \`${this.database}\`.\`${this.table}\` ${orderClause} LIMIT 5;`;
            output += `${sqlText}\n\n`;

            const sampleData = await Utility.queryPromise<any[]>(connectionOptions, sqlText);

            if (sampleData.length > 0) {
                // Create header: column_name (comment)
                const headerParts: string[] = [];
                for (const col of columns) {
                    const colName = col.COLUMN_NAME;
                    const comment = col.COLUMN_COMMENT || '';
                    const header = comment ? `${colName} (${comment})` : colName;
                    headerParts.push(header);
                }

                // Get values for each row and filter out columns that have no data in all rows
                const columnsWithData: { [key: string]: boolean } = {};
                for (const col of columns) {
                    columnsWithData[col.COLUMN_NAME] = false;
                }

                const rowValues: any[][] = [];
                for (const row of sampleData) {
                    const values: any[] = [];
                    for (const col of columns) {
                        const value = row[col.COLUMN_NAME];
                        values.push(value);
                        // Check if column has any non-null/non-empty value
                        if (value !== null && value !== undefined && value !== '') {
                            columnsWithData[col.COLUMN_NAME] = true;
                        }
                    }
                    rowValues.push(values);
                }

                // Filter to only include columns that have data
                const activeColumnIndices: number[] = [];
                const activeHeaders: string[] = [];
                for (let i = 0; i < columns.length; i++) {
                    if (columnsWithData[columns[i].COLUMN_NAME]) {
                        activeColumnIndices.push(i);
                        activeHeaders.push(headerParts[i]);
                    }
                }

                if (activeHeaders.length > 0) {
                    // Calculate column widths for display
                    const dataWidths: number[] = [];
                    for (let i = 0; i < activeHeaders.length; i++) {
                        const header = activeHeaders[i];
                        let maxLen = header.length;
                        for (const row of rowValues) {
                            const val = row[activeColumnIndices[i]];
                            const valStr = val === null || val === undefined ? 'NULL' : String(val);
                            // For string values, limit to 50 chars for width calculation
                            const displayStr = valStr.length > 50 ? valStr.substring(0, 47) + '...' : valStr;
                            maxLen = Math.max(maxLen, displayStr.length);
                        }
                        dataWidths.push(Math.min(maxLen, 50)); // Max 50 chars width
                    }

                    // Print header
                    for (let i = 0; i < activeHeaders.length; i++) {
                        output += padEnd(activeHeaders[i], dataWidths[i] + 2);
                    }
                    output += `\n`;

                    // Print separator
                    for (let i = 0; i < activeHeaders.length; i++) {
                        output += padEnd('', dataWidths[i] + 2, '-');
                    }
                    output += `\n`;

                    // Print rows
                    for (const row of rowValues) {
                        for (let i = 0; i < activeColumnIndices.length; i++) {
                            const val = row[activeColumnIndices[i]];
                            const valStr = val === null || val === undefined ? 'NULL' : String(val);
                            // Truncate long values
                            let displayVal = valStr;
                            if (valStr.length > 50) {
                                displayVal = valStr.substring(0, 47) + '...';
                            }
                            output += padEnd(displayVal, dataWidths[i] + 2);
                        }
                        output += `\n`;
                    }
                } else {
                    output += "(No data in any column)\n";
                }
            } else {
                output += "(No data)\n";
            }

            await Utility.createSQLTextDocument(output);

        } catch (err) {
            vscode.window.showErrorMessage(`Error: ${err}`);
        }
    }

    // Public getters for external access
    public getDatabase(): string {
        return this.database;
    }

    public getHost(): string {
        return this.host;
    }

    public getUser(): string {
        return this.user;
    }

    public getPassword(): string {
        return this.password;
    }

    public getPort(): string {
        return this.port;
    }

    public getCertPath(): string {
        return this.certPath;
    }

    public async countTable() {
        AppInsightsClient.sendEvent("countTable");
        const query = `SELECT COUNT(*) AS count FROM \`${this.database}\`.\`${this.table}\`;`;

        await Utility.runQuery(query, this.getConnectionOptions());
    }

    public async addColumn() {
        AppInsightsClient.sendEvent("addColumn");

        // Step 1: Get column name
        const columnName = await vscode.window.showInputBox({
            prompt: I18n.t("addColumn.prompt.columnName", "Enter column name"),
            placeHolder: I18n.t("addColumn.placeholder.columnName", "column_name"),
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value || !value.trim()) {
                    return I18n.t("addColumn.error.emptyColumnName", "Column name cannot be empty");
                }
                if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
                    return I18n.t("addColumn.error.invalidColumnName", "Invalid column name. Use letters, numbers, and underscores, starting with a letter or underscore");
                }
                return null;
            }
        });

        if (!columnName) {
            return; // User cancelled
        }

        // Step 2: Select column type
        const typeOptions: vscode.QuickPickItem[] = [
            { label: "VARCHAR", description: I18n.t("addColumn.type.varchar", "Variable-length string") },
            { label: "INT", description: I18n.t("addColumn.type.int", "Integer") },
            { label: "BIGINT", description: I18n.t("addColumn.type.bigint", "Large integer") },
            { label: "DECIMAL", description: I18n.t("addColumn.type.decimal", "Fixed-point number") },
            { label: "TEXT", description: I18n.t("addColumn.type.text", "Long text") },
            { label: "DATE", description: I18n.t("addColumn.type.date", "Date (YYYY-MM-DD)") },
            { label: "DATETIME", description: I18n.t("addColumn.type.datetime", "Date and time") },
            { label: "TIMESTAMP", description: I18n.t("addColumn.type.timestamp", "Timestamp") },
            { label: "TINYINT", description: I18n.t("addColumn.type.tinyint", "Small integer (0-255)") },
            { label: "SMALLINT", description: I18n.t("addColumn.type.smallint", "Small integer") },
            { label: "FLOAT", description: I18n.t("addColumn.type.float", "Floating-point number") },
            { label: "DOUBLE", description: I18n.t("addColumn.type.double", "Double precision floating-point") },
            { label: "BOOLEAN", description: I18n.t("addColumn.type.boolean", "True/False") },
            { label: "JSON", description: I18n.t("addColumn.type.json", "JSON data") },
        ];

        const selectedType = await vscode.window.showQuickPick(typeOptions, {
            placeHolder: I18n.t("addColumn.placeholder.selectType", "Select column type"),
            ignoreFocusOut: true
        });

        if (!selectedType) {
            return; // User cancelled
        }

        let columnType = selectedType.label;
        let length: string | undefined;

        // Step 3: Get length for types that require it
        if (["VARCHAR", "CHAR", "DECIMAL", "NUMERIC"].includes(columnType)) {
            const isDecimal = columnType === "DECIMAL" || columnType === "NUMERIC";
            const lengthInput = await vscode.window.showInputBox({
                prompt: I18n.format("addColumn.prompt.typeLength", [columnType]),
                placeHolder: isDecimal ?
                    I18n.t("addColumn.placeholder.decimalLength", "10,2") :
                    I18n.t("addColumn.placeholder.typeLength", "255"),
                ignoreFocusOut: true
            });
            if (lengthInput) {
                columnType = `${columnType}(${lengthInput})`;
            }
        }

        // Step 4: Optional - nullable
        const nullableOptions: vscode.QuickPickItem[] = [
            { label: "NULL", description: I18n.t("addColumn.nullable.null", "Column can be null"), picked: true },
            { label: "NOT NULL", description: I18n.t("addColumn.nullable.notNull", "Column cannot be null") },
        ];

        const nullableOption = await vscode.window.showQuickPick(nullableOptions, {
            placeHolder: I18n.t("addColumn.placeholder.selectNullable", "Select nullability (default: NULL)"),
            ignoreFocusOut: true
        });

        // Step 5: Optional - default value
        const defaultValue = await vscode.window.showInputBox({
            prompt: I18n.t("addColumn.prompt.defaultValue", "Enter default value (optional)"),
            placeHolder: I18n.t("addColumn.placeholder.defaultValue", "Leave empty for no default"),
            ignoreFocusOut: true
        });

        // Step 6: Optional - comment
        const comment = await vscode.window.showInputBox({
            prompt: I18n.t("addColumn.prompt.comment", "Enter column comment (optional)"),
            placeHolder: I18n.t("addColumn.placeholder.comment", "Column description"),
            ignoreFocusOut: true
        });

        // Build the ALTER TABLE SQL
        let sql = `ALTER TABLE \`${this.database}\`.\`${this.table}\`\n`;
        sql += `ADD COLUMN \`${columnName.trim()}\` ${columnType}`;

        if (nullableOption && nullableOption.label === "NOT NULL") {
            sql += ` NOT NULL`;
        }

        if (defaultValue !== undefined) {
            const typeUpper = columnType.toUpperCase();
            // Check if it's a numeric type to determine if we need quotes
            const isNumeric = ["INT", "BIGINT", "TINYINT", "SMALLINT", "FLOAT", "DOUBLE", "DECIMAL", "NUMERIC", "BOOLEAN"].some(t => typeUpper.includes(t));
            if (defaultValue.trim() === "") {
                // Empty input means no default
            } else if (defaultValue.trim().toUpperCase() === "NULL" && nullableOption?.label !== "NOT NULL") {
                sql += ` DEFAULT NULL`;
            } else if (isNumeric && ["CURRENT_TIMESTAMP", "NOW()"].indexOf(defaultValue.trim().toUpperCase()) === -1) {
                sql += ` DEFAULT ${defaultValue}`;
            } else {
                sql += ` DEFAULT '${defaultValue.replace(/'/g, "''")}'`;
            }
        }

        if (comment) {
            sql += ` COMMENT '${comment.replace(/'/g, "''")}'`;
        }

        sql += ";";

        // Create SQL document with the generated statement
        await Utility.createSQLTextDocument(sql);
    }
}
