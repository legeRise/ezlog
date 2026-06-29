class LogViewer {
    constructor(aliases, groups) {
        this.aliases = aliases;
        this.groups = groups;
        this.ws = null;
        this.currentAlias = null;
        this.currentProject = null;
        
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
        this.isSearchMode = false;
        this.lastSearchQuery = "";
        this.searchResults = [];
        
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
            pauseLabel: document.getElementById('pauseLabel'),
            downloadBtn: document.getElementById('downloadBtn'),
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
        if (this.dom.downloadBtn) {
            this.dom.downloadBtn.addEventListener('click', () => this.downloadCurrentLog());
        }
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

        this.dom.filterInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.searchFullFile(e.target.value);
            } else if (e.key === 'Escape' && this.isSearchMode) {
                e.preventDefault();
                this.goToBottom();
            }
        });

        window.addEventListener('popstate', () => {
            const aliasFromPath = this.getAliasFromPath();
            if (aliasFromPath && this.aliases[aliasFromPath]) {
                this.connect(aliasFromPath, { updateRoute: false });
            }
        });

        const initialAlias = (window.INITIAL_ALIAS && this.aliases[window.INITIAL_ALIAS])
            ? window.INITIAL_ALIAS
            : this.getAliasFromPath();
        if (initialAlias && this.aliases[initialAlias]) {
            this.connect(initialAlias, { updateRoute: false });
        }

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

        // Determine sort order: _root last
        const groupKeys = Object.keys(this.groups).sort((a, b) => {
            if (a === '_root') return 1;
            if (b === '_root') return -1;
            return a.localeCompare(b);
        });

        for (const groupKey of groupKeys) {
            const items = this.groups[groupKey];
            const shortNames = Object.keys(items).sort();

            // Check if any log in this group matches the filter
            const anyMatch = this.groupMatchesFilter(items, lowerFilter);
            if (!anyMatch && lowerFilter) continue;

            if (groupKey === '_root') {
                // Project-less logs rendered directly
                for (const short of shortNames) {
                    const info = items[short];
                    if (lowerFilter && !info.alias.toLowerCase().includes(lowerFilter)) continue;
                    this.createLogButton(info.alias, short, null);
                }
            } else {
                // Project group with collapsible section
                const section = this.createProjectSection(groupKey, items, shortNames, lowerFilter);
                this.dom.projectList.appendChild(section);
            }
        }
    }

    groupMatchesFilter(items, lowerFilter) {
        if (!lowerFilter) return true;
        for (const short of Object.keys(items)) {
            if (items[short].alias.toLowerCase().includes(lowerFilter)) return true;
            if (short.toLowerCase().includes(lowerFilter)) return true;
        }
        return false;
    }

    createProjectSection(projectName, items, shortNames, lowerFilter) {
        const section = document.createElement('div');
        section.className = 'border-b border-gray-600';

        // Project header (always visible)
        const header = document.createElement('button');
        header.className = 'w-full flex items-center justify-between px-4 py-2.5 text-sm font-semibold text-gray-300 hover:bg-gray-700 hover:text-white transition-colors';
        header.innerHTML = `
            <span class="flex items-center gap-2">
                <span class="text-blue-400">📁</span>
                <span>${projectName}</span>
                <span class="text-xs text-gray-500 font-normal">(${shortNames.length})</span>
            </span>
            <span class="project-chevron text-gray-500 transition-transform duration-200">▼</span>
        `;

        // Log list container (collapsible)
        const logList = document.createElement('div');
        logList.className = 'overflow-hidden transition-all duration-200';

        // Determine if this project should be expanded
        const currentProject = this.getProjectFromAlias(this.currentAlias);
        const shouldExpand = (currentProject === projectName) || (!lowerFilter && !currentProject);
        logList.style.maxHeight = shouldExpand ? (shortNames.length * 44 + 8) + 'px' : '0';

        if (shouldExpand) {
            header.querySelector('.project-chevron').classList.add('rotate-180');
        }

        header.addEventListener('click', () => {
            const chevron = header.querySelector('.project-chevron');
            const isOpen = logList.style.maxHeight !== '0px';
            if (isOpen) {
                logList.style.maxHeight = '0px';
                chevron.classList.remove('rotate-180');
            } else {
                logList.style.maxHeight = (shortNames.length * 44 + 8) + 'px';
                chevron.classList.add('rotate-180');
            }
        });

        // Log item buttons
        const listInner = document.createElement('div');
        listInner.className = 'py-1';
        for (const short of shortNames) {
            const info = items[short];
            if (lowerFilter && !info.alias.toLowerCase().includes(lowerFilter) && !short.toLowerCase().includes(lowerFilter)) continue;
            this.createLogButton(info.alias, short, listInner, projectName);
        }
        logList.appendChild(listInner);

        section.appendChild(header);
        section.appendChild(logList);
        return section;
    }

    getProjectFromAlias(alias) {
        if (!alias) return null;
        const dotIdx = alias.indexOf('.');
        if (dotIdx === -1) return null;
        return alias.substring(0, dotIdx);
    }

    createLogButton(alias, displayName, parent, projectName) {
        const container = parent || this.dom.projectList;
        const btn = document.createElement('button');
        const isActive = alias === this.currentAlias;
        
        let classes = 'w-full text-left px-4 py-2 text-sm transition-colors truncate flex items-center gap-2';
        if (projectName) {
            classes += ' pl-8';  // indent sub-logs
        }
        if (isActive) {
            classes += ' bg-gray-700 text-white border-l-2 border-blue-500';
        } else {
            classes += ' text-gray-400 hover:bg-gray-700 hover:text-white border-l-2 border-transparent';
        }
        btn.className = classes;

        btn.innerHTML = `<span class="text-xs text-gray-500">📄</span><span>${displayName}</span>`;

        btn.onclick = () => {
            this.connect(alias);
            // Mobile: Close sidebar after selection
            if (window.innerWidth < 768) {
                this.dom.sidebar.classList.add('-translate-x-full');
                this.dom.overlay.classList.add('hidden');
            }
        };
        container.appendChild(btn);
    }

    connect(alias, options = {}) {
        const { updateRoute = true } = options;

        if (this.currentAlias === alias && this.ws?.readyState === 1) return;
        
        // Reset View
        this.currentAlias = alias;
        this.currentProject = this.getProjectFromAlias(alias);
        this.renderSidebar(document.getElementById('projectSearch').value); 
        
        // Show project context in title
        const displayName = alias.includes('.') ? alias.split('.').pop() : alias;
        if (this.currentProject) {
            this.dom.title.textContent = `${this.currentProject} › ${displayName}`;
            this.dom.title.title = alias;
        } else {
            this.dom.title.textContent = alias;
        }
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
        this.isSearchMode = false;
        this.lastSearchQuery = "";
        this.searchResults = [];
        this.updateFileInfo();
        this.updatePendingCount();
        this.updateNavigationButtons();

        if (updateRoute) {
            this.updateRoute(alias);
        }

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
                this.handleIncomingBatch(msg.data);
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

    handleIncomingBatch(lines) {
        if (!Array.isArray(lines) || lines.length === 0) {
            return;
        }

        if (this.isPaused) {
            this.pauseBuffer.push(...lines);
            this.updatePendingCount();
        } else {
            this.appendBatch(lines);
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
        const label = this.dom.pauseLabel;
        
        if (this.isPaused) {
            btn.classList.add('bg-yellow-700', 'border-yellow-500', 'text-white');
            btn.classList.remove('bg-gray-700');
            if (label) label.textContent = "Resume";
            document.getElementById('pauseIcon').textContent = "▶";
        } else {
            if (this.pauseBuffer.length > 0) {
                this.appendBatch(this.pauseBuffer);
                this.pauseBuffer = [];
                this.updatePendingCount();
            }
            btn.classList.remove('bg-yellow-700', 'border-yellow-500', 'text-white');
            btn.classList.add('bg-gray-700');
            if (label) label.textContent = "Pause";
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
                if (div.classList.contains('py-1')) {
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

    async searchFullFile(rawTerm) {
        const term = (rawTerm || '').trim();

        if (!this.currentAlias) {
            this.updateStatus('Select a log first', 'bg-yellow-600');
            return;
        }

        if (!term) {
            this.updateStatus('Search query is empty', 'bg-yellow-600');
            return;
        }

        this.showLoading(true);

        try {
            const response = await fetch(`/api/logs/${encodeURIComponent(this.currentAlias)}/search?q=${encodeURIComponent(term)}&limit=300`);
            const data = await response.json();

            if (data.error) {
                this.updateStatus('Search failed', 'bg-red-600');
                return;
            }

            if (this.ws) {
                this.ws.close();
                this.ws = null;
            }

            this.isLive = false;
            this.isAtBottom = false;
            this.isSearchMode = true;
            this.lastSearchQuery = term;

            this.searchResults = data.matches || [];
            this.dom.logContainer.innerHTML = '';
            this.lines = this.searchResults.map(match => `L${match.line} | ${match.text}`);

            if (this.searchResults.length === 0) {
                this.appendLog(`No matches found for: ${term}`, 'text-gray-500 italic');
            } else {
                this.renderSearchResults(this.searchResults, term);
            }

            this.currentStartLine = 1;
            this.currentEndLine = this.totalLines;
            this.updateFileInfo();
            this.updateNavigationButtons();

            const suffix = data.truncated ? ' (truncated)' : '';
            this.updateStatus(`Found ${data.count} matches${suffix}. Click a match to open context.`, 'bg-blue-600');
        } catch (error) {
            console.error('Error searching log:', error);
            this.updateStatus('Search failed', 'bg-red-600');
        } finally {
            this.showLoading(false);
        }
    }

    renderSearchResults(matches, term) {
        this.dom.logContainer.innerHTML = '';
        const frag = document.createDocumentFragment();

        for (const match of matches) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'w-full text-left py-1 px-3 hover:bg-gray-800 border-b border-transparent hover:border-gray-700 text-blue-400';
            row.textContent = `L${match.line} | ${match.text}`;
            row.title = `Open context around line ${match.line}`;
            row.addEventListener('click', () => this.openSearchContext(match.line, term));
            frag.appendChild(row);
        }

        this.dom.logContainer.appendChild(frag);
        this.dom.logContainer.scrollTop = 0;
    }

    async openSearchContext(lineNumber, term) {
        if (!this.currentAlias) return;

        this.showLoading(true);

        try {
            const response = await fetch(`/api/logs/${encodeURIComponent(this.currentAlias)}/history?direction=around&around_line=${lineNumber}&count=120`);
            const data = await response.json();

            if (data.error) {
                this.updateStatus('Unable to load context', 'bg-red-600');
                return;
            }

            this.isLive = false;
            this.isAtBottom = false;
            this.isSearchMode = true;

            this.currentStartLine = data.start_line;
            this.currentEndLine = data.end_line;

            const contextual = data.lines.map((text, idx) => `L${data.start_line + idx} | ${text}`);
            this.lines = contextual;
            this.dom.logContainer.innerHTML = '';
            this.renderLines(contextual, false);

            const matchIndex = Math.max(0, lineNumber - data.start_line);
            const matchElement = this.dom.logContainer.children[matchIndex];
            if (matchElement) {
                matchElement.classList.add('bg-blue-900/40', 'border-blue-500');
                matchElement.scrollIntoView({ block: 'center' });
            }

            this.updateFileInfo();
            this.updateNavigationButtons();
            this.updateStatus(`Showing context around L${lineNumber} for "${term}"`, 'bg-blue-600');
        } catch (error) {
            console.error('Error loading search context:', error);
            this.updateStatus('Unable to load context', 'bg-red-600');
        } finally {
            this.showLoading(false);
        }
    }

    downloadCurrentLog() {
        if (!this.currentAlias) {
            this.updateStatus('Select a log first', 'bg-yellow-600');
            return;
        }

        const url = `/api/logs/${encodeURIComponent(this.currentAlias)}/download`;
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
    }

    getAliasFromPath() {
        const path = window.location.pathname || '/';
        const prefix = '/logs/';
        if (!path.startsWith(prefix)) return '';

        const encodedAlias = path.slice(prefix.length);
        if (!encodedAlias) return '';

        try {
            return decodeURIComponent(encodedAlias);
        } catch {
            return '';
        }
    }

    updateRoute(alias) {
        const target = `/logs/${encodeURIComponent(alias)}`;
        if (window.location.pathname !== target) {
            window.history.pushState({ alias }, '', target);
        }
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
    window.app = new LogViewer(ALIASES, GROUPS);
});