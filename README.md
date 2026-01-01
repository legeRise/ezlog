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

### Step 1: Download the latest version

Visit the releases page: https://github.com/legeRise/ezviewer/releases

Click on the latest `ezviewer-linux-x64-v*.tar.gz` file to download it.

Or use command line:
```bash
cd ~/Downloads
wget https://github.com/legeRise/ezviewer/releases/download/v1.0.0/ezviewer-linux-x64-v1.0.0.tar.gz
```

### Step 2: Extract the archive

```bash
tar -xzf ezviewer-linux-x64-v1.0.0.tar.gz
cd ezviewer-linux-x64
```

### Step 3: Install system-wide

```bash
sudo ./install.sh
```

This will install ezviewer to `/usr/local/ezviewer/` and make it available system-wide.

### Step 4: Verify installation

Open a new terminal and run:
```bash
ezviewer --help
```

If you see the help message, installation was successful.

### Step 5: Clean up

Now that ezviewer is installed system-wide, you can delete the download folder:
```bash
cd ~/Downloads
rm -rf ezviewer-linux-x64
rm ezviewer-linux-x64-v1.0.0.tar.gz
```

### Step 6: Use ezviewer

```bash
ezviewer add myapp /var/log/myapp.log
ezviewer list
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

### Example Scenario: Managing Multiple Project Logs

Let's say you're a developer working on a server with 5 different projects, each with their own log files in different locations:

```
/var/log/nginx/access.log
/home/user/myapp/logs/app.log
/opt/api-server/logs/api.log
/var/www/website/errors.log
/home/user/scripts/cron.log
```

Instead of remembering these long paths and using `tail -f` for each one, ezviewer lets you organize them.

### Step 1: Add logs with aliases

An **alias** is a short nickname you give to a log file. Instead of typing the full path, you use the alias.

```bash
# Syntax: ezviewer add <alias> <full-path-to-log-file>

ezviewer add nginx /var/log/nginx/access.log
ezviewer add myapp /home/user/myapp/logs/app.log
ezviewer add api /opt/api-server/logs/api.log
ezviewer add website /var/www/website/errors.log
ezviewer add cron /home/user/scripts/cron.log
```

After each command, you'll see:
```
Added nginx -> /var/log/nginx/access.log
```

### Step 2: Verify logs are tracked

Check all tracked logs:
```bash
ezviewer list
```

Output:
```
nginx           /var/log/nginx/access.log
myapp           /home/user/myapp/logs/app.log
api             /opt/api-server/logs/api.log
website         /var/www/website/errors.log
cron            /home/user/scripts/cron.log
```

Now you can see all your logs and their aliases at a glance.

### Step 3: Start the web viewer

```bash
ezviewer run
```

Output:
```
Starting ezviewer on http://0.0.0.0:9200
```

### Step 4: View logs in your browser

Open your browser and go to: `http://localhost:9200`

You'll see a web interface with all your tracked logs listed. Click any alias (nginx, myapp, api, etc.) to view that log in real-time.

### Managing Your Logs

**Update a log path:**
```bash
# If your log file moves to a new location
ezviewer update myapp /home/user/newpath/app.log
```

**Remove a log:**
```bash
# Stop tracking a log file
ezviewer remove cron
```

**Custom port and host:**
```bash
# Run on a different port
ezviewer run --port 8000

# Run on localhost only (more secure)
ezviewer run --port 9200 --host 127.0.0.1
```

### Where is tracking data stored?

All your tracked logs are saved in: `~/.ezviewer/tracked_logs.json`

This means each user on the system can track their own logs independently.

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
