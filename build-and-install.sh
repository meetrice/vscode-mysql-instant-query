#!/bin/bash
# 编译、打包、安装 Cursor 插件脚本
set -e  # 遇到错误时退出

CURSOR_CMD="${CURSOR_CMD:-cursor}"

if ! command -v "$CURSOR_CMD" &>/dev/null; then
    echo "错误: 未找到 Cursor CLI ($CURSOR_CMD)"
    echo "请确认 Cursor 已安装，并在 PATH 中可用（或设置 CURSOR_CMD 环境变量）"
    exit 1
fi

echo "========================================="
echo "0. 卸载旧版本插件..."
echo "========================================="
"$CURSOR_CMD" --list-extensions 2>/dev/null | grep -i mysql | while read -r ext; do
    echo "正在卸载: $ext"
    "$CURSOR_CMD" --uninstall-extension "$ext" 2>/dev/null || true
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
echo "3. 安装扩展到 Cursor..."
echo "========================================="
# 查找生成的 vsix 文件
VSIX_FILE=$(ls -t mysql-instant-query-*.vsix 2>/dev/null | head -1)

if [ -z "$VSIX_FILE" ]; then
    echo "错误: 未找到 VSIX 文件"
    exit 1
fi

echo "找到 VSIX 文件: $VSIX_FILE"
VSIX_ABS_PATH="$(cd "$(dirname "$VSIX_FILE")" && pwd)/$(basename "$VSIX_FILE")"
INSTALL_CMD="$CURSOR_CMD --install-extension \"$VSIX_ABS_PATH\" --force"
echo ""
echo "执行安装命令:"
echo "  $INSTALL_CMD"
echo ""

# NODE_NO_WARNINGS=1 用于屏蔽 Node punycode 等 DeprecationWarning
NODE_NO_WARNINGS=1 "$CURSOR_CMD" --install-extension "$VSIX_ABS_PATH" --force

echo ""
echo "========================================="
echo "✅ 完成! 请重新加载 Cursor 窗口以使用更新后的扩展"
echo "   命令面板 → Developer: Reload Window"
echo "========================================="
