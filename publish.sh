#!/bin/bash
# VS Code Extension Publish Script
set -e

VERSION=$(node -p "require('./package.json').version")

echo "======================================"
echo "  MySQL Instant Query Extension"
echo "  Publishing Version ${VERSION}"
echo "======================================"
echo ""

# Check PAT
if [ -z "$VSCE_PAT" ]; then
    echo "⚠️  VSCE_PAT 未设置。"
    echo "   请先创建 Azure DevOps Personal Access Token（Marketplace → Manage）"
    echo "   然后执行: export VSCE_PAT=\"你的_PAT\""
    echo ""
    echo "   详见: docs/publishing.md"
    echo ""
    # Try vsce login cache as fallback
    if ! npx @vscode/vsce ls-publishers 2>/dev/null | grep -q meetrice; then
        echo "❌ 未找到有效的发布凭据，退出。"
        exit 1
    fi
    echo "ℹ️  将尝试使用 vsce login 缓存的凭据..."
fi

# Step 1: Clean and compile
echo "📦 Step 1: Cleaning and compiling..."
rm -rf out/
npm run compile
echo "✅ Compilation successful!"
echo ""

# Step 2: Package the extension
echo "📦 Step 2: Packaging extension..."
npx @vscode/vsce package
echo "✅ Packaging successful! (mysql-instant-query-${VERSION}.vsix)"
echo ""

# Step 3: Publish to marketplace
echo "📦 Step 3: Publishing to VS Code Marketplace..."
npx @vscode/vsce publish
echo "✅ Publishing successful!"
echo ""

# Step 4: Git commit reminder
echo "📝 Step 4: Recommended git steps after publish:"
echo "git add package.json RELEASE_NOTES.md publish.sh"
echo "git commit -m \"chore: release version ${VERSION}\""
echo "git tag v${VERSION}"
echo "git push origin master --tags"
echo ""

echo "======================================"
echo "  ✅ Version ${VERSION} Published!"
echo "======================================"
echo ""
echo "Marketplace:"
echo "https://marketplace.visualstudio.com/items?itemName=meetrice.mysql-instant-query"
echo ""
