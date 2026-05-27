import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

/**
 * 多语言管理类
 */
export class I18n {
    private static messages: any = {};
    private static locale: string = "en";
    private static extensionPath: string = "";

    /**
     * 初始化多语言
     */
    public static init(context: vscode.ExtensionContext) {
        this.extensionPath = context.extensionPath;
        this.locale = this.getVSCodeLocale();
        this.loadMessages(this.locale);
    }

    /**
     * 获取当前语言
     */
    public static getLocale(): string {
        return this.locale;
    }

    /**
     * 运行时切换语言
     */
    private static localeChangeListeners: Array<() => void> = [];

    public static onLocaleChange(listener: () => void): void {
        this.localeChangeListeners.push(listener);
    }

    public static setLocale(locale: string): void {
        this.locale = locale;
        this.loadMessages(locale);
        this.localeChangeListeners.forEach((listener) => listener());
    }

    private static getVSCodeLocale(): string {
        return vscode.env.language || "en";
    }

    /**
     * 加载语言包
     */
    private static loadMessages(locale: string) {
        try {
            const localeMap: { [key: string]: string } = {
                "zh": "zh-cn",
                "zh-cn": "zh-cn",
                "zh-hans": "zh-cn",
                "zh-hans-cn": "zh-cn",
                "zh-tw": "zh-cn",
                "zh-hant": "zh-cn",
                "zh-hant-tw": "zh-cn",
                "en": "en",
                "en-us": "en",
                "en-gb": "en",
            };

            const localeKey = localeMap[locale.toLowerCase()] || "en";
            const languageFile = path.join(this.extensionPath, "language", `messages.${localeKey}.json`);

            if (fs.existsSync(languageFile)) {
                const content = fs.readFileSync(languageFile, "utf-8");
                this.messages = JSON.parse(content);
                return;
            }

            const defaultLanguageFile = path.join(this.extensionPath, "language", "messages.en.json");
            if (fs.existsSync(defaultLanguageFile)) {
                const content = fs.readFileSync(defaultLanguageFile, "utf-8");
                this.messages = JSON.parse(content);
            }
        } catch (error) {
            console.error("Failed to load language pack:", error);
        }
    }

    /**
     * 根据键名获取翻译文本
     */
    public static t(key: string, defaultValue?: string): string {
        return this.messages[key] || defaultValue || key;
    }

    /**
     * 格式化翻译文本(支持参数替换)
     */
    public static format(key: string, args: any[] | any = []): string {
        let message = this.t(key);
        if (Array.isArray(args)) {
            args.forEach((arg, index) => {
                message = message.replace(`{${index}}`, arg);
            });
        } else if (args && typeof args === "object") {
            Object.keys(args).forEach((argKey) => {
                message = message.replace(`{${argKey}}`, args[argKey]);
            });
        }
        return message;
    }
}
