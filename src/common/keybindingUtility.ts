import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { I18n } from "./i18n";

interface KeybindingRule {
    command?: string;
    key?: string;
    mac?: string;
    win?: string;
    linux?: string;
}

export class KeybindingUtility {
    public static getKeybindingForCommand(context: vscode.ExtensionContext, commandId: string): string {
        const defaultKey = KeybindingUtility.getDefaultKeybinding(context, commandId);
        const userPath = KeybindingUtility.getUserKeybindingsPath();

        if (!fs.existsSync(userPath)) {
            return defaultKey || I18n.t("settings.shortcuts.unassigned", "Unassigned");
        }

        try {
            const userRules = KeybindingUtility.parseKeybindingsJson(fs.readFileSync(userPath, "utf-8"));
            const keys: string[] = defaultKey ? [defaultKey] : [];

            for (const rule of userRules) {
                const command = rule.command || "";
                const isRemoval = command.startsWith("-");
                const ruleCommand = isRemoval ? command.slice(1) : command;

                if (ruleCommand !== commandId) {
                    continue;
                }

                if (isRemoval) {
                    if (rule.key) {
                        const keyToRemove = KeybindingUtility.resolvePlatformKey(rule);
                        const index = keys.indexOf(keyToRemove);
                        if (index >= 0) {
                            keys.splice(index, 1);
                        }
                    } else {
                        keys.length = 0;
                    }
                    continue;
                }

                const key = KeybindingUtility.resolvePlatformKey(rule);
                if (key && keys.indexOf(key) < 0) {
                    keys.push(key);
                }
            }

            if (keys.length > 0) {
                return keys.join(", ");
            }
            return I18n.t("settings.shortcuts.unassigned", "Unassigned");
        } catch {
            return defaultKey || I18n.t("settings.shortcuts.unassigned", "Unassigned");
        }
    }

    public static watchUserKeybindings(onChange: () => void): vscode.Disposable {
        const userPath = KeybindingUtility.getUserKeybindingsPath();
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(path.dirname(userPath), path.basename(userPath))
        );
        watcher.onDidChange(onChange);
        watcher.onDidCreate(onChange);
        watcher.onDidDelete(onChange);
        return watcher;
    }

    private static getDefaultKeybinding(context: vscode.ExtensionContext, commandId: string): string {
        const rules: KeybindingRule[] = context.extension.packageJSON.contributes?.keybindings ?? [];
        const rule = rules.find((item) => item.command === commandId);
        if (!rule) {
            return I18n.t("settings.shortcuts.unassigned", "Unassigned");
        }
        return KeybindingUtility.resolvePlatformKey(rule);
    }

    private static resolvePlatformKey(rule: KeybindingRule): string {
        if (process.platform === "darwin" && rule.mac) {
            return rule.mac;
        }
        if (process.platform === "win32" && rule.win) {
            return rule.win;
        }
        if (process.platform === "linux" && rule.linux) {
            return rule.linux;
        }
        return rule.key || "";
    }

    private static getUserKeybindingsPath(): string {
        if (process.env.VSCODE_PORTABLE) {
            return path.join(process.env.VSCODE_PORTABLE, "user-data", "User", "keybindings.json");
        }

        const appName = vscode.env.appName;
        switch (process.platform) {
            case "darwin":
                return path.join(os.homedir(), "Library", "Application Support", appName, "User", "keybindings.json");
            case "win32":
                return path.join(process.env.APPDATA || "", appName, "User", "keybindings.json");
            default:
                return path.join(os.homedir(), ".config", appName, "User", "keybindings.json");
        }
    }

    private static parseKeybindingsJson(content: string): KeybindingRule[] {
        const stripped = content
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "");
        const parsed = JSON.parse(stripped);
        return Array.isArray(parsed) ? parsed : [];
    }
}
