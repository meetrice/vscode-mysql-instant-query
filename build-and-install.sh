#!/bin/bash
# 编译、打包、安装 VSCode 插件脚本
#npm run compile && npx vsce package && code --install-extension mysql-instant-query-0.5.5.vsix --force
set -e  # 遇到错误时退出

echo "========================================="
echo "0. 卸载旧版本插件..."
echo "========================================="
# 卸载可能存在的旧版本 code --uninstall-extension meetrice.vscode-mysql
code --list-extensions | grep -i mysql | while read ext; do
    echo "正在卸载: $ext"
    code --uninstall-extension "$ext" 2>/dev/null || true
done
echo "旧版本插件卸载完成"

echo ""
echo "========================================="
echo "1. 编译 TypeScript..."
echo "========================================="
npm run compile

echo ""
echo "========================================="
echo "2. 打包生成 VSIX..."
echo "========================================="
npx vsce package

echo ""
echo "========================================="
echo "3. 安装扩展..."
echo "========================================="
# 查找生成的 vsix 文件
VSIX_FILE=$(ls -t mysql-instant-query-*.vsix 2>/dev/null | head -1)

if [ -z "$VSIX_FILE" ]; then
    echo "错误: 未找到 VSIX 文件"
    exit 1
fi

echo "找到 VSIX 文件: $VSIX_FILE"
code --install-extension "$VSIX_FILE" --force

echo ""
echo "========================================="
echo "4. 同步到 Cursor 扩展目录..."
echo "========================================="
CURSOR_EXT_DIR="$HOME/.cursor/extensions"
if [ -d "$CURSOR_EXT_DIR" ]; then
    # 从 package.json 获取扩展 ID 和版本
    EXT_NAME="meetrice.mysql-instant-query"
    EXT_VERSION=$(node -p "require('./package.json').version")
    EXT_FOLDER="${EXT_NAME}-${EXT_VERSION}"
    VSCODE_SRC="$HOME/.vscode/extensions/${EXT_FOLDER}"
    CURSOR_DST="${CURSOR_EXT_DIR}/${EXT_FOLDER}"

    if [ -d "$VSCODE_SRC" ]; then
        echo "同步 ${EXT_FOLDER} 到 Cursor..."
        rm -rf "$CURSOR_DST"
        cp -r "$VSCODE_SRC" "$CURSOR_DST"
        echo "Cursor 扩展同步完成"
    else
        echo "跳过: VSCode 扩展目录不存在 ${VSCODE_SRC}"
    fi
else
    echo "跳过: Cursor 扩展目录不存在"
fi

echo ""
echo "========================================="
echo "✅ 完成! 请重新加载 VSCode/Cursor 窗口以使用更新后的扩展"
echo "========================================="
