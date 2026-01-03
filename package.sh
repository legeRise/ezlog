#!/bin/bash
set -e

echo "📦 Packaging ezlog for distribution..."

VERSION="1.0.0"
PACKAGE_NAME="ezlog-linux-x64"
ARCHIVE_NAME="${PACKAGE_NAME}-v${VERSION}.tar.gz"

# Check if binary exists
if [ ! -d "dist/ezlog" ]; then
    echo "❌ Binary not found! Run ./build.sh first."
    exit 1
fi

# Create distribution package
echo "📁 Creating distribution folder..."
rm -rf "$PACKAGE_NAME"
mkdir -p "$PACKAGE_NAME"

# Copy binary folder and install script
cp -r dist/ezlog/* "$PACKAGE_NAME/"
cp install.sh "$PACKAGE_NAME/"
cp README.md "$PACKAGE_NAME/" 2>/dev/null || true

# Make install script executable
chmod +x "$PACKAGE_NAME/install.sh"

# Create tarball
echo "🗜️  Creating tarball..."
tar -czf "$ARCHIVE_NAME" "$PACKAGE_NAME"

# Cleanup
rm -rf "$PACKAGE_NAME"

# Calculate size
SIZE=$(du -h "$ARCHIVE_NAME" | cut -f1)

echo "✅ Package created: $ARCHIVE_NAME ($SIZE)"
echo ""
echo "📤 Distribution options:"
echo ""
echo "1. GitHub Releases:"
echo "   - Go to your repository's Releases page"
echo "   - Upload: $ARCHIVE_NAME"
echo "   - Users download and extract"
echo ""
echo "2. Direct server hosting:"
echo "   scp $ARCHIVE_NAME user@yourserver.com:/path/to/downloads/"
echo "   wget https://yourserver.com/downloads/$ARCHIVE_NAME"
echo ""
echo "3. Share directly:"
echo "   Just send the $ARCHIVE_NAME file to users"
echo ""
echo "Users install with:"
echo "   tar -xzf $ARCHIVE_NAME"
echo "   cd $PACKAGE_NAME"
echo "   sudo ./install.sh"
