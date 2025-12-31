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
            welcome: document.getElementById('welcomeMsg')
        };

        this.init();
    }

    init() {
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
        
        document.getElementById('clearBtn').addEventListener('click', () => {
            this.dom.logContainer.innerHTML = '';
        });

        this.dom.filterInput.addEventListener('input', (e) => this.applyFilter(e.target.value));

        // Smart Scroll Detection
        this.dom.logContainer.addEventListener('scroll', () => {
            const container = this.dom.logContainer;
            const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
            this.isUserScrolling = distanceToBottom > 50;
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
        this.updatePendingCount();

        if (this.ws) this.ws.close();

        // Connect
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        this.ws = new WebSocket(`${proto}://${window.location.host}/ws/${encodeURIComponent(alias)}`);
        
        this.updateStatus('Connecting...', 'bg-yellow-600');

        this.ws.onopen = () => this.updateStatus('Live', 'bg-green-600');
        this.ws.onclose = () => this.updateStatus('Offline', 'bg-red-600');
        
        this.ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            
            if (msg.type === 'sys') {
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
        const frag = document.createDocumentFragment();
        lines.forEach(text => {
            const el = this.createLogElement(text);
            if (el) frag.appendChild(el);
        });
        this.dom.logContainer.appendChild(frag);
        this.scrollToBottom();
    }

    appendLog(text, extraClass = '') {
        const el = this.createLogElement(text, extraClass);
        if (!el) return;
        this.dom.logContainer.appendChild(el);
        this.scrollToBottom();
    }

    createLogElement(text, extraClass = '') {
        // Content Filtering
        const isHidden = this.filterTerm && !text.toLowerCase().includes(this.filterTerm);
        
        const div = document.createElement('div');
        div.className = `py-0.5 px-2 hover:bg-gray-800 border-b border-transparent hover:border-gray-700 ${extraClass} ${isHidden ? 'hidden' : ''}`;
        
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
        const logs = this.dom.logContainer.children;
        for (let div of logs) {
            if (div.classList.contains('py-0.5')) {
                const text = div.textContent.toLowerCase();
                const shouldHide = this.filterTerm && !text.includes(this.filterTerm);
                div.classList.toggle('hidden', shouldHide);
            }
        }
    }

    scrollToBottom() {
        if (!this.isUserScrolling) {
            this.dom.logContainer.scrollTop = this.dom.logContainer.scrollHeight;
        }
    }

    updateStatus(msg, colorClass) {
        const el = this.dom.status;
        el.textContent = msg;
        el.className = `px-2 py-0.5 rounded text-[10px] font-bold uppercase text-white ${colorClass}`;
        el.style.display = 'block';
        setTimeout(() => { el.style.display = 'none'; }, 3000); // Hide after 3s
    }
}

window.addEventListener('DOMContentLoaded', () => {
    window.app = new LogViewer(ALIASES);
});