# EZViewer - Simple Log Viewer for Linux Servers

A standalone, web-based log viewer with real-time streaming.

## Features

- 📊 Real-time log streaming via WebSockets
- 📁 Track multiple logs with simple aliases
- 🌐 Web interface for easy viewing
- 🚀 Standalone binary - no Python installation needed
- ⚡ Fast and lightweight - ~15MB total size
- 🔧 Simple CLI for log management

---

## 🚀 Quick Start (For Users)

1. Download the latest binary from releases
2. Extract and install:
   ```bash
   tar -xzf ezviewer-linux-x64.tar.gz
   cd ezviewer-linux-x64
   sudo ./install.sh
   ```

3. Use it:
   ```bash
   ezviewer add myapp /var/log/myapp.log
   ezviewer run
   # Open browser: http://localhost:9200
   ```

---

## 🛠️ Build from Source (For Developers)

1. Clone the repository:
   ```bash
   git clone https://github.com/legerise/ezviewer.git
   cd ezviewer
   ```

2. Build the binary:
   ```bash
   chmod +x build.sh
   ./build.sh
   ```
   This creates `dist/ezviewer/` with the standalone binary.

3. Install system-wide:
   ```bash
   sudo ./install.sh
   ```
   This installs the binary to `/usr/local/ezviewer/` and creates a symlink at `/usr/local/bin/ezviewer`.

---

## 📖 Usage

### Track log files

```bash
# Add a log file
ezviewer add myapp /var/log/myapp.log

# List tracked logs
ezviewer list

# Remove a tracked log
ezviewer remove myapp

# Update log path
ezviewer update myapp /var/log/newpath.log
```

### Start the web server

```bash
# Start on default port (9200)
ezviewer run

# Custom port and host
ezviewer run --port 8000 --host 127.0.0.1
```

Then open your browser to `http://localhost:9200`

## Requirements

- **Build time**: Python 3.9+, pip, PyInstaller
- **Runtime**: None! The binary is completely standalone

## How it works

1. Track log files with aliases
2. Start the web server
3. View logs in real-time through your browser
4. WebSocket streams new log lines as they're written

## Uninstall

```bash
sudo rm -rf /usr/local/ezviewer
sudo rm /usr/local/bin/ezviewer
rm -rf ~/.ezviewer  # Optional: removes tracked log config
```

## Development

Run in development mode:

```bash
pip install -r requirements.txt
python cli.py run --port 9200
```

## License

MIT
