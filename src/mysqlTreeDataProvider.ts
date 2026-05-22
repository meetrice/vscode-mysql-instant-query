import * as vscode from "vscode";
import { AppInsightsClient } from "./common/appInsightsClient";
import { Constants } from "./common/constants";
import { Global } from "./common/global";
import { ConnectionWebView } from "./connectionWebView";
import { IConnection, normalizeDriver } from "./model/connection";
import { ConnectionNode } from "./model/connectionNode";
import { INode } from "./model/INode";
import { RootNode } from "./model/rootNode";

const PINNED_TABLES_KEY = "mysqlInstantQuery.pinnedTables";

// Global filter state for table filtering
export class TableFilterState {
    private static _instance: TableFilterState;
    private _filterText: string = "";
    private _columnFilterText: string = "";
    private _allExpanded: boolean = false;
    private _expandVersion: number = 0; // Version to force TreeItem recreation
    private _onDidChangeFilter: vscode.EventEmitter<INode> = new vscode.EventEmitter<INode>();
    // Per-table expand state: table key -> expanded (true) / collapsed (false)
    private _tableExpandState: Map<string, boolean> = new Map();
    public readonly onDidChangeFilter: vscode.Event<INode> = this._onDidChangeFilter.event;

    private constructor() {}

    public static get instance(): TableFilterState {
        if (!TableFilterState._instance) {
            TableFilterState._instance = new TableFilterState();
        }
        return TableFilterState._instance;
    }

    public get allExpanded(): boolean {
        return this._allExpanded;
    }

    public toggleAllExpanded(): boolean {
        this._allExpanded = !this._allExpanded;
        this._expandVersion++; // Increment version to force TreeItem recreation
        return this._allExpanded;
    }

    public getExpandVersion(): number {
        return this._expandVersion;
    }

    public setAllExpanded(value: boolean): void {
        if (this._allExpanded !== value) {
            this._allExpanded = value;
            this._expandVersion++; // Increment version to force TreeItem recreation
        }
    }

    // Per-table expand state management
    public getTableExpanded(tableKey: string): boolean {
        if (this._allExpanded) return true;
        return this._tableExpandState.get(tableKey) ?? false;
    }

    public toggleTableExpanded(tableKey: string): boolean {
        const current = this.getTableExpanded(tableKey);
        const next = !current;
        this._tableExpandState.set(tableKey, next);
        this._expandVersion++;
        return next;
    }

    public clearTableExpandState(): void {
        this._tableExpandState.clear();
        this._expandVersion++;
    }

    public get filterText(): string {
        return this._filterText;
    }

    public setFilterText(text: string): void {
        if (this._filterText !== text) {
            this._filterText = text;
            this._onDidChangeFilter.fire(null);
        }
    }

    public get columnFilterText(): string {
        return this._columnFilterText;
    }

    public setColumnFilterText(text: string): void {
        if (this._columnFilterText !== text) {
            this._columnFilterText = text;
            this._onDidChangeFilter.fire(null);
        }
    }

    public clear(): void {
        this.setFilterText("");
        this.setColumnFilterText("");
    }
}

export class MySQLTreeDataProvider implements vscode.TreeDataProvider<INode> {
    public _onDidChangeTreeData: vscode.EventEmitter<INode> = new vscode.EventEmitter<INode>();
    public readonly onDidChangeTreeData: vscode.Event<INode> = this._onDidChangeTreeData.event;

    private filterState: TableFilterState;
    private rootNode: RootNode;

    constructor(private context: vscode.ExtensionContext) {
        this.filterState = TableFilterState.instance;
        this.rootNode = new RootNode(() => this.buildConnectionNodes());
    }

    public getFilterText(): string {
        return this.filterState.filterText;
    }

    public getColumnFilterText(): string {
        return this.filterState.columnFilterText;
    }

    public get onFilterChanged(): vscode.Event<INode> {
        return this.filterState.onDidChangeFilter;
    }

    public get hasTableFilter(): boolean {
        return this.filterState.filterText.length > 0;
    }

    public get hasColumnFilter(): boolean {
        return this.filterState.columnFilterText.length > 0;
    }

    public getAllExpanded(): boolean {
        return this.filterState.allExpanded;
    }

    public toggleAllExpanded(): boolean {
        return this.filterState.toggleAllExpanded();
    }

    public getExpandVersion(): number {
        return this.filterState.getExpandVersion();
    }

    public getFilterState(): TableFilterState {
        return this.filterState;
    }

    public getTreeItem(element: INode): Promise<vscode.TreeItem> | vscode.TreeItem {
        return element.getTreeItem();
    }

    public getChildren(element?: INode): Thenable<INode[]> | INode[] {
        if (!element) {
            return [this.rootNode];
        }

        return element.getChildren();
    }

    public getPinnedTables(): string[] {
        return this.context.globalState.get<string[]>(PINNED_TABLES_KEY, []);
    }

    public async addPinnedTable(tableKey: string): Promise<void> {
        const pinnedTables = this.getPinnedTables();
        if (pinnedTables.indexOf(tableKey) < 0) {
            pinnedTables.push(tableKey);
            await this.context.globalState.update(PINNED_TABLES_KEY, pinnedTables);
        }
    }

    public async removePinnedTable(tableKey: string): Promise<void> {
        const pinnedTables = this.getPinnedTables();
        const index = pinnedTables.indexOf(tableKey);
        if (index >= 0) {
            pinnedTables.splice(index, 1);
            await this.context.globalState.update(PINNED_TABLES_KEY, pinnedTables);
        }
    }

    public addConnection() {
        ConnectionWebView.show(this.context, this);
    }

    public refresh(element?: INode): void {
        this._onDidChangeTreeData.fire(element);
    }

    private async buildConnectionNodes(): Promise<ConnectionNode[]> {
        const connections = this.context.globalState.get<{ [key: string]: IConnection }>(Constants.GlobalStateMySQLConectionsKey);
        const connectionNodes = [];
        if (connections) {
            for (const id of Object.keys(connections)) {
                const conn = connections[id];
                const password = await Global.secrets.get(id);
                const driver = normalizeDriver(conn.driver);
                connectionNodes.push(new ConnectionNode(
                    id,
                    conn.host,
                    conn.user,
                    password,
                    conn.port,
                    conn.certPath,
                    conn.displayName || conn.host,
                    this,
                    driver,
                    conn.filePath,
                ));
                if (!Global.activeConnection) {
                    Global.activeConnection = {
                        driver,
                        host: conn.host,
                        user: conn.user,
                        password,
                        port: conn.port,
                        certPath: conn.certPath,
                        filePath: conn.filePath,
                    };
                }
            }
        }
        return connectionNodes;
    }
}
