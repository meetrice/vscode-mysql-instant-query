#!/bin/bash

# VSCode Extension Publish Script
# Version: 0.7.1

echo "======================================"
echo "  MySQL Instant Query Extension"
echo "  Publishing Version 0.8.3"
echo "======================================"
echo ""

# Step 1: Clean and compile
echo "📦 Step 1: Cleaning and compiling..."
rm -rf out/
npm run compile

if [ $? -ne 0 ]; then
    echo "❌ Compilation failed!"
    exit 1
fi
echo "✅ Compilation successful!"
echo ""

# Step 2: Package the extension
echo "📦 Step 2: Packaging extension..."
vsce package

if [ $? -ne 0 ]; then
    echo "❌ Packaging failed!"
    exit 1
fi
echo "✅ Packaging successful!"
echo ""

# Step 3: Publish to marketplace
echo "📦 Step 3: Publishing to VSCode Marketplace..."
vsce publish

if [ $? -ne 0 ]; then
    echo "❌ Publishing failed!"
    exit 1
fi
echo "✅ Publishing successful!"
echo ""

# Step 4: Git commit
echo "📝 Step 4: Git commit recommended changes..."
echo "git add package.json RELEASE_NOTES.md"
echo 'git commit -m "chore: release version 0.8.3"'
echo "git tag v0.8.3"
echo ""

echo "======================================"
echo "  ✅ Version 0.8.3 Published!"
echo "======================================"
echo ""
echo "Extension published to marketplace:"
echo "https://marketplace.visualstudio.com/items?itemName=meetrice.mysql-instant-query"
echo ""
