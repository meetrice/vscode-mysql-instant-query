import * as path from "path";
import * as uuidv1 from "uuid/v1";
import * as vscode from "vscode";
import { AppInsightsClient } from "./common/appInsightsClient";
import { Constants } from "./common/constants";
import { Global } from "./common/global";
import { IConnection } from "./model/connection";
import { ConnectionNode } from "./model/connectionNode";
import { INode } from "./model/INode";

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

    constructor(private context: vscode.ExtensionContext) {
        this.filterState = TableFilterState.instance;
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
            return this.getConnectionNodes();
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

    public async addConnection() {
        AppInsightsClient.sendEvent("addConnection.start");
        const displayName = await vscode.window.showInputBox({ prompt: "Display name for this connection", placeHolder: "My MySQL Server", ignoreFocusOut: true });
        if (displayName === undefined) {
            return;
        }

        const host = await vscode.window.showInputBox({ prompt: "The hostname of the database", placeHolder: "host", ignoreFocusOut: true });
        if (!host) {
            return;
        }

        const user = await vscode.window.showInputBox({ prompt: "The MySQL user to authenticate as", placeHolder: "user", ignoreFocusOut: true });
        if (!user) {
            return;
        }

        const password = await vscode.window.showInputBox({ prompt: "The password of the MySQL user", placeHolder: "password", ignoreFocusOut: true, password: true });
        if (password === undefined) {
            return;
        }

        const port = await vscode.window.showInputBox({ prompt: "The port number to connect to", placeHolder: "port", ignoreFocusOut: true, value: "3306" });
        if (!port) {
            return;
        }

        const certPath = await vscode.window.showInputBox({ prompt: "[Optional] SSL certificate path. Leave empty to ignore", placeHolder: "certificate file path", ignoreFocusOut: true });
        if (certPath === undefined) {
            return;
        }

        let connections = this.context.globalState.get<{ [key: string]: IConnection }>(Constants.GlobalStateMySQLConectionsKey);

        if (!connections) {
            connections = {};
        }

        const id = uuidv1();
        connections[id] = {
            host,
            user,
            port,
            certPath,
            displayName,
        };

        if (password) {
            await Global.secrets.store(id, password);
        }
        await this.context.globalState.update(Constants.GlobalStateMySQLConectionsKey, connections);
        this.refresh();
        AppInsightsClient.sendEvent("addConnection.end");
    }

    public refresh(element?: INode): void {
        this._onDidChangeTreeData.fire(element);
    }

    private async getConnectionNodes(): Promise<ConnectionNode[]> {
        const connections = this.context.globalState.get<{ [key: string]: IConnection }>(Constants.GlobalStateMySQLConectionsKey);
        const ConnectionNodes = [];
        if (connections) {
            for (const id of Object.keys(connections)) {
                const password = await Global.secrets.get(id);
                ConnectionNodes.push(new ConnectionNode(id, connections[id].host, connections[id].user, password, connections[id].port, connections[id].certPath, connections[id].displayName || connections[id].host, this));
                if (!Global.activeConnection) {
                    Global.activeConnection = {
                        host: connections[id].host,
                        user: connections[id].user,
                        password,
                        port: connections[id].port,
                        certPath: connections[id].certPath,
                    };
                }
            }
        }
        return ConnectionNodes;
    }
}
