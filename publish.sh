#!/bin/bash

# GitHub MCP Server Publishing Script

echo "🚀 GitHub MCP Server Publishing Script"
echo "======================================"

# Check if logged in to npm
if ! npm whoami > /dev/null 2>&1; then
    echo "❌ Not logged in to npm. Please run 'npm login' first."
    exit 1
fi

echo "✅ Logged in to npm as: $(npm whoami)"

# Validate package.json
echo "📦 Validating package.json..."
npm run test > /dev/null 2>&1
if [ $? -ne 0 ]; then
    echo "❌ Package validation failed. Check your code."
    exit 1
fi

echo "✅ Package validation passed"

# Check version
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "📋 Current version: $CURRENT_VERSION"

# Ask for version bump
echo "🔢 Choose version bump:"
echo "1) patch (1.0.0 → 1.0.1)"
echo "2) minor (1.0.0 → 1.1.0)" 
echo "3) major (1.0.0 → 2.0.0)"
echo "4) Skip version bump"

read -p "Enter choice (1-4): " choice

case $choice in
    1) npm version patch ;;
    2) npm version minor ;;
    3) npm version major ;;
    4) echo "Skipping version bump" ;;
    *) echo "Invalid choice, skipping version bump" ;;
esac

NEW_VERSION=$(node -p "require('./package.json').version")
echo "📋 Publishing version: $NEW_VERSION"

# Dry run
echo "🧪 Running dry-run..."
npm publish --dry-run

if [ $? -ne 0 ]; then
    echo "❌ Dry-run failed. Fix issues before publishing."
    exit 1
fi

echo "✅ Dry-run successful"

# Confirm publication
read -p "🚀 Ready to publish v$NEW_VERSION to npm? (y/N): " confirm
if [[ $confirm != [yY] ]]; then
    echo "❌ Publication cancelled"
    exit 1
fi

# Publish
echo "📤 Publishing to npm..."
npm publish

if [ $? -eq 0 ]; then
    echo "🎉 Successfully published github-mcp-server-kosta@$NEW_VERSION!"
    echo "📦 Users can now run: npx github-mcp-server-kosta"
    echo "🔗 Package URL: https://www.npmjs.com/package/github-mcp-server-kosta"
else
    echo "❌ Publication failed"
    exit 1
fi