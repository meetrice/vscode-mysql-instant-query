import * as uuidv1 from "uuid/v1";
import * as vscode from "vscode";
import { AppInsightsClient } from "./common/appInsightsClient";
import { Constants } from "./common/constants";
import { Global } from "./common/global";
import { DatabaseDriver, IConnection, IStoredConnection, normalizeDriver } from "./model/connection";
import { MySQLTreeDataProvider } from "./mysqlTreeDataProvider";

export interface ConnectionFormData {
    driver: DatabaseDriver;
    displayName: string;
    host: string;
    port: string;
    user: string;
    password: string;
    certPath: string;
    filePath: string;
}

export class ConnectionWebView {
    private static currentPanel: vscode.WebviewPanel | undefined;
    private static context: vscode.ExtensionContext | undefined;
    private static treeDataProvider: MySQLTreeDataProvider | undefined;
    private static editConnectionId: string | undefined;

    public static show(
        context: vscode.ExtensionContext,
        treeDataProvider: MySQLTreeDataProvider,
        existingConnection?: { id: string; connection: IConnection },
    ): void {
        ConnectionWebView.context = context;
        ConnectionWebView.treeDataProvider = treeDataProvider;
        ConnectionWebView.editConnectionId = existingConnection?.id;

        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ConnectionWebView.currentPanel) {
            ConnectionWebView.currentPanel.reveal(column);
            ConnectionWebView.sendInit(existingConnection?.connection);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            "mysqlInstantQueryConnection",
            existingConnection ? "编辑数据库连接" : "添加数据库连接",
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        ConnectionWebView.currentPanel = panel;
        panel.webview.html = ConnectionWebView.getHtml();

        panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case "ready":
                    ConnectionWebView.sendInit(existingConnection?.connection);
                    break;
                case "browseFile":
                    await ConnectionWebView.handleBrowseFile(message.driver);
                    break;
                case "save":
                    await ConnectionWebView.handleSave(message.data as ConnectionFormData);
                    break;
                case "cancel":
                    panel.dispose();
                    break;
            }
        });

        panel.onDidDispose(() => {
            ConnectionWebView.currentPanel = undefined;
            ConnectionWebView.editConnectionId = undefined;
        });
    }

    private static sendInit(existing?: IConnection): void {
        const driver = normalizeDriver(existing?.driver);
        ConnectionWebView.currentPanel?.webview.postMessage({
            command: "init",
            data: {
                driver,
                displayName: existing?.displayName || "",
                host: existing?.host || "",
                port: existing?.port || ConnectionWebView.getDefaultPort(driver),
                user: existing?.user || "",
                password: "",
                certPath: existing?.certPath || "",
                filePath: existing?.filePath || existing?.host || "",
                isEdit: !!ConnectionWebView.editConnectionId,
            },
        });
    }

    private static getDefaultPort(driver: DatabaseDriver): string {
        switch (driver) {
            case "postgresql":
                return "5432";
            case "mysql":
            default:
                return "3306";
        }
    }

    private static async handleBrowseFile(driver: DatabaseDriver): Promise<void> {
        const filters: { [name: string]: string[] } = {};
        if (driver === "sqlite") {
            filters["SQLite"] = ["db", "sqlite", "sqlite3"];
        } else if (driver === "duckdb") {
            filters["DuckDB"] = ["duckdb", "db"];
        }

        const result = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: "选择数据库文件",
            filters,
        });

        if (result && result[0]) {
            ConnectionWebView.currentPanel?.webview.postMessage({
                command: "setFilePath",
                filePath: result[0].fsPath,
            });
        }
    }

    private static async handleSave(data: ConnectionFormData): Promise<void> {
        if (!ConnectionWebView.context || !ConnectionWebView.treeDataProvider) {
            return;
        }

        const driver = normalizeDriver(data.driver);
        const isFileDriver = driver === "sqlite" || driver === "duckdb";

        if (!data.displayName?.trim()) {
            vscode.window.showErrorMessage("请填写连接显示名称");
            return;
        }

        if (isFileDriver) {
            if (!data.filePath?.trim()) {
                vscode.window.showErrorMessage("请选择数据库文件路径");
                return;
            }
        } else {
            if (!data.host?.trim()) {
                vscode.window.showErrorMessage("请填写主机地址");
                return;
            }
            if (!data.user?.trim()) {
                vscode.window.showErrorMessage("请填写用户名");
                return;
            }
            if (!data.port?.trim()) {
                vscode.window.showErrorMessage("请填写端口号");
                return;
            }
        }

        AppInsightsClient.sendEvent("addConnection.start");

        let connections = ConnectionWebView.context.globalState.get<{ [key: string]: IStoredConnection }>(
            Constants.GlobalStateMySQLConectionsKey
        );
        if (!connections) {
            connections = {};
        }

        const id = ConnectionWebView.editConnectionId || uuidv1();
        const stored: IStoredConnection = {
            driver,
            displayName: data.displayName.trim(),
            host: isFileDriver ? data.filePath.trim() : data.host.trim(),
            user: isFileDriver ? "" : data.user.trim(),
            port: isFileDriver ? "" : data.port.trim(),
            certPath: data.certPath?.trim() || "",
            filePath: isFileDriver ? data.filePath.trim() : undefined,
        };

        connections[id] = stored;

        if (data.password) {
            await Global.secrets.store(id, data.password);
        }

        await ConnectionWebView.context.globalState.update(Constants.GlobalStateMySQLConectionsKey, connections);
        ConnectionWebView.treeDataProvider.refresh();
        ConnectionWebView.currentPanel?.dispose();

        AppInsightsClient.sendEvent("addConnection.end");
        vscode.window.showInformationMessage(
            ConnectionWebView.editConnectionId ? "连接已更新" : "连接已添加"
        );
    }

    private static getHtml(): string {
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <title>数据库连接</title>
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            padding: 20px 24px;
            margin: 0;
        }
        h1 {
            font-size: 1.4em;
            font-weight: 600;
            margin: 0 0 20px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .form-group { margin-bottom: 16px; }
        label { display: block; margin-bottom: 6px; font-weight: 500; }
        input, select {
            width: 100%;
            padding: 8px 10px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 4px;
            font-family: inherit;
            font-size: inherit;
        }
        input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
        .row { display: flex; gap: 12px; }
        .row .form-group { flex: 1; }
        .file-row { display: flex; gap: 8px; }
        .file-row input { flex: 1; }
        button {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-family: inherit;
            font-size: inherit;
        }
        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-browse {
            white-space: nowrap;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .actions {
            display: flex;
            gap: 10px;
            margin-top: 24px;
            padding-top: 16px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        .hint {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
        .hidden { display: none; }
        .section-title {
            font-size: 0.9em;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            margin: 20px 0 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
    </style>
</head>
<body>
    <h1 id="pageTitle">添加数据库连接</h1>
    <div class="form-group">
        <label for="driver">数据库类型</label>
        <select id="driver">
            <option value="mysql">MySQL</option>
            <option value="postgresql">PostgreSQL</option>
            <option value="sqlite">SQLite</option>
            <option value="duckdb">DuckDB</option>
        </select>
    </div>
    <div class="form-group">
        <label for="displayName">显示名称</label>
        <input type="text" id="displayName" placeholder="例如：本地开发库">
    </div>
    <div id="networkSection">
        <div class="section-title">连接信息</div>
        <div class="form-group">
            <label for="host">主机地址</label>
            <input type="text" id="host" placeholder="localhost">
        </div>
        <div class="row">
            <div class="form-group">
                <label for="port">端口</label>
                <input type="text" id="port" placeholder="3306">
            </div>
            <div class="form-group">
                <label for="user">用户名</label>
                <input type="text" id="user" placeholder="root">
            </div>
        </div>
        <div class="form-group">
            <label for="password">密码</label>
            <input type="password" id="password" placeholder="留空表示无密码">
            <div class="hint" id="passwordHint"></div>
        </div>
        <div class="form-group" id="certPathGroup">
            <label for="certPath">SSL 证书路径（可选）</label>
            <input type="text" id="certPath" placeholder="证书文件路径">
        </div>
    </div>
    <div id="fileSection" class="hidden">
        <div class="section-title">文件路径</div>
        <div class="form-group">
            <label for="filePath">数据库文件</label>
            <div class="file-row">
                <input type="text" id="filePath" placeholder="选择 .db / .sqlite / .duckdb 文件">
                <button type="button" class="btn-browse" id="browseBtn">浏览...</button>
            </div>
            <div class="hint">SQLite 和 DuckDB 通过本地文件连接</div>
        </div>
    </div>
    <div class="actions">
        <button type="button" class="btn-primary" id="saveBtn">保存连接</button>
        <button type="button" class="btn-secondary" id="cancelBtn">取消</button>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const driverEl = document.getElementById('driver');
        const displayNameEl = document.getElementById('displayName');
        const hostEl = document.getElementById('host');
        const portEl = document.getElementById('port');
        const userEl = document.getElementById('user');
        const passwordEl = document.getElementById('password');
        const certPathEl = document.getElementById('certPath');
        const filePathEl = document.getElementById('filePath');
        const networkSection = document.getElementById('networkSection');
        const fileSection = document.getElementById('fileSection');
        const certPathGroup = document.getElementById('certPathGroup');
        const passwordHint = document.getElementById('passwordHint');
        const pageTitle = document.getElementById('pageTitle');
        const defaultPorts = { mysql: '3306', postgresql: '5432', sqlite: '', duckdb: '' };
        function isFileDriver(driver) { return driver === 'sqlite' || driver === 'duckdb'; }
        function updateFormVisibility() {
            const driver = driverEl.value;
            const fileDriver = isFileDriver(driver);
            networkSection.classList.toggle('hidden', fileDriver);
            fileSection.classList.toggle('hidden', !fileDriver);
            certPathGroup.classList.toggle('hidden', driver !== 'mysql');
            if (!portEl.dataset.userEdited) {
                portEl.value = defaultPorts[driver] || '';
            }
        }
        driverEl.addEventListener('change', updateFormVisibility);
        portEl.addEventListener('input', () => { portEl.dataset.userEdited = '1'; });
        document.getElementById('browseBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'browseFile', driver: driverEl.value });
        });
        document.getElementById('saveBtn').addEventListener('click', () => {
            vscode.postMessage({
                command: 'save',
                data: {
                    driver: driverEl.value,
                    displayName: displayNameEl.value,
                    host: hostEl.value,
                    port: portEl.value,
                    user: userEl.value,
                    password: passwordEl.value,
                    certPath: certPathEl.value,
                    filePath: filePathEl.value,
                }
            });
        });
        document.getElementById('cancelBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'cancel' });
        });
        window.addEventListener('message', (event) => {
            const message = event.data;
            switch (message.command) {
                case 'init':
                    const d = message.data;
                    driverEl.value = d.driver || 'mysql';
                    displayNameEl.value = d.displayName || '';
                    hostEl.value = d.host || '';
                    portEl.value = d.port || defaultPorts[d.driver] || '3306';
                    portEl.dataset.userEdited = d.port ? '1' : '';
                    userEl.value = d.user || '';
                    passwordEl.value = d.password || '';
                    certPathEl.value = d.certPath || '';
                    filePathEl.value = d.filePath || '';
                    if (d.isEdit) {
                        pageTitle.textContent = '编辑数据库连接';
                        passwordHint.textContent = '留空则保持原密码不变';
                    }
                    updateFormVisibility();
                    break;
                case 'setFilePath':
                    filePathEl.value = message.filePath;
                    if (!displayNameEl.value) {
                        const parts = message.filePath.replace(/\\\\/g, '/').split('/');
                        displayNameEl.value = parts[parts.length - 1];
                    }
                    break;
            }
        });
        vscode.postMessage({ command: 'ready' });
    </script>
</body>
</html>`;
    }
}
