// EZLog frontend.
//
// Single line-window model: `this.lines` is a contiguous run of file lines
// [startLine .. startLine + lines.length - 1]. Live appends extend it at the
// end, scrolling up back-fills at the front, and search/context replaces it.
// Rendering is virtualized (wrap mode falls back to streaming the whole window).

const LEVEL_RE = /\b(?:FATAL|CRITICAL|PANIC|ERROR|ERR|WARN(?:ING)?|NOTICE|INFO|DEBUG|TRACE)\b/i;
const ROW_HEIGHT = 22;
const MAX_LINES = 100000;      // memory ceiling for the loaded window
const WRAP_RENDER_CAP = 3000;  // rows rendered at once in wrap mode

function detectLevel(text) {
    const m = text.match(LEVEL_RE);
    if (!m) return 'OTHER';
    const t = m[0].toUpperCase();
    if (t === 'FATAL' || t === 'CRITICAL' || t === 'PANIC' || t === 'ERROR' || t === 'ERR') return 'ERROR';
    if (t === 'WARN' || t === 'WARNING') return 'WARN';
    if (t === 'INFO' || t === 'NOTICE') return 'INFO';
    return 'DEBUG';
}

function levelClass(level) {
    switch (level) {
        case 'ERROR': return 'text-red-400';
        case 'WARN': return 'text-yellow-400';
        case 'INFO': return 'text-blue-400';
        case 'DEBUG': return 'text-gray-500';
        default: return '';
    }
}

class LogViewer {
    constructor(aliases, groups) {
        this.aliases = aliases;
        this.groups = groups;

        // Connection
        this.ws = null;
        this.wantLive = false;
        this.intentionalClose = false;
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;

        // Current file
        this.currentAlias = null;
        this.currentProject = null;

        // Line window
        this.lines = [];          // [{ n, text, lvl, isSearch? }]
        this.view = [];           // filtered view of lines (=== lines when no filter)
        this.startLine = 0;
        this.totalLines = 0;
        this.fileSizeHuman = '';
        this.mode = 'idle';       // idle | live | history | search
        this._historyPhase = false;

        // Interaction
        this.paused = false;
        this.pendingRows = [];
        this.filterText = '';
        this.filterLevel = 'ALL';
        this.showNumbers = true;
        this.wrap = false;
        this.following = true;
        this.newWhileAway = 0;
        this.highlightLine = 0;
        this.searchResults = [];
        this.lastSearchQuery = '';

        // Loading guards
        this.loadingOlder = false;

        // Render bookkeeping
        this._rafRender = null;
        this.filterDebounce = null;

        this.dom = {
            sidebar: document.getElementById('sidebar'),
            overlay: document.getElementById('sidebarOverlay'),
            projectList: document.getElementById('projectList'),
            scroll: document.getElementById('scroll'),
            sizer: document.getElementById('sizer'),
            rows: document.getElementById('rows'),
            title: document.getElementById('currentLogTitle'),
            fileInfo: document.getElementById('fileInfo'),
            connChip: document.getElementById('connChip'),
            connLabel: document.getElementById('connLabel'),
            welcome: document.getElementById('welcome'),
            toast: document.getElementById('toast'),
            topLoader: document.getElementById('topLoader'),
            loading: document.getElementById('loadingIndicator'),
            jumpLatest: document.getElementById('jumpLatest'),
            pauseBtn: document.getElementById('pauseBtn'),
            pauseIcon: document.getElementById('pauseIcon'),
            pendingBadge: document.getElementById('pendingCount'),
            filterInput: document.getElementById('logFilter'),
            themeBtn: document.getElementById('themeBtn'),
            goTopBtn: document.getElementById('goTopBtn'),
            goBottomBtn: document.getElementById('goBottomBtn'),
            levelChips: document.getElementById('levelChips'),
            lineNumBtn: document.getElementById('lineNumBtn'),
            wrapBtn: document.getElementById('wrapBtn'),
        };

        this.init();
    }

    // -- setup ----------------------------------------------------------
    init() {
        this.loadTheme();
        this.loadPrefs();
        this.renderSidebar('');

        document.getElementById('projectSearch').addEventListener('input', (e) => this.renderSidebar(e.target.value));

        const toggleMenu = (show) => {
            this.dom.sidebar.classList.toggle('-translate-x-full', !show);
            this.dom.overlay.classList.toggle('hidden', !show);
        };
        document.getElementById('toggleSidebar').addEventListener('click', () => toggleMenu(true));
        document.getElementById('closeSidebar').addEventListener('click', () => toggleMenu(false));
        this.dom.overlay.addEventListener('click', () => toggleMenu(false));

        this.dom.pauseBtn.addEventListener('click', () => this.togglePause());
        this.dom.themeBtn.addEventListener('click', () => this.cycleTheme());
        document.getElementById('downloadBtn').addEventListener('click', () => this.downloadCurrentLog());
        document.getElementById('clearBtn').addEventListener('click', () => this.clearView());

        this.dom.goTopBtn.addEventListener('click', () => this.goToTop());
        this.dom.goBottomBtn.addEventListener('click', () => this.goToBottom());
        this.dom.jumpLatest.addEventListener('click', () => this.jumpToLatest());

        this.dom.lineNumBtn.addEventListener('click', () => this.setShowNumbers(!this.showNumbers));
        this.dom.wrapBtn.addEventListener('click', () => this.setWrap(!this.wrap));

        this.dom.levelChips.querySelectorAll('.lvl').forEach((btn) => {
            btn.addEventListener('click', () => this.setLevel(btn.dataset.level));
        });

        this.dom.filterInput.addEventListener('input', (e) => {
            clearTimeout(this.filterDebounce);
            this.filterDebounce = setTimeout(() => this.setFilterText(e.target.value), 250);
        });
        this.dom.filterInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.searchFullFile(e.target.value);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.setFilterText('');
                this.dom.filterInput.value = '';
                this.dom.filterInput.blur();
            }
        });

        this.dom.scroll.addEventListener('scroll', () => this.onScroll(), { passive: true });
        window.addEventListener('resize', () => this.scheduleRender());

        window.addEventListener('popstate', () => {
            const alias = this.getAliasFromPath();
            if (alias && this.aliases[alias]) this.connect(alias, { updateRoute: false });
        });

        this.updateLevelChips();
        this.updateToggleButtons();
        this.setConn('idle', '');

        const initialAlias = (window.INITIAL_ALIAS && this.aliases[window.INITIAL_ALIAS])
            ? window.INITIAL_ALIAS
            : this.getAliasFromPath();
        if (initialAlias && this.aliases[initialAlias]) this.connect(initialAlias, { updateRoute: false });
    }

    // -- sidebar --------------------------------------------------------
    renderSidebar(filterText) {
        this.dom.projectList.innerHTML = '';
        const lower = (filterText || '').toLowerCase();

        const groupKeys = Object.keys(this.groups).sort((a, b) => {
            if (a === '_root') return 1;
            if (b === '_root') return -1;
            return a.localeCompare(b);
        });

        for (const key of groupKeys) {
            const items = this.groups[key];
            const shortNames = Object.keys(items).sort();
            if (lower && !this.groupMatches(items, lower)) continue;

            if (key === '_root') {
                for (const short of shortNames) {
                    const info = items[short];
                    if (lower && !info.alias.toLowerCase().includes(lower)) continue;
                    this.createLogButton(info.alias, short, null, null);
                }
            } else {
                this.dom.projectList.appendChild(this.createProjectSection(key, items, shortNames, lower));
            }
        }
    }

    groupMatches(items, lower) {
        for (const short of Object.keys(items)) {
            if (items[short].alias.toLowerCase().includes(lower)) return true;
            if (short.toLowerCase().includes(lower)) return true;
        }
        return false;
    }

    createProjectSection(projectName, items, shortNames, lower) {
        const section = document.createElement('div');
        section.className = 'border-b border-gray-600';

        const visible = shortNames.filter((s) =>
            !lower || items[s].alias.toLowerCase().includes(lower) || s.toLowerCase().includes(lower));

        const header = document.createElement('button');
        header.className = 'w-full flex items-center justify-between px-4 py-2.5 text-sm font-semibold text-gray-300 hover:bg-gray-700 hover:text-white transition-colors';
        header.innerHTML = `
            <span class="flex items-center gap-2">
                <span class="text-blue-400">📁</span>
                <span>${this.escape(projectName)}</span>
                <span class="text-xs text-gray-500 font-normal">(${visible.length})</span>
            </span>
            <span class="project-chevron text-gray-500 transition-transform duration-200">▼</span>`;

        const logList = document.createElement('div');
        logList.className = 'overflow-hidden transition-all duration-200';

        const currentProject = this.getProjectFromAlias(this.currentAlias);
        const shouldExpand = (currentProject === projectName) || (!lower && !currentProject);
        logList.style.maxHeight = shouldExpand ? 'none' : '0';
        if (shouldExpand) header.querySelector('.project-chevron').classList.add('rotate-180');

        header.addEventListener('click', () => {
            const chevron = header.querySelector('.project-chevron');
            const isOpen = logList.style.maxHeight !== '0px';
            logList.style.maxHeight = isOpen ? '0px' : 'none';
            chevron.classList.toggle('rotate-180', !isOpen);
        });

        const inner = document.createElement('div');
        inner.className = 'py-1';
        for (const short of visible) this.createLogButton(items[short].alias, short, inner, projectName);
        logList.appendChild(inner);

        section.appendChild(header);
        section.appendChild(logList);
        return section;
    }

    createLogButton(alias, displayName, parent, projectName) {
        const container = parent || this.dom.projectList;
        const btn = document.createElement('button');
        const active = alias === this.currentAlias;

        let cls = 'w-full text-left px-4 py-2 text-sm transition-colors truncate flex items-center gap-2';
        if (projectName) cls += ' pl-8';
        cls += active
            ? ' bg-gray-700 text-white border-l-2 border-blue-500'
            : ' text-gray-400 hover:bg-gray-700 hover:text-white border-l-2 border-transparent';
        btn.className = cls;
        btn.innerHTML = `<span class="text-xs text-gray-500">📄</span><span>${this.escape(displayName)}</span>`;

        btn.onclick = () => {
            this.connect(alias);
            if (window.innerWidth < 768) {
                this.dom.sidebar.classList.add('-translate-x-full');
                this.dom.overlay.classList.add('hidden');
            }
        };
        container.appendChild(btn);
    }

    // -- connection -----------------------------------------------------
    connect(alias, options = {}) {
        const { updateRoute = true } = options;
        if (this.currentAlias === alias && this.ws && this.ws.readyState === 1) return;

        this.resetView(alias);

        if (updateRoute) this.updateRoute(alias);
        this.openSocket();
    }

    resetView(alias) {
        clearTimeout(this.reconnectTimer);
        this.reconnectAttempts = 0;
        if (this.ws) {
            this.intentionalClose = true;
            try { this.ws.close(); } catch (e) { /* ignore */ }
            this.ws = null;
        }

        this.currentAlias = alias;
        this.currentProject = this.getProjectFromAlias(alias);

        const short = alias.includes('.') ? alias.split('.').pop() : alias;
        this.dom.title.textContent = this.currentProject ? `${this.currentProject} › ${short}` : alias;
        this.dom.title.title = alias;

        this.lines = [];
        this.view = [];
        this.startLine = 0;
        this.totalLines = 0;
        this.fileSizeHuman = '';
        this.mode = 'connecting';
        this._historyPhase = true;
        this.paused = false;
        this.pendingRows = [];
        this.newWhileAway = 0;
        this.highlightLine = 0;
        this.searchResults = [];
        this.following = true;
        this.loadingOlder = false;

        this.updatePauseButton();
        this.updatePendingBadge();
        this.updateFileInfo();
        this.dom.welcome.classList.add('hidden');
        this.dom.jumpLatest.classList.add('hidden');
        this.dom.scroll.scrollTop = 0;
        this.render();
        this.renderSidebar(document.getElementById('projectSearch').value);
        this.showLoading(true);
    }

    openSocket() {
        if (!this.currentAlias) return;
        this.wantLive = true;
        this.intentionalClose = false;
        this.setConn('connecting', 'Connecting…');
        this.showLoading(true);

        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${proto}://${window.location.host}/ws/${encodeURIComponent(this.currentAlias)}`);
        this.ws = ws;

        ws.onopen = () => {
            if (this.ws !== ws) return;
            this.reconnectAttempts = 0;
            this.showLoading(false);
        };
        ws.onmessage = (e) => {
            if (this.ws !== ws) return;
            let msg;
            try { msg = JSON.parse(e.data); } catch (err) { return; }
            this.handleMessage(msg);
        };
        ws.onclose = () => {
            if (this.ws !== ws) return;
            this.ws = null;
            this.onSocketClosed();
        };
        ws.onerror = () => { /* onclose follows */ };
    }

    onSocketClosed() {
        if (this.intentionalClose) { this.intentionalClose = false; return; }
        if (!this.wantLive) return;

        this.setConn('connecting', 'Reconnecting…');
        const delay = Math.min(8000, 500 * Math.pow(2, this.reconnectAttempts));
        this.reconnectAttempts++;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            if (this.wantLive && !this.ws) {
                this.toast(`Reconnecting… (attempt ${this.reconnectAttempts})`);
                this.openSocket();
            }
        }, delay);
    }

    handleMessage(msg) {
        switch (msg.type) {
            case 'metadata':
                this.onMetadata(msg);
                break;
            case 'log_batch':
                this.onBatch(msg.data);
                break;
            case 'sys':
                if (msg.msg === '__LIVE_START__') this.onLiveStart();
                else this.toast(msg.msg);
                break;
            case 'notice':
                this.onNotice(msg.msg);
                break;
            case 'ping':
                break;
        }
    }

    onMetadata(msg) {
        this.totalLines = msg.lines || 0;
        this.fileSizeHuman = msg.size_human || '';
        const start = Math.max(1, this.totalLines - 499);
        this.startLine = start;
        this._nextN = start;
        this._historyPhase = true;
        this.lines = [];
        this.rebuildView();
        if (msg.missing) this.toast('Log file not found — waiting for it to appear');
        this.updateFileInfo();
    }

    onBatch(data) {
        if (!Array.isArray(data) || data.length === 0) return;
        const rows = data.map((text) => ({ n: this._nextN++, text, lvl: detectLevel(text) }));

        if (this._historyPhase) {
            this.appendRows(rows, { live: false });
            // keep pinned to the bottom while history streams in
            this.following = true;
            this.scheduleRender();
            return;
        }

        if (this.paused) {
            this.pendingRows.push(...rows);
            this.updatePendingBadge();
            return;
        }
        this.appendRows(rows, { live: true });
    }

    onLiveStart() {
        this._historyPhase = false;
        this.mode = 'live';
        this.setConn('live', 'Live');
        this.following = true;
        this.newWhileAway = 0;
        this.updateFileInfo();
        this.updateNavButtons();
        this.showLoading(false);
        this.render();
        this.scrollToBottom();
    }

    onNotice(kind) {
        if (kind === 'rotated') this.toast('Log rotated — continuing to tail');
        else if (kind === 'missing') this.toast('Log file disappeared — waiting…');
    }

    appendRows(rows, { live }) {
        this.lines.push(...rows);
        let excess = this.lines.length - MAX_LINES;
        if (excess > 0) {
            this.lines.splice(0, excess);
            this.startLine += excess;
        }

        if (!this.isFiltered()) {
            this.view = this.lines;
        } else {
            for (const r of rows) if (this.matches(r)) this.view.push(r);
        }

        if (live) {
            this.totalLines += rows.length;
            this.updateFileInfo();
            if (this.following) this.scheduleRender();
            else {
                this.newWhileAway += rows.length;
                this.showJumpLatest();
                this.scheduleRender();
            }
        }
        this.updateNavButtons();
    }

    prependRows(rows) {
        this.lines.unshift(...rows);
        let excess = this.lines.length - MAX_LINES;
        if (excess > 0) {
            this.lines.splice(this.lines.length - excess, excess);
        }
        if (!this.isFiltered()) this.view = this.lines;
        else {
            const matched = rows.filter((r) => this.matches(r));
            if (matched.length) this.view.unshift(...matched);
        }
    }

    // -- filtering ------------------------------------------------------
    isFiltered() {
        return this.filterLevel !== 'ALL' || !!this.filterText;
    }

    matches(row) {
        if (this.filterLevel !== 'ALL' && row.lvl !== this.filterLevel) return false;
        if (this.filterText && !row.text.toLowerCase().includes(this.filterText)) return false;
        return true;
    }

    rebuildView() {
        this.view = this.isFiltered() ? this.lines.filter((r) => this.matches(r)) : this.lines;
    }

    setFilterText(value) {
        this.filterText = (value || '').trim().toLowerCase();
        this.rebuildView();
        this.updateFileInfo();
        this.scheduleRender();
    }

    setLevel(level) {
        if (this.filterLevel === level) level = 'ALL';
        this.filterLevel = level;
        this.updateLevelChips();
        this.rebuildView();
        this.updateFileInfo();
        this.scheduleRender();
    }

    updateLevelChips() {
        this.dom.levelChips.querySelectorAll('.lvl').forEach((btn) => {
            const on = btn.dataset.level === this.filterLevel;
            btn.classList.toggle('bg-blue-500', on);
            btn.classList.toggle('text-white', on);
            btn.classList.toggle('text-gray-400', !on);
        });
    }

    // -- rendering (virtualized) ---------------------------------------
    scheduleRender() {
        if (this._rafRender) return;
        this._rafRender = requestAnimationFrame(() => {
            this._rafRender = null;
            this.render();
        });
    }

    render() {
        const rows = this.dom.rows;
        const sizer = this.dom.sizer;

        if (this.wrap) return this.renderWrapped();

        rows.style.position = 'absolute';
        rows.style.width = 'max-content';
        rows.style.minWidth = '100%';
        sizer.style.height = `${this.view.length * ROW_HEIGHT}px`;

        if (this.view.length === 0) {
            rows.style.transform = 'translateY(0)';
            rows.innerHTML = '';
            return;
        }

        const st = this.dom.scroll.scrollTop;
        const h = this.dom.scroll.clientHeight || 400;
        const first = Math.max(0, Math.floor(st / ROW_HEIGHT) - 8);
        const last = Math.min(this.view.length - 1, Math.ceil((st + h) / ROW_HEIGHT) + 8);

        rows.style.transform = `translateY(${first * ROW_HEIGHT}px)`;

        const frag = document.createDocumentFragment();
        for (let i = first; i <= last; i++) frag.appendChild(this.makeRow(this.view[i]));
        rows.replaceChildren(frag);
    }

    renderWrapped() {
        const rows = this.dom.rows;
        rows.style.position = 'static';
        rows.style.transform = 'none';
        rows.style.width = '100%';

        const slice = this.view.slice(0, WRAP_RENDER_CAP);
        const frag = document.createDocumentFragment();
        for (const row of slice) frag.appendChild(this.makeRow(row));
        rows.replaceChildren(frag);
        this.dom.sizer.style.height = 'auto';
        if (this.view.length > WRAP_RENDER_CAP) {
            this.toast(`Wrap mode limited to ${WRAP_RENDER_CAP} lines — disable to scroll the full window`);
        }
    }

    makeRow(row) {
        const d = document.createElement('div');
        d.className = this.wrap
            ? 'wrapped-row px-3 py-0.5 hover:bg-gray-800'
            : 'log-row nowrap-row flex px-3 hover:bg-gray-800';

        if (this.showNumbers) {
            const n = document.createElement('span');
            n.className = 'log-num text-gray-500 pr-3 shrink-0';
            n.style.minWidth = '3.25rem';
            n.style.textAlign = 'right';
            n.textContent = row.n;
            d.appendChild(n);
        }

        const t = document.createElement('span');
        t.className = levelClass(row.lvl);
        t.textContent = row.text;
        d.appendChild(t);

        if (this.highlightLine && row.n === this.highlightLine) {
            d.classList.add('bg-blue-900/40');
        }
        if (row.isSearch) {
            d.classList.add('cursor-pointer');
            d.title = `Open context around line ${row.n}`;
            d.onclick = () => this.openSearchContext(row.n);
        }
        return d;
    }

    // -- scrolling ------------------------------------------------------
    onScroll() {
        const el = this.dom.scroll;
        const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        this.following = distanceToBottom < 40;

        if (this.following) {
            this.newWhileAway = 0;
            this.dom.jumpLatest.classList.add('hidden');
        }

        if (el.scrollTop < 400 && !this.loadingOlder && this.startLine > 1 && this.mode !== 'search') {
            this.loadOlder();
        }

        this.updateNavButtons();
        this.scheduleRender();
    }

    scrollToBottom() {
        requestAnimationFrame(() => {
            this.dom.scroll.scrollTop = this.dom.scroll.scrollHeight;
            this.following = true;
            this.scheduleRender();
        });
    }

    jumpToLatest() {
        if (this.mode === 'live') {
            this.scrollToBottom();
        } else {
            this.goToBottom();
        }
    }

    showJumpLatest() {
        if (this.mode !== 'live') return;
        this.dom.jumpLatest.textContent = this.newWhileAway > 0
            ? `↓ ${this.newWhileAway} new line${this.newWhileAway === 1 ? '' : 's'} — jump to latest`
            : '↓ Jump to latest';
        this.dom.jumpLatest.classList.remove('hidden');
    }

    async loadOlder() {
        if (this.loadingOlder || this.startLine <= 1) return;
        this.loadingOlder = true;
        this.dom.topLoader.classList.remove('hidden');

        try {
            const res = await fetch(`/api/logs/${encodeURIComponent(this.currentAlias)}/history?direction=up&before_line=${this.startLine}&count=500`);
            const data = await res.json();
            if (data.error || !data.lines || data.lines.length === 0) {
                this.startLine = 1;
                return;
            }
            const rows = data.lines.map((text, i) => ({
                n: data.start_line + i, text, lvl: detectLevel(text),
            }));

            const el = this.dom.scroll;
            const oldHeight = el.scrollHeight;
            const oldTop = el.scrollTop;

            this.prependRows(rows);
            this.startLine = data.start_line;

            this.scheduleRender();
            requestAnimationFrame(() => {
                const newHeight = el.scrollHeight;
                el.scrollTop = oldTop + (newHeight - oldHeight);
            });
            this.updateFileInfo();
            this.updateNavButtons();
        } catch (e) {
            /* transient */
        } finally {
            this.loadingOlder = false;
            this.dom.topLoader.classList.add('hidden');
        }
    }

    // -- navigation -----------------------------------------------------
    async goToTop() {
        if (!this.currentAlias) return;
        this.wantLive = false;
        this.intentionalClose = true;
        if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
        this.setConn('history', 'History');
        this.showLoading(true);

        try {
            const res = await fetch(`/api/logs/${encodeURIComponent(this.currentAlias)}/history?direction=top&count=500`);
            const data = await res.json();
            if (data.error) { this.toast('Unable to load top'); return; }
            const rows = data.lines.map((text, i) => ({ n: (data.start_line || 1) + i, text, lvl: detectLevel(text) }));
            this.lines = rows;
            this.startLine = data.start_line || 1;
            this.mode = 'history';
            this.highlightLine = 0;
            this.rebuildView();
            this.render();
            this.dom.scroll.scrollTop = 0;
            this.updateFileInfo();
            this.updateNavButtons();
        } catch (e) {
            this.toast('Unable to load top');
        } finally {
            this.showLoading(false);
        }
    }

    goToBottom() {
        if (!this.currentAlias) return;
        this.connect(this.currentAlias, { updateRoute: false });
    }

    // -- search ---------------------------------------------------------
    async searchFullFile(rawTerm) {
        const term = (rawTerm || '').trim();
        if (!this.currentAlias) { this.toast('Select a log first'); return; }
        if (!term) { this.toast('Search query is empty'); return; }

        this.showLoading(true);
        try {
            const res = await fetch(`/api/logs/${encodeURIComponent(this.currentAlias)}/search?q=${encodeURIComponent(term)}&limit=300`);
            const data = await res.json();
            if (data.error) { this.toast('Search failed'); return; }

            this.wantLive = false;
            this.intentionalClose = true;
            if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
            this.setConn('history', 'Search');

            this.mode = 'search';
            this.lastSearchQuery = term;
            this.searchResults = data.matches || [];
            this.highlightLine = 0;

            if (this.searchResults.length === 0) {
                this.lines = [];
                this.rebuildView();
                this.render();
                this.toast(`No matches for "${term}"`);
            } else {
                this.lines = this.searchResults.map((m) => ({
                    n: m.line, text: m.text, lvl: detectLevel(m.text), isSearch: true,
                }));
                this.rebuildView();
                this.render();
                const suffix = data.truncated ? ' (truncated)' : '';
                this.toast(`${data.count} matches for "${term}"${suffix} — click one for context`);
            }
            this.dom.scroll.scrollTop = 0;
            this.updateFileInfo();
            this.updateNavButtons();
        } catch (e) {
            this.toast('Search failed');
        } finally {
            this.showLoading(false);
        }
    }

    async openSearchContext(lineNumber) {
        if (!this.currentAlias) return;
        this.showLoading(true);
        try {
            const res = await fetch(`/api/logs/${encodeURIComponent(this.currentAlias)}/history?direction=around&around_line=${lineNumber}&count=120`);
            const data = await res.json();
            if (data.error) { this.toast('Unable to load context'); return; }

            this.mode = 'history';
            this.lines = data.lines.map((text, i) => ({ n: data.start_line + i, text, lvl: detectLevel(text) }));
            this.startLine = data.start_line;
            this.highlightLine = lineNumber;
            this.rebuildView();
            this.render();
            this.scrollToLine(lineNumber);
            this.updateFileInfo();
            this.updateNavButtons();
            this.toast(`Context around line ${lineNumber}`);
        } catch (e) {
            this.toast('Unable to load context');
        } finally {
            this.showLoading(false);
        }
    }

    scrollToLine(lineNumber) {
        const idx = this.view.findIndex((r) => r.n === lineNumber);
        if (idx < 0) return;
        requestAnimationFrame(() => {
            this.dom.scroll.scrollTop = Math.max(0, idx * ROW_HEIGHT - this.dom.scroll.clientHeight / 2);
            this.scheduleRender();
        });
    }

    // -- pause ----------------------------------------------------------
    togglePause() {
        this.paused = !this.paused;
        if (!this.paused && this.pendingRows.length) {
            const rows = this.pendingRows;
            this.pendingRows = [];
            this.appendRows(rows, { live: true });
            this.updatePendingBadge();
            if (this.following) this.scrollToBottom();
        }
        this.updatePauseButton();
    }

    updatePauseButton() {
        this.dom.pauseIcon.textContent = this.paused ? '▶' : '⏸';
        this.dom.pauseBtn.classList.toggle('bg-yellow-700', this.paused);
        this.dom.pauseBtn.classList.toggle('border-yellow-500', this.paused);
        this.dom.pauseBtn.classList.toggle('bg-gray-700', !this.paused);
    }

    updatePendingBadge() {
        const n = this.pendingRows.length;
        this.dom.pendingBadge.classList.toggle('hidden', n === 0);
        this.dom.pendingBadge.textContent = n > 99 ? '99+' : n;
    }

    // -- toggles / prefs ------------------------------------------------
    setShowNumbers(on) {
        this.showNumbers = on;
        localStorage.setItem('ezlog-numbers', on ? '1' : '0');
        this.updateToggleButtons();
        this.scheduleRender();
    }

    setWrap(on) {
        this.wrap = on;
        localStorage.setItem('ezlog-wrap', on ? '1' : '0');
        this.updateToggleButtons();
        this.render();
    }

    updateToggleButtons() {
        this.dom.lineNumBtn.classList.toggle('bg-gray-600', this.showNumbers);
        this.dom.lineNumBtn.classList.toggle('text-white', this.showNumbers);
        this.dom.wrapBtn.classList.toggle('bg-gray-600', this.wrap);
        this.dom.wrapBtn.classList.toggle('text-white', this.wrap);
    }

    loadPrefs() {
        this.showNumbers = localStorage.getItem('ezlog-numbers') !== '0';
        this.wrap = localStorage.getItem('ezlog-wrap') === '1';
    }

    // -- chrome ---------------------------------------------------------
    setConn(state, label) {
        const chip = this.dom.connChip;
        chip.className = `conn-chip conn-${state}`;
        if (!label) { chip.classList.add('hidden'); return; }
        chip.classList.remove('hidden');
        this.dom.connLabel.textContent = label;
    }

    updateFileInfo() {
        if (!this.currentAlias) { this.dom.fileInfo.textContent = ''; return; }
        const parts = [];
        if (this.fileSizeHuman) parts.push(this.fileSizeHuman);
        if (this.totalLines) parts.push(`${this.totalLines.toLocaleString()} lines`);
        if (this.isFiltered()) parts.push(`${this.view.length.toLocaleString()} shown`);
        this.dom.fileInfo.textContent = parts.join(' • ');
    }

    updateNavButtons() {
        this.dom.goTopBtn.classList.toggle('hidden', this.startLine <= 1 || this.mode === 'search');
        this.dom.goBottomBtn.classList.toggle('hidden', this.mode === 'live' && this.following && this.newWhileAway === 0);
    }

    showLoading(show) {
        this.dom.loading.classList.toggle('hidden', !show);
    }

    toast(message) {
        this.dom.toast.textContent = message;
        this.dom.toast.classList.remove('hidden');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => this.dom.toast.classList.add('hidden'), 4000);
    }

    clearView() {
        this.lines = [];
        this.view = [];
        this.startLine = 0;
        this.highlightLine = 0;
        this.render();
        this.updateFileInfo();
    }

    downloadCurrentLog() {
        if (!this.currentAlias) { this.toast('Select a log first'); return; }
        const a = document.createElement('a');
        a.href = `/api/logs/${encodeURIComponent(this.currentAlias)}/download`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    // -- routing --------------------------------------------------------
    getAliasFromPath() {
        const path = window.location.pathname || '/';
        const prefix = '/logs/';
        if (!path.startsWith(prefix)) return '';
        const encoded = path.slice(prefix.length);
        if (!encoded) return '';
        try { return decodeURIComponent(encoded); } catch (e) { return ''; }
    }

    updateRoute(alias) {
        const target = `/logs/${encodeURIComponent(alias)}`;
        if (window.location.pathname !== target) {
            window.history.pushState({ alias }, '', target);
        }
    }

    // -- theme ----------------------------------------------------------
    loadTheme() {
        this.applyTheme(localStorage.getItem('ezlog-theme') || 'dark');
    }

    cycleTheme() {
        const themes = ['dark', 'light', 'solarized-light'];
        const current = document.documentElement.className;
        const idx = themes.indexOf(current);
        this.applyTheme(themes[(idx + 1) % themes.length]);
    }

    applyTheme(theme) {
        document.documentElement.className = theme;
        localStorage.setItem('ezlog-theme', theme);
        const icons = { dark: '🌙', light: '☀️', 'solarized-light': '🎨' };
        if (this.dom.themeBtn) this.dom.themeBtn.textContent = icons[theme] || '🎨';
        this.scheduleRender();
    }

    // -- utils ----------------------------------------------------------
    getProjectFromAlias(alias) {
        if (!alias) return null;
        const i = alias.indexOf('.');
        return i === -1 ? null : alias.substring(0, i);
    }

    escape(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }
}

window.addEventListener('DOMContentLoaded', () => {
    window.app = new LogViewer(ALIASES, GROUPS);
});
