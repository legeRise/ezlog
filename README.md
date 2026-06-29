# EZLog - Simple Log Viewer for Linux Servers

A standalone, web-based log viewer with real-time streaming.

## Features

- 📊 Real-time log streaming via WebSockets
- 📁 Track multiple logs with simple aliases
- 🗂️ **Project grouping** - group related logs under collapsible project sections
- 📂 **Folder import** - add all `.log` files from a folder as a project (`ezlog add-folder`)
- 🌐 Web interface for easy viewing
- 🚀 Standalone binary - no Python installation needed
- ⚡ Fast loading - shows last 500 lines instantly
- 🔄 Infinite scroll - loads history as you scroll up
- 🎯 Navigation buttons - jump to top/bottom quickly
- ⏸️ Pause/Resume - buffer logs while you read
- 🔍 Real-time filtering
- 🔎 Full-file search (press Enter in filter box)
- 🎨 Multiple themes (Dark, Light, Solarized)
- 📱 Mobile responsive
- 🔧 Simple CLI for log management
- 🔗 Route-based log tabs (`/logs/<alias>`)
- ✂️ Bulk remove (`ezlog remove alias1 alias2 alias3`)
- ⬆️ One-command self-upgrade (`ezlog upgrade`)

---

## 🚀 Quick Start (For Users)

### Step 1: Download the latest version

Visit the releases page: [https://github.com/legeRise/ezlog/releases](https://github.com/legeRise/ezlog/releases/latest/download/ezlog-linux-x64.tar.gz)

Or use command line:
```bash
cd ~/Downloads
wget https://github.com/legeRise/ezlog/releases/latest/download/ezlog-linux-x64.tar.gz
```

### Step 2: Extract the archive

```bash
tar -xzf ezlog-linux-x64.tar.gz
cd ezlog-linux-x64
```

### Step 3: Install system-wide

```bash
sudo ./install.sh
```

This will install ezlog to `/usr/local/ezlog/` and make it available system-wide.

### Step 4: Verify installation

Open a new terminal and run:
```bash
ezlog --help
```

If you see the help message, installation was successful.

### Step 5: Clean up

Now that ezlog is installed system-wide, you can delete the download folder:
```bash
cd ~/Downloads
rm -rf ezlog-linux-x64
rm ezlog-linux-x64.tar.gz
```

### Step 6: Use ezlog

```bash
ezlog add myapp /var/log/myapp.log
ezlog list
ezlog start
# Open browser: http://localhost:9200
```

### Step 7: Upgrade later (easy)

When a new release is available (v1.1.0+), just run:

```bash
ezlog upgrade
```

What it does:
- Downloads latest release tarball
- Compares installed binary vs downloaded binary
- Skips install if already up-to-date
- Stops running ezlog (if running), installs new release, restarts it
- Reuses last host/port automatically on restart

**On v1.0.5 (pre-upgrade command)?** Use this one-liner:

```bash
sudo curl -L https://github.com/legeRise/ezlog/releases/latest/download/ezlog-linux-x64.tar.gz | sudo tar -xz -C /tmp && sudo /tmp/ezlog-linux-x64/install.sh && sudo rm -rf /tmp/ezlog-linux-x64
```

Or just reinstall from scratch following [Steps 1-5](#-quick-start-for-users).

![EZLog Dashboard](docs/images/dashboard.png)
*Screenshot: Main view showing log list in sidebar*

---
## Auth

EZLog does not include built-in authentication. If you expose it on a server, put it behind Nginx Basic Auth.

First, create a password file:

```bash
sudo apt update
sudo apt install apache2-utils -y
sudo htpasswd -c /etc/nginx/.ezlog_htpasswd yourusername
```

Then add Basic Auth inside the Nginx `location` block that proxies EZLog:

```nginx
location / {
    auth_basic "EZLog";
    auth_basic_user_file /etc/nginx/.ezlog_htpasswd;

    proxy_pass http://127.0.0.1:9200;
}
```

Use HTTPS at the proxy when exposing EZLog beyond a trusted local network.

---

## 🛠️ Build from Source (For Developers)

1. Clone the repository:
   ```bash
   git clone https://github.com/legerise/ezlog.git
   cd ezlog
   ```

2. **(Optional)** Bump the version number in `cli.py`:
   ```bash
   # Edit cli.py and change:
   EZLOG_VERSION = "1.0.5"   →   EZLOG_VERSION = "1.1.0"
   ```

3. Build the binary:
   ```bash
   chmod +x build.sh
   ./build.sh
   ```
   This creates `dist/ezlog/` with the standalone binary.

4. Package for distribution:
   ```bash
   chmod +x package.sh
   ./package.sh
   ```
   This creates `ezlog-linux-x64.tar.gz` — ready for GitHub Releases or sharing.

   **Build workflow summary:**
   ```
   Bump version in cli.py → ./build.sh → ./package.sh
   ```

   Notes:
   - `build.sh` compiles a fresh binary using PyInstaller.
   - `package.sh` does **not** compile; it only packages `dist/ezlog` into a tarball.
   - Always bump the version **before** building so the binary reports the correct version.

3. Install system-wide:
   ```bash
   sudo ./install.sh
   ```
   This installs the binary to `/usr/local/ezlog/` and creates a symlink at `/usr/local/bin/ezlog`.

4. Create distribution tarball:

   ```bash
   chmod +x package.sh
   ./package.sh
   ```

   This creates `ezlog-linux-x64.tar.gz` for GitHub Releases or direct sharing.

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

Instead of remembering these long paths and using `tail -f` for each one, ezlog lets you organize them.

### Step 1: Add logs with aliases

An **alias** is a short nickname you give to a log file. Instead of typing the full path, you use the alias.

```bash
# Syntax: ezlog add <alias> <full-path-to-log-file>

```bash
ezlog add nginx /var/log/nginx/access.log
ezlog add myapp /home/user/myapp/logs/app.log
ezlog add api /opt/api-server/logs/api.log
ezlog add website /var/www/website/errors.log
ezlog add cron /home/user/scripts/cron.log
```

After each command, you'll see:
```
Added nginx -> /var/log/nginx/access.log
```

### Step 2: Verify logs are tracked

Check all tracked logs (grouped by project):
```bash
ezlog list
```

Output (flat aliases):
```
nginx           /var/log/nginx/access.log
myapp           /home/user/myapp/logs/app.log
```

Output (project-grouped using dot notation, e.g. `project.sub_alias`):
```
📁 myapp:
  • access             /var/log/nginx/access.log
  • api                /opt/api-server/logs/api.log

📁 website:
  • errors             /var/www/website/errors.log
  • cron               /home/user/scripts/cron.log
```

Now you can see all your logs and their aliases at a glance.

### Step 3: Start ezlog

```bash
ezlog start
```

Output:
```
✅ Started ezlog in background (PID: 12345)
🌐 Visit http://0.0.0.0:9200
⏹️  Stop with: ezlog stop
```

### Step 4: View logs in your browser

Open your browser and go to: `http://localhost:9200`

You'll see a web interface with all your tracked logs listed. Click any alias (nginx, myapp, api, etc.) to view that log in real-time.

Tip: type in the filter box to filter currently loaded lines. Press **Enter** to search the entire file and show global matches.

Each selected log updates the URL to `/logs/<alias>`, so you can open different aliases in different tabs and share direct links.

![Log Viewer](docs/images/bottom.png)
*Screenshot: Log file selected and displaying live logs*

![Top View](docs/images/top.png)
*Screenshot: Scrolled to top of log file showing oldest entries*

### Managing Your Logs

**Add a folder of logs (project grouping):**
```bash
# Add all .log files from a folder as a project
ezlog add-folder /var/log/myapp/

# Custom project name
ezlog add-folder /var/log/myapp/ --project production

# Use a custom extension pattern
ezlog add-folder /var/log/nginx/ --pattern "*.access.log"

# Include ALL files (not just .log)
ezlog add-folder /var/log/myapp/ --all

# Short flags
ezlog add-folder /var/log/myapp/ -p myapp -a
```

All files are added as `project.filename` (e.g. `myapp.app`, `myapp.error`).  
In the web UI, they appear grouped under a collapsible project section.

**Update a log path:**
```bash
# If your log file moves to a new location
ezlog update myapp /home/user/newpath/app.log
```

**Remove logs (single, bulk, or by project):**
```bash
# Remove a single log
ezlog remove myapp.api

# Remove multiple logs at once
ezlog remove myapp.api myapp.error myapp.cron

# Remove an entire project group
ezlog remove --project myapp
ezlog remove --project myapp --yes     # Skip confirmation
```

**Remove all tracked logs (with confirmation):**
```bash
ezlog clear
# or non-interactive
ezlog clear --yes
```

**Check tracked logs health (missing paths):**
```bash
ezlog check
ezlog check --missing-only
```

**Prune dead aliases automatically:**
```bash
ezlog prune
ezlog prune --project myapp      # Scope to a project
# or non-interactive
ezlog prune --yes
```

**Custom port and host:**
```bash
# Run on a different port
ezlog start --port 8000

# Run on localhost only (more secure)
ezlog start --port 9200 --host 127.0.0.1
```

**Process management:**
```bash
ezlog version         # Show version + install details
ezlog status          # Check if running
ezlog stop            # Stop background process
ezlog start           # Start in background
ezlog run             # Run in foreground (for debugging)
ezlog upgrade         # Auto-download and install latest release
```

**Upgrade options:**
```bash
ezlog upgrade --check-only               # Only check if update exists
ezlog upgrade --yes                       # Non-interactive
ezlog upgrade --no-restart                # Install only
ezlog upgrade --port 9200 --host 0.0.0.0 # Restart target
```

### Where is tracking data stored?

All your tracked logs are saved in: `~/.ezlog/tracked_logs.json`

This means each user on the system can track their own logs independently.

## Requirements

- **Build time**: Python 3.9+, pip, PyInstaller
- **Runtime**: None! The binary is completely standalone

## How it works

1. Track log files with aliases
2. Start the web server (runs in background)
3. View logs in real-time through your browser
4. WebSocket streams new log lines as they're written
5. Scroll up to load history in 500-line chunks
6. Use navigation buttons to jump to top/bottom
7. Pause to read, resume to continue streaming

## Uninstall

```bash
sudo rm -rf /usr/local/ezlog
sudo rm /usr/local/bin/ezlog
rm -rf ~/.ezlog  # Optional: removes tracked log config
```

## Development

Run in development mode:

```bash
pip install -r requirements.txt
python cli.py run --port 9200
```

## License

MIT
