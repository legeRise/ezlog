class LogViewer {
    constructor(aliases) {
        this.aliases = aliases;
        this.ws = null;
        this.currentAlias = null;
        
        // State
        this.isPaused = false;
        this.pauseBuffer = []; 
        this.filterTerm = "";
        this.isUserScrolling = false;
        
        // File metadata
        this.fileSize = 0;
        this.totalLines = 0;
        this.fileSizeHuman = "";
        this.currentStartLine = 0;
        this.currentEndLine = 0;
        this.isAtTop = false;
        this.isAtBottom = true;
        this.isLive = true;
        this.isLoadingHistory = false;
        
        // Performance: In-memory line buffer (circular buffer with max limit)
        this.lines = []; // Store all lines in memory
        this.maxLines = 10000; // Limit to prevent memory bloat
        this.renderChunkSize = 100; // Render in chunks
        
        // Debounce/Throttle timers
        this.filterDebounce = null;
        this.scrollThrottle = null;

        // DOM Elements
        this.dom = {
            sidebar: document.getElementById('sidebar'),
            overlay: document.getElementById('sidebarOverlay'),
            projectList: document.getElementById('projectList'),
            logContainer: document.getElementById('logContainer'),
            title: document.getElementById('currentLogTitle'),
            status: document.getElementById('connectionStatus'),
            pauseBtn: document.getElementById('pauseBtn'),
            pendingBadge: document.getElementById('pendingCount'),
            filterInput: document.getElementById('logFilter'),
            welcome: document.getElementById('welcomeMsg'),
            themeBtn: document.getElementById('themeBtn'),
            loading: document.getElementById('loadingIndicator'),
            fileInfo: document.getElementById('fileInfo'),
            goTopBtn: document.getElementById('goTopBtn'),
            goBottomBtn: document.getElementById('goBottomBtn'),
            historyLoader: document.getElementById('historyLoader')
        };

        this.init();
    }

    init() {
        // Load saved theme
        this.loadTheme();
        
        this.renderSidebar("");
        
        // Event Listeners
        document.getElementById('projectSearch').addEventListener('input', (e) => this.renderSidebar(e.target.value));
        
        // Mobile Sidebar Logic
        const toggleMenu = (show) => {
            if (show) {
                this.dom.sidebar.classList.remove('-translate-x-full');
                this.dom.overlay.classList.remove('hidden');
            } else {
                this.dom.sidebar.classList.add('-translate-x-full');
                this.dom.overlay.classList.add('hidden');
            }
        };

        document.getElementById('toggleSidebar').addEventListener('click', () => toggleMenu(true));
        document.getElementById('closeSidebar').addEventListener('click', () => toggleMenu(false));
        this.dom.overlay.addEventListener('click', () => toggleMenu(false));

        this.dom.pauseBtn.addEventListener('click', () => this.togglePause());
        this.dom.themeBtn.addEventListener('click', () => this.cycleTheme());
        
        if (this.dom.goTopBtn) {
            this.dom.goTopBtn.addEventListener('click', () => this.goToTop());
        }
        
        if (this.dom.goBottomBtn) {
            this.dom.goBottomBtn.addEventListener('click', () => this.goToBottom());
        }
        
        document.getElementById('clearBtn').addEventListener('click', () => {
            this.dom.logContainer.innerHTML = '';
            this.lines = []; // Clear memory buffer too
        });

        // Debounced filter (300ms delay)
        this.dom.filterInput.addEventListener('input', (e) => {
            clearTimeout(this.filterDebounce);
            this.filterDebounce = setTimeout(() => this.applyFilter(e.target.value), 300);
        });

        // Throttled scroll detection using RAF
        this.dom.logContainer.addEventListener('scroll', () => {
            if (!this.scrollThrottle) {
                this.scrollThrottle = requestAnimationFrame(() => {
                    const container = this.dom.logContainer;
                    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
                    const distanceToTop = container.scrollTop;
                    
                    this.isUserScrolling = distanceToBottom > 50;
                    
                    // Load more history when scrolling near top
                    if (distanceToTop < 100 && !this.isLoadingHistory && !this.isAtTop && this.currentStartLine > 1) {
                        this.loadMoreHistory();
                    }
                    
                    // Load newer history when scrolling down (near bottom but not live)
                    if (distanceToBottom < 100 && !this.isLoadingHistory && !this.isLive && this.currentEndLine < this.totalLines) {
                        this.loadNewerHistory();
                    }
                    
                    // Update button visibility
                    this.updateNavigationButtons();
                    
                    this.scrollThrottle = null;
                });
            }
        });
    }

    renderSidebar(filterText) {
        this.dom.projectList.innerHTML = '';
        const lowerFilter = filterText.toLowerCase();

        Object.keys(this.aliases).sort().forEach(alias => {
            if (alias.toLowerCase().includes(lowerFilter)) {
                const btn = document.createElement('button');
                btn.className = `w-full text-left px-4 py-3 text-sm text-gray-400 hover:bg-gray-700 hover:text-white border-l-2 border-transparent transition-colors truncate`;
                btn.textContent = alias;
                
                if (alias === this.currentAlias) {
                    btn.classList.add('bg-gray-700', 'text-white', 'border-blue-500');
                }

                btn.onclick = () => {
                    this.connect(alias, btn);
                    // Mobile: Close sidebar after selection for better UX
                    if (window.innerWidth < 768) {
                        this.dom.sidebar.classList.add('-translate-x-full');
                        this.dom.overlay.classList.add('hidden');
                    }
                };
                this.dom.projectList.appendChild(btn);
            }
        });
    }

    connect(alias) {
        if (this.currentAlias === alias && this.ws?.readyState === 1) return;
        
        // Reset View
        this.currentAlias = alias;
        this.renderSidebar(document.getElementById('projectSearch').value); 
        this.dom.title.textContent = alias;
        this.dom.welcome.style.display = 'none';
        this.dom.logContainer.innerHTML = '';
        this.isUserScrolling = false;
        this.pauseBuffer = [];
        this.lines = []; // Clear in-memory buffer
        this.currentStartLine = 0;
        this.currentEndLine = 0;
        this.isAtTop = false;
        this.isAtBottom = true;
        this.isLive = true;
        this.updateFileInfo();
        this.updatePendingCount();
        this.updateNavigationButtons();

        if (this.ws) this.ws.close();

        // Connect
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        this.ws = new WebSocket(`${proto}://${window.location.host}/ws/${encodeURIComponent(alias)}`);
        
        this.updateStatus('Connecting...', 'bg-yellow-600');
        this.showLoading(true);

        this.ws.onopen = () => {
            this.updateStatus('Live', 'bg-green-600');
            this.showLoading(false);
        };
        this.ws.onclose = () => {
            this.updateStatus('Offline', 'bg-red-600');
            this.showLoading(false);
        };
        
        this.ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            
            if (msg.type === 'metadata') {
                this.fileSize = msg.size;
                this.totalLines = msg.lines;
                this.fileSizeHuman = msg.size_human;
                // Set initial line range to last 500 lines
                this.currentStartLine = Math.max(1, this.totalLines - 499);
                this.currentEndLine = this.totalLines;
                this.updateFileInfo();
                this.updateNavigationButtons();
            }
            else if (msg.type === 'sys') {
                if (msg.msg === '__LIVE_START__') this.appendDivider();
                else this.appendLog(msg.msg, 'text-gray-500 italic');
            } 
            else if (msg.type === 'log_batch') {
                this.appendBatch(msg.data);
            }
            else if (msg.type === 'log') {
                this.handleIncomingLog(msg.data);
            }
        };
    }

    handleIncomingLog(text) {
        if (this.isPaused) {
            this.pauseBuffer.push(text);
            this.updatePendingCount();
        } else {
            this.appendLog(text);
        }
    }

    appendBatch(lines) {
        // Add to in-memory buffer
        this.lines.push(...lines);
        
        // Update end line when receiving new lines
        if (this.isLive) {
            this.currentEndLine = this.totalLines;
        }
        
        // Trim if exceeded max lines (circular buffer)
        if (this.lines.length > this.maxLines) {
            const excess = this.lines.length - this.maxLines;
            this.lines.splice(0, excess);
        }
        
        // Render in chunks to avoid blocking UI
        this.renderLines(lines);
        this.updateFileInfo();
        this.updateNavigationButtons();
    }

    appendLog(text, extraClass = '') {
        // Add to in-memory buffer
        this.lines.push(text);
        
        // Trim if exceeded max lines
        if (this.lines.length > this.maxLines) {
            this.lines.shift();
            // Remove oldest DOM element if needed
            const firstChild = this.dom.logContainer.firstElementChild;
            if (firstChild && firstChild.classList.contains('py-0.5')) {
                firstChild.remove();
            }
        }
        
        // Render single line to DOM
        const el = this.createLogElement(text, extraClass);
        if (el) {
            this.dom.logContainer.appendChild(el);
            this.scrollToBottom();
        }
    }

    createLogElement(text, extraClass = '') {
        // Content Filtering
        const isHidden = this.filterTerm && !text.toLowerCase().includes(this.filterTerm);
        
        const div = document.createElement('div');
        div.className = `py-1 px-3 hover:bg-gray-800 border-b border-transparent hover:border-gray-700 ${extraClass} ${isHidden ? 'hidden' : ''}`;
        
        // Syntax Highlighting
        if (text.includes('ERROR') || text.includes('CRITICAL')) div.classList.add('text-red-400');
        else if (text.includes('WARN')) div.classList.add('text-yellow-400');
        else if (text.includes('INFO')) div.classList.add('text-blue-400');
        else if (text.includes('SUCCESS')) div.classList.add('text-green-400');
        
        div.textContent = text;
        return div;
    }

    appendDivider() {
        const div = document.createElement('div');
        div.className = "flex items-center my-4 text-xs text-blue-500 font-bold uppercase tracking-widest";
        div.innerHTML = `<div class="flex-grow border-t border-blue-900"></div><span class="mx-4">Live Stream Started</span><div class="flex-grow border-t border-blue-900"></div>`;
        this.dom.logContainer.appendChild(div);
        this.scrollToBottom();
    }

    togglePause() {
        this.isPaused = !this.isPaused;
        const btn = this.dom.pauseBtn;
        
        if (this.isPaused) {
            btn.classList.add('bg-yellow-700', 'border-yellow-500', 'text-white');
            btn.classList.remove('bg-gray-700');
            btn.querySelector('span').textContent = "Resume";
            document.getElementById('pauseIcon').textContent = "▶";
        } else {
            if (this.pauseBuffer.length > 0) {
                this.appendBatch(this.pauseBuffer);
                this.pauseBuffer = [];
                this.updatePendingCount();
            }
            btn.classList.remove('bg-yellow-700', 'border-yellow-500', 'text-white');
            btn.classList.add('bg-gray-700');
            btn.querySelector('span').textContent = "Pause";
            document.getElementById('pauseIcon').textContent = "⏸";
        }
    }

    updatePendingCount() {
        const badge = this.dom.pendingBadge;
        if (this.pauseBuffer.length > 0) {
            badge.textContent = this.pauseBuffer.length > 99 ? '99+' : this.pauseBuffer.length;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }

    applyFilter(term) {
        this.filterTerm = term.toLowerCase();
        
        // If no filter, show all
        if (!this.filterTerm) {
            const logs = this.dom.logContainer.children;
            for (let div of logs) {
                if (div.classList.contains('py-0.5')) {
                    div.classList.remove('hidden');
                }
            }
            return;
        }
        
        // Filter in-memory lines and re-render (faster than DOM manipulation)
        const filtered = this.lines.filter(line => 
            line.toLowerCase().includes(this.filterTerm)
        );
        
        // Clear and render filtered results
        this.dom.logContainer.innerHTML = '';
        this.renderLines(filtered, false); // Don't scroll during filter
    }

    renderLines(lines, shouldScroll = true) {
        // Render lines in chunks to avoid blocking
        const frag = document.createDocumentFragment();
        let count = 0;
        
        for (const text of lines) {
            const el = this.createLogElement(text);
            if (el) frag.appendChild(el);
            
            // Yield control every N lines
            if (++count % this.renderChunkSize === 0) {
                this.dom.logContainer.appendChild(frag);
                // Small delay to let browser breathe
                if (lines.length > 1000) {
                    setTimeout(() => {}, 0);
                }
            }
        }
        
        // Append remaining
        if (frag.childNodes.length > 0) {
            this.dom.logContainer.appendChild(frag);
        }
        
        if (shouldScroll) this.scrollToBottom();
    }
    
    scrollToBottom() {
        if (!this.isUserScrolling) {
            // Use RAF for smooth scrolling
            requestAnimationFrame(() => {
                this.dom.logContainer.scrollTop = this.dom.logContainer.scrollHeight;
            });
        }
    }

    updateStatus(msg, colorClass) {
        const el = this.dom.status;
        el.textContent = msg;
        el.className = `px-2 py-0.5 rounded text-[10px] font-bold uppercase text-white ${colorClass}`;
        el.style.display = 'block';
        setTimeout(() => { el.style.display = 'none'; }, 3000); // Hide after 3s
    }
    
    // Theme Management
    loadTheme() {
        const saved = localStorage.getItem('ezlog-theme') || 'dark';
        this.applyTheme(saved);
    }
    
    cycleTheme() {
        const themes = ['dark', 'light', 'solarized-light'];
        const current = document.documentElement.className;
        const currentIndex = themes.indexOf(current) || 0;
        const next = themes[(currentIndex + 1) % themes.length];
        this.applyTheme(next);
    }
    
    applyTheme(theme) {
        document.documentElement.className = theme;
        localStorage.setItem('ezlog-theme', theme);
        
        // Update theme button icon
        const icons = { 'dark': '🌙', 'light': '☀️', 'solarized-light': '🎨' };
        if (this.dom.themeBtn) {
            this.dom.themeBtn.textContent = icons[theme] || '🎨';
        }
    }
    
    showLoading(show) {
        if (this.dom.loading) {
            this.dom.loading.classList.toggle('hidden', !show);
        }
    }
    
    updateFileInfo() {
        if (!this.dom.fileInfo) return;
        
        if (this.totalLines === 0) {
            this.dom.fileInfo.textContent = '';
            return;
        }
        
        // Simplified: just show size and total lines
        const info = `${this.fileSizeHuman} • ${this.totalLines.toLocaleString()} lines`;
        this.dom.fileInfo.textContent = info;
    }
    
    updateNavigationButtons() {
        // Show/hide Go to Top button
        if (this.dom.goTopBtn) {
            if (this.currentStartLine > 1) {
                this.dom.goTopBtn.classList.remove('hidden');
            } else {
                this.dom.goTopBtn.classList.add('hidden');
            }
        }
        
        // Show/hide Go to Bottom button
        if (this.dom.goBottomBtn) {
            if (!this.isLive || !this.isAtBottom) {
                this.dom.goBottomBtn.classList.remove('hidden');
            } else {
                this.dom.goBottomBtn.classList.add('hidden');
            }
        }
    }
    
    async goToTop() {
        if (!this.currentAlias) return;
        
        this.showLoading(true);
        
        try {
            const response = await fetch(`/api/logs/${encodeURIComponent(this.currentAlias)}/history?direction=top&count=500`);
            const data = await response.json();
            
            if (data.error) {
                console.error('Error fetching top:', data.error);
                return;
            }
            
            // Disconnect WebSocket (stop live tailing)
            if (this.ws) {
                this.ws.close();
                this.ws = null;
            }
            
            this.isLive = false;
            this.isAtTop = true;
            this.isAtBottom = false;
            
            // Clear and render
            this.dom.logContainer.innerHTML = '';
            this.lines = data.lines;
            this.currentStartLine = data.start_line;
            this.currentEndLine = data.end_line;
            
            this.renderLines(data.lines, false);
            this.dom.logContainer.scrollTop = 0;
            
            this.updateFileInfo();
            this.updateNavigationButtons();
            this.updateStatus('Viewing history', 'bg-gray-600');
            
        } catch (error) {
            console.error('Error loading top:', error);
        } finally {
            this.showLoading(false);
        }
    }
    
    goToBottom() {
        // Reconnect to WebSocket to get live stream
        this.connect(this.currentAlias);
    }
    
    async loadMoreHistory() {
        if (this.isLoadingHistory || this.isAtTop || this.currentStartLine <= 1) return;
        
        this.isLoadingHistory = true;
        
        if (this.dom.historyLoader) {
            this.dom.historyLoader.classList.remove('hidden');
        }
        
        try {
            const response = await fetch(`/api/logs/${encodeURIComponent(this.currentAlias)}/history?direction=up&before_line=${this.currentStartLine}&count=500`);
            const data = await response.json();
            
            if (data.error || data.lines.length === 0) {
                this.isAtTop = true;
                return;
            }
            
            // Save scroll position
            const container = this.dom.logContainer;
            const oldScrollHeight = container.scrollHeight;
            const oldScrollTop = container.scrollTop;
            
            // Prepend lines to buffer and DOM
            this.lines.unshift(...data.lines);
            this.currentStartLine = data.start_line;
            this.isAtTop = !data.has_more;
            
            // Render at the beginning
            this.prependLines(data.lines);
            
            // Restore scroll position (adjust for new content)
            const newScrollHeight = container.scrollHeight;
            container.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
            
            this.updateFileInfo();
            this.updateNavigationButtons();
            
        } catch (error) {
            console.error('Error loading history:', error);
        } finally {
            this.isLoadingHistory = false;
            if (this.dom.historyLoader) {
                this.dom.historyLoader.classList.add('hidden');
            }
        }
    }
    
    prependLines(lines) {
        const frag = document.createDocumentFragment();
        
        for (const text of lines) {
            const el = this.createLogElement(text);
            if (el) frag.appendChild(el);
        }
        
        // Prepend to container
        if (this.dom.logContainer.firstChild) {
            this.dom.logContainer.insertBefore(frag, this.dom.logContainer.firstChild);
        } else {
            this.dom.logContainer.appendChild(frag);
        }
    }
    
    async loadNewerHistory() {
        if (this.isLoadingHistory || this.isLive || this.currentEndLine >= this.totalLines) return;
        
        this.isLoadingHistory = true;
        
        if (this.dom.historyLoader) {
            this.dom.historyLoader.classList.remove('hidden');
            this.dom.historyLoader.textContent = 'Loading newer logs...';
        }
        
        try {
            const startLine = this.currentEndLine + 1;
            const response = await fetch(`/api/logs/${encodeURIComponent(this.currentAlias)}/history?direction=up&before_line=${startLine + 500}&count=500`);
            const data = await response.json();
            
            if (data.error || data.lines.length === 0) {
                return;
            }
            
            // Append lines to buffer and DOM
            this.lines.push(...data.lines);
            this.currentEndLine = data.end_line;
            
            // Check if we've reached the end
            if (this.currentEndLine >= this.totalLines) {
                // Reconnect to get live stream
                this.goToBottom();
                return;
            }
            
            // Render at the end
            this.renderLines(data.lines, false);
            
            this.updateFileInfo();
            this.updateNavigationButtons();
            
        } catch (error) {
            console.error('Error loading newer history:', error);
        } finally {
            this.isLoadingHistory = false;
            if (this.dom.historyLoader) {
                this.dom.historyLoader.classList.add('hidden');
                this.dom.historyLoader.textContent = 'Loading older logs...';
            }
        }
    }
}

window.addEventListener('DOMContentLoaded', () => {
    window.app = new LogViewer(ALIASES);
});