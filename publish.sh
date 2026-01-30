#!/bin/bash

# VSCode Extension Publish Script
# Version: 0.6.0

echo "======================================"
echo "  MySQL Instant Query Extension"
echo "  Publishing Version 0.6.0"
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

# Step 3: Publish to marketplace (uncomment to actually publish)
echo "📦 Step 3: Publishing to VSCode Marketplace..."
echo "⚠️  To publish, uncomment the line below:"
echo "# vsce publish"
echo ""
echo "Or manually publish with:"
echo "vsce publish"
echo ""

# Step 4: Git commit (optional)
echo "📝 Step 4: Git commit recommended changes..."
echo "git add package.json RELEASE_NOTES.md"
echo "git commit -m \"chore: release version 0.6.0\""
echo "git tag v0.6.0"
echo ""

echo "======================================"
echo "  ✅ Ready to publish!"
echo "======================================"
echo ""
echo "Package created: mysql-instant-query-0.6.0.vsix"
echo ""
echo "To publish, run:"
echo "  vsce publish"
echo ""
echo "Or test locally first:"
echo "  code --install-extension mysql-instant-query-0.6.0.vsix"
echo ""
