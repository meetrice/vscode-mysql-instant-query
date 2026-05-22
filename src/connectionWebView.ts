import * as uuidv1 from "uuid/v1";
import * as vscode from "vscode";
import { AppInsightsClient } from "./common/appInsightsClient";
import { Constants } from "./common/constants";
import { DbDriver } from "./common/dbDriver";
import { Global } from "./common/global";
import { I18n } from "./common/i18n";
import { OutputChannel } from "./common/outputChannel";
import { DatabaseDriver, IConnection, IStoredConnection, normalizeDriver, normalizeSslMode, normalizeUserSelectedSslMode, SslMode } from "./model/connection";
import { MySQLTreeDataProvider } from "./mysqlTreeDataProvider";

export interface ConnectionFormData {
    driver: DatabaseDriver;
    displayName: string;
    host: string;
    port: string;
    user: string;
    password: string;
    database: string;
    certPath: string;
    filePath: string;
    sslMode: SslMode;
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
            ConnectionWebView.currentPanel.title = ConnectionWebView.getPanelTitle(!!existingConnection);
            ConnectionWebView.currentPanel.reveal(column);
            ConnectionWebView.sendInit(existingConnection?.connection);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            "mysqlInstantQueryConnection",
            ConnectionWebView.getPanelTitle(!!existingConnection),
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
                case "test":
                    await ConnectionWebView.handleTest(message.data as ConnectionFormData);
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

    private static getPanelTitle(isEdit: boolean): string {
        return isEdit
            ? I18n.t("connection.panel.editTitle", "Edit Database Connection")
            : I18n.t("connection.panel.addTitle", "Add Database Connection");
    }

    private static sendInit(existing?: IConnection): void {
        const driver = normalizeDriver(existing?.driver);
        const isFileDriver = driver === "sqlite" || driver === "duckdb";
        ConnectionWebView.currentPanel?.webview.postMessage({
            command: "init",
            data: {
                driver,
                displayName: existing?.displayName || "",
                host: isFileDriver ? "" : (existing?.host || ""),
                port: existing?.port || ConnectionWebView.getDefaultPort(driver),
                user: existing?.user || "",
                password: "",
                database: existing?.database || "",
                certPath: existing?.certPath || "",
                filePath: existing?.filePath || (isFileDriver ? existing?.host : "") || "",
                sslMode: normalizeSslMode(existing?.sslMode),
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
            openLabel: I18n.t("connection.browseDialogLabel", "Select database file"),
            filters,
        });

        if (result && result[0]) {
            ConnectionWebView.currentPanel?.webview.postMessage({
                command: "setFilePath",
                filePath: result[0].fsPath,
            });
        }
    }

    private static validateConnectionFields(data: ConnectionFormData): boolean {
        const driver = normalizeDriver(data.driver);
        const isFileDriver = driver === "sqlite" || driver === "duckdb";

        if (isFileDriver) {
            if (!data.filePath?.trim()) {
                vscode.window.showErrorMessage(I18n.t("connection.error.filePathRequired"));
                return false;
            }
        } else {
            if (!data.host?.trim()) {
                vscode.window.showErrorMessage(I18n.t("connection.error.hostRequired"));
                return false;
            }
            if (!data.user?.trim()) {
                vscode.window.showErrorMessage(I18n.t("connection.error.userRequired"));
                return false;
            }
            if (!data.port?.trim()) {
                vscode.window.showErrorMessage(I18n.t("connection.error.portRequired"));
                return false;
            }
        }
        return true;
    }

    private static async buildConnectionOptions(data: ConnectionFormData): Promise<IConnection> {
        const driver = normalizeDriver(data.driver);
        const isFileDriver = driver === "sqlite" || driver === "duckdb";
        let password = data.password;
        if (!password && ConnectionWebView.editConnectionId) {
            password = await Global.secrets.get(ConnectionWebView.editConnectionId) || "";
        }
        const initialDatabase = data.database?.trim() || undefined;
        return {
            driver,
            host: isFileDriver ? data.filePath.trim() : data.host.trim(),
            user: isFileDriver ? "" : data.user.trim(),
            port: isFileDriver ? "" : data.port.trim(),
            database: isFileDriver ? undefined : initialDatabase,
            certPath: data.certPath?.trim() || "",
            filePath: isFileDriver ? data.filePath.trim() : undefined,
            password,
            displayName: data.displayName?.trim() || "",
            sslMode: driver === "postgresql" ? normalizeUserSelectedSslMode(data.sslMode) : undefined,
        };
    }

    private static async handleTest(data: ConnectionFormData): Promise<void> {
        if (!ConnectionWebView.validateConnectionFields(data)) {
            ConnectionWebView.currentPanel?.webview.postMessage({ command: "testResult", success: false });
            return;
        }

        try {
            const options = await ConnectionWebView.buildConnectionOptions(data);
            await DbDriver.testConnection(options);
            vscode.window.showInformationMessage(I18n.t("connection.testSuccess"));
            ConnectionWebView.currentPanel?.webview.postMessage({ command: "testResult", success: true });
        } catch (err) {
            const message = typeof err === "string"
                ? err
                : (err && (err as Error).message) ? (err as Error).message : String(err);
            OutputChannel.appendLine("[Connection Test Failed] " + message);
            if (/postgres/i.test(normalizeDriver(data.driver)) || /pg_hba|no encryption/i.test(message)) {
                OutputChannel.show();
            }
            vscode.window.showErrorMessage(I18n.format("connection.testFailed", [message]));
            ConnectionWebView.currentPanel?.webview.postMessage({ command: "testResult", success: false });
        }
    }

    private static async handleSave(data: ConnectionFormData): Promise<void> {
        if (!ConnectionWebView.context || !ConnectionWebView.treeDataProvider) {
            return;
        }

        if (!data.displayName?.trim()) {
            vscode.window.showErrorMessage(I18n.t("connection.error.displayNameRequired"));
            return;
        }

        if (!ConnectionWebView.validateConnectionFields(data)) {
            return;
        }

        AppInsightsClient.sendEvent("addConnection.start");

        let connections = ConnectionWebView.context.globalState.get<{ [key: string]: IStoredConnection }>(
            Constants.GlobalStateMySQLConectionsKey
        );
        if (!connections) {
            connections = {};
        }

        const id = ConnectionWebView.editConnectionId || uuidv1();
        const options = await ConnectionWebView.buildConnectionOptions(data);
        const stored: IStoredConnection = {
            driver: normalizeDriver(options.driver),
            displayName: data.displayName.trim(),
            host: options.host,
            user: options.user || "",
            port: options.port || "",
            database: options.database,
            certPath: options.certPath || "",
            filePath: options.filePath,
            sslMode: normalizeDriver(options.driver) === "postgresql" ? normalizeUserSelectedSslMode(options.sslMode) : undefined,
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
            ConnectionWebView.editConnectionId
                ? I18n.t("connection.info.updated")
                : I18n.t("connection.info.added")
        );
    }

    private static getHtml(): string {
        const labels = {
            addTitle: I18n.t("connection.panel.addTitle", "Add Database Connection"),
            editTitle: I18n.t("connection.panel.editTitle", "Edit Database Connection"),
            passwordEditHint: I18n.t("connection.passwordEditHint", "Leave empty to keep current password"),
            save: I18n.t("connection.save", "Save Connection"),
            saveEdit: I18n.t("connection.saveEdit", "Save Changes"),
            test: I18n.t("connection.test", "Test Connection"),
            testing: I18n.t("connection.testing", "Testing..."),
        };
        const labelsJson = JSON.stringify(labels);

        return `<!DOCTYPE html>
<html lang="${I18n.getLocale()}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <title>${I18n.t("connection.panel.addTitle", "Add Database Connection")}</title>
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
            justify-content: flex-end;
            align-items: center;
            gap: 10px;
            margin-top: 24px;
            padding-top: 16px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        .actions .btn-primary { order: 1; }
        .actions .btn-secondary { order: 2; }
        .actions .btn-test { order: 3; }
        .btn-test {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-test:hover { background: var(--vscode-button-secondaryHoverBackground); }
        .btn-test:disabled {
            opacity: 0.6;
            cursor: not-allowed;
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
    <h1 id="pageTitle">${I18n.t("connection.panel.addTitle", "Add Database Connection")}</h1>
    <div class="form-group">
        <label for="driver">${I18n.t("connection.driver", "Database Type")}</label>
        <select id="driver">
            <option value="mysql">MySQL</option>
            <option value="postgresql">PostgreSQL</option>
            <option value="sqlite">SQLite</option>
            <option value="duckdb">DuckDB</option>
        </select>
    </div>
    <div class="form-group">
        <label for="displayName">${I18n.t("connection.displayName", "Display Name")}</label>
        <input type="text" id="displayName" placeholder="${I18n.t("connection.displayNamePlaceholder", "e.g. Local Dev")}">
    </div>
    <div id="networkSection">
        <div class="section-title">${I18n.t("connection.section.network", "Connection Info")}</div>
        <div class="form-group">
            <label for="host">${I18n.t("connection.host", "Host")}</label>
            <input type="text" id="host" placeholder="${I18n.t("connection.hostPlaceholder", "localhost")}">
        </div>
        <div class="row">
            <div class="form-group">
                <label for="port">${I18n.t("connection.port", "Port")}</label>
                <input type="text" id="port" placeholder="3306">
            </div>
            <div class="form-group">
                <label for="user">${I18n.t("connection.user", "Username")}</label>
                <input type="text" id="user" placeholder="${I18n.t("connection.userPlaceholder", "root")}">
            </div>
        </div>
        <div class="form-group">
            <label for="password">${I18n.t("connection.password", "Password")}</label>
            <input type="password" id="password" placeholder="${I18n.t("connection.passwordPlaceholder", "Leave empty for no password")}">
            <div class="hint" id="passwordHint"></div>
        </div>
        <div class="form-group" id="databaseGroup">
            <label for="database">${I18n.t("connection.database", "Initial Database (optional)")}</label>
            <input type="text" id="database" placeholder="${I18n.t("connection.databasePlaceholder", "Database name, e.g. uranpgsql")}">
            <div class="hint">${I18n.t("connection.databaseHint", "Leave empty to use the server default. Required if server denies the default database in pg_hba.conf.")}</div>
        </div>
        <div class="form-group" id="certPathGroup">
            <label for="certPath">${I18n.t("connection.certPath", "SSL Certificate Path (optional)")}</label>
            <input type="text" id="certPath" placeholder="${I18n.t("connection.certPathPlaceholder", "Certificate file path")}">
        </div>
        <div class="form-group" id="pgSslGroup">
            <label for="sslMode">${I18n.t("connection.sslMode", "SSL Mode")}</label>
            <select id="sslMode">
                <option value="disable">${I18n.t("connection.sslMode.disable", "Disable")}</option>
                <option value="require">${I18n.t("connection.sslMode.require", "Require (encrypted)")}</option>
                <option value="verify-ca">${I18n.t("connection.sslMode.verifyCa", "Verify CA certificate")}</option>
            </select>
            <div class="hint">${I18n.t("connection.sslModeHint", "Use Require or Verify CA if your server requires encrypted connections")}</div>
        </div>
        <div class="form-group" id="pgCertPathGroup">
            <label for="pgCertPath">${I18n.t("connection.pgCertPath", "SSL CA Certificate (optional)")}</label>
            <input type="text" id="pgCertPath" placeholder="${I18n.t("connection.certPathPlaceholder", "Certificate file path")}">
        </div>
    </div>
    <div id="fileSection" class="hidden">
        <div class="section-title">${I18n.t("connection.section.file", "File Path")}</div>
        <div class="form-group">
            <label for="filePath">${I18n.t("connection.filePath", "Database File")}</label>
            <div class="file-row">
                <input type="text" id="filePath" placeholder="${I18n.t("connection.filePathPlaceholder", "Select .db / .sqlite / .duckdb file")}">
                <button type="button" class="btn-browse" id="browseBtn">${I18n.t("connection.fileBrowse", "Browse...")}</button>
            </div>
            <div class="hint">${I18n.t("connection.fileHint", "SQLite and DuckDB connect via local file")}</div>
        </div>
    </div>
    <div class="actions">
        <button type="button" class="btn-primary" id="saveBtn">${I18n.t("connection.save", "Save Connection")}</button>
        <button type="button" class="btn-secondary" id="cancelBtn">${I18n.t("connection.cancel", "Cancel")}</button>
        <button type="button" class="btn-test" id="testBtn">${I18n.t("connection.test", "Test Connection")}</button>
    </div>
    <script>
        const labels = ${labelsJson};
        const vscode = acquireVsCodeApi();
        const driverEl = document.getElementById('driver');
        const displayNameEl = document.getElementById('displayName');
        const hostEl = document.getElementById('host');
        const portEl = document.getElementById('port');
        const userEl = document.getElementById('user');
        const passwordEl = document.getElementById('password');
        const databaseEl = document.getElementById('database');
        const databaseGroup = document.getElementById('databaseGroup');
        const certPathEl = document.getElementById('certPath');
        const pgSslGroup = document.getElementById('pgSslGroup');
        const sslModeEl = document.getElementById('sslMode');
        const pgCertPathGroup = document.getElementById('pgCertPathGroup');
        const pgCertPathEl = document.getElementById('pgCertPath');
        const filePathEl = document.getElementById('filePath');
        const networkSection = document.getElementById('networkSection');
        const fileSection = document.getElementById('fileSection');
        const certPathGroup = document.getElementById('certPathGroup');
        const passwordHint = document.getElementById('passwordHint');
        const pageTitle = document.getElementById('pageTitle');
        const saveBtn = document.getElementById('saveBtn');
        const testBtn = document.getElementById('testBtn');
        const defaultPorts = { mysql: '3306', postgresql: '5432', sqlite: '', duckdb: '' };
        function getFormData() {
            const driver = driverEl.value;
            const isPg = driver === 'postgresql';
            return {
                driver: driver,
                displayName: displayNameEl.value,
                host: hostEl.value,
                port: portEl.value,
                user: userEl.value,
                password: passwordEl.value,
                database: databaseEl.value,
                certPath: isPg ? pgCertPathEl.value : certPathEl.value,
                filePath: filePathEl.value,
                sslMode: isPg ? sslModeEl.value : 'require',
            };
        }
        function isFileDriver(driver) { return driver === 'sqlite' || driver === 'duckdb'; }
        function updateFormVisibility() {
            const driver = driverEl.value;
            const fileDriver = isFileDriver(driver);
            const isPg = driver === 'postgresql';
            networkSection.classList.toggle('hidden', fileDriver);
            fileSection.classList.toggle('hidden', !fileDriver);
            certPathGroup.classList.toggle('hidden', driver !== 'mysql');
            pgSslGroup.classList.toggle('hidden', !isPg);
            pgCertPathGroup.classList.toggle('hidden', !isPg);
            databaseGroup.classList.toggle('hidden', fileDriver);
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
            vscode.postMessage({ command: 'save', data: getFormData() });
        });
        document.getElementById('cancelBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'cancel' });
        });
        testBtn.addEventListener('click', () => {
            testBtn.disabled = true;
            testBtn.textContent = labels.testing;
            vscode.postMessage({ command: 'test', data: getFormData() });
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
                    databaseEl.value = d.database || '';
                    certPathEl.value = d.certPath || '';
                    pgCertPathEl.value = d.certPath || '';
                    sslModeEl.value = d.sslMode || 'disable';
                    filePathEl.value = d.filePath || '';
                    if (d.isEdit) {
                        pageTitle.textContent = labels.editTitle;
                        passwordHint.textContent = labels.passwordEditHint;
                        saveBtn.textContent = labels.saveEdit;
                        driverEl.disabled = true;
                    } else {
                        pageTitle.textContent = labels.addTitle;
                        passwordHint.textContent = '';
                        saveBtn.textContent = labels.save;
                        driverEl.disabled = false;
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
                case 'testResult':
                    testBtn.disabled = false;
                    testBtn.textContent = labels.test;
                    break;
            }
        });
        vscode.postMessage({ command: 'ready' });
    </script>
</body>
</html>`;
    }
}
