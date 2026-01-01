#!/bin/bash
set -e

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo "Please run as root: sudo ./install.sh"
    exit 1
fi

INSTALL_DIR="/usr/local/ezviewer"
BIN_LINK="/usr/local/bin/ezviewer"

echo "📦 Installing ezviewer..."

# Check if binary exists
if [ ! -f "dist/ezviewer/ezviewer" ]; then
    echo "❌ Binary not found! Run ./build.sh first."
    exit 1
fi

# Remove old installation if exists
if [ -d "$INSTALL_DIR" ]; then
    echo "🗑️  Removing old installation..."
    rm -rf "$INSTALL_DIR"
fi

if [ -L "$BIN_LINK" ]; then
    rm -f "$BIN_LINK"
fi

# Copy binary to installation directory
echo "📁 Copying files to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cp -r dist/ezviewer/* "$INSTALL_DIR/"

# Make executable
chmod +x "$INSTALL_DIR/ezviewer"

# Create symlink
echo "🔗 Creating symlink in /usr/local/bin..."
ln -s "$INSTALL_DIR/ezviewer" "$BIN_LINK"

echo "✅ Installation complete!"
echo ""
echo "🎉 ezviewer is now installed system-wide!"
echo ""
echo "Usage:"
echo "  ezviewer add <alias> <path>    # Track a log file"
echo "  ezviewer list                  # List tracked logs"
echo "  ezviewer remove <alias>        # Remove tracked log"
echo "  ezviewer run --port 9200       # Start web server"
echo ""
echo "Example:"
echo "  ezviewer add myapp /var/log/myapp.log"
echo "  ezviewer run"
echo "  # Open browser: http://localhost:9200"
