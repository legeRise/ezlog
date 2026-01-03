#!/bin/bash
set -e

echo "🔨 Building ezlog with PyInstaller..."

# Check if PyInstaller is installed
if ! command -v pyinstaller &> /dev/null; then
    echo "📦 Installing PyInstaller..."
    # Use uv if available (modern, faster), otherwise fall back to pip
    if command -v uv &> /dev/null; then
        echo "Using uv..."
        uv pip install pyinstaller
    else
        pip install pyinstaller
    fi
fi

# Clean previous builds
echo "🧹 Cleaning previous builds..."
rm -rf build dist

# Build with PyInstaller
echo "🚀 Building standalone binary..."
pyinstaller ezlog.spec

# Check if build was successful
if [ -f "dist/ezlog/ezlog" ]; then
    echo "✅ Build successful!"
    echo ""
    echo "📁 Binary location: dist/ezlog/ezlog"
    echo ""
    echo "🧪 Test with:"
    echo "  ./dist/ezlog/ezlog --help"
    echo "  ./dist/ezlog/ezlog add test /tmp/test.log"
    echo "  ./dist/ezlog/ezlog list"
    echo "  ./dist/ezlog/ezlog run --port 8000"
    echo ""
    echo "📦 To install system-wide, run: sudo ./install.sh"
else
    echo "❌ Build failed!"
    exit 1
fi
