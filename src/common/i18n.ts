import * as vscode from 'vscode';
import * as path from 'path';

/**
 * 多语言管理类
 */
export class I18n {
    private static messages: any = {};

    /**
     * 初始化多语言
     */
    public static init(context: vscode.ExtensionContext) {
        const locale = this.getVSCodeLocale();
        this.loadMessages(context, locale);
    }

    /**
     * 获取 VSCode 当前语言
     */
    private static getVSCodeLocale(): string {
        // 获取 VSCode 的显示语言配置
        const config = vscode.env.language;
        return config || 'en';
    }

    /**
     * 加载语言包
     */
    private static async loadMessages(context: vscode.ExtensionContext, locale: string) {
        try {
            // 支持的语言包映射
            const localeMap: { [key: string]: string } = {
                'zh': 'zh-cn',
                'zh-cn': 'zh-cn',
                'zh-tw': 'zh-cn',
                'en': 'en',
                'en-us': 'en',
                'en-gb': 'en'
            };

            // 获取实际的语言包文件名
            const localeKey = localeMap[locale.toLowerCase()] || 'en';

            // 构建语言包路径
            const languageFile = path.join(context.extensionPath, 'language', `messages.${localeKey}.json`);

            // 读取语言包
            const fs = require('fs');
            if (fs.existsSync(languageFile)) {
                const content = fs.readFileSync(languageFile, 'utf-8');
                this.messages = JSON.parse(content);
            } else {
                // 如果找不到对应的语言包,使用默认的英文包
                const defaultLanguageFile = path.join(context.extensionPath, 'language', 'messages.en.json');
                if (fs.existsSync(defaultLanguageFile)) {
                    const content = fs.readFileSync(defaultLanguageFile, 'utf-8');
                    this.messages = JSON.parse(content);
                }
            }
        } catch (error) {
            console.error('Failed to load language pack:', error);
        }
    }

    /**
     * 根据键名获取翻译文本
     * @param key 翻译键名
     * @param defaultValue 默认值
     */
    public static t(key: string, defaultValue?: string): string {
        return this.messages[key] || defaultValue || key;
    }

    /**
     * 格式化翻译文本(支持参数替换)
     * @param key 翻译键名
     * @param args 参数数组或对象
     */
    public static format(key: string, args: any[] | any = []): string {
        let message = this.t(key);
        if (Array.isArray(args)) {
            // 支持数组形式的参数: {0}, {1}, {2}...
            args.forEach((arg, index) => {
                message = message.replace(`{${index}}`, arg);
            });
        } else if (args && typeof args === 'object') {
            // 支持对象形式的参数: {name}, {age}...
            Object.keys(args).forEach(argKey => {
                message = message.replace(`{${argKey}}`, args[argKey]);
            });
        }
        return message;
    }
}
