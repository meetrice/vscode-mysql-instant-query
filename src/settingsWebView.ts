import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Constants } from "./common/constants";
import { I18n } from "./common/i18n";
import { KeybindingUtility } from "./common/keybindingUtility";
import { Utility } from "./common/utility";

interface SettingsData {
    language: string;
    dataLimit: number;
    keybindingRunQuery: string;
    keybindingOpenTable: string;
    pluginVersion: string;
    pluginName: string;
    repoUrl: string;
    supportInfo: string;
}

export class SettingsWebView {
    private static currentPanel: vscode.WebviewPanel | undefined;
    private static context: vscode.ExtensionContext | undefined;

    public static show(context: vscode.ExtensionContext): void {
        SettingsWebView.context = context;

        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (SettingsWebView.currentPanel) {
            SettingsWebView.currentPanel.reveal(column);
            SettingsWebView.sendSettingsData();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            "mysqlInstantQuerySettings",
            I18n.t("settings.title", "Settings"),
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        SettingsWebView.currentPanel = panel;
        panel.webview.html = SettingsWebView.getHtml();

        panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case "ready":
                    SettingsWebView.sendSettingsData();
                    break;
                case "saveSettings":
                    await SettingsWebView.handleSaveSettings(message.data);
                    break;
                case "exportSettings":
                    await SettingsWebView.handleExportSettings();
                    break;
                case "importSettings":
                    await SettingsWebView.handleImportSettings();
                    break;
                case "cancel":
                    panel.dispose();
                    break;
                case "openUrl":
                    vscode.env.openExternal(vscode.Uri.parse(message.url));
                    break;
                case "openKeybindings":
                    SettingsWebView.handleOpenKeybindings(message.filter);
                    break;
            }
        });

        const keybindingsWatcher = KeybindingUtility.watchUserKeybindings(() => {
            SettingsWebView.sendSettingsData();
        });

        panel.onDidChangeViewState((e) => {
            if (e.webviewPanel.visible) {
                SettingsWebView.sendSettingsData();
            }
        });

        panel.onDidDispose(() => {
            keybindingsWatcher.dispose();
            SettingsWebView.currentPanel = undefined;
        });
    }

    private static getSettings(context: vscode.ExtensionContext): SettingsData {
        const language = context.globalState.get<string>(Constants.GlobalStateSettingsLanguage, I18n.getLocale());
        const dataLimit = context.globalState.get<number>(Constants.GlobalStateSettingsDataLimit, 5000);
        const keybindingRunQuery = KeybindingUtility.getKeybindingForCommand(context, "mysqlInstantQuery.runQuery");
        const keybindingOpenTable = KeybindingUtility.getKeybindingForCommand(context, "mysqlInstantQuery.openTable");

        const packageJson = context.extension.packageJSON;

        return {
            language,
            dataLimit,
            keybindingRunQuery,
            keybindingOpenTable,
            pluginVersion: packageJson.version || "0.8.8",
            pluginName: SettingsWebView.resolveDisplayName(context),
            repoUrl: "https://github.com/meetrice/vscode-mysql-instant-query",
            supportInfo: "https://github.com/meetrice/vscode-mysql-instant-query",
        };
    }

    private static resolveDisplayName(context: vscode.ExtensionContext): string {
        const displayName = context.extension.packageJSON.displayName as string | undefined;
        if (displayName && !displayName.startsWith("%")) {
            return displayName;
        }

        const locale = I18n.getLocale().toLowerCase();
        const nlsCandidates = locale.startsWith("zh")
            ? ["package.nls.zh-cn.json", "package.nls.json"]
            : ["package.nls.json"];

        for (const file of nlsCandidates) {
            const nlsPath = path.join(context.extensionPath, file);
            if (!fs.existsSync(nlsPath)) {
                continue;
            }
            const nls = JSON.parse(fs.readFileSync(nlsPath, "utf-8")) as { displayName?: string };
            if (nls.displayName) {
                return nls.displayName;
            }
        }

        return "Mysql Instant Query";
    }

    private static sendSettingsData(): void {
        if (!SettingsWebView.context) return;
        const settings = SettingsWebView.getSettings(SettingsWebView.context);
        SettingsWebView.currentPanel?.webview.postMessage({
            command: "initSettings",
            data: settings,
        });
    }

    private static async handleSaveSettings(data: any): Promise<void> {
        if (!SettingsWebView.context) return;

        const context = SettingsWebView.context;

        if (data.language !== undefined) {
            await context.globalState.update(Constants.GlobalStateSettingsLanguage, data.language);
            I18n.setLocale(data.language);
        }
        if (data.dataLimit !== undefined) {
            await context.globalState.update(Constants.GlobalStateSettingsDataLimit, data.dataLimit);
            Utility.customDataLimit = data.dataLimit;
        }
        vscode.window.showInformationMessage(I18n.t("settings.saved", "Settings saved"));
    }

    private static async handleExportSettings(): Promise<void> {
        if (!SettingsWebView.context) return;

        const context = SettingsWebView.context;
        const connections = context.globalState.get(Constants.GlobalStateMySQLConectionsKey, {});
        const settings = {
            language: context.globalState.get(Constants.GlobalStateSettingsLanguage, I18n.getLocale()),
            dataLimit: context.globalState.get(Constants.GlobalStateSettingsDataLimit, 5000),
            keybindingRunQuery: KeybindingUtility.getKeybindingForCommand(context, "mysqlInstantQuery.runQuery"),
            keybindingOpenTable: KeybindingUtility.getKeybindingForCommand(context, "mysqlInstantQuery.openTable"),
        };

        const exportData = {
            version: 1,
            exportedAt: new Date().toISOString(),
            connections,
            settings,
        };

        const uri = await vscode.window.showSaveDialog({
            filters: { "MIQ Settings": ["miq-settings.json"] },
            defaultUri: vscode.Uri.file("mysql-instant-query-settings.miq-settings.json"),
        });

        if (!uri) return;

        try {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(exportData, null, 2), "utf-8"));
            vscode.window.showInformationMessage(I18n.t("settings.exported", "Settings exported successfully"));
        } catch (err) {
            vscode.window.showErrorMessage(I18n.format("settings.exportFailed", [String(err)]));
        }
    }

    private static async handleImportSettings(): Promise<void> {
        if (!SettingsWebView.context) return;

        const uri = await vscode.window.showOpenDialog({
            filters: { "MIQ Settings": ["miq-settings.json"] },
            canSelectMany: false,
        });

        if (!uri || uri.length === 0) return;

        try {
            const fileData = await vscode.workspace.fs.readFile(uri[0]);
            const importData = JSON.parse(Buffer.from(fileData).toString("utf-8"));

            if (!importData.version) {
                vscode.window.showErrorMessage(I18n.t("settings.importInvalid", "Invalid settings file"));
                return;
            }

            const context = SettingsWebView.context;

            if (importData.connections) {
                await context.globalState.update(Constants.GlobalStateMySQLConectionsKey, importData.connections);
            }
            if (importData.settings) {
                if (importData.settings.language !== undefined) {
                    await context.globalState.update(Constants.GlobalStateSettingsLanguage, importData.settings.language);
                    I18n.setLocale(importData.settings.language);
                }
                if (importData.settings.dataLimit !== undefined) {
                    await context.globalState.update(Constants.GlobalStateSettingsDataLimit, importData.settings.dataLimit);
                }
            }

            vscode.window.showInformationMessage(I18n.t("settings.imported", "Settings imported successfully"));
            SettingsWebView.sendSettingsData();
        } catch (err) {
            vscode.window.showErrorMessage(I18n.format("settings.importFailed", [String(err)]));
        }
    }

    private static handleOpenKeybindings(filter: string): void {
        vscode.commands.executeCommand("workbench.action.openGlobalKeybindings", filter);
    }

    private static getHtml(): string {
        const locale = I18n.getLocale();
        const isZh = locale.startsWith("zh");

        const settings = {
            title: I18n.t("settings.title", "Settings"),
            menuGeneral: I18n.t("settings.menu.general", "General"),
            menuData: I18n.t("settings.menu.data", "Data"),
            menuShortcuts: I18n.t("settings.menu.shortcuts", "Shortcuts"),
            menuBackup: I18n.t("settings.menu.backup", "Backup Settings"),
            menuMember: I18n.t("settings.menu.member", "Member"),
            menuAbout: I18n.t("settings.menu.about", "About"),
            generalLanguage: I18n.t("settings.general.language", "Language"),
            generalLanguageDesc: I18n.t("settings.general.languageDesc", "Select the display language for this extension"),
            dataLimit: I18n.t("settings.data.limit", "Data Query Limit"),
            dataLimitDesc: I18n.t("settings.data.limitDesc", "Maximum rows returned by SELECT queries. Default: 5000"),
            shortcutsRunQuery: I18n.t("settings.shortcuts.runQuery", "Execute SQL Query"),
            shortcutsRunQueryDesc: I18n.t("settings.shortcuts.runQueryDesc", "Shortcut to execute the current SQL query"),
            shortcutsOpenTable: I18n.t("settings.shortcuts.openTable", "Open Table"),
            shortcutsOpenTableDesc: I18n.t("settings.shortcuts.openTableDesc", "Shortcut to open and browse a table"),
            shortcutsChange: I18n.t("settings.shortcuts.change", "Change"),
            backupExport: I18n.t("settings.backup.export", "Export Settings"),
            backupExportDesc: I18n.t("settings.backup.exportDesc", "Export all connections and settings to a file"),
            backupImport: I18n.t("settings.backup.import", "Import Settings"),
            backupImportDesc: I18n.t("settings.backup.importDesc", "Import connections and settings from a file"),
            memberNotImplemented: I18n.t("settings.member.notImplemented", "Not implemented yet"),
            memberLoggedIn: I18n.t("settings.member.loggedIn", "Logged-in user info will be displayed here"),
            aboutName: I18n.t("settings.about.name", "Name"),
            aboutVersion: I18n.t("settings.about.version", "Version"),
            aboutRepo: I18n.t("settings.about.repo", "Repository"),
            aboutSupport: I18n.t("settings.about.support", "Support"),
            save: I18n.t("settings.save", "Save"),
            cancel: I18n.t("settings.cancel", "Cancel"),
            english: "English",
            chinese: "中文",
        };
        const settingsJson = JSON.stringify(settings);

        return `<!DOCTYPE html>
<html lang="${locale}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <title>${settings.title}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            display: flex;
            height: 100vh;
            overflow: hidden;
        }
        .sidebar {
            width: 180px;
            min-width: 180px;
            background: var(--vscode-sideBar-background);
            border-right: 1px solid var(--vscode-panel-border);
            display: flex;
            flex-direction: column;
            padding-top: 8px;
            overflow-y: auto;
        }
        .sidebar-item {
            padding: 10px 16px;
            cursor: pointer;
            font-size: 13px;
            color: var(--vscode-sideBar-foreground);
            border-left: 3px solid transparent;
            user-select: none;
        }
        .sidebar-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .sidebar-item.active {
            background: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
            border-left-color: var(--vscode-focusBorder);
        }
        .content {
            flex: 1;
            padding: 24px 32px;
            overflow-y: auto;
        }
        .content-section { display: none; }
        .content-section.active { display: block; }
        .content-section h2 {
            font-size: 1.3em;
            font-weight: 600;
            margin-bottom: 20px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .setting-group {
            margin-bottom: 20px;
            padding: 16px;
            background: var(--vscode-sideBar-background);
            border-radius: 6px;
            border: 1px solid var(--vscode-panel-border);
        }
        .setting-label {
            font-weight: 500;
            margin-bottom: 4px;
        }
        .setting-desc {
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 10px;
        }
        select, input[type="number"] {
            padding: 6px 10px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 4px;
            font-family: inherit;
            font-size: inherit;
            width: 100%;
            max-width: 300px;
        }
        select:focus, input:focus { outline: 1px solid var(--vscode-focusBorder); }
        .shortcut-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 0;
        }
        .shortcut-row + .shortcut-row {
            border-top: 1px solid var(--vscode-panel-border);
        }
        .shortcut-info { flex: 1; }
        .shortcut-keys {
            font-family: monospace;
            padding: 4px 10px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 4px;
            font-size: 12px;
            margin-right: 12px;
        }
        .btn {
            padding: 6px 14px;
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
        .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
        .btn-row {
            display: flex;
            gap: 12px;
            margin-top: 10px;
        }
        .member-placeholder {
            text-align: center;
            padding: 40px 20px;
            color: var(--vscode-descriptionForeground);
        }
        .about-table {
            width: 100%;
            border-collapse: collapse;
        }
        .about-table td {
            padding: 10px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .about-table td:first-child {
            font-weight: 500;
            width: 120px;
            color: var(--vscode-descriptionForeground);
        }
        .about-table a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }
        .about-table a:hover {
            text-decoration: underline;
        }
        .actions {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
            margin-top: 24px;
            padding-top: 16px;
            border-top: 1px solid var(--vscode-panel-border);
        }
    </style>
</head>
<body>
    <div class="sidebar" id="sidebar">
        <div class="sidebar-item active" data-section="general">${settings.menuGeneral}</div>
        <div class="sidebar-item" data-section="data">${settings.menuData}</div>
        <div class="sidebar-item" data-section="shortcuts">${settings.menuShortcuts}</div>
        <div class="sidebar-item" data-section="backup">${settings.menuBackup}</div>
        <div class="sidebar-item" data-section="member">${settings.menuMember}</div>
        <div class="sidebar-item" data-section="about">${settings.menuAbout}</div>
    </div>

    <div class="content">
        <!-- General -->
        <div class="content-section active" id="section-general">
            <h2>${settings.menuGeneral}</h2>
            <div class="setting-group">
                <div class="setting-label">${settings.generalLanguage}</div>
                <div class="setting-desc">${settings.generalLanguageDesc}</div>
                <select id="languageSelect">
                    <option value="en">${settings.english}</option>
                    <option value="zh-cn">${settings.chinese}</option>
                </select>
            </div>
        </div>

        <!-- Data -->
        <div class="content-section" id="section-data">
            <h2>${settings.menuData}</h2>
            <div class="setting-group">
                <div class="setting-label">${settings.dataLimit}</div>
                <div class="setting-desc">${settings.dataLimitDesc}</div>
                <input type="number" id="dataLimitInput" min="1" max="100000" value="5000">
            </div>
        </div>

        <!-- Shortcuts -->
        <div class="content-section" id="section-shortcuts">
            <h2>${settings.menuShortcuts}</h2>
            <div class="setting-group">
                <div class="shortcut-row">
                    <div class="shortcut-info">
                        <div class="setting-label">${settings.shortcutsRunQuery}</div>
                        <div class="setting-desc">${settings.shortcutsRunQueryDesc}</div>
                    </div>
                    <span class="shortcut-keys" id="keyRunQueryDisplay">ctrl+alt+e</span>
                    <button class="btn btn-secondary" onclick="openKeybindings('@command:mysqlInstantQuery.runQuery')">${settings.shortcutsChange}</button>
                </div>
                <div class="shortcut-row">
                    <div class="shortcut-info">
                        <div class="setting-label">${settings.shortcutsOpenTable}</div>
                        <div class="setting-desc">${settings.shortcutsOpenTableDesc}</div>
                    </div>
                    <span class="shortcut-keys" id="keyOpenTableDisplay">cmd+shift+t</span>
                    <button class="btn btn-secondary" onclick="openKeybindings('@command:mysqlInstantQuery.openTable')">${settings.shortcutsChange}</button>
                </div>
            </div>
        </div>

        <!-- Backup -->
        <div class="content-section" id="section-backup">
            <h2>${settings.menuBackup}</h2>
            <div class="setting-group">
                <div class="setting-label">${settings.backupExport}</div>
                <div class="setting-desc">${settings.backupExportDesc}</div>
                <button class="btn btn-primary" onclick="exportSettings()">${settings.backupExport}</button>
            </div>
            <div class="setting-group">
                <div class="setting-label">${settings.backupImport}</div>
                <div class="setting-desc">${settings.backupImportDesc}</div>
                <button class="btn btn-secondary" onclick="importSettings()">${settings.backupImport}</button>
            </div>
        </div>

        <!-- Member -->
        <div class="content-section" id="section-member">
            <h2>${settings.menuMember}</h2>
            <div class="member-placeholder">
                <div style="font-size: 48px; margin-bottom: 16px;">👤</div>
                <div style="font-size: 1.1em; margin-bottom: 8px;">${settings.memberNotImplemented}</div>
                <div>${settings.memberLoggedIn}</div>
            </div>
        </div>

        <!-- About -->
        <div class="content-section" id="section-about">
            <h2>${settings.menuAbout}</h2>
            <div class="setting-group">
                <table class="about-table">
                    <tr><td>${settings.aboutName}</td><td id="aboutName">Mysql Instant Query</td></tr>
                    <tr><td>${settings.aboutVersion}</td><td id="aboutVersion">0.8.8</td></tr>
                    <tr><td>${settings.aboutRepo}</td><td><a href="#" id="aboutRepoLink" onclick="openUrl('${isZh ? "https://github.com/meetrice/vscode-mysql-instant-query/blob/master/README.md" : "https://github.com/meetrice/vscode-mysql-instant-query"}')">GitHub</a></td></tr>
                    <tr><td>${settings.aboutSupport}</td><td><a href="#" onclick="openUrl('https://github.com/meetrice/vscode-mysql-instant-query/issues')">GitHub Issues</a></td></tr>
                </table>
            </div>
        </div>

        <div class="actions">
            <button class="btn btn-primary" id="saveBtn">${settings.save}</button>
            <button class="btn btn-secondary" onclick="closeSettings()">${settings.cancel}</button>
        </div>
    </div>

    <script>
        const settings = ${settingsJson};
        const vscode = acquireVsCodeApi();

        let currentData = {};

        // Sidebar navigation
        document.querySelectorAll('.sidebar-item').forEach(item => {
            item.addEventListener('click', () => {
                document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
                document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
                item.classList.add('active');
                const section = document.getElementById('section-' + item.dataset.section);
                if (section) section.classList.add('active');
            });
        });

        // Save
        document.getElementById('saveBtn').addEventListener('click', () => {
            const data = {
                language: document.getElementById('languageSelect').value,
                dataLimit: parseInt(document.getElementById('dataLimitInput').value, 10) || 5000,
            };
            vscode.postMessage({ command: 'saveSettings', data: data });
        });

        function closeSettings() {
            vscode.postMessage({ command: 'cancel' });
        }

        function openKeybindings(filter) {
            vscode.postMessage({ command: 'openKeybindings', filter: filter });
        }

        function exportSettings() {
            vscode.postMessage({ command: 'exportSettings' });
        }

        function importSettings() {
            vscode.postMessage({ command: 'importSettings' });
        }

        function openUrl(url) {
            vscode.postMessage({ command: 'openUrl', url: url });
        }

        // Receive init data
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'initSettings') {
                const d = message.data;
                currentData = d;
                document.getElementById('languageSelect').value = d.language || 'en';
                document.getElementById('dataLimitInput').value = d.dataLimit || 5000;
                document.getElementById('keyRunQueryDisplay').textContent = d.keybindingRunQuery || 'ctrl+alt+e';
                document.getElementById('keyOpenTableDisplay').textContent = d.keybindingOpenTable || 'cmd+shift+t';
                document.getElementById('aboutName').textContent = d.pluginName || 'Mysql Instant Query';
                document.getElementById('aboutVersion').textContent = d.pluginVersion || '0.8.8';
            }
        });

        vscode.postMessage({ command: 'ready' });
    </script>
</body>
</html>`;
    }
}
