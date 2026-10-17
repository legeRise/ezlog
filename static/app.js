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

// Inline monochrome icon from the SVG sprite in index.html — the single icon
// language used everywhere (no emoji in the chrome).
function svgIcon(name, cls = 'ico') {
    return `<svg class="${cls}"><use href="#i-${name}"></use></svg>`;
}

// Fill `el` with `text`, wrapping case-insensitive occurrences of `query` in
// <mark>. Built from text nodes only, so log content can never inject markup.
function markMatches(el, text, query) {
    if (!query) { el.textContent = text; return; }
    const lower = text.toLowerCase();
    const q = query.toLowerCase();
    const frag = document.createDocumentFragment();
    let i = 0;
    let pos;
    while ((pos = lower.indexOf(q, i)) !== -1) {
        if (pos > i) frag.appendChild(document.createTextNode(text.slice(i, pos)));
        const mark = document.createElement('mark');
        mark.className = 'bg-yellow-500/40 text-inherit rounded-sm px-0.5';
        mark.textContent = text.slice(pos, pos + q.length);
        frag.appendChild(mark);
        i = pos + q.length;
    }
    if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
    el.replaceChildren(frag);
}

// Colour only the level token (e.g. "[WARN ]"), leaving the message in the
// default foreground so mixed-level logs stay readable. When a search query is
// active, highlight that instead.
function appendLevelText(el, text, query) {
    if (query) { markMatches(el, text, query); return; }

    const m = LEVEL_RE.exec(text);
    if (!m) { el.textContent = text; return; }

    let start = m.index;
    let end = m.index + m[0].length;
    // Absorb a surrounding "[ ... ]" if the token sits inside brackets.
    if (start > 0 && text[start - 1] === '[') {
        let j = end;
        while (j < text.length && text[j] === ' ') j++;
        if (text[j] === ']') { start -= 1; end = j + 1; }
    }

    const cls = levelClass(detectLevel(text)) || 'text-gray-400';
    const frag = document.createDocumentFragment();
    if (start > 0) frag.appendChild(document.createTextNode(text.slice(0, start)));
    const tok = document.createElement('span');
    tok.className = `${cls} font-semibold`;
    tok.textContent = text.slice(start, end);
    frag.appendChild(tok);
    if (end < text.length) frag.appendChild(document.createTextNode(text.slice(end)));
    el.replaceChildren(frag);
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
        this.showNumbers = true;
        this.wrap = false;
        this.following = true;
        this.newWhileAway = 0;
        this.highlightLine = 0;
        this.searchResults = [];
        this.lastSearchQuery = '';
        this.highlightQuery = '';
        this.activeLine = 0;      // anchor line for copy / range selection
        this.selStart = 0;        // inclusive range (0 = no range)
        this.selEnd = 0;
        this.matchIndex = -1;     // index into this.view of the current match

        // Phase 4: tabs, health, notifications, shortcuts panel
        this.tabs = [];                       // open aliases
        this.sidebarItems = {};               // alias -> { dot, badge }
        this.lastStatus = {};                 // alias -> status record
        this.baseline = {};                   // alias -> { errors, warnings } seen
        this.notifyEnabled = false;
        this.panelOpen = false;               // shortcuts panel — hidden by default
        this._notifyAt = 0;
        this.statusTimer = null;

        // Loading guards
        this.loadingOlder = false;
        this.loadingNewer = false;      // fetching the next chunk down
        this.loadedToEnd = false;       // window has reached the live end of the file

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
            lineNumBtn: document.getElementById('lineNumBtn'),
            wrapBtn: document.getElementById('wrapBtn'),
            selBar: document.getElementById('selBar'),
            selCount: document.getElementById('selCount'),
            selCopy: document.getElementById('selCopy'),
            selDownload: document.getElementById('selDownload'),
            selClear: document.getElementById('selClear'),
            tabBar: document.getElementById('tabBar'),
            helpPanel: document.getElementById('helpPanel'),
            panelBtn: document.getElementById('panelBtn'),
            notifyBtn: document.getElementById('notifyBtn'),
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

        // Selection bar (copy / download a line range)
        this.dom.selCopy.addEventListener('click', () => this.copySelection());
        this.dom.selDownload.addEventListener('click', () => this.downloadCurrentLog());
        this.dom.selClear.addEventListener('click', () => this.clearSelection());

        this.dom.panelBtn.addEventListener('click', () => this.togglePanel());
        this.dom.notifyBtn.addEventListener('click', () => this.toggleNotify());

        // Overflow menu — keeps the rarely used, stateful controls out of the bar.
        const moreBtn = document.getElementById('moreBtn');
        const moreMenu = document.getElementById('moreMenu');
        this._closeMore = () => {
            moreMenu.classList.add('hidden');
            moreBtn.setAttribute('aria-expanded', 'false');
        };
        moreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const nowOpen = moreMenu.classList.toggle('hidden');
            moreBtn.setAttribute('aria-expanded', String(!nowOpen));
        });
        document.addEventListener('click', (e) => {
            if (!moreMenu.classList.contains('hidden') && !e.target.closest('.menu-wrap')) this._closeMore();
        });
        document.getElementById('clearBtn').addEventListener('click', () => {
            this.clearView();
            this._closeMore();
        });

        document.addEventListener('keydown', (e) => this.onKeydown(e));

        window.addEventListener('popstate', () => {
            const alias = this.getAliasFromPath();
            if (alias && this.aliases[alias]) this.connect(alias, { updateRoute: false });
        });

        this.updateToggleButtons();
        this.applyNotifyButton();
        this.applyPanel();
        this.renderTabs();
        this.startStatusPolling();
        this.setConn('idle', '');

        const savedAlias = (() => {
            try { return localStorage.getItem('ezlog-last') || ''; } catch (e) { return ''; }
        })();
        const initialAlias =
            (window.INITIAL_ALIAS && this.aliases[window.INITIAL_ALIAS]) ? window.INITIAL_ALIAS
            : this.getAliasFromPath() || (this.aliases[savedAlias] ? savedAlias : '');
        if (initialAlias && this.aliases[initialAlias]) this.connect(initialAlias, { updateRoute: false });
    }

    // -- sidebar --------------------------------------------------------
    renderSidebar(filterText) {
        this.dom.projectList.innerHTML = '';
        this.sidebarItems = {};
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
        this.applyStatus(this.lastStatus);
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
        header.className = 'w-full flex items-center justify-between px-4 py-2 text-sm font-semibold text-gray-300 hover:bg-gray-700 hover:text-white transition-colors';
        header.innerHTML = `
            <span class="flex items-center gap-2 min-w-0">
                <svg class="ico ico-sm" style="color:var(--fg-dim)"><use href="#i-folder"></use></svg>
                <span class="truncate">${this.escape(projectName)}</span>
                <span class="text-xs text-gray-500 font-normal">(${visible.length})</span>
            </span>
            <span class="project-chevron transition-transform duration-200"><svg class="ico ico-sm"><use href="#i-chevron"></use></svg></span>`;

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
        inner.className = 'py-0.5';
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

        let cls = 'w-full text-left px-4 py-2 text-sm transition-colors flex items-center gap-2';
        if (projectName) cls += ' pl-8';
        cls += active
            ? ' bg-gray-700 text-white border-l-2 border-blue-500'
            : ' text-gray-400 hover:bg-gray-700 hover:text-white border-l-2 border-transparent';
        btn.className = cls;

        const dot = document.createElement('span');
        dot.className = 'health-dot unknown';
        dot.title = 'Health unknown';

        const icon = document.createElement('span');
        icon.className = 'flex items-center';
        icon.style.color = 'var(--fg-dim)';
        icon.innerHTML = svgIcon('file', 'ico ico-sm');

        const name = document.createElement('span');
        name.className = 'truncate flex-1';
        name.textContent = displayName;

        const badge = document.createElement('span');
        badge.className = 'hl-badge err hidden';

        btn.append(dot, icon, name, badge);
        this.sidebarItems[alias] = { dot, badge };

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

        this.openTab(alias);
        this.markSeen(alias);
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
        this.loadingNewer = false;
        this.loadedToEnd = false;
        this.highlightQuery = '';
        this.activeLine = 0;
        this.selStart = 0;
        this.selEnd = 0;
        this.matchIndex = -1;
        if (this.dom.selBar) this.dom.selBar.classList.add('hidden');

        try { localStorage.setItem('ezlog-last', alias); } catch (e) { /* ignore */ }

        this.updatePauseButton();
        this.updatePendingBadge();
        this.updateFileInfo();
        this.dom.welcome.classList.add('hidden');
        this.dom.jumpLatest.classList.add('hidden');
        this.dom.scroll.scrollTop = 0;
        this.render();
        this.renderSidebar(document.getElementById('projectSearch').value);
        this.renderTabs();
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

        if (live) this.maybeNotify(rows);

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
        return !!this.filterText;
    }

    matches(row) {
        return !this.filterText || row.text.toLowerCase().includes(this.filterText);
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

        // Follow: keep the newest line in view as batches stream in. The sizer
        // height changed just above, so snap to the new bottom *before* picking
        // the row window — otherwise we render the previous window and the new
        // lines sit below the fold until the user scrolls.
        const el = this.dom.scroll;
        if (this.following) {
            const maxTop = el.scrollHeight - el.clientHeight;
            if (el.scrollTop < maxTop) el.scrollTop = maxTop;
        }

        const st = el.scrollTop;
        const h = el.clientHeight || 400;
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
        // Wrap mode renders a fixed prefix, so only follow when nothing is
        // truncated — otherwise "bottom" would mean line WRAP_RENDER_CAP.
        if (this.following && this.view.length <= WRAP_RENDER_CAP) {
            const el = this.dom.scroll;
            el.scrollTop = el.scrollHeight;
        }
        if (this.view.length > WRAP_RENDER_CAP) {
            this.toast(`Wrap mode limited to ${WRAP_RENDER_CAP} lines — disable to scroll the full window`);
        }
    }

    makeRow(row) {
        const d = document.createElement('div');
        d.className = this.wrap
            ? 'wrapped-row px-3 py-0.5 hover:bg-gray-800'
            : 'log-row nowrap-row flex px-3 hover:bg-gray-800';
        d.dataset.line = String(row.n);

        if (this.showNumbers) {
            const n = document.createElement('span');
            n.className = 'log-num text-gray-500 pr-3 shrink-0';
            n.style.minWidth = '3.25rem';
            n.style.textAlign = 'right';
            n.textContent = row.n;
            d.appendChild(n);
        }

        const t = document.createElement('span');
        appendLevelText(t, row.text, this.highlightQuery);
        d.appendChild(t);

        // Row state: search target, active anchor, selection range.
        if (this.highlightLine && row.n === this.highlightLine) d.classList.add('row-hit');
        if (this.selEnd > this.selStart && row.n >= this.selStart && row.n <= this.selEnd) {
            d.classList.add('row-sel');
        }
        if (row.n === this.activeLine) d.classList.add('row-active');

        if (row.isSearch) {
            d.classList.add('cursor-pointer');
            d.title = `Open context around line ${row.n}`;
            d.onclick = () => this.openSearchContext(row.n);
        } else {
            d.title = 'Click to copy · Shift-click to select a range';
            d.onclick = (e) => this.onRowClick(row.n, e);
        }
        return d;
    }

    // -- scrolling ------------------------------------------------------
    onScroll() {
        const el = this.dom.scroll;
        const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        // "Following" only means anything while live. In history mode we must NOT
        // pin to the bottom, or every appended chunk would drag you further down
        // and chain-load the whole file.
        this.following = distanceToBottom < 40 && this.mode === 'live';

        if (this.following) {
            this.newWhileAway = 0;
            this.dom.jumpLatest.classList.add('hidden');
        }

        if (el.scrollTop < 400 && !this.loadingOlder && this.startLine > 1 && this.mode !== 'search') {
            this.loadOlder();
        }

        // Reached the end of what's loaded while browsing history: pull the next chunk.
        if (this.mode === 'history' && !this.loadedToEnd && !this.loadingNewer
            && distanceToBottom < 400 && this.totalLines && this.lastLoadedLine() < this.totalLines) {
            this.loadNewer();
        }

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
        } catch (e) {
            /* transient */
        } finally {
            this.loadingOlder = false;
            this.dom.topLoader.classList.add('hidden');
        }
    }

    // -- navigation -----------------------------------------------------
    lastLoadedLine() {
        return this.lines.length ? this.lines[this.lines.length - 1].n : 0;
    }

    // Extend the window forwards. The counterpart to loadOlder(), and the piece
    // that was missing: without it, jumping to the top of a huge file left
    // everything after line 500 unreachable.
    async loadNewer() {
        const alias = this.currentAlias;
        if (!alias || this.loadingNewer || this.mode === 'live' || this.mode === 'search') return;

        const last = this.lastLoadedLine();
        if (!last) return;
        if (this.totalLines && last >= this.totalLines) { this.loadedToEnd = true; return; }

        this.loadingNewer = true;
        try {
            const res = await fetch(`/api/logs/${encodeURIComponent(alias)}/history?direction=down&after_line=${last}&count=500`);
            const data = await res.json();
            if (data.total_lines) this.totalLines = data.total_lines;

            if (data.error || !data.lines || data.lines.length === 0) {
                this.loadedToEnd = true;
                this.updateFileInfo();
                return;
            }

            const rows = data.lines.map((text, i) => ({
                n: data.start_line + i, text, lvl: detectLevel(text),
            }));
            this.appendRows(rows, { live: false });
            this.scheduleRender();
            this.updateFileInfo();
        } catch (e) {
            /* transient — the next scroll will retry */
        } finally {
            this.loadingNewer = false;
        }
    }

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
            if (data.total_lines) this.totalLines = data.total_lines;
            this.loadedToEnd = false;
            this.mode = 'history';
            this.highlightLine = 0;
            this.highlightQuery = '';
            this.matchIndex = -1;
            this.clearSelection();
            this.rebuildView();
            this.render();
            this.dom.scroll.scrollTop = 0;
            this.updateFileInfo();
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
            this.highlightQuery = term;
            this.matchIndex = -1;
            this.clearSelection();

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
            if (data.total_lines) this.totalLines = data.total_lines;
            this.loadedToEnd = false;
            this.highlightLine = lineNumber;
            this.highlightQuery = this.lastSearchQuery;
            this.activeLine = lineNumber;
            this.clearSelection();
            this.rebuildView();
            this.matchIndex = this.view.findIndex((r) => r.n === lineNumber);
            this.render();
            this.scrollToLine(lineNumber);
            this.updateFileInfo();
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

    // -- selection / copy ----------------------------------------------
    onRowClick(lineNumber, e) {
        if (e.shiftKey && this.activeLine) {
            this.selStart = Math.min(this.activeLine, lineNumber);
            this.selEnd = Math.max(this.activeLine, lineNumber);
        } else {
            this.activeLine = lineNumber;
            this.selStart = 0;
            this.selEnd = 0;
        }
        // Shift-click also makes the browser drag its own text selection across the
        // rows, which doubles up with our highlight and looks messy. Drop the native
        // selection so the row highlight is the single, consistent one.
        if (e.shiftKey && window.getSelection) {
            window.getSelection().removeAllRanges();
        }
        this.updateSelBar();
        this.scheduleRender();
    }

    clearSelection() {
        this.activeLine = 0;
        this.selStart = 0;
        this.selEnd = 0;
        if (this.dom.selBar) this.dom.selBar.classList.add('hidden');
    }

    updateSelBar() {
        if (!this.dom.selBar) return;
        if (this.selEnd > this.selStart) {
            this.dom.selCount.textContent = `${this.selEnd - this.selStart + 1} lines`;
            this.dom.selBar.classList.remove('hidden');
        } else {
            this.dom.selBar.classList.add('hidden');
        }
    }

    selectionText() {
        if (this.selEnd > this.selStart) {
            return this.view
                .filter((r) => r.n >= this.selStart && r.n <= this.selEnd)
                .map((r) => r.text)
                .join('\n');
        }
        const row = this.view.find((r) => r.n === this.activeLine);
        return row ? row.text : '';
    }

    copySelection() {
        const text = this.selectionText();
        if (!text) { this.toast('Nothing selected'); return; }
        const label = this.selEnd > this.selStart
            ? `Copied ${this.selEnd - this.selStart + 1} lines`
            : `Copied line ${this.activeLine}`;
        this.copyText(text).then(() => this.toast(label)).catch(() => this.toast('Copy failed'));
    }

    async copyText(text) {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text);
        }
        // Fallback for plain-HTTP origins where the async clipboard is unavailable.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (!ok) throw new Error('copy failed');
    }

    // -- match navigation ----------------------------------------------
    jumpToMatch(dir) {
        const q = (this.lastSearchQuery || '').toLowerCase();
        if (!q) { this.toast('Search first (press / or Enter in the filter)'); return; }
        if (!this.view.length) { this.toast('No matches'); return; }

        if (this.mode === 'search') {
            const n = this.view.length;
            this.matchIndex = this.matchIndex < 0 ? 0 : (this.matchIndex + dir + n) % n;
            this.activeLine = this.view[this.matchIndex].n;
            this.highlightQuery = this.lastSearchQuery;
            this.scrollToLine(this.activeLine);
            this.scheduleRender();
            this.toast(`Match ${this.matchIndex + 1}/${n}`);
            return;
        }

        const idxs = [];
        this.view.forEach((r, i) => { if (r.text.toLowerCase().includes(q)) idxs.push(i); });
        if (!idxs.length) { this.toast('No matches in the loaded lines'); return; }
        let pos = idxs.indexOf(this.matchIndex);
        pos = pos === -1 ? (dir > 0 ? 0 : idxs.length - 1) : (pos + dir + idxs.length) % idxs.length;
        this.matchIndex = idxs[pos];
        this.activeLine = this.view[this.matchIndex].n;
        this.highlightQuery = this.lastSearchQuery;
        this.scrollToLine(this.activeLine);
        this.scheduleRender();
        this.toast(`Match ${pos + 1}/${idxs.length}`);
    }

    clearSearchState() {
        this.highlightQuery = '';
        this.matchIndex = -1;
        this.lastSearchQuery = '';
        this.setFilterText('');
        this.dom.filterInput.value = '';
        if (this.mode === 'search') this.goToBottom();
        this.scheduleRender();
    }

    // -- keyboard -------------------------------------------------------
    onKeydown(e) {
        const tag = (e.target && e.target.tagName ? e.target.tagName : '').toLowerCase();
        const typing = tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable);

        if (e.key === '/') {
            e.preventDefault();
            this.dom.filterInput.focus();
            this.dom.filterInput.select();
            return;
        }
        if (e.key === 'Escape') {
            if (this._closeMore) this._closeMore();
            if (typing) this.dom.filterInput.blur();
            this.clearSearchState();
            return;
        }
        if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

        switch (e.key) {
            case 'g': this.goToTop(); break;
            case 'G': this.goToBottom(); break;
            case 'p': this.togglePause(); break;
            case 'n': this.jumpToMatch(1); break;
            case 'N': this.jumpToMatch(-1); break;
            case 'L': this.setShowNumbers(!this.showNumbers); break;
            case 'W': this.setWrap(!this.wrap); break;
            case 'c': this.copySelection(); break;
            case '?': this.togglePanel(); break;
            case 'j': this.dom.scroll.scrollTop += ROW_HEIGHT; break;
            case 'k': this.dom.scroll.scrollTop -= ROW_HEIGHT; break;
        }
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
        this.dom.pauseIcon.innerHTML = svgIcon(this.paused ? 'play' : 'pause');
        this.dom.pauseBtn.classList.toggle('is-warn', this.paused);
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
        this.dom.lineNumBtn.classList.toggle('is-on', this.showNumbers);
        this.dom.wrapBtn.classList.toggle('is-on', this.wrap);
    }

    loadPrefs() {
        this.showNumbers = localStorage.getItem('ezlog-numbers') !== '0';
        this.wrap = localStorage.getItem('ezlog-wrap') === '1';
        this.notifyEnabled = localStorage.getItem('ezlog-notify') === '1';
        this.panelOpen = localStorage.getItem('ezlog-panel') === '1';
        try {
            this.tabs = JSON.parse(localStorage.getItem('ezlog-tabs') || '[]') || [];
            this.baseline = JSON.parse(localStorage.getItem('ezlog-baseline') || '{}') || {};
        } catch (e) {
            this.tabs = [];
            this.baseline = {};
        }
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
        if (this.totalLines) {
            if (this.mode !== 'live' && this.lines.length) {
                parts.push(`lines ${this.startLine.toLocaleString()}–${this.lastLoadedLine().toLocaleString()} of ${this.totalLines.toLocaleString()}`);
            } else {
                parts.push(`${this.totalLines.toLocaleString()} lines`);
            }
        }
        if (this.isFiltered()) parts.push(`${this.view.length.toLocaleString()} shown`);
        this.dom.fileInfo.textContent = parts.join(' • ');
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
        let url = `/api/logs/${encodeURIComponent(this.currentAlias)}/download`;
        if (this.selEnd > this.selStart) {
            url += `?start=${this.selStart}&end=${this.selEnd}`;
            this.toast(`Downloading lines ${this.selStart}–${this.selEnd}`);
        }
        const a = document.createElement('a');
        a.href = url;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    // -- keyboard-shortcuts panel ---------------------------------------
    // The panel content is static markup in the template: a reference that is
    // always true, instead of counts guessed from the log text.
    togglePanel() {
        this.panelOpen = !this.panelOpen;
        localStorage.setItem('ezlog-panel', this.panelOpen ? '1' : '0');
        this.applyPanel();
    }

    applyPanel() {
        this.dom.helpPanel.classList.toggle('hidden', !this.panelOpen);
        this.dom.panelBtn.classList.toggle('is-on', this.panelOpen);
    }

    // -- desktop notifications -----------------------------------------
    async toggleNotify() {
        if (!this.notifyEnabled) {
            if (!('Notification' in window)) { this.toast('Notifications not supported'); return; }
            let perm = Notification.permission;
            if (perm === 'default') perm = await Notification.requestPermission();
            if (perm !== 'granted') { this.toast('Notification permission denied'); return; }
            this.notifyEnabled = true;
            this.toast('Desktop notifications on for new errors');
        } else {
            this.notifyEnabled = false;
            this.toast('Desktop notifications off');
        }
        localStorage.setItem('ezlog-notify', this.notifyEnabled ? '1' : '0');
        this.applyNotifyButton();
    }

    applyNotifyButton() {
        const on = this.notifyEnabled && 'Notification' in window && window.Notification.permission === 'granted';
        this.dom.notifyBtn.classList.toggle('is-on', on);
        this.dom.notifyBtn.innerHTML = svgIcon(on ? 'bell' : 'bell-off') +
            `<span>${on ? 'Notifications on for errors' : 'Notify me about errors'}</span>`;
    }

    maybeNotify(rows) {
        if (!this.notifyEnabled) return;
        if (!('Notification' in window) || window.Notification.permission !== 'granted') return;
        const errors = rows.filter((r) => r.lvl === 'ERROR');
        if (!errors.length) return;
        const now = Date.now();
        if (now - this._notifyAt < 3000) return; // throttle bursts
        this._notifyAt = now;
        try {
            const body = errors.length === 1 ? errors[0].text : `${errors.length} error lines`;
            new window.Notification(`${this.currentAlias}: ${errors.length} new error${errors.length === 1 ? '' : 's'}`, { body, tag: 'ezlog-errors' });
        } catch (e) { /* notification blocked */ }
    }

    // -- sidebar health -------------------------------------------------
    startStatusPolling() {
        this.refreshStatus();
        clearInterval(this.statusTimer);
        this.statusTimer = setInterval(() => this.refreshStatus(), 10000);
    }

    async refreshStatus() {
        try {
            const res = await fetch('/api/status');
            const data = await res.json();
            if (data && data.logs) {
                this.lastStatus = data.logs;
                this.applyStatus(data.logs);
            }
        } catch (e) { /* server offline */ }
    }

    applyStatus(logs) {
        for (const alias of Object.keys(logs)) {
            const item = this.sidebarItems[alias];
            const rec = logs[alias];
            if (!item) continue;

            item.dot.className = rec.exists ? 'health-dot ok' : 'health-dot missing';
            item.dot.title = rec.exists ? (rec.size_human || 'OK') : 'File missing';

            const base = this.baseline[alias] || { errors: 0, warnings: 0 };
            if (!rec.exists) {
                item.badge.className = 'hl-badge miss';
                item.badge.textContent = '!';
                item.badge.title = 'File missing';
            } else if ((rec.errors || 0) > (base.errors || 0)) {
                item.badge.className = 'hl-badge err';
                item.badge.textContent = rec.errors > 99 ? '99+' : String(rec.errors);
                item.badge.title = `${rec.errors} recent errors`;
            } else if ((rec.warnings || 0) > (base.warnings || 0)) {
                item.badge.className = 'hl-badge warn';
                item.badge.textContent = rec.warnings > 99 ? '99+' : String(rec.warnings);
                item.badge.title = `${rec.warnings} recent warnings`;
            } else {
                item.badge.className = 'hl-badge err hidden';
            }
        }
    }

    markSeen(alias) {
        const rec = this.lastStatus[alias];
        this.baseline[alias] = {
            errors: rec ? (rec.errors || 0) : 0,
            warnings: rec ? (rec.warnings || 0) : 0,
        };
        try { localStorage.setItem('ezlog-baseline', JSON.stringify(this.baseline)); } catch (e) { /* ignore */ }
        const item = this.sidebarItems[alias];
        if (item) item.badge.className = 'hl-badge err hidden';
    }

    // -- tabs -----------------------------------------------------------
    openTab(alias) {
        if (!this.tabs.includes(alias)) {
            this.tabs.push(alias);
            try { localStorage.setItem('ezlog-tabs', JSON.stringify(this.tabs)); } catch (e) { /* ignore */ }
        }
        this.renderTabs();
    }

    closeTab(alias) {
        const i = this.tabs.indexOf(alias);
        if (i === -1) return;
        this.tabs.splice(i, 1);
        try { localStorage.setItem('ezlog-tabs', JSON.stringify(this.tabs)); } catch (e) { /* ignore */ }
        if (this.currentAlias === alias) {
            const next = this.tabs[Math.min(i, this.tabs.length - 1)];
            if (next) this.connect(next);
            else this.closeAllTabs();
        }
        this.renderTabs();
    }

    closeAllTabs() {
        this.wantLive = false;
        this.intentionalClose = true;
        if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } this.ws = null; }
        this.currentAlias = null;
        this.currentProject = null;
        this.lines = [];
        this.view = [];
        this.dom.title.textContent = 'Select a log';
        this.dom.fileInfo.textContent = '';
        this.setConn('idle', '');
        this.dom.welcome.classList.remove('hidden');
        this.dom.selBar.classList.add('hidden');
        this.render();
        this.renderSidebar(document.getElementById('projectSearch').value);
        this.renderTabs();
    }

    renderTabs() {
        const bar = this.dom.tabBar;
        if (this.tabs.length === 0) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
        bar.classList.remove('hidden');
        bar.innerHTML = '';
        for (const alias of this.tabs) {
            const isActive = alias === this.currentAlias;
            const tab = document.createElement('div');
            tab.className = 'tab shrink-0' + (isActive ? ' is-active' : '');
            const label = document.createElement('button');
            label.className = 'tab-label';
            label.textContent = alias;
            label.title = alias;
            label.onclick = () => this.connect(alias);
            const close = document.createElement('button');
            close.className = 'tab-x';
            close.innerHTML = svgIcon('close');
            close.title = 'Close tab';
            close.onclick = (e) => { e.stopPropagation(); this.closeTab(alias); };
            tab.append(label, close);
            bar.appendChild(tab);
        }
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
        const meta = { dark: ['moon', 'Dark'], light: ['sun', 'Light'], 'solarized-light': ['contrast', 'Solarized'] };
        const [ic, label] = meta[theme] || meta.dark;
        if (this.dom.themeBtn) this.dom.themeBtn.innerHTML = svgIcon(ic) + `<span>Theme: ${label}</span>`;
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
