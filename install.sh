#!/bin/bash
set -e

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo "Please run as root: sudo ./install.sh"
    exit 1
fi

INSTALL_DIR="/usr/local/ezlog"
BIN_LINK="/usr/local/bin/ezlog"

# Get the directory where the script resides (resolves symlinks)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "📦 Installing ezlog..."
echo "  Script dir: $SCRIPT_DIR"

# Check if binary exists (handle both packaged and source directory)
if [ -f "$SCRIPT_DIR/ezlog" ]; then
    # Running from extracted package (binary is next to install.sh)
    SOURCE_DIR="$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/dist/ezlog/ezlog" ]; then
    # Running from source directory (binary is in dist/)
    SOURCE_DIR="$SCRIPT_DIR/dist/ezlog"
else
    echo "❌ Binary not found!"
    echo "Looked in:"
    echo "  - $SCRIPT_DIR/ezlog"
    echo "  - $SCRIPT_DIR/dist/ezlog/ezlog"
    echo "If building from source, run ./build.sh first."
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

# Copy binary and assets to installation directory
echo "📁 Copying files to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cp -r "$SOURCE_DIR"/* "$INSTALL_DIR/"

# Make executable
chmod +x "$INSTALL_DIR/ezlog"

# Create symlink
echo "🔗 Creating symlink in /usr/local/bin..."
ln -s "$INSTALL_DIR/ezlog" "$BIN_LINK"

echo "✅ Installation complete!"
echo ""
echo "🎉 ezlog is now installed system-wide!"
echo ""
echo "Usage:"
echo "  ezlog add <alias> <path>    # Track a log file"
echo "  ezlog list                  # List tracked logs"
echo "  ezlog remove <alias>        # Remove tracked log"
echo "  ezlog run --port 9200       # Start web server"
echo ""
echo "Example:"
echo "  ezlog add myapp /var/log/myapp.log"
echo "  ezlog run"
echo "  # Open browser: http://localhost:9200"
