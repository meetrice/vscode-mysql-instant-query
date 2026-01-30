# 多语言功能说明 / Internationalization (i18n)

本插件现已支持多语言功能,可根据 VSCode 的界面语言自动切换显示相应的语言。

This extension now supports multiple languages and automatically switches the display language based on VSCode's interface language.

## 支持的语言 / Supported Languages

- 🇺🇸 **English** (en)
- 🇨🇳 **简体中文** (zh-cn)

## 工作原理 / How It Works

1. **自动检测语言 / Auto-detection**
   - 插件会自动读取 VSCode 的当前语言设置 (`vscode.env.language`)
   - The extension automatically reads VSCode's current language setting

2. **语言包加载 / Language Pack Loading**
   - 根据检测到的语言加载对应的语言包文件
   - Loads the appropriate language pack file based on the detected language
   - 如果找不到对应的语言包,则默认使用英文
   - Falls back to English if the corresponding language pack is not found

3. **VSCode UI 翻译 / VSCode UI Translation**
   - 使用 VSCode 的标准国际化方案 (`package.nls.json`)
   - Uses VSCode's standard internationalization approach
   - 所有命令、视图标题等都会自动翻译
   - All commands, view titles, etc. are automatically translated

4. **运行时消息翻译 / Runtime Message Translation**
   - 使用自定义的 i18n 工具类 (`src/common/i18n.ts`)
   - Uses custom i18n utility class
   - 支持动态消息翻译,如提示、警告、错误信息等
   - Supports dynamic message translation for prompts, warnings, errors, etc.

## 文件结构 / File Structure

```
├── package.nls.json                 # 默认语言包(英文) / Default language pack (English)
├── package.nls.en.json              # 英文语言包 / English language pack
├── package.nls.zh-cn.json           # 简体中文语言包 / Simplified Chinese language pack
├── language/
│   ├── messages.en.json             # 英文运行时消息 / English runtime messages
│   ├── messages.zh-cn.json          # 简体中文运行时消息 / Simplified Chinese runtime messages
│   ├── package.nls.en.json          # 英文 UI 翻译 / English UI translations
│   └── package.nls.zh-cn.json       # 简体中文 UI 翻译 / Simplified Chinese UI translations
└── src/common/i18n.ts               # 多语言管理工具类 / i18n utility class
```

## 如何添加新语言 / How to Add a New Language

### 1. 创建 VSCode UI 语言包 / Create VSCode UI Language Pack

在项目根目录创建 `package.nls.{locale}.json`:

Create `package.nls.{locale}.json` in the project root:

```json
{
    "displayName": "...",
    "description": "...",
    "commands.mysqlInstantQuery.refresh.title": "...",
    ...
}
```

### 2. 创建运行时消息语言包 / Create Runtime Message Language Pack

在 `language/` 目录创建 `messages.{locale}.json`:

Create `messages.{locale}.json` in the `language/` directory:

```json
{
    "warning.collapseExpand": "...",
    "button.continue": "...",
    ...
}
```

### 3. 更新语言映射 / Update Language Mapping

在 `src/common/i18n.ts` 的 `localeMap` 中添加新语言映射:

Add new language mapping in `localeMap` of `src/common/i18n.ts`:

```typescript
const localeMap: { [key: string]: string } = {
    'zh-cn': 'zh-cn',
    'en': 'en',
    'ja': 'ja',  // 添加新语言 / Add new language
    ...
};
```

## 在代码中使用多语言 / Using i18n in Code

### 获取翻译文本 / Get Translated Text

```typescript
import { I18n } from './common/i18n';

// 简单翻译 / Simple translation
const message = I18n.t("warning.collapseExpand");

// 带参数的翻译 / Translation with parameters
const message = I18n.format("confirmation.dropTable", ["database", "table"]);
// 结果 / Result: "Are you sure you want to drop table `database`.`table`? ..."
```

### 添加新的翻译键 / Add New Translation Keys

1. 在 `language/messages.en.json` 中添加英文翻译:
   Add English translation in `language/messages.en.json`:
   ```json
   {
       "my.new.message": "My new message with {0} parameter"
   }
   ```

2. 在 `language/messages.zh-cn.json` 中添加中文翻译:
   Add Chinese translation in `language/messages.zh-cn.json`:
   ```json
   {
       "my.new.message": "我的新消息,带{0}个参数"
   }
   ```

3. 在代码中使用:
   Use in code:
   ```typescript
   const message = I18n.format("my.new.message", ["1"]);
   ```

## 切换 VSCode 语言 / Changing VSCode Language

要切换 VSCode 的界面语言:

To change VSCode's interface language:

1. 按 `Ctrl+Shift+P` (或 `Cmd+Shift+P` on Mac) 打开命令面板
   Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac) to open Command Palette

2. 输入 "Configure Display Language"
   Type "Configure Display Language"

3. 选择你想要的语言
   Select your desired language

4. 重启 VSCode
   Restart VSCode

插件会自动检测并使用新的语言。

The extension will automatically detect and use the new language.
