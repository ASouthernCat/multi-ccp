const token = document.querySelector('meta[name="ccp-ui-token"]').content;
const state = { profiles: [], dashboard: null, selected: null, filter: 'all', query: '', view: 'cards', gateway: null, gatewayLog: null, gatewayTab: 'upstreams', gatewayLogFilter: 'all', gatewayLogEntriesById: new Map(), gatewayLogFocus: null, gatewayDrawerAnimationId: 0, gatewayUpstreamTemplates: [], upstreams: [], presets: [], selectedPreset: 'custom-api', presetQuery: '', presetFilter: 'all', sync: { sourceName: 'main', targetName: '', projects: null, selectedProjectKey: '', scan: null, actions: {}, projectQuery: '', scanning: false, applying: false, requestId: 0, confirm: null, lastResult: null } };
const $ = (id) => document.getElementById(id);
const primaryModalHistory = [];
const primaryModalSuppressedCloseCounts = new Map();
const api = async (path, options = {}) => {
    const res = await fetch(path, { ...options, headers: { 'content-type': 'application/json', 'x-ccp-ui-token': token, ...(options.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
        throw new Error(data.error || 'Request failed');
    return data;
};
function escapeHtml(v) { return String(v ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
function tagClass(tag) { if (['Ready', 'Running'].includes(tag))
    return 'ready'; if (['Need Attention', 'Missing API Key', 'Missing Token', 'Missing Base URL', 'Missing Provider Key', 'Gateway Offline', 'No Token'].includes(tag))
    return 'warn'; if (['Invalid', 'Path Missing', 'Conflict'].includes(tag))
    return 'bad'; return ''; }
function tags(items) { return `<div class="tag-row">${items.slice(0, 3).map(t => `<span class="tag ${tagClass(t)}">${escapeHtml(t)}</span>`).join('')}</div>`; }
function toast(message) { const el = document.createElement('div'); el.className = 'toast'; el.textContent = message; const openDialogs = Array.from(document.querySelectorAll('dialog[open]')); const openDialog = openDialogs[openDialogs.length - 1]; let region = openDialog?.querySelector('.gateway-upstream-drawer:not([hidden]) .dialog-toast-region') || openDialog?.querySelector('.dialog-toast-region'); if (openDialog && !region) {
    region = document.createElement('div');
    region.className = 'dialog-toast-region';
    (openDialog.querySelector('.modal-card') || openDialog).append(region);
} (region || $('toastRegion')).append(el); setTimeout(() => el.remove(), 3600); }
function brief(profile) { if (profile.type === 'api')
    return `<div><strong>Model</strong> ${escapeHtml(profile.model || 'Claude Code default')}</div><div><strong>Base</strong> ${escapeHtml(hostname(profile.baseUrl) || 'Missing')}</div><div><strong>API Key</strong> ${profile.tokenStatus === 'set' ? 'Configured' : 'Missing'}</div>`; if (profile.type === 'login')
    return `<div>Claude account login profile</div><div><strong>Path</strong> ${escapeHtml(shortPath(profile.dir))}</div>`; if (profile.type === 'gateway')
    return `<div><strong>Upstream</strong> ${escapeHtml(profile.meta?.gateway?.upstreamId || 'Missing')}</div><div><strong>Default model</strong> ${escapeHtml(profile.model || 'Missing')}</div><div><strong>Provider</strong> ${escapeHtml(profile.gatewayUpstream?.provider || 'Unavailable')}</div>`; if (profile.type === 'main')
    return `<div>Claude Code default configuration</div><div><strong>Path</strong> ${escapeHtml(shortPath(profile.dir))}</div>`; return `<div><strong>Path</strong> ${escapeHtml(shortPath(profile.dir))}</div>`; }
function hostname(url) { try {
    return new URL(url).hostname;
}
catch {
    return url || '';
} }
function shortPath(p) { return String(p || '').replace(/^.*?\.claude-profiles/, '~/.claude-profiles').replace(/^.*?\.claude$/, '~/.claude'); }
function filtered() { return state.profiles.filter(p => { const q = state.query.toLowerCase(); const hay = [p.name, p.type, p.model, p.baseUrl, p.statusText, ...(p.tags || [])].join(' ').toLowerCase(); const okQ = !q || hay.includes(q); const okF = state.filter === 'all' || p.type === state.filter || (state.filter === 'attention' && p.status !== 'ready'); return okQ && okF; }); }
function bindMetricAction(element, action) { element.onclick = action; element.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    action();
} }; }
function renderSummary() { const d = state.dashboard?.profiles || {}; const g = state.dashboard?.gateway || {}; const gatewayStatus = g.statusText || (g.running ? 'Running' : 'Offline'); const metrics = [['Profiles', d.total ?? 0, 'all'], ['API', d.api ?? 0, 'api'], ['Gateway', d.gateway ?? 0, 'gateway'], ['Login', d.login ?? 0, 'login'], ['Attention', d.needsAttention ?? 0, 'attention']]; $('summaryGrid').innerHTML = metrics.map(([label, val, kind]) => `<article class="metric ${kind}"><span>${label}</span><b>${val}</b></article>`).join('') + `<article class="metric gateway-service ${g.running ? 'running' : ''}" role="button" tabindex="0" id="gatewayMetric" title="打开 Gateway 管理" aria-label="打开 Gateway 管理，当前状态 ${escapeHtml(gatewayStatus)}"><span>Gateway Service</span><b>${escapeHtml(gatewayStatus)}</b></article>`; bindMetricAction($('gatewayMetric'), openGatewayPanel); }
function iconSvg(name) {
    const icons = {
        home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.4 12 4l8 7.4v7.1a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-7.1Z"/><path d="M9 20v-6h6v6"/></svg>',
        key: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 9h8"/><path d="M8 13h5"/><path d="M8 17h8"/></svg>',
        user: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="8" r="4"/></svg>',
        route: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M8 7.5 11 16"/><path d="m16 7.5-3 8.5"/><path d="M8 6h8"/></svg>',
        circleHelp: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 1 1 5.8 1c-.8 1.1-1.9 1.3-2.4 2.5"/><path d="M12 17h.01"/></svg>',
        moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 13.3A8.5 8.5 0 1 1 10.7 3.2 6.7 6.7 0 0 0 20.8 13.3Z"/></svg>',
        sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>',
        refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>',
        plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
        search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
        history: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/></svg>',
        terminal: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/></svg>',
        trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>',
        power: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v10"/><path d="M18.4 6.6a8 8 0 1 1-12.8 0"/></svg>',
        fileText: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h6"/></svg>',
        pencil: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
        eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
        eyeOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18"/><path d="M10.6 6.2A10.6 10.6 0 0 1 12 6c6.5 0 10 6 10 6s-.8 1.4-2.1 2.8"/><path d="M6.6 6.6C3.6 8.4 2 12 2 12s3.5 6 10 6a10.2 10.2 0 0 0 4.1-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
        cpu: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><rect x="8" y="9" width="8" height="6" rx="1"/><path d="M8 2v3M16 2v3M8 19v3M16 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>',
        send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
        zap: '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
        database: '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
        activity: '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
        maximize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>',
        minimize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>',
        sparkles: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/><path d="M5 3v4M3 5h4M19 17v4M17 19h4"/></svg>',
        target: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
        copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
        check: '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
        code: '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
        bug: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="8" height="14" x="8" y="6" rx="4"/><path d="m19 7-3 2"/><path d="m5 7 3 2"/><path d="m19 19-3-2"/><path d="m5 19 3-2"/><path d="M20 13h-4"/><path d="M4 13h4"/><path d="m10 4 1 2"/><path d="m14 4-1 2"/></svg>',
        flask: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 2v7.31L4.29 19.3A2 2 0 0 0 6 22h12a2 2 0 0 0 1.71-2.7L14 9.31V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/></svg>',
        users: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
        x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
        shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 6v6c0 5 3.4 8.4 8 9.5 4.6-1.1 8-4.5 8-9.5V6l-8-3Z"/><path d="m9 12 2 2 4-4"/></svg>',
        messageSquare: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
    };
    return icons[name] || icons.circleHelp;
}
function secretInput(id, value = '', options = {}) {
    const disabled = options.disabled ? 'disabled' : '';
    const required = options.required ? 'required' : '';
    const placeholder = options.placeholder ? `placeholder="${escapeHtml(options.placeholder)}"` : '';
    return `<span class="secret-field"><input id="${escapeHtml(id)}" type="password" value="${escapeHtml(value)}" ${placeholder} ${disabled} ${required} autocomplete="off" spellcheck="false" /><button class="secret-toggle" type="button" data-secret-toggle="${escapeHtml(id)}" aria-label="Show API Key" title="Show API Key" ${disabled}>${iconSvg('eye')}</button></span>`;
}
function bindSecretToggles(scope = document) {
    scope.querySelectorAll('[data-secret-toggle]').forEach(button => {
        button.onclick = () => {
            const input = $(button.dataset.secretToggle);
            if (!input || input.disabled)
                return;
            const reveal = input.type === 'password';
            input.type = reveal ? 'text' : 'password';
            const label = reveal ? 'Hide API Key' : 'Show API Key';
            button.innerHTML = iconSvg(reveal ? 'eyeOff' : 'eye');
            button.setAttribute('aria-label', label);
            button.title = label;
        };
    });
}
function hydrateIcons() { document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = iconSvg(el.dataset.icon); }); }
function iconFor(type) { return iconSvg({ main: 'home', api: 'key', gateway: 'route', login: 'user', unknown: 'circleHelp' }[type] || 'circleHelp'); }
const providerIcons = {
    aicodemirror: '/icons/aicodemirror.ico',
    anthropic: '/icons/anthropic.svg',
    claude: '/icons/claude.svg',
    deepseek: '/icons/deepseek.svg',
    mimo: '/icons/mimo.svg',
    openai: '/icons/chatgpt.svg',
    xai: '/icons/xai.svg',
    xiaomi: '/icons/xiaomi.svg',
    zai: '/icons/zai.svg'
};
function inferProviderBrand(...values) {
    const haystack = values.flat(Infinity).filter(Boolean).join(' ').toLowerCase();
    if (haystack.includes('aicodemirror'))
        return 'aicodemirror';
    if (haystack.includes('deepseek'))
        return 'deepseek';
    if (haystack.includes('mimo'))
        return 'mimo';
    if (haystack.includes('x.ai') || haystack.includes('xai') || haystack.includes('grok'))
        return 'xai';
    if (haystack.includes('z.ai') || haystack.includes('bigmodel') || haystack.includes('glm-'))
        return 'zai';
    if (haystack.includes('xiaomi'))
        return 'xiaomi';
    if (haystack.includes('openai.com') || haystack.includes('openai official'))
        return 'openai';
    return '';
}
function brandIconMarkup(brand, fallback = '', className = '') {
    const src = providerIcons[brand];
    if (!src)
        return fallback;
    return `<span class="provider-logo ${escapeHtml(brand)} ${escapeHtml(className)}"><img src="${src}" alt="" aria-hidden="true" /></span>`;
}
function profileBrand(p) {
    if (p.type === 'main' || p.type === 'login')
        return 'claude';
    if (p.type === 'gateway') {
        const upstream = p.gatewayUpstream || {};
        if (upstream.provider === 'openai')
            return 'openai';
        return inferProviderBrand(upstream.id, upstream.endpointUrl, upstream.models, p.model);
    }
    if (p.type === 'api')
        return inferProviderBrand(p.name, p.baseUrl, p.model, p.tags);
    return '';
}
function profileIcon(p) { return brandIconMarkup(profileBrand(p), iconFor(p.type), 'profile-brand-logo'); }
function actionHint(p) { if (p.type === 'api')
    return p.tokenStatus === 'set' ? 'API Key ready' : 'Needs API Key'; if (p.type === 'login')
    return 'Login isolated'; if (p.type === 'main')
    return 'Default config'; return p.statusText; }
function renderBoard(options = {}) { const board = $('profileBoard'); const items = filtered(); if (!items.length) {
    board.innerHTML = `${boardToolbar()}<div class="empty-state"><p class="eyebrow">empty result</p><h2>没有匹配的 Profile</h2><p>调整搜索或筛选条件，或者创建一个新的 Profile。</p></div>`;
    bindBoardControls(board);
    restoreBoardFocus(options);
    return;
} board.innerHTML = `${boardToolbar()}<div class="board-head"><div><p class="eyebrow">profiles</p><h2>${items.length} visible profiles</h2></div><p>${items.filter(p => p.status !== 'ready').length} need attention</p></div>${state.view === 'cards' ? renderCards(items) : renderList(items)}`; bindBoardControls(board); restoreBoardFocus(options); board.querySelectorAll('[data-select]').forEach(el => el.addEventListener('click', () => selectProfile(el.dataset.select))); board.querySelectorAll('[data-term]').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); launchTerminal(el.dataset.term); })); }
function restoreBoardFocus(options) { if (!options.focusSearch)
    return; const input = $('profileBoard').querySelector('#searchInput'); if (!input)
    return; input.focus(); const pos = input.value.length; input.setSelectionRange(pos, pos); }
function boardToolbar() { return `<div class="board-toolbar"><div class="board-tools-left"><div class="search-wrap"><span>${iconSvg('search')}</span><input id="searchInput" type="search" placeholder="搜索 profile、模型、endpoint..." value="${escapeHtml(state.query)}" /></div><div class="filters" id="typeFilters"><button class="chip ${state.filter === 'all' ? 'active' : ''}" data-filter="all" type="button">All</button><button class="chip ${state.filter === 'main' ? 'active' : ''}" data-filter="main" type="button">Main</button><button class="chip ${state.filter === 'api' ? 'active' : ''}" data-filter="api" type="button">API</button><button class="chip ${state.filter === 'gateway' ? 'active' : ''}" data-filter="gateway" type="button">Gateway</button><button class="chip ${state.filter === 'login' ? 'active' : ''}" data-filter="login" type="button">Login</button><button class="chip ${state.filter === 'attention' ? 'active' : ''}" data-filter="attention" type="button">Attention</button></div></div><div class="board-tools-right"><button class="chip ${state.view === 'cards' ? 'active' : ''}" id="cardViewBtn" type="button">Cards</button><button class="chip ${state.view === 'list' ? 'active' : ''}" id="listViewBtn" type="button">List</button></div></div>`; }
function bindBoardControls(scope) { const search = scope.querySelector('#searchInput'); if (search)
    search.oninput = e => { state.query = e.target.value; renderBoard({ focusSearch: true }); }; const filters = scope.querySelector('#typeFilters'); if (filters)
    filters.onclick = e => { if (!e.target.dataset.filter)
        return; state.filter = e.target.dataset.filter; renderBoard(); }; const card = scope.querySelector('#cardViewBtn'); if (card)
    card.onclick = () => { state.view = 'cards'; renderBoard(); }; const list = scope.querySelector('#listViewBtn'); if (list)
    list.onclick = () => { state.view = 'list'; renderBoard(); }; }
function renderCards(arr) { return `<div class="cards">${arr.map(p => `<article class="profile-card ${state.selected === p.name ? 'selected' : ''}" data-select="${escapeHtml(p.name)}"><div class="card-top"><div class="profile-icon ${p.type}">${profileIcon(p)}</div><div class="card-title"><h3>${escapeHtml(p.name)}</h3><p>${escapeHtml(actionHint(p))}</p></div></div>${tags(p.tags)}<div class="profile-meta">${brief(p)}</div><div class="card-actions"><button class="ghost tiny icon-action" type="button" data-term="${escapeHtml(p.name)}" title="Open Terminal">${iconSvg('terminal')}<span>Terminal</span></button></div><img class="profile-clawd profile-clawd-card" src="/icons/clawd.svg" alt="" aria-hidden="true" draggable="false" /></article>`).join('')}</div>`; }
function renderList(arr) { return `<table class="list-table"><thead><tr><th>Name</th><th>Tags</th><th>Model</th><th>Base / Path</th><th>Actions</th></tr></thead><tbody>${arr.map(p => `<tr class="${state.selected === p.name ? 'selected' : ''}" data-select="${escapeHtml(p.name)}"><td><span class="profile-list-name"><span class="profile-icon ${p.type}">${profileIcon(p)}</span><strong>${escapeHtml(p.name)}</strong></span></td><td>${tags(p.tags)}</td><td>${escapeHtml(p.model || '—')}</td><td>${escapeHtml(hostname(p.baseUrl) || shortPath(p.dir))}</td><td><span class="profile-list-actions"><button class="ghost tiny icon-action" type="button" data-term="${escapeHtml(p.name)}" title="Open Terminal">${iconSvg('terminal')}<span>Terminal</span></button><img class="profile-clawd profile-clawd-list" src="/icons/clawd.svg" alt="" aria-hidden="true" draggable="false" /></span></td></tr>`).join('')}</tbody></table>`; }
function updateBoardSelection(name) {
    const board = $('profileBoard');
    if (!board)
        return;
    board.querySelectorAll('[data-select]').forEach(element => element.classList.toggle('selected', element.dataset.select === name));
}
async function selectProfile(name) { const data = await api(`/api/profiles/${encodeURIComponent(name)}`); state.selected = name; $('drawer').inert = false; $('drawer').setAttribute('aria-hidden', 'false'); renderDrawer(data.profile); updateBoardSelection(name); $('workspace').classList.add('drawer-open'); }
function renderDrawer(p) { const env = p.settings?.env || {}; $('drawer').innerHTML = `<div class="drawer-rail"><button class="icon-btn" id="drawerClose" type="button" title="关闭">×</button></div><div class="drawer-fixed"><p class="eyebrow">${escapeHtml(p.type)} profile</p><h2>${escapeHtml(p.name)}</h2>${tags(p.tags)}<div class="drawer-section launch-section"><p class="eyebrow">launch</p><div class="command"><code>${escapeHtml(p.startCommand)}</code><span class="command-actions"><button class="ghost tiny" id="copyStart">Copy</button><button class="ghost tiny icon-action" id="termStart" type="button" title="Open Terminal">${iconSvg('terminal')}<span>Terminal</span></button></span></div></div></div><div class="drawer-scroll"><div class="profile-summary"><div class="drawer-section profile-info"><div class="kv"><span>Status</span><strong>${escapeHtml(p.statusText)}</strong><span>Path</span><strong><button class="path-link" id="revealSettings" type="button" title="在文件管理器中显示">${escapeHtml(p.settingsPath)}</button></strong></div>${fullConfigBlock(p)}</div></div>${settingsForm(p, env)}<div class="drawer-section drawer-sync-section"><p class="eyebrow">sessions</p><button class="ghost icon-action" id="openSyncWorkspace" type="button">${iconSvg('history')}<span>Sync Workspace</span></button><p class="hint">在 profile 之间可视化同步项目会话日志。</p></div>${p.type !== 'main' ? `<div class="drawer-section"><p class="eyebrow">danger zone</p><p class="hint">删除操作不可撤销。请输入 profile 名称确认。</p><div class="danger-actions"><input id="deleteConfirm" placeholder="${escapeHtml(p.name)}"/><button class="ghost" id="deleteBtn">Delete Profile</button></div></div>` : ''}</div>`; $('drawerClose').onclick = closeDrawer; $('copyStart').onclick = () => copy(p.startCommand); $('termStart').onclick = () => launchTerminal(p.name); $('revealSettings').onclick = () => revealSettings(p.name); $('openSyncWorkspace').onclick = () => openSyncWorkspace(p.name); bindSecretToggles($('drawer')); if (p.type === 'api')
    void hydrateProfileApiKey(p.name); const openGateway = $('openGatewayFromDrawer'); if (openGateway)
    openGateway.onclick = openGatewayPanel; if (p.type === 'gateway')
    bindGatewayBinding('editGateway', p.meta?.gateway?.upstreamId, p.meta?.gateway?.model); const save = $('saveSettings'); if (save)
    save.onclick = () => saveProfile(p).catch(err => toast(err.message)); const del = $('deleteBtn'); if (del)
    del.onclick = () => deleteProfile(p.name); }
function closeDrawer() { state.selected = null; updateBoardSelection(null); $('workspace').classList.remove('drawer-open'); $('drawer').setAttribute('aria-hidden', 'true'); $('drawer').inert = true; }
function fullConfigBlock(p) { const config = { settings: p.settings || {}, ...(p.meta ? { ccp: p.meta } : {}) }; return `<details class="preset-config drawer-config"><summary>完整配置</summary><pre>${escapeHtml(JSON.stringify(config, null, 2))}</pre></details>`; }
const gatewayChatCompatibilityKeys = ['instructionRole', 'maxTokensField', 'supportsStop', 'supportsSampling', 'parallelToolCalls', 'streamUsage', 'reasoningEffort', 'structuredOutput'];
const gatewayResponsesCompatibilityKeys = ['instructions', 'maxOutputTokens', 'supportsStop', 'supportsSampling', 'parallelToolCalls', 'toolStrict', 'reasoningEffort', 'structuredOutput', 'store'];
const gatewayCompatibilityPresets = {
    openaiChat: { protocol: 'openai_chat_completions', instructionRole: 'developer', maxTokensField: 'max_completion_tokens', supportsStop: false, supportsSampling: false, parallelToolCalls: 'supported', streamUsage: 'include', reasoningEffort: 'reasoning_effort', structuredOutput: 'response_format' },
    modern: { protocol: 'openai_chat_completions', instructionRole: 'developer', maxTokensField: 'max_completion_tokens', supportsStop: true, supportsSampling: true, parallelToolCalls: 'supported', streamUsage: 'include', reasoningEffort: 'reasoning_effort', structuredOutput: 'response_format' },
    legacy: { protocol: 'openai_chat_completions', instructionRole: 'system', maxTokensField: 'max_tokens', supportsStop: true, supportsSampling: true, parallelToolCalls: 'unsupported', streamUsage: 'omit', reasoningEffort: 'omit', structuredOutput: 'unsupported' },
    openaiResponses: { protocol: 'openai_responses', instructions: 'instructions', maxOutputTokens: 'max_output_tokens', supportsStop: false, supportsSampling: false, parallelToolCalls: 'supported', toolStrict: 'non_strict', reasoningEffort: 'reasoning.effort', structuredOutput: 'text.format', store: false },
    responses: { protocol: 'openai_responses', instructions: 'instructions', maxOutputTokens: 'max_output_tokens', supportsStop: false, supportsSampling: true, parallelToolCalls: 'supported', toolStrict: 'non_strict', reasoningEffort: 'reasoning.effort', structuredOutput: 'text.format', store: false }
};
function gatewayProtocolLabel(protocol) { return protocol === 'openai_responses' ? 'Responses' : 'Chat Completions'; }
function sameGatewayCompatibility(left, right, keys) { return keys.every(key => left?.[key] === right?.[key]); }
function gatewayCompatibilityMode(protocol, provider, compatibility) {
    if (protocol === 'openai_responses') {
        if (provider === 'openai' && sameGatewayCompatibility(compatibility, gatewayCompatibilityPresets.openaiResponses, gatewayResponsesCompatibilityKeys))
            return 'openai';
        if (sameGatewayCompatibility(compatibility, gatewayCompatibilityPresets.responses, gatewayResponsesCompatibilityKeys))
            return 'responses';
        return 'advanced';
    }
    if (provider === 'openai' && sameGatewayCompatibility(compatibility, gatewayCompatibilityPresets.openaiChat, gatewayChatCompatibilityKeys))
        return 'openai';
    if (sameGatewayCompatibility(compatibility, gatewayCompatibilityPresets.modern, gatewayChatCompatibilityKeys))
        return 'modern';
    if (sameGatewayCompatibility(compatibility, gatewayCompatibilityPresets.legacy, gatewayChatCompatibilityKeys))
        return 'legacy';
    return 'advanced';
}
function gatewayModeButtons(prefix, mode, protocol, provider) {
    return `<div class="segmented gateway-mode" data-gateway-mode-control="${prefix}"><button type="button" data-gateway-mode="openai" ${provider === 'openai' ? '' : 'hidden'}>OpenAI</button><button type="button" data-gateway-mode="responses" ${protocol === 'openai_responses' && provider !== 'openai' ? '' : 'hidden'}>Responses</button><button type="button" data-gateway-mode="modern" ${protocol === 'openai_chat_completions' && provider !== 'openai' ? '' : 'hidden'}>Modern</button><button type="button" data-gateway-mode="legacy" ${protocol === 'openai_chat_completions' && provider !== 'openai' ? '' : 'hidden'}>Legacy</button><button type="button" data-gateway-mode="advanced" ${provider === 'openai' ? 'hidden' : ''}>Advanced</button></div><input type="hidden" id="${prefix}Mode" value="${escapeHtml(mode)}" />`;
}
function gatewayAdvancedFields(prefix, protocol, compatibility) {
    if (protocol === 'openai_responses') {
        const c = compatibility?.protocol === 'openai_responses' ? compatibility : gatewayCompatibilityPresets.responses;
        return `<div class="gateway-advanced" id="${prefix}Advanced"><label>Instructions<select id="${prefix}Instructions"><option value="instructions" ${c.instructions === 'instructions' ? 'selected' : ''}>instructions</option><option value="system_input" ${c.instructions === 'system_input' ? 'selected' : ''}>system input item</option></select></label><label>Effort Mapping<select id="${prefix}ReasoningEffort"><option value="reasoning.effort" ${c.reasoningEffort === 'reasoning.effort' ? 'selected' : ''}>reasoning.effort</option><option value="omit" ${c.reasoningEffort === 'omit' ? 'selected' : ''}>omit</option></select></label><label>Structured Output<select id="${prefix}StructuredOutput"><option value="text.format" ${c.structuredOutput === 'text.format' ? 'selected' : ''}>text.format</option><option value="unsupported" ${c.structuredOutput === 'unsupported' ? 'selected' : ''}>unsupported</option></select></label><label>Tool Strict Mode<select id="${prefix}ToolStrict"><option value="non_strict" ${c.toolStrict !== 'strict' ? 'selected' : ''}>non_strict (recommended for Claude Code)</option><option value="strict" ${c.toolStrict === 'strict' ? 'selected' : ''}>strict (all props required)</option></select></label><div class="gateway-toggles"><label class="gateway-toggle"><input id="${prefix}SupportsSampling" type="checkbox" ${c.supportsSampling ? 'checked' : ''}/><span>Sampling</span></label><label class="gateway-toggle"><input id="${prefix}ParallelToolCalls" type="checkbox" ${c.parallelToolCalls === 'supported' ? 'checked' : ''}/><span>Parallel tools</span></label></div></div>`;
    }
    const c = compatibility?.protocol === 'openai_chat_completions' ? compatibility : gatewayCompatibilityPresets.modern;
    return `<div class="gateway-advanced" id="${prefix}Advanced"><label>Instruction Role<select id="${prefix}InstructionRole"><option value="developer" ${c.instructionRole === 'developer' ? 'selected' : ''}>developer</option><option value="system" ${c.instructionRole === 'system' ? 'selected' : ''}>system</option></select></label><label>Token Field<select id="${prefix}MaxTokensField"><option value="max_completion_tokens" ${c.maxTokensField === 'max_completion_tokens' ? 'selected' : ''}>max_completion_tokens</option><option value="max_tokens" ${c.maxTokensField === 'max_tokens' ? 'selected' : ''}>max_tokens</option></select></label><label>Effort Mapping<select id="${prefix}ReasoningEffort"><option value="reasoning_effort" ${c.reasoningEffort === 'reasoning_effort' ? 'selected' : ''}>reasoning_effort</option><option value="output_config" ${c.reasoningEffort === 'output_config' ? 'selected' : ''}>output_config.effort</option><option value="omit" ${c.reasoningEffort === 'omit' ? 'selected' : ''}>omit</option></select></label><label>Structured Output<select id="${prefix}StructuredOutput"><option value="response_format" ${c.structuredOutput === 'response_format' ? 'selected' : ''}>response_format</option><option value="output_config" ${c.structuredOutput === 'output_config' ? 'selected' : ''}>output_config.format</option><option value="unsupported" ${c.structuredOutput === 'unsupported' ? 'selected' : ''}>unsupported</option></select></label><div class="gateway-toggles"><label class="gateway-toggle"><input id="${prefix}SupportsStop" type="checkbox" ${c.supportsStop ? 'checked' : ''}/><span>Stop sequences</span></label><label class="gateway-toggle"><input id="${prefix}SupportsSampling" type="checkbox" ${c.supportsSampling ? 'checked' : ''}/><span>Sampling</span></label><label class="gateway-toggle"><input id="${prefix}ParallelToolCalls" type="checkbox" ${c.parallelToolCalls === 'supported' ? 'checked' : ''}/><span>Parallel tools</span></label><label class="gateway-toggle"><input id="${prefix}StreamUsage" type="checkbox" ${c.streamUsage === 'include' ? 'checked' : ''}/><span>Stream usage</span></label></div></div>`;
}
function readGatewayCompatibility(prefix, protocol) {
    if (protocol === 'openai_responses') {
        return { protocol, instructions: $(`${prefix}Instructions`).value, maxOutputTokens: 'max_output_tokens', supportsStop: false, supportsSampling: $(`${prefix}SupportsSampling`).checked, parallelToolCalls: $(`${prefix}ParallelToolCalls`).checked ? 'supported' : 'unsupported', toolStrict: $(`${prefix}ToolStrict`)?.value || 'non_strict', reasoningEffort: $(`${prefix}ReasoningEffort`).value, structuredOutput: $(`${prefix}StructuredOutput`).value, store: false };
    }
    return { protocol, instructionRole: $(`${prefix}InstructionRole`).value, maxTokensField: $(`${prefix}MaxTokensField`).value, supportsStop: $(`${prefix}SupportsStop`).checked, supportsSampling: $(`${prefix}SupportsSampling`).checked, parallelToolCalls: $(`${prefix}ParallelToolCalls`).checked ? 'supported' : 'unsupported', streamUsage: $(`${prefix}StreamUsage`).checked ? 'include' : 'omit', reasoningEffort: $(`${prefix}ReasoningEffort`).value, structuredOutput: $(`${prefix}StructuredOutput`).value };
}
function availableGatewayUpstreams(provider) {
    return state.upstreams.filter(upstream => !provider || upstream.provider === provider);
}
function gatewayUpstreamOptions(selected = '', provider) {
    const upstreams = availableGatewayUpstreams(provider);
    if (!upstreams.length)
        return '<option value="">No matching upstreams</option>';
    return upstreams.map(upstream => `<option value="${escapeHtml(upstream.id)}" ${upstream.id === selected ? 'selected' : ''}>${escapeHtml(upstream.id)} · ${escapeHtml(upstream.provider)}</option>`).join('');
}
function gatewayModelOptions(upstreamId, selected = '') {
    const upstream = state.upstreams.find(item => item.id === upstreamId);
    if (!upstream?.models?.length)
        return '<option value="">No models configured</option>';
    return upstream.models.map(model => `<option value="${escapeHtml(model)}" ${model === selected ? 'selected' : ''}>${escapeHtml(model)}</option>`).join('');
}
function bindGatewayBinding(prefix, initialUpstream = '', initialModel = '', provider) {
    const upstreamSelect = $(`${prefix}Upstream`);
    const modelSelect = $(`${prefix}Model`);
    if (!upstreamSelect || !modelSelect)
        return false;
    const choices = availableGatewayUpstreams(provider);
    const available = choices.length > 0;
    const empty = $(`${prefix}Empty`);
    upstreamSelect.disabled = !available;
    modelSelect.disabled = !available;
    if (empty)
        empty.hidden = available;
    const selectedUpstream = choices.some(item => item.id === initialUpstream) ? initialUpstream : choices[0]?.id || '';
    upstreamSelect.innerHTML = gatewayUpstreamOptions(selectedUpstream, provider);
    upstreamSelect.value = selectedUpstream;
    const applyModels = (selected = '') => {
        modelSelect.innerHTML = gatewayModelOptions(upstreamSelect.value, selected);
        const upstream = state.upstreams.find(item => item.id === upstreamSelect.value);
        modelSelect.value = upstream?.models?.includes(selected) ? selected : upstream?.models?.[0] || '';
    };
    upstreamSelect.onchange = () => applyModels('');
    applyModels(initialModel);
    return available;
}
function setCreateProfileAvailability(available, message = '') {
    const button = $('createProfileSubmit');
    if (!button)
        return;
    button.disabled = !available;
    if (available) {
        delete button.dataset.unavailable;
        button.removeAttribute('title');
    }
    else {
        button.dataset.unavailable = '1';
        button.title = message;
    }
}
function gatewaySettingsForm(p) {
    const binding = p.meta?.gateway || {};
    const upstream = p.gatewayUpstream;
    return `<div class="drawer-section gateway-editor"><div class="section-heading"><div><p class="eyebrow">gateway routing</p><h3>Profile Binding</h3></div><button class="ghost icon-action" id="openGatewayFromDrawer" type="button">${iconSvg('route')}<span>Manage</span></button></div><div class="gateway-form-grid"><label>Upstream<select id="editGatewayUpstream" required>${gatewayUpstreamOptions(binding.upstreamId)}</select></label><label>Default model<select id="editGatewayModel" required>${gatewayModelOptions(binding.upstreamId, binding.model)}</select></label></div><div class="gateway-binding-summary"><span>Provider<strong>${escapeHtml(upstream?.provider || 'Unavailable')}</strong></span><span>Protocol<strong>${escapeHtml(upstream ? gatewayProtocolLabel(upstream.protocol) : 'Unavailable')}</strong></span><span>Endpoint<strong title="${escapeHtml(upstream?.endpointUrl || '')}">${escapeHtml(hostname(upstream?.endpointUrl || '') || 'Unavailable')}</strong></span><span>Applies to<strong>Claude Code Default</strong></span></div><p class="hint">Running sessions using Default switch on their next request. Explicit /model selections remain selected while available on the chosen Upstream. No gateway restart is required.</p><button class="primary" id="saveSettings">Save Default</button></div>`;
}
function settingsForm(p, env) {
    if (p.type === 'api')
        return `<div class="drawer-section"><p class="eyebrow">settings</p><label>Base URL<input id="baseUrl" value="${escapeHtml(env.ANTHROPIC_BASE_URL || '')}" placeholder="https://api.example.com/anthropic" autocomplete="url"></label><label>API Key${secretInput('apiKey', '', { disabled: true, placeholder: 'Loading...' })}</label><label>Model<input id="model" value="${escapeHtml(env.ANTHROPIC_MODEL || '')}" placeholder="留空使用默认，或完整模型ID如 claude-opus-4-8" autocomplete="off"></label><label>Opus Model<input id="opusModel" value="${escapeHtml(env.ANTHROPIC_DEFAULT_OPUS_MODEL || '')}" placeholder="claude-opus-4-8" autocomplete="off"></label><label>Sonnet Model<input id="sonnetModel" value="${escapeHtml(env.ANTHROPIC_DEFAULT_SONNET_MODEL || '')}" placeholder="claude-sonnet-5" autocomplete="off"></label><label>Haiku Model<input id="haikuModel" value="${escapeHtml(env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '')}" placeholder="claude-haiku-4-5" autocomplete="off"></label><label>Subagent Model<input id="subagentModel" value="${escapeHtml(env.CLAUDE_CODE_SUBAGENT_MODEL || '')}" placeholder="claude-haiku-4-5" autocomplete="off"></label><button class="primary" id="saveSettings" disabled>Save Settings</button></div>`;
    if (p.type === 'gateway')
        return gatewaySettingsForm(p);
    return `<div class="drawer-section"><p class="eyebrow">settings</p><p class="hint">该 Profile 当前以只读方式展示。</p></div>`;
}
async function saveProfile(p) { let body; if (p.type === 'gateway') {
    body = { kind: 'gateway', upstreamId: $('editGatewayUpstream').value, model: $('editGatewayModel').value };
}
else
    body = { kind: 'api', baseUrl: $('baseUrl').value, token: $('apiKey').value, model: $('model').value, opusModel: $('opusModel').value, sonnetModel: $('sonnetModel').value, haikuModel: $('haikuModel').value, subagentModel: $('subagentModel').value }; const data = await api(`/api/profiles/${encodeURIComponent(p.name)}`, { method: 'PUT', body: JSON.stringify(body) }); toast(p.type === 'gateway' ? 'Default model 已更新；运行中使用 Default 的会话将在下一次请求生效' : '已保存'); await load(); renderDrawer(data.profile); }
async function hydrateProfileApiKey(name) {
    const input = $('apiKey');
    const toggle = document.querySelector('[data-secret-toggle="apiKey"]');
    try {
        const data = await api(`/api/profiles/${encodeURIComponent(name)}/api-key`, { method: 'POST' });
        if (state.selected !== name || input !== $('apiKey'))
            return;
        input.value = data.apiKey || '';
        input.placeholder = '';
    }
    catch (err) {
        if (state.selected !== name || input !== $('apiKey'))
            return;
        input.placeholder = 'Unable to load API Key';
        toast(err.message);
    }
    finally {
        if (state.selected === name && input === $('apiKey')) {
            input.disabled = false;
            if (toggle)
                toggle.disabled = false;
            const save = $('saveSettings');
            if (save)
                save.disabled = false;
        }
    }
}
async function deleteProfile(name) { if (($('deleteConfirm').value || '') !== name) {
    toast('请输入完整 Profile 名称确认');
    return;
} if (!confirm(`确认删除 profile "${name}"？此操作不可撤销。`))
    return; await api(`/api/profiles/${encodeURIComponent(name)}`, { method: 'DELETE', body: JSON.stringify({ confirmName: name }) }); state.selected = null; toast('已删除'); await load(); closeDrawer(); }
async function copy(text) { await navigator.clipboard.writeText(text); toast('已复制'); }
async function launchTerminal(name) { try {
    await api(`/api/profiles/${encodeURIComponent(name)}/terminal`, { method: 'POST' });
    toast('已拉起终端');
}
catch (err) {
    toast(err.message);
} }
async function revealSettings(name) { try {
    await api(`/api/profiles/${encodeURIComponent(name)}/reveal-settings`, { method: 'POST' });
    toast('已打开文件位置');
}
catch (err) {
    toast(err.message);
} }
function gatewayLogTime(value) { if (!value)
    return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function gatewayLogIsExpected(entry) { return entry.kind === 'request' && entry.outcome === 'expected_unsupported'; }
function gatewayLogIsFailure(entry) { return entry.kind === 'request' && !gatewayLogIsExpected(entry) && (entry.outcome === 'failure' || Number(entry.status || 0) >= 400); }
function gatewayFilteredLogEntries(log) {
    const entries = log?.entries || [];
    if (state.gatewayLogFilter === 'errors')
        return entries.filter(gatewayLogIsFailure);
    if (state.gatewayLogFilter === 'success')
        return entries.filter(entry => entry.kind === 'request' && !gatewayLogIsExpected(entry) && Number(entry.status || 0) >= 200 && Number(entry.status || 0) < 400);
    return entries;
}
function gatewayLogRows(log) { const entries = gatewayFilteredLogEntries(log); state.gatewayLogEntriesById = new Map(entries.filter(entry => entry.kind === 'request').map((entry, index) => [entry.requestId || `log-${index}`, entry])); if (!entries.length)
    return '<div class="gateway-log-empty">No matching request events</div>'; return `<div class="gateway-log-scroll"><table class="gateway-log-table"><thead><tr><th>Time</th><th>Profile</th><th>Model</th><th>Endpoint URL</th><th>Mode</th><th>Effort</th><th>Status</th><th>Latency</th><th>Tokens</th></tr></thead><tbody>${entries.map((entry, index) => { if (entry.kind === 'system')
    return `<tr class="system"><td>${gatewayLogTime(entry.completedAt)}</td><td colspan="8">${escapeHtml(entry.message || 'Gateway event')}</td></tr>`; const status = Number(entry.status || 0); const expected = gatewayLogIsExpected(entry); const statusClass = expected ? 'expected' : status >= 500 ? 'bad' : status >= 400 ? 'warn' : 'ok'; const tokens = entry.inputTokens === undefined && entry.outputTokens === undefined ? '&mdash;' : `${entry.inputTokens ?? 0} / ${entry.outputTokens ?? 0}`; const endpointUrl = entry.endpointUrl || '-'; const rowId = entry.requestId || `log-${index}`; const statusLabel = expected ? `${status || '-'} expected` : status || '-'; return `<tr class="gateway-log-request-row" tabindex="0" role="button" aria-haspopup="dialog" data-log-request-id="${escapeHtml(rowId)}"><td>${gatewayLogTime(entry.completedAt)}</td><td><strong>${escapeHtml(entry.profileName || '-')}</strong></td><td>${escapeHtml(entry.model || '-')}</td><td class="gateway-log-endpoint" title="${escapeHtml(endpointUrl)}">${escapeHtml(endpointUrl)}</td><td>${entry.stream ? 'Stream' : 'JSON'}</td><td>${escapeHtml(entry.effort || '-')}</td><td><span class="gateway-http ${statusClass}">${escapeHtml(statusLabel)}</span></td><td>${entry.durationMs === undefined ? '&mdash;' : `${Math.round(entry.durationMs)} ms`}</td><td>${tokens}</td></tr>`; }).join('')}</tbody></table></div>`; }
function gatewayLogDetailHasValue(value) { return value !== undefined && value !== null && value !== ''; }
function gatewayLogDetailRow(label, value, mono = false) { if (!gatewayLogDetailHasValue(value))
    return ''; return `<div class="gateway-log-detail-row"><span>${escapeHtml(label)}</span><strong class="${mono ? 'mono' : ''}">${escapeHtml(String(value))}</strong></div>`; }
function gatewayLogDetailList(label, values, limit = 6) { if (!Array.isArray(values) || !values.length)
    return ''; const visible = values.slice(0, limit); const remaining = values.slice(limit); const chips = items => items.map(value => `<code>${escapeHtml(value)}</code>`).join(''); const more = remaining.length ? `<details class="gateway-log-detail-list-more"><summary>+${remaining.length} more</summary><div>${chips(remaining)}</div></details>` : ''; return `<div class="gateway-log-detail-row gateway-log-detail-list"><span>${escapeHtml(label)} <small>${values.length}</small></span><div>${chips(visible)}${more}</div></div>`; }
function gatewayLogDetailSection(title, content) { return content ? `<section class="gateway-log-detail-section"><h3>${escapeHtml(title)}</h3>${content}</section>` : ''; }
function gatewayLogDetailFact(label, value, mono = false) { return gatewayLogDetailHasValue(value) ? `<span><small>${escapeHtml(label)}</small><strong class="${mono ? 'mono' : ''}">${escapeHtml(String(value))}</strong></span>` : ''; }
function closeGatewayLogDetail() { $('gatewayLogDetailDialog').close(); const focus = state.gatewayLogFocus; state.gatewayLogFocus = null; if (focus?.isConnected)
    focus.focus(); }
function openGatewayLogDetail(entry, trigger) {
    if (!entry)
        return;
    state.gatewayLogFocus = trigger || document.activeElement;
    const expected = gatewayLogIsExpected(entry);
    const failure = gatewayLogIsFailure(entry);
    const title = expected ? 'Expected compatibility fallback' : failure ? 'Gateway request failure' : 'Gateway request details';
    const duration = entry.durationMs === undefined ? undefined : `${Math.round(entry.durationMs)} ms`;
    const tokens = entry.inputTokens === undefined && entry.outputTokens === undefined ? undefined : `${entry.inputTokens ?? 0} / ${entry.outputTokens ?? 0}`;
    const mode = `${entry.stream ? 'Stream' : 'JSON'}${entry.effort ? ` / ${entry.effort}` : ''}`;
    const requestRows = gatewayLogDetailRow('Time', entry.completedAt) + gatewayLogDetailRow('Method / path', [entry.method, entry.pathname].filter(Boolean).join(' '), true) + gatewayLogDetailRow('Request ID', entry.requestId, true) + gatewayLogDetailRow('Kind', entry.requestKind);
    const routingRows = gatewayLogDetailRow('Profile', entry.profileName) + gatewayLogDetailRow('Client model', entry.clientModel) + gatewayLogDetailRow('Upstream model', entry.model) + gatewayLogDetailRow('Protocol', entry.protocol) + gatewayLogDetailRow('Endpoint', entry.endpointUrl, true);
    const upstreamRows = gatewayLogDetailRow('HTTP status', entry.upstreamStatus) + gatewayLogDetailRow('Request ID', entry.upstreamRequestId, true) + gatewayLogDetailRow('First event', entry.firstEventMs === undefined ? undefined : `${Math.round(entry.firstEventMs)} ms`) + gatewayLogDetailRow('Last event', entry.lastEventType, true) + gatewayLogDetailRow('Terminal received', entry.terminalEventReceived);
    const failureRows = gatewayLogDetailRow('Error type', entry.errorType) + gatewayLogDetailRow('Failure code', entry.failureCode) + gatewayLogDetailRow('Validation field', entry.validationField, true) + gatewayLogDetailRow('Validation rule', entry.validationRule) + gatewayLogDetailRow('Upstream error', [entry.upstreamErrorCode, entry.upstreamErrorParam].filter(Boolean).join(' / '), true);
    const diagnostics = gatewayLogDetailRow('Session ID', entry.sessionId, true) + gatewayLogDetailRow('Agent ID', entry.agentId, true) + gatewayLogDetailRow('Parent agent ID', entry.parentAgentId, true) + gatewayLogDetailList('Converted fields', entry.upstreamFields) + gatewayLogDetailList('Event types', entry.upstreamEventTypes, 5) + gatewayLogDetailList('Item types', entry.upstreamItemTypes);
    const diagnosticCounts = [`${entry.upstreamEventTypes?.length || 0} events`, `${entry.upstreamItemTypes?.length || 0} items`].join(' · ');
    const summary = entry.errorSummary || (expected ? 'Claude Code will use its compatibility fallback.' : 'Request completed.');
    $('gatewayLogDetailPanel').innerHTML = `<div class="modal-head gateway-log-detail-head"><div><p class="eyebrow">request detail</p><h2>${escapeHtml(title)}</h2></div><button class="icon-btn" id="gatewayLogDetailClose" type="button" aria-label="Close request details">×</button></div><div class="gateway-log-detail-summary ${expected ? 'expected' : failure ? 'failure' : 'success'}"><span class="gateway-http ${expected ? 'expected' : Number(entry.status || 0) >= 500 ? 'bad' : Number(entry.status || 0) >= 400 ? 'warn' : 'ok'}">${escapeHtml(entry.status || '-')}</span><div class="gateway-log-detail-summary-copy"><strong title="${escapeHtml(summary)}">${escapeHtml(summary)}</strong><small>${escapeHtml(entry.failureStage || entry.outcome || 'success')}</small></div><div class="gateway-log-detail-facts">${gatewayLogDetailFact('Latency', duration, true)}${gatewayLogDetailFact('Mode', mode)}${gatewayLogDetailFact('Tokens', tokens, true)}</div></div><div class="gateway-log-detail-grid ${failure || expected ? 'has-failure' : ''}">${gatewayLogDetailSection('Request', requestRows)}${gatewayLogDetailSection('Routing', routingRows)}${gatewayLogDetailSection('Upstream & stream', upstreamRows)}${failure || expected ? gatewayLogDetailSection('Failure', failureRows) : ''}</div>${diagnostics ? `<details class="gateway-log-diagnostics"><summary><strong>Diagnostics</strong><span>${escapeHtml(diagnosticCounts)}</span></summary><div class="gateway-log-diagnostics-body">${diagnostics}</div></details>` : ''}<p class="gateway-log-privacy">Exact prompts, responses, tool arguments, images, and provider error text are not stored.</p>`;
    $('gatewayLogDetailClose').onclick = closeGatewayLogDetail;
    const dialog = $('gatewayLogDetailDialog');
    dialog.oncancel = event => { event.preventDefault(); closeGatewayLogDetail(); };
    dialog.showModal();
}
function gatewayModelChips(models = []) {
    const visible = models.slice(0, 5);
    const overflow = models.length > visible.length;
    return `${visible.map(model => `<span>${escapeHtml(model)}</span>`).join('')}${overflow ? `<span class="gateway-model-more" tabindex="0" title="${escapeHtml(models.join(', '))}" aria-label="All models: ${escapeHtml(models.join(', '))}">&hellip;</span>` : ''}`;
}
function gatewayUpstreamRows(upstreams) {
    if (!upstreams.length)
        return '<div class="gateway-upstream-empty"><strong>No upstreams configured</strong><span>Create one before adding a gateway profile.</span></div>';
    return `<div class="gateway-upstream-list">${upstreams.map(upstream => { const references = upstream.profileNames || []; const protectedTitle = references.length ? `Rebind profiles before deleting: ${references.join(', ')}` : 'Delete upstream'; const brand = upstream.provider === 'openai' ? 'openai' : inferProviderBrand(upstream.id, upstream.endpointUrl, upstream.models); return `<article class="gateway-upstream-row"><div class="gateway-upstream-main">${brandIconMarkup(brand, iconSvg('route'), 'upstream-brand-logo')}<div><span class="gateway-upstream-title"><strong>${escapeHtml(upstream.id)}</strong><span class="gateway-provider-kind">${upstream.provider === 'openai' ? 'OpenAI official' : 'OpenAI-compatible'}</span><span class="gateway-provider-kind">${escapeHtml(gatewayProtocolLabel(upstream.protocol))}</span></span><small title="${escapeHtml(upstream.endpointUrl)}">${escapeHtml(hostname(upstream.endpointUrl))}</small></div></div><div class="gateway-model-chips">${gatewayModelChips(upstream.models)}</div><div class="gateway-upstream-usage"><span>${references.length} profile${references.length === 1 ? '' : 's'}</span><span class="${upstream.apiKeyStatus === 'set' ? 'key-ready' : 'key-missing'}">${upstream.apiKeyStatus === 'set' ? 'Key set' : 'Key missing'}</span></div><div class="gateway-upstream-actions"><button class="ghost icon-action icon-only" type="button" data-edit-upstream="${escapeHtml(upstream.id)}" title="Edit upstream" aria-label="Edit upstream">${iconSvg('pencil')}</button><button class="ghost icon-action icon-only" type="button" data-delete-upstream="${escapeHtml(upstream.id)}" title="${escapeHtml(protectedTitle)}" aria-label="${escapeHtml(protectedTitle)}" aria-disabled="${references.length ? 'true' : 'false'}">${iconSvg('trash')}</button></div></article>`; }).join('')}</div>`;
}
function gatewayTabButton(id, label, count) {
    const active = state.gatewayTab === id;
    return `<button class="gateway-tab ${active ? 'active' : ''}" type="button" role="tab" aria-selected="${active}" data-gateway-tab="${id}"><span>${label}</span><b>${count}</b></button>`;
}
function gatewayUpstreamsView(upstreams) {
    const createProfileAction = primaryModalCanReturnTo('newProfileDialog') ? '' : `<button class="ghost icon-action" id="gatewayCreateProfile" type="button" title="创建 Gateway Profile">${iconSvg('plus')}<span>New Profile</span></button>`;
    return `<section class="gateway-view gateway-upstreams" role="tabpanel"><div class="gateway-view-toolbar"><div><p class="eyebrow">upstreams</p><h3>OpenAI-format providers</h3></div><div class="gateway-view-actions">${createProfileAction}<button class="primary icon-action" id="gatewayAddUpstream" type="button">${iconSvg('plus')}<span>New Upstream</span></button></div></div>${gatewayUpstreamRows(upstreams)}</section>`;
}
function gatewayLogView(log, status) {
    const entries = log?.entries || [];
    const errorCount = entries.filter(gatewayLogIsFailure).length;
    const successCount = entries.filter(entry => entry.kind === 'request' && Number(entry.status || 0) >= 200 && Number(entry.status || 0) < 400).length;
    const filterCount = state.gatewayLogFilter === 'errors'
        ? `<span class="gateway-error-count">${errorCount} errors</span>`
        : state.gatewayLogFilter === 'success'
            ? `<span class="gateway-error-count success">${successCount} successful</span>`
            : '';
    return `<section class="gateway-view gateway-log" role="tabpanel"><div class="gateway-view-toolbar gateway-log-toolbar"><div><p class="eyebrow">request log</p><h3>${escapeHtml(entries.length)} recent events${filterCount}</h3><code title="${escapeHtml(log?.path || '')}">${escapeHtml(shortPath(log?.path || status.logPath || ''))}</code></div><div class="gateway-log-tools"><div class="gateway-log-filters" role="group" aria-label="Request log filter"><button type="button" data-log-filter="all" class="${state.gatewayLogFilter === 'all' ? 'active' : ''}">All</button><button type="button" data-log-filter="errors" class="${state.gatewayLogFilter === 'errors' ? 'active' : ''}">Errors</button><button type="button" data-log-filter="success" class="${state.gatewayLogFilter === 'success' ? 'active' : ''}">Success</button></div><button class="ghost icon-action icon-only" id="gatewayLogRefresh" type="button" title="Refresh log" aria-label="Refresh log">${iconSvg('refresh')}</button><button class="ghost icon-action danger-lite" id="gatewayLogClear" type="button">${iconSvg('trash')}<span>Clear</span></button></div></div>${gatewayLogRows(log)}</section>`;
}
function bindGatewayPanel(status, log, upstreams) {
    $('gatewayClose').onclick = () => closePrimaryModal('gatewayDialog');
    document.querySelectorAll('[data-gateway-tab]').forEach(button => button.onclick = () => { state.gatewayTab = button.dataset.gatewayTab; renderGatewayPanel(status, log, upstreams); });
    document.querySelectorAll('[data-log-filter]').forEach(button => button.onclick = () => { state.gatewayLogFilter = button.dataset.logFilter; renderGatewayPanel(status, log, upstreams); });
    document.querySelectorAll('[data-log-request-id]').forEach(row => { const open = () => openGatewayLogDetail(state.gatewayLogEntriesById.get(row.dataset.logRequestId), row); row.onclick = open; row.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open();
        } }; });
    const add = $('gatewayAddUpstream'); if (add)
        add.onclick = () => openUpstreamEditor();
    const createProfile = $('gatewayCreateProfile'); if (createProfile)
        createProfile.onclick = () => void openNewGatewayProfileFromManager();
    document.querySelectorAll('[data-edit-upstream]').forEach(button => button.onclick = () => openUpstreamEditor(button.dataset.editUpstream));
    document.querySelectorAll('[data-delete-upstream]').forEach(button => button.onclick = () => deleteGatewayUpstream(button.dataset.deleteUpstream));
    const start = $('gatewayStart'); if (start)
        start.onclick = () => runGatewayAction('start');
    const restart = $('gatewayRestart'); if (restart)
        restart.onclick = () => runGatewayAction('restart');
    const stop = $('gatewayStop'); if (stop)
        stop.onclick = () => runGatewayAction('stop');
    const refresh = $('gatewayLogRefresh'); if (refresh)
        refresh.onclick = openGatewayPanel;
    const clear = $('gatewayLogClear'); if (clear)
        clear.onclick = clearGatewayLogFromUi;
    $('upstreamDrawerScrim').onclick = () => void closeUpstreamEditor();
}
function renderGatewayPanel(status, log, upstreams) {
    const running = Boolean(status.running);
    const serviceActions = running
        ? `<button class="ghost icon-action" id="gatewayRestart" type="button">${iconSvg('refresh')}<span>Restart</span></button><button class="ghost icon-action danger-lite" id="gatewayStop" type="button">${iconSvg('power')}<span>Stop</span></button>`
        : `<button class="primary icon-action" id="gatewayStart" type="button">${iconSvg('power')}<span>Start</span></button>`;
    const logCount = log?.entries?.length || 0;
    const content = state.gatewayTab === 'logs' ? gatewayLogView(log, status) : gatewayUpstreamsView(upstreams);
    $('gatewayPanel').innerHTML = `<div class="modal-head gateway-head"><div><p class="eyebrow">shared gateway</p><h2>Gateway Service</h2></div><button class="icon-btn" id="gatewayClose" type="button" aria-label="Close Gateway">×</button></div><section class="gateway-service-band"><div class="gateway-state ${running ? 'running' : 'offline'}"><span></span><strong>${escapeHtml(status.statusText || 'Unknown')}</strong></div><div class="gateway-service-kv"><span>Endpoint<strong>${escapeHtml(status.endpoint || '—')}</strong></span><span>PID<strong>${escapeHtml(status.pid || '—')}</strong></span><span>Profiles<strong>${escapeHtml(status.profilesUsingGateway ?? status.profileCount ?? 0)}</strong></span><span>Upstreams<strong>${escapeHtml(upstreams.length)}</strong></span></div><div class="gateway-service-actions">${serviceActions}</div></section><nav class="gateway-tabs" role="tablist" aria-label="Gateway views">${gatewayTabButton('upstreams', 'Upstreams', upstreams.length)}${gatewayTabButton('logs', 'Request Logs', logCount)}</nav>${content}<div class="gateway-drawer-scrim" id="upstreamDrawerScrim" hidden></div><form class="gateway-upstream-drawer" id="upstreamForm" hidden></form><div class="dialog-toast-region"></div>`;
    bindGatewayPanel(status, log, upstreams);
}
async function openGatewayPanel() { try {
    const [status, log, upstreamData, templateData] = await Promise.all([api('/api/gateway/status'), api('/api/gateway/log'), api('/api/gateway/upstreams'), api('/api/gateway/upstream-templates')]);
    state.gateway = status;
    state.gatewayLog = log;
    state.upstreams = upstreamData.upstreams || [];
    state.gatewayUpstreamTemplates = templateData.templates || [];
    renderGatewayPanel(status, log, state.upstreams);
    activatePrimaryModal('gatewayDialog');
    renderGatewayPanel(status, log, state.upstreams);
}
catch (err) {
    toast(err.message);
} }
async function openNewProfileDialog(options = {}) {
    resetNewProfileForm();
    if (options.presetId)
        state.selectedPreset = options.presetId;
    if (options.presetFilter)
        state.presetFilter = options.presetFilter;
    await loadPresets();
    if (options.presetId && state.presets.some(preset => preset.id === options.presetId))
        state.selectedPreset = options.presetId;
    renderPresetPicker();
    activatePrimaryModal('newProfileDialog');
    renderPresetDetail();
}

function activatePrimaryModal(targetId) {
    const target = $(targetId);
    const current = ['newProfileDialog', 'gatewayDialog']
        .map(id => $(id))
        .find(dialog => dialog.open);
    if (current && current.id !== targetId) {
        primaryModalHistory.push(current.id);
        closePrimaryModalWithoutHistory(current);
    }
    if (!target.open)
        target.showModal();
}

function primaryModalCanReturnTo(dialogId) {
    return primaryModalHistory.at(-1) === dialogId;
}

function handlePrimaryModalClose(dialogId) {
    const suppressedCount = primaryModalSuppressedCloseCounts.get(dialogId) || 0;
    if (suppressedCount > 0) {
        if (suppressedCount === 1)
            primaryModalSuppressedCloseCounts.delete(dialogId);
        else
            primaryModalSuppressedCloseCounts.set(dialogId, suppressedCount - 1);
        return;
    }
    restorePreviousPrimaryModal();
}

function closePrimaryModal(dialogId) {
    const dialog = $(dialogId);
    if (!dialog.open)
        return;
    closePrimaryModalWithoutHistory(dialog);
    restorePreviousPrimaryModal();
}

function closePrimaryModalWithoutHistory(dialog) {
    const suppressedCount = primaryModalSuppressedCloseCounts.get(dialog.id) || 0;
    primaryModalSuppressedCloseCounts.set(dialog.id, suppressedCount + 1);
    dialog.close();
}

function restorePreviousPrimaryModal() {
    const previousId = primaryModalHistory.pop();
    if (!previousId)
        return;
    const previous = $(previousId);
    if (!previous.open)
        previous.showModal();
}
async function openNewGatewayProfileFromManager() {
    if (!state.upstreams.length) {
        toast('请先创建一个上游供应商');
        openUpstreamEditor();
        return;
    }
    await closeUpstreamEditor();
    await openNewProfileDialog({ presetId: 'gateway', presetFilter: 'gateway' });
}
function gatewayUpstreamTemplateOptions(selectedId) {
    return state.gatewayUpstreamTemplates.map(template => `<option value="${escapeHtml(template.id)}" ${template.id === selectedId ? 'selected' : ''}>${escapeHtml(template.label)}</option>`).join('');
}
function gatewayUpstreamTemplateId(upstream) {
    if (!upstream)
        return 'custom';
    const matched = state.gatewayUpstreamTemplates.find(template => template.id !== 'custom' && template.provider === upstream.provider && template.protocol === upstream.protocol && template.endpointUrl === upstream.endpointUrl);
    return matched?.id || 'custom';
}
function gatewayTemplateBrand(templateId, upstream) {
    if (templateId === 'openai-official')
        return 'openai';
    if (templateId === 'xai-grok-4.5')
        return 'xai';
    if (templateId === 'aicodemirror')
        return 'aicodemirror';
    return inferProviderBrand(upstream?.id, upstream?.endpointUrl, upstream?.models);
}
function updateUpstreamBrandPreview(brand) {
    const preview = $('upstreamBrandPreview');
    if (preview)
        preview.innerHTML = brandIconMarkup(brand, iconSvg('route'), 'upstream-editor-logo');
}
function applyGatewayUpstreamTemplate(templateId, seedId = false) {
    const template = state.gatewayUpstreamTemplates.find(item => item.id === templateId);
    if (!template)
        return;
    const provider = $('upstreamProvider');
    const providerLabel = $('upstreamProviderLabel');
    const protocol = $('upstreamProtocol');
    const upstreamId = $('upstreamId');
    const changedProtocol = protocol.value !== template.protocol;
    provider.value = template.provider;
    providerLabel.value = template.provider === 'openai' ? 'OpenAI official' : 'OpenAI-compatible';
    protocol.value = template.protocol;
    $('upstreamEndpointUrl').value = template.endpointUrl || '';
    $('upstreamBaseUrl').value = gatewayEndpointToBaseUrl(template.endpointUrl || '', template.protocol);
    $('upstreamModels').value = (template.models || []).join(', ');
    $('upstreamTemplateHint').textContent = template.description || '';
    $('upstreamTemplateHint').title = template.description || '';
    updateUpstreamBrandPreview(gatewayTemplateBrand(templateId));
    const templateDefaultIds = state.gatewayUpstreamTemplates.map(item => item.defaultUpstreamId).filter(Boolean);
    if (seedId && (!upstreamId.value.trim() || templateDefaultIds.includes(upstreamId.value.trim())))
        upstreamId.value = template.defaultUpstreamId || '';
    syncUpstreamUrlMode('base');
    syncUpstreamProtocolEditor(changedProtocol && template.id === 'custom');
    const mode = template.compatibilityMode || gatewayCompatibilityMode(template.protocol, template.provider, template.compatibility);
    const modeButton = document.querySelector(`[data-gateway-mode-control="upstreamEditor"] [data-gateway-mode="${mode}"]`);
    modeButton?.click();
}
function gatewayEndpointToBaseUrl(endpointUrl, protocol) {
    if (!endpointUrl)
        return '';
    try {
        const url = new URL(endpointUrl);
        const suffix = protocol === 'openai_responses' ? '/responses' : '/chat/completions';
        if (url.pathname.toLowerCase().endsWith(suffix))
            url.pathname = url.pathname.slice(0, -suffix.length) || '/';
        return url.toString().replace(/\/$/, '');
    }
    catch {
        return endpointUrl;
    }
}
function gatewayBaseUrlFromEndpointLikeValue(value) {
    if (!value.trim())
        return '';
    try {
        const url = new URL(value);
        for (const suffix of ['/responses', '/chat/completions']) {
            if (url.pathname.toLowerCase().endsWith(suffix)) {
                url.pathname = url.pathname.slice(0, -suffix.length) || '/';
                return url.toString().replace(/\/$/, '');
            }
        }
        return url.toString().replace(/\/$/, '');
    }
    catch {
        return value;
    }
}
function gatewayHasKnownEndpointSuffix(value) {
    try {
        const pathname = new URL(value).pathname.toLowerCase();
        return ['/responses', '/chat/completions'].some(suffix => pathname.endsWith(suffix));
    }
    catch {
        return false;
    }
}
function gatewayEndpointFromBaseUrl(baseUrl, protocol) {
    if (!baseUrl.trim())
        return '';
    try {
        const url = new URL(gatewayBaseUrlFromEndpointLikeValue(baseUrl));
        const suffix = protocol === 'openai_responses' ? 'responses' : 'chat/completions';
        let pathname = url.pathname.replace(/\/+$/, '');
        if (!pathname.toLowerCase().endsWith(`/${suffix}`))
            pathname = pathname.toLowerCase().endsWith('/v1') ? `${pathname}/${suffix}` : `${pathname}/v1/${suffix}`;
        url.pathname = pathname.replace(/^\/{2,}/, '/');
        url.hash = '';
        return url.toString();
    }
    catch {
        return '';
    }
}
function gatewayEndpointForProtocolSwitch(endpointUrl, baseUrl, protocol) {
    if (!endpointUrl.trim())
        return gatewayEndpointFromBaseUrl(baseUrl, protocol);
    if (!gatewayHasKnownEndpointSuffix(endpointUrl))
        return endpointUrl;
    return gatewayEndpointFromBaseUrl(endpointUrl, protocol) || endpointUrl;
}
function gatewayActiveUpstreamUrl() {
    return $('upstreamUrlMode')?.value === 'endpoint' ? $('upstreamEndpointUrl')?.value || '' : $('upstreamBaseUrl')?.value || '';
}
function gatewayCommonModels(protocol) {
    return protocol === 'openai_responses'
        ? ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'grok-4.5']
        : ['gpt-5.6', 'gpt-5.5', 'gpt-4.1', 'o3', 'deepseek-chat'];
}
function gatewayCommonModelOptions(protocol) {
    return gatewayCommonModels(protocol).map(model => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('');
}
function bindGatewayCommonModels() {
    const select = $('upstreamCommonModel');
    if (!select)
        return;
    select.onchange = () => {
        const model = select.value;
        if (!model)
            return;
        const input = $('upstreamModels');
        const models = input.value.split(',').map(value => value.trim()).filter(Boolean);
        if (!models.includes(model))
            models.push(model);
        input.value = models.join(', ');
        select.value = '';
        input.dispatchEvent(new Event('input'));
    };
}
function withBusyButton(buttonId, busyText, task) {
    const button = $(buttonId);
    if (!button)
        return task();
    if (button.dataset.pending === '1')
        return Promise.resolve();
    const prevText = button.textContent;
    let busyShown = false;
    button.dataset.pending = '1';
    const busyTimer = setTimeout(() => {
        if ($(buttonId) !== button)
            return;
        busyShown = true;
        button.disabled = true;
        button.dataset.busy = '1';
        button.textContent = busyText;
    }, 140);
    return Promise.resolve().then(task).finally(() => {
        clearTimeout(busyTimer);
        const next = $(buttonId);
        if (next === button) {
            next.disabled = false;
            delete next.dataset.pending;
            delete next.dataset.busy;
            if (busyShown)
                next.textContent = prevText;
        }
    });
}
async function fetchUpstreamModels() {
    const button = $('upstreamFetchModels');
    if (button.dataset.pending === '1')
        return;
    const apiKey = $('upstreamApiKey').value.trim();
    if (!apiKey) {
        toast('Enter an API key before fetching models');
        return;
    }
    const protocol = $('upstreamProtocol').value;
    const provider = $('upstreamProvider').value;
    const body = {
        provider,
        protocol,
        apiKey,
        ...($('upstreamUrlMode').value === 'endpoint'
            ? { endpointUrl: $('upstreamEndpointUrl').value }
            : { baseUrl: $('upstreamBaseUrl').value })
    };
    const buttonMarkup = button.innerHTML;
    button.dataset.pending = '1';
    button.disabled = true;
    button.classList.add('is-fetching');
    button.innerHTML = `${iconSvg('refresh')}<span>Fetching</span>`;
    try {
        const data = await api('/api/gateway/upstreams/models', { method: 'POST', body: JSON.stringify(body) });
        renderUpstreamDiscoveredModels(data.models || [], data.modelsUrl || '');
    }
    catch (err) {
        toast(err.message);
    }
    finally {
        if ($('upstreamFetchModels') === button) {
            delete button.dataset.pending;
            button.classList.remove('is-fetching');
            button.innerHTML = buttonMarkup;
            button.disabled = !$('upstreamApiKey').value.trim();
        }
    }
}

function upstreamModelValues() {
    return $('upstreamModels').value.split(/[\s,]+/).map(value => value.trim()).filter(Boolean);
}

function updateDiscoveredModelSelection() {
    const panel = $('upstreamDiscoveredModels');
    if (!panel || panel.hidden)
        return;
    const selectable = Array.from(panel.querySelectorAll('.gateway-discovered-check:not(:disabled)'));
    const selected = selectable.filter(input => input.checked);
    $('upstreamDiscoverySelection').textContent = `${selected.length} selected`;
    $('upstreamAddDiscovered').disabled = selected.length === 0;
    $('upstreamSelectVisible').disabled = !selectable.some(input => !input.closest('.gateway-discovered-row').hidden && !input.checked);
    $('upstreamClearDiscovered').disabled = selected.length === 0;
}

function filterDiscoveredModels() {
    const query = $('upstreamModelSearch').value.trim().toLowerCase();
    const rows = Array.from(document.querySelectorAll('#upstreamDiscoveredList .gateway-discovered-row'));
    let visible = 0;
    rows.forEach(row => {
        row.hidden = Boolean(query) && !row.dataset.model.toLowerCase().includes(query);
        if (!row.hidden)
            visible += 1;
    });
    $('upstreamDiscoveryEmpty').hidden = visible > 0;
    updateDiscoveredModelSelection();
}

function renderUpstreamDiscoveredModels(models, modelsUrl) {
    const existing = new Set(upstreamModelValues());
    const ordered = [...new Set(models)].sort((left, right) => Number(existing.has(right)) - Number(existing.has(left)) || left.localeCompare(right));
    const panel = $('upstreamDiscoveredModels');
    const source = hostname(modelsUrl);
    $('upstreamDiscoveryMeta').textContent = `${ordered.length} available${source ? ` from ${source}` : ''}`;
    $('upstreamDiscoveryMeta').title = modelsUrl;
    $('upstreamModelSearch').value = '';
    $('upstreamDiscoveredList').innerHTML = ordered.map(model => {
        const configured = existing.has(model);
        return `<label class="gateway-discovered-row" data-model="${escapeHtml(model)}"><input class="gateway-discovered-check" type="checkbox" value="${escapeHtml(model)}" ${configured ? 'checked disabled' : ''} /><span class="gateway-discovered-id">${escapeHtml(model)}</span>${configured ? '<span class="gateway-discovered-status">Configured</span>' : ''}</label>`;
    }).join('');
    panel.hidden = ordered.length === 0;
    panel.querySelectorAll('.gateway-discovered-check').forEach(input => input.onchange = updateDiscoveredModelSelection);
    updateDiscoveredModelSelection();
    $('upstreamModelSearch').focus();
}

function selectVisibleDiscoveredModels() {
    document.querySelectorAll('#upstreamDiscoveredList .gateway-discovered-row:not([hidden]) .gateway-discovered-check:not(:disabled)').forEach(input => {
        input.checked = true;
    });
    updateDiscoveredModelSelection();
}

function clearDiscoveredModels() {
    document.querySelectorAll('#upstreamDiscoveredList .gateway-discovered-check:not(:disabled)').forEach(input => {
        input.checked = false;
    });
    updateDiscoveredModelSelection();
}

function addSelectedUpstreamModels() {
    const input = $('upstreamModels');
    const selected = Array.from(document.querySelectorAll('#upstreamDiscoveredList .gateway-discovered-check:checked:not(:disabled)')).map(option => option.value.trim()).filter(Boolean);
    const models = upstreamModelValues();
    input.value = [...new Set([...models, ...selected])].join(', ');
    input.dispatchEvent(new Event('input'));
    $('upstreamDiscoveredModels').hidden = true;
    toast(`Added ${selected.length} model${selected.length === 1 ? '' : 's'}`);
}
function syncUpstreamUrlMode(mode = $('upstreamUrlMode')?.value || 'base') {
    const isEndpoint = mode === 'endpoint';
    $('upstreamUrlMode').value = mode;
    document.querySelectorAll('[data-upstream-url-mode]').forEach(button => button.classList.toggle('active', button.dataset.upstreamUrlMode === mode));
    $('upstreamBaseUrlField').hidden = isEndpoint;
    $('upstreamEndpointUrlField').hidden = !isEndpoint;
    $('upstreamBaseUrl').required = !isEndpoint;
    $('upstreamEndpointUrl').required = isEndpoint;
}
function renderUpstreamEditor(upstream) {
    const editing = Boolean(upstream);
    const provider = upstream?.provider || 'openai-compatible';
    const protocol = upstream?.protocol || 'openai_responses';
    const compatibility = upstream?.compatibility || gatewayCompatibilityPresets.responses;
    const mode = gatewayCompatibilityMode(protocol, provider, compatibility);
    const templateId = gatewayUpstreamTemplateId(upstream);
    const form = $('upstreamForm');
    const scrim = $('upstreamDrawerScrim');
    const animationId = ++state.gatewayDrawerAnimationId;
    form.dataset.animationId = String(animationId);
    form.dataset.upstreamId = upstream?.id || '';
    form.dataset.originalProtocol = upstream?.protocol || '';
    form.classList.remove('is-closing');
    scrim.classList.remove('is-closing');
    const template = state.gatewayUpstreamTemplates.find(item => item.id === templateId);
    const baseUrl = gatewayEndpointToBaseUrl(upstream?.endpointUrl || '', protocol);
    const endpointUrl = upstream?.endpointUrl || '';
    const renameHint = editing ? '<span class="gateway-field-hint gateway-field-hint-compact">Renaming also updates bound Profiles.</span>' : '';
    form.innerHTML = `<div class="modal-head upstream-editor-head"><div class="upstream-editor-title"><span id="upstreamBrandPreview">${brandIconMarkup(gatewayTemplateBrand(templateId, upstream), iconSvg('route'), 'upstream-editor-logo')}</span><div><p class="eyebrow">${editing ? 'edit upstream' : 'new upstream'}</p><h2>${editing ? escapeHtml(upstream.id) : 'Connect Provider'}</h2></div></div><button class="icon-btn" id="upstreamClose" type="button">&times;</button></div><div class="upstream-form-body"><div class="gateway-form-grid"><label class="gateway-wide gateway-template-field">Preset Template<select id="upstreamTemplate">${gatewayUpstreamTemplateOptions(templateId)}</select><span class="gateway-field-hint gateway-field-hint-compact" id="upstreamTemplateHint" title="${escapeHtml(template?.description || '')}">${escapeHtml(template?.description || '')}</span></label><label>Upstream ID<input id="upstreamId" value="${escapeHtml(upstream?.id || '')}" required placeholder="my-provider" autocomplete="off" />${renameHint}</label><label>Provider Format<input id="upstreamProviderLabel" class="gateway-readonly" value="${provider === 'openai' ? 'OpenAI official' : 'OpenAI-compatible'}" readonly title="Provider Format is controlled by the selected template" /><input id="upstreamProvider" type="hidden" value="${escapeHtml(provider)}" /></label><label class="gateway-wide">Protocol<select id="upstreamProtocol"><option value="openai_responses" ${protocol === 'openai_responses' ? 'selected' : ''}>Responses (recommended)</option><option value="openai_chat_completions" ${protocol === 'openai_chat_completions' ? 'selected' : ''}>Chat Completions (legacy)</option></select></label><div class="gateway-wide gateway-url-config"><div class="gateway-url-heading"><span>URL</span><div class="segmented gateway-url-mode" role="group"><button type="button" class="active" data-upstream-url-mode="base">Base URL</button><button type="button" data-upstream-url-mode="endpoint">Full Endpoint</button></div><input id="upstreamUrlMode" type="hidden" value="base" /></div><label id="upstreamBaseUrlField">Base URL<input id="upstreamBaseUrl" value="${escapeHtml(baseUrl)}" required placeholder="https://api.example.com or .../v1" autocomplete="url" /><span class="gateway-field-hint gateway-field-hint-compact" id="upstreamBaseUrlHint">Auto-completes <code>/v1/responses</code></span></label><label id="upstreamEndpointUrlField" hidden>Full Endpoint URL<input id="upstreamEndpointUrl" value="${escapeHtml(endpointUrl)}" placeholder="https://api.example.com/v1/responses" autocomplete="url" /><span class="gateway-field-hint gateway-field-hint-compact">Used exactly as entered</span></label></div><label class="gateway-wide">API Key${secretInput('upstreamApiKey', '', { disabled: editing, required: !editing, placeholder: editing ? 'Loading...' : 'sk-... or provider API Key' })}</label><div class="gateway-wide gateway-model-field"><label class="gateway-control-label" for="upstreamModels">Models</label><div class="gateway-model-input-row"><input id="upstreamModels" value="${escapeHtml((upstream?.models || []).join(', '))}" required placeholder="gpt-5.6-sol, gpt-5.5" autocomplete="off" /><button class="ghost icon-action gateway-fetch-models" id="upstreamFetchModels" type="button" title="Fetch available models" disabled>${iconSvg('refresh')}<span>Fetch</span></button></div><div class="gateway-model-help"><span>Separate multiple model IDs with ,</span><span>Common models may not be supported by this provider.</span></div><div class="gateway-model-quick"><span>Quick add</span><select id="upstreamCommonModel"><option value="">Select a common model...</option>${gatewayCommonModelOptions(protocol)}</select></div><section id="upstreamDiscoveredModels" class="gateway-discovered-models" hidden><header class="gateway-discovered-head"><div><strong>Available models</strong><span id="upstreamDiscoveryMeta"></span></div><button class="ghost icon-action icon-only" id="upstreamCloseDiscovery" type="button" title="Close model picker" aria-label="Close model picker">&times;</button></header><div class="gateway-discovery-toolbar"><label class="gateway-model-search">${iconSvg('search')}<input id="upstreamModelSearch" type="search" placeholder="Filter models" autocomplete="off" /></label><div class="gateway-discovery-bulk"><button id="upstreamSelectVisible" type="button">Select all</button><button id="upstreamClearDiscovered" type="button">Clear</button></div></div><div id="upstreamDiscoveredList" class="gateway-discovered-list" role="group" aria-label="Available models"></div><div id="upstreamDiscoveryEmpty" class="gateway-discovery-empty" hidden>No matching models</div><footer class="gateway-discovery-footer"><span id="upstreamDiscoverySelection">0 selected</span><button class="primary" id="upstreamAddDiscovered" type="button" disabled>Add selected</button></footer></section></div></div><div class="gateway-mode-field"><span>Compatibility</span>${gatewayModeButtons('upstreamEditor', mode, protocol, provider)}</div>${gatewayAdvancedFields('upstreamEditor', protocol, compatibility)}</div><menu class="modal-actions"><button class="ghost" id="upstreamCancel" type="button">Cancel</button><button class="primary" id="upstreamSave" type="button" ${editing ? 'disabled' : ''}>${editing ? 'Save Upstream' : 'Create Upstream'}</button></menu><div class="dialog-toast-region"></div>`;
    const modelHints = form.querySelectorAll('.gateway-model-help span');
    modelHints[0].textContent = 'Separate multiple model IDs with commas.';
    modelHints[1].remove();
    const modelAvailability = document.createElement('span');
    modelAvailability.className = 'gateway-model-availability';
    modelAvailability.textContent = 'Common models are suggestions only; availability depends on the provider.';
    $('upstreamCommonModel').after(modelAvailability);
    bindSecretToggles(form);
    $('upstreamTemplate').title = template?.description || '';
    $('upstreamTemplateHint').hidden = true;
    $('upstreamTemplate').onchange = event => applyGatewayUpstreamTemplate(event.target.value, !editing);
    $('upstreamProtocol').onchange = () => {
        $('upstreamTemplate').value = 'custom';
        syncUpstreamProtocolEditor(true);
    };
    document.querySelector('.gateway-url-mode').onclick = event => {
        if (event.target.dataset.upstreamUrlMode)
            syncUpstreamUrlMode(event.target.dataset.upstreamUrlMode);
    };
    const refreshCustomBrand = () => {
        if ($('upstreamTemplate').value === 'custom')
            updateUpstreamBrandPreview(inferProviderBrand($('upstreamId').value, gatewayActiveUpstreamUrl(), $('upstreamModels').value));
    };
    $('upstreamId').addEventListener('input', refreshCustomBrand);
    $('upstreamBaseUrl').addEventListener('input', refreshCustomBrand);
    $('upstreamEndpointUrl').addEventListener('input', refreshCustomBrand);
    $('upstreamModels').addEventListener('input', refreshCustomBrand);
    $('upstreamFetchModels').onclick = () => void fetchUpstreamModels();
    $('upstreamAddDiscovered').onclick = addSelectedUpstreamModels;
    $('upstreamModelSearch').oninput = filterDiscoveredModels;
    $('upstreamSelectVisible').onclick = selectVisibleDiscoveredModels;
    $('upstreamClearDiscovered').onclick = clearDiscoveredModels;
    $('upstreamCloseDiscovery').onclick = () => {
        $('upstreamDiscoveredModels').hidden = true;
    };
    $('upstreamApiKey').addEventListener('input', () => {
        if ($('upstreamFetchModels').dataset.pending !== '1')
            $('upstreamFetchModels').disabled = !$('upstreamApiKey').value.trim();
    });
    $('upstreamClose').onclick = () => void closeUpstreamEditor();
    $('upstreamCancel').onclick = () => void closeUpstreamEditor();
    $('upstreamSave').onclick = () => saveGatewayUpstream(editing ? upstream.id : '');
    form.hidden = false;
    scrim.hidden = false;
    syncUpstreamUrlMode('base');
    bindGatewayCommonModels();
    syncUpstreamProtocolEditor(false, compatibility, mode);
}

function syncUpstreamProtocolEditor(clearCustomEndpoint = false, compatibility, requestedMode) {
    const protocol = $('upstreamProtocol').value;
    const provider = $('upstreamProvider').value;
    const responses = protocol === 'openai_responses';
    const baseUrl = $('upstreamBaseUrl');
    const endpointUrl = $('upstreamEndpointUrl');
    endpointUrl.placeholder = responses ? 'https://api.example.com/v1/responses' : 'https://api.example.com/v1/chat/completions';
    $('upstreamBaseUrlHint').innerHTML = responses
        ? 'Auto-completes <code>/v1/responses</code>'
        : 'Auto-completes <code>/v1/chat/completions</code>';
    if (provider === 'openai') {
        const officialEndpoint = responses ? 'https://api.openai.com/v1/responses' : 'https://api.openai.com/v1/chat/completions';
        if (clearCustomEndpoint || !endpointUrl.value.trim())
            endpointUrl.value = officialEndpoint;
        if (clearCustomEndpoint || !baseUrl.value.trim())
            baseUrl.value = 'https://api.openai.com/v1';
    }
    else if (clearCustomEndpoint) {
        baseUrl.value = gatewayBaseUrlFromEndpointLikeValue(baseUrl.value);
        endpointUrl.value = gatewayEndpointForProtocolSwitch(endpointUrl.value, baseUrl.value, protocol);
    }
    baseUrl.readOnly = false;
    endpointUrl.readOnly = false;
    baseUrl.classList.remove('gateway-readonly');
    endpointUrl.classList.remove('gateway-readonly');
    $('upstreamCommonModel').innerHTML = `<option value="">Select a common model...</option>${gatewayCommonModelOptions(protocol)}`;
    bindGatewayCommonModels();
    const mode = provider === 'openai' ? 'openai' : requestedMode || (responses ? 'responses' : 'modern');
    const modeField = document.querySelector('.gateway-mode-field');
    modeField.innerHTML = `<span>Compatibility</span>${gatewayModeButtons('upstreamEditor', mode, protocol, provider)}`;
    $('upstreamEditorAdvanced').outerHTML = gatewayAdvancedFields('upstreamEditor', protocol, compatibility || gatewayCompatibilityPresets[provider === 'openai' ? (responses ? 'openaiResponses' : 'openaiChat') : mode]);
    const control = document.querySelector('[data-gateway-mode-control="upstreamEditor"]');
    const applyMode = nextMode => {
        $('upstreamEditorMode').value = nextMode;
        control.querySelectorAll('[data-gateway-mode]').forEach(button => button.classList.toggle('active', button.dataset.gatewayMode === nextMode));
        const advanced = $('upstreamEditorAdvanced');
        advanced.hidden = nextMode !== 'advanced';
        advanced.querySelectorAll('input,select').forEach(field => field.disabled = nextMode !== 'advanced');
    };
    control.onclick = event => {
        if (event.target.dataset.gatewayMode)
            applyMode(event.target.dataset.gatewayMode);
    };
    applyMode(mode);
}
function closeUpstreamEditor() {
    const form = $('upstreamForm');
    const scrim = $('upstreamDrawerScrim');
    if (!form || form.hidden)
        return Promise.resolve();
    const animationId = ++state.gatewayDrawerAnimationId;
    form.dataset.animationId = String(animationId);
    form.classList.add('is-closing');
    scrim?.classList.add('is-closing');
    return new Promise(resolve => {
        let finished = false;
        const finish = () => {
            if (finished)
                return;
            finished = true;
            if (form.dataset.animationId === String(animationId)) {
                form.hidden = true;
                form.innerHTML = '';
                form.classList.remove('is-closing');
                if (scrim) {
                    scrim.hidden = true;
                    scrim.classList.remove('is-closing');
                }
            }
            resolve();
        };
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
            finish();
            return;
        }
        form.addEventListener('animationend', event => { if (event.target === form && event.animationName === 'gateway-drawer-out')
            finish(); }, { once: true });
        setTimeout(finish, 240);
    });
}
async function openUpstreamEditor(id = '') {
    const upstream = id ? state.upstreams.find(item => item.id === id) : undefined;
    renderUpstreamEditor(upstream);
    if (!id)
        return;
    const form = $('upstreamForm');
    const input = $('upstreamApiKey');
    const toggle = form.querySelector('[data-secret-toggle="upstreamApiKey"]');
    try {
        const data = await api(`/api/gateway/upstreams/${encodeURIComponent(id)}/api-key`, { method: 'POST' });
        if (form.hidden || form.dataset.upstreamId !== id || input !== $('upstreamApiKey'))
            return;
        input.value = data.apiKey || '';
        input.placeholder = '';
    }
    catch (err) {
        if (form.hidden || form.dataset.upstreamId !== id || input !== $('upstreamApiKey'))
            return;
        input.placeholder = 'Unable to load API Key';
        toast(err.message);
    }
    finally {
        if (!form.hidden && form.dataset.upstreamId === id && input === $('upstreamApiKey')) {
            input.disabled = false;
            if (toggle)
                toggle.disabled = false;
            const save = $('upstreamSave');
            if (save)
                save.disabled = false;
            const fetchModels = $('upstreamFetchModels');
            if (fetchModels)
                fetchModels.disabled = !input.value.trim();
        }
    }
}
async function saveGatewayUpstream(existingId = '') {
    const form = $('upstreamForm');
    if (!form.reportValidity())
        return;
    const provider = $('upstreamProvider').value;
    const protocol = $('upstreamProtocol').value;
    const mode = $('upstreamEditorMode').value;
    const nextId = $('upstreamId').value.trim();
    if (existingId && nextId !== existingId) {
        const profiles = state.upstreams.find(item => item.id === existingId)?.profileNames || [];
        const impact = profiles.length ? ` The bound Profiles (${profiles.join(', ')}) will be updated automatically.` : '';
        if (!confirm(`Rename upstream "${existingId}" to "${nextId}"?${impact}`))
            return;
    }
    if (existingId && form.dataset.originalProtocol && form.dataset.originalProtocol !== protocol) {
        const profiles = state.upstreams.find(item => item.id === existingId)?.profileNames || [];
        const profileImpact = profiles.length ? ` Bound profiles (${profiles.join(', ')})` : ' Any bound profiles';
        if (!confirm(`Change protocol from ${gatewayProtocolLabel(form.dataset.originalProtocol)} to ${gatewayProtocolLabel(protocol)}?${profileImpact} will use the new protocol on the next request.`))
            return;
    }
    const body = {
        id: $('upstreamId').value,
        provider,
        protocol,
        ...($('upstreamUrlMode').value === 'endpoint'
            ? { endpointUrl: $('upstreamEndpointUrl').value }
            : { baseUrl: $('upstreamBaseUrl').value }),
        apiKey: $('upstreamApiKey').value,
        models: $('upstreamModels').value,
        compatibilityMode: mode,
        ...(mode === 'advanced' ? { compatibility: readGatewayCompatibility('upstreamEditor', protocol) } : {})
    };
    try {
        await withBusyButton('upstreamSave', existingId ? 'Saving...' : 'Creating...', () => api(existingId ? `/api/gateway/upstreams/${encodeURIComponent(existingId)}` : '/api/gateway/upstreams', { method: existingId ? 'PUT' : 'POST', body: JSON.stringify(body) }));
        await closeUpstreamEditor();
        state.gatewayTab = 'upstreams';
        await load();
        renderPresetDetail();
        await openGatewayPanel();
        toast(existingId ? 'Upstream updated' : 'Upstream created');
    }
    catch (err) {
        toast(err.message);
    }
}
async function deleteGatewayUpstream(id) {
    const upstream = state.upstreams.find(item => item.id === id);
    if (upstream?.profileNames?.length) {
        toast(`Cannot delete '${id}'. Rebind profiles first: ${upstream.profileNames.join(', ')}`);
        return;
    }
    if (!confirm(`Delete upstream "${id}"?`))
        return;
    try {
        await api(`/api/gateway/upstreams/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ confirmId: id }) });
        await load();
        renderPresetDetail();
        await openGatewayPanel();
        toast('Upstream deleted');
    }
    catch (err) {
        toast(err.message);
    }
}
async function runGatewayAction(action) { if (action === 'stop' && !confirm('Stop the shared Gateway service? Active requests may be interrupted.'))
    return; const buttonId = action === 'start' ? 'gatewayStart' : action === 'stop' ? 'gatewayStop' : 'gatewayRestart'; try {
    await withBusyButton(buttonId, action === 'stop' ? 'Stopping…' : action === 'start' ? 'Starting…' : 'Restarting…', () => api(`/api/gateway/${action}`, { method: 'POST' }));
    await load();
    await openGatewayPanel();
    toast(`Gateway ${action} completed`);
}
catch (err) {
    toast(err.message);
} }
async function clearGatewayLogFromUi() { if (!confirm('确认清空 Gateway 请求日志？'))
    return; try {
    const log = await api('/api/gateway/log/clear', { method: 'POST' });
    state.gatewayLog = log;
    renderGatewayPanel(state.gateway || await api('/api/gateway/status'), log, state.upstreams);
    toast('Gateway 日志已清空');
}
catch (err) {
    toast(err.message);
} }
function profileOptions(selected, blocked = '') { const placeholder = selected ? '' : '<option value="" selected disabled>选择 profile</option>'; return placeholder + state.profiles.map(p => `<option value="${escapeHtml(p.name)}" ${p.name === selected ? 'selected' : ''} ${p.name === blocked ? 'disabled' : ''}>${escapeHtml(p.name)} · ${escapeHtml(p.type)}</option>`).join(''); }
function firstProfileExcept(name) { return state.profiles.find(p => p.name !== name)?.name || ''; }
function normalizeSyncPair(changed = 'source') { if (!state.sync.sourceName)
    state.sync.sourceName = state.profiles[0]?.name || 'main'; if (!state.sync.targetName || state.sync.targetName === state.sync.sourceName) {
    if (changed === 'target' && state.sync.targetName)
        state.sync.sourceName = firstProfileExcept(state.sync.targetName);
    else
        state.sync.targetName = firstProfileExcept(state.sync.sourceName);
} return Boolean(state.sync.sourceName && state.sync.targetName && state.sync.sourceName !== state.sync.targetName); }
function resetSyncState(sourceName = 'main') { const source = state.profiles.find(p => p.name === sourceName)?.name || state.profiles[0]?.name || sourceName; const target = state.profiles.find(p => p.name !== source)?.name || ''; state.sync = { sourceName: source, targetName: target, projects: null, selectedProjectKey: '', scan: null, actions: {}, projectQuery: '', scanning: false, applying: false, requestId: 0, confirm: null, lastResult: null }; }
async function openSyncWorkspace(sourceName = 'main') { if (!state.profiles.length)
    await load(); resetSyncState(sourceName); renderSyncPanel('loading'); $('syncDialog').showModal(); await loadSyncProjects(); }
async function loadSyncProjects(options = {}) { const previousProject = options.projectKey || state.sync.selectedProjectKey; const previousResult = state.sync.lastResult; const requestId = ++state.sync.requestId; try {
    if (!normalizeSyncPair(options.changed || 'source')) {
        state.sync.projects = null;
        state.sync.selectedProjectKey = '';
        state.sync.scan = null;
        state.sync.actions = {};
        state.sync.scanning = false;
        renderSyncPanel();
        return;
    }
    if (!options.silent)
        renderSyncPanel('loading');
    const data = await api('/api/sessions/projects', { method: 'POST', body: JSON.stringify({ sourceName: state.sync.sourceName, targetName: state.sync.targetName }) });
    if (requestId !== state.sync.requestId)
        return;
    const keepProject = Boolean(options.preserveProject && previousProject && data.sourceProjects?.some(p => p.projectKey === previousProject));
    state.sync.projects = data;
    state.sync.selectedProjectKey = keepProject ? previousProject : '';
    state.sync.scan = null;
    state.sync.actions = {};
    state.sync.scanning = false;
    state.sync.applying = false;
    state.sync.lastResult = options.keepResult ? previousResult : null;
    renderSyncPanel();
}
catch (err) {
    if (requestId !== state.sync.requestId)
        return;
    state.sync.scanning = false;
    state.sync.applying = false;
    toast(err.message);
    renderSyncPanel('error', err.message);
} }
function syncCount(projects, side) { return projects?.[side]?.length || 0; }
function filteredSourceProjects() { const q = state.sync.projectQuery.toLowerCase(); const list = state.sync.projects?.sourceProjects || []; return list.filter(p => !q || [p.projectKey, p.dir].join(' ').toLowerCase().includes(q)).slice(0, 80); }
function targetProjectMap() { return new Map((state.sync.projects?.targetProjects || []).map(p => [p.projectKey, p])); }
function shortProjectKey(key) { return key.length > 44 ? `${key.slice(0, 41)}...` : key; }
function projectNode(project, side) { const selected = project.projectKey === state.sync.selectedProjectKey; const targetMatch = side === 'target' && selected; const active = side === 'source' ? selected : targetMatch; const cls = ['sync-node', side, active ? 'active' : '', targetMatch ? 'match sync-create-placeholder' : '', side === 'target' ? 'muted' : ''].join(' '); const attrs = side === 'source' ? `data-sync-project="${escapeHtml(project.projectKey)}"` : `data-target-project="${escapeHtml(project.projectKey)}" tabindex="-1" aria-disabled="true"`; const matchedTag = side === 'source' ? project.matchedInTarget : targetMatch; const deleteTitle = side === 'source' ? '删除来源项目' : '删除目标项目'; const deleteButton = `<button class="sync-delete-button" type="button" data-delete-project="${escapeHtml(project.projectKey)}" data-delete-side="${side}" title="${deleteTitle}" aria-label="${deleteTitle}">${iconSvg('trash')}</button>`; return `<div class="sync-node-wrap ${side}"><button class="${cls}" ${attrs} type="button"><strong title="${escapeHtml(project.projectKey)}">${escapeHtml(shortProjectKey(project.projectKey))}</strong><small>${escapeHtml(project.relativeTime || '暂无会话')}</small><span class="sync-node-tags"><em>${project.sessionCount} 会话</em><em>${project.assetCount} 资源</em>${matchedTag ? '<em class="ok">已匹配</em>' : ''}</span></button>${deleteButton}</div>`; }
function sourceProjectNodesMarkup() { const source = filteredSourceProjects(); return source.length ? source.map(p => projectNode(p, 'source')).join('') : '<div class="sync-empty">Source 没有项目会话</div>'; }
function createTargetPlaceholder(projectKey) { return `<div class="sync-node-wrap target"><div class="sync-node target sync-create-placeholder" data-target-project="__create__"><strong>将创建项目</strong><small title="${escapeHtml(projectKey)}">${escapeHtml(shortProjectKey(projectKey))}</small><span class="sync-node-tags"><em>目标不存在</em><em class="ok">确认同步后创建</em></span></div></div>`; }
function targetProjectNodesMarkup() { const selected = state.sync.selectedProjectKey; const targetProjects = state.sync.projects?.targetProjects || []; const targetMap = targetProjectMap(); const placeholder = selected && !targetMap.has(selected) ? createTargetPlaceholder(selected) : ''; const nodes = targetProjects.map(p => projectNode(p, 'target')).join(''); return placeholder || nodes ? `${placeholder}${nodes}` : '<div class="sync-empty">Target 没有项目会话</div>'; }
function syncFlowMarkup() { const selected = state.sync.selectedProjectKey; if (!selected)
    return `<div class="sync-flow idle" aria-hidden="true"><span class="sync-flow-line"></span><span class="sync-flow-label">选择项目</span></div>`; const matched = targetProjectMap().has(selected); return `<div class="sync-flow ${matched ? 'matched' : 'create'}" aria-hidden="true"><span class="sync-flow-line"></span><span class="sync-flow-label">${matched ? '匹配' : '创建'}</span></div>`; }
function bindProjectNodes(scope = document) { scope.querySelectorAll('[data-sync-project]').forEach(btn => btn.onclick = () => selectSourceProject(btn.dataset.syncProject)); scope.querySelectorAll('[data-delete-project]').forEach(btn => btn.onclick = e => { e.stopPropagation(); confirmDeleteProject(btn.dataset.deleteProject, btn.dataset.deleteSide || 'source'); }); }
function refreshSourceProjectList() { const lane = document.querySelector('#syncPanel .source-lane'); if (!lane)
    return; lane.innerHTML = sourceProjectNodesMarkup(); bindProjectNodes(lane); }
function renderSyncMap() { return `<section class="sync-map"><div class="sync-lane-head"><div><p class="eyebrow">来源项目</p><h3>${escapeHtml(state.sync.sourceName)} <span>${syncCount(state.sync.projects, 'sourceProjects')} 个项目</span></h3></div><label class="sync-search">${iconSvg('search')}<input id="syncProjectSearch" value="${escapeHtml(state.sync.projectQuery)}" placeholder="搜索项目..." /></label></div><div class="sync-lane-head target-head"><div><p class="eyebrow">目标项目</p><h3>${escapeHtml(state.sync.targetName)} <span>${syncCount(state.sync.projects, 'targetProjects')} 个项目</span></h3></div></div><div class="sync-lane source-lane">${sourceProjectNodesMarkup()}</div><div class="sync-link-layer">${syncFlowMarkup()}</div><div class="sync-lane target-lane">${targetProjectNodesMarkup()}</div></section>`; }
function statusLabel(status) { return { copied: '新会话', updated: '安全更新', unchanged: '无变化', overwritten: '已覆盖', conflict: '冲突' }[status] || status; }
function statusClass(status) { return status === 'copied' ? 'new' : status === 'updated' ? 'update' : status === 'conflict' ? 'conflict' : status === 'unchanged' ? 'same' : 'update'; }
function defaultActionFor(session) { const stored = state.sync.actions[session.name]; if (stored === 'skip')
    return 'skip'; if (stored === 'overwrite' && session.status === 'conflict')
    return 'overwrite'; if (stored === 'sync' && (session.status === 'copied' || session.status === 'updated'))
    return 'sync'; if (session.status === 'copied' || session.status === 'updated')
    return 'sync'; return 'skip'; }
function selectedSyncSessions() { return (state.sync.scan?.sessions || []).map(s => ({ name: s.name, action: defaultActionFor(s) })).filter(s => s.action !== 'skip'); }
function sessionActionOptions(session, action) { if (session.status === 'conflict')
    return `<option value="overwrite" ${action === 'overwrite' ? 'selected' : ''}>覆盖</option><option value="skip" ${action === 'skip' ? 'selected' : ''}>跳过</option>`; if (session.status === 'copied' || session.status === 'updated')
    return `<option value="sync" ${action === 'sync' ? 'selected' : ''}>同步</option><option value="skip" ${action === 'skip' ? 'selected' : ''}>跳过</option>`; return `<option value="skip" selected>跳过</option>`; }
function syncSelectionSummary() { const sessions = state.sync.scan?.sessions || []; const summary = { total: sessions.length, selected: 0, sync: 0, overwrite: 0, skipped: 0, conflict: state.sync.scan?.counts?.conflict || 0 }; for (const session of sessions) {
    const action = defaultActionFor(session);
    if (action === 'skip')
        summary.skipped++;
    else {
        summary.selected++;
        summary[action]++;
    }
} return summary; }
function syncSelectionSummaryMarkup() { if (state.sync.scanning)
    return '<span class="sync-apply-summary">正在扫描项目会话...</span>'; if (!state.sync.scan)
    return '<span class="sync-apply-summary">选择 Source 项目后自动扫描</span>'; const s = syncSelectionSummary(); return `<span class="sync-apply-summary">将同步 ${s.sync} 个，覆盖 ${s.overwrite} 个，跳过 ${s.skipped} 个</span>`; }
function syncResultBanner() { const result = state.sync.lastResult; if (!result)
    return ''; const counts = result.counts || {}; return `<div class="sync-result"><strong>同步完成</strong><span>新增 ${counts.copied || 0}</span><span>更新 ${counts.updated || 0}</span><span>覆盖 ${counts.overwritten || 0}</span><span>跳过 ${counts.skipped || 0}</span>${counts.conflict ? `<span class="warn">剩余冲突 ${counts.conflict}</span>` : ''}</div>`; }
function sessionTableHeader() { return '<table class="sync-session-table sync-session-table-head"><thead><tr><th></th><th>会话</th><th>更新时间</th><th>资源</th><th>状态</th><th>策略</th><th>操作</th></tr></thead></table>'; }
function sessionTableBody(sessions) { return `<table class="sync-session-table"><tbody>${sessions.map((s, index) => { const action = defaultActionFor(s); const unchanged = s.status === 'unchanged'; return `<tr class="${action === 'skip' ? 'is-skipped' : 'is-selected'}" style="--row-index:${Math.min(index, 10)}" data-session-row="${escapeHtml(s.name)}"><td><input type="checkbox" data-session-check="${escapeHtml(s.name)}" data-session-status="${escapeHtml(s.status)}" ${action !== 'skip' ? 'checked' : ''} ${unchanged ? 'disabled' : ''}></td><td><strong>${escapeHtml(s.title)}</strong><small>${escapeHtml(s.name)}</small></td><td>${escapeHtml(s.relativeTime)}</td><td>${s.hasAssets ? '有' : '无'}</td><td><span class="sync-status ${statusClass(s.status)}">${statusLabel(s.status)}</span></td><td><select data-session-action="${escapeHtml(s.name)}" ${unchanged ? 'disabled' : ''}>${sessionActionOptions(s, action)}</select></td><td><button class="sync-delete-button table" type="button" data-delete-session="${escapeHtml(s.name)}" title="删除来源会话" aria-label="删除来源会话">${iconSvg('trash')}</button></td></tr>`; }).join('')}</tbody></table>`; }
function renderSessionRows() { const sessions = state.sync.scan?.sessions || []; const result = syncResultBanner(); if (state.sync.scanning)
    return `${result}<div class="sync-session-scroll"><div class="sync-session-empty is-loading"><p class="eyebrow">扫描结果</p><h2>正在扫描会话</h2><p>正在比较 Source 与 Target 的 session 文件。</p></div></div>`; if (!state.sync.scan)
    return `${result}<div class="sync-session-scroll"><div class="sync-session-empty"><p class="eyebrow">扫描结果</p><h2>请选择来源项目</h2><p>扫描结果将显示新增、可更新、无变化和冲突会话。</p></div></div>`; if (!sessions.length)
    return `${result}<div class="sync-session-scroll"><div class="sync-session-empty"><p class="eyebrow">扫描结果</p><h2>该项目没有可同步 session</h2></div></div>`; return `${result}${sessionTableHeader()}<div class="sync-session-scroll">${sessionTableBody(sessions)}</div>`; }
function syncMeasureSessionScrollbar() { const sessions = document.querySelector('#syncPanel .sync-sessions'); const scroll = document.querySelector('#syncPanel .sync-session-scroll'); if (!sessions || !scroll)
    return; sessions.style.setProperty('--sync-scrollbar-width', `${Math.max(0, scroll.offsetWidth - scroll.clientWidth)}px`); }
function syncScrollTargetSelection() { const selected = state.sync.selectedProjectKey; if (!selected)
    return; const key = targetProjectMap().has(selected) ? selected : '__create__'; requestAnimationFrame(() => { if (state.sync.selectedProjectKey !== selected)
    return; const lane = document.querySelector('#syncPanel .target-lane'); if (!lane)
    return; const item = [...lane.querySelectorAll('[data-target-project]')].find(el => el.dataset.targetProject === key); if (!item)
    return; const laneRect = lane.getBoundingClientRect(); const itemRect = item.getBoundingClientRect(); const paddingTop = parseFloat(getComputedStyle(lane).paddingTop) || 0; const top = Math.max(0, lane.scrollTop + itemRect.top - laneRect.top - paddingTop); const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; lane.scrollTo({ top, behavior: reduceMotion ? 'auto' : 'smooth' }); }); }
function refreshSyncSummaryControls() { const summary = document.querySelector('#syncPanel .sync-apply-summary'); if (summary) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = syncSelectionSummaryMarkup();
    summary.replaceWith(wrapper.firstElementChild);
} const apply = $('syncApply'); if (apply) {
    const busy = state.sync.scanning || state.sync.applying;
    apply.disabled = !selectedSyncSessions().length || busy;
    apply.textContent = state.sync.applying ? '同步中...' : '同步选中项';
} }
function syncSessionsHeadMarkup() { const project = state.sync.selectedProjectKey; const scan = state.sync.scan; const selectedCount = selectedSyncSessions().length; const busy = state.sync.scanning || state.sync.applying; return `<div class="sync-sessions-head"><div><p class="eyebrow">扫描结果</p><h3>${state.sync.scanning ? '扫描中...' : scan ? `${scan.sessions.length} 条会话` : '等待扫描'}</h3></div><div class="sync-bulk">${syncSelectionSummaryMarkup()}<button class="ghost tiny" id="syncScan" type="button" ${project && !state.sync.scanning && !state.sync.applying ? '' : 'disabled'}>重新扫描</button><button class="ghost tiny" id="syncSelectSafe" type="button" ${scan && !busy ? '' : 'disabled'}>选择安全项</button><button class="ghost tiny" id="syncSkipConflicts" type="button" ${scan && !busy ? '' : 'disabled'}>跳过冲突</button><button class="ghost tiny danger-lite" id="syncOverwriteConflicts" type="button" ${scan && !busy ? '' : 'disabled'}>覆盖冲突</button><button class="primary tiny" id="syncApply" type="button" ${selectedCount && !busy ? '' : 'disabled'}>${state.sync.applying ? '同步中...' : '同步选中项'}</button></div></div>`; }
function renderSyncSessionsSection() { return `<section class="sync-sessions">${syncSessionsHeadMarkup()}${renderSessionRows()}</section>`; }
function refreshSyncToolbarState() { const busy = state.sync.scanning || state.sync.applying; const source = $('syncSource'); const target = $('syncTarget'); const swap = $('syncSwap'); if (source)
    source.disabled = busy; if (target)
    target.disabled = busy; if (swap)
    swap.disabled = busy; }
function refreshSyncProjectSelection() { const selected = state.sync.selectedProjectKey; const sourceLane = document.querySelector('#syncPanel .source-lane'); if (sourceLane)
    sourceLane.querySelectorAll('[data-sync-project]').forEach(btn => btn.classList.toggle('active', btn.dataset.syncProject === selected)); const targetLane = document.querySelector('#syncPanel .target-lane'); if (targetLane) {
    targetLane.innerHTML = targetProjectNodesMarkup();
    bindProjectNodes(targetLane);
} const linkLayer = document.querySelector('#syncPanel .sync-link-layer'); if (linkLayer)
    linkLayer.innerHTML = syncFlowMarkup(); syncScrollTargetSelection(); }
function bindSyncSessionControls(scope = document) { const scanBtn = scope.querySelector('#syncScan'); if (scanBtn)
    scanBtn.onclick = () => scanSelectedProject({ partial: true }); const safe = scope.querySelector('#syncSelectSafe'); if (safe)
    safe.onclick = () => bulkSetActions('safe'); const skip = scope.querySelector('#syncSkipConflicts'); if (skip)
    skip.onclick = () => bulkSetActions('skip-conflicts'); const over = scope.querySelector('#syncOverwriteConflicts'); if (over)
    over.onclick = () => bulkSetActions('overwrite-conflicts'); const apply = scope.querySelector('#syncApply'); if (apply)
    apply.onclick = applySyncSessions; scope.querySelectorAll('[data-delete-session]').forEach(btn => btn.onclick = () => confirmDeleteSession(btn.dataset.deleteSession)); scope.querySelectorAll('[data-session-action]').forEach(sel => sel.onchange = e => { state.sync.actions[e.target.dataset.sessionAction] = e.target.value; refreshSessionRow(e.target.dataset.sessionAction); refreshSyncSummaryControls(); }); scope.querySelectorAll('[data-session-check]').forEach(ch => ch.onchange = e => { const status = e.target.dataset.sessionStatus; state.sync.actions[e.target.dataset.sessionCheck] = e.target.checked ? (status === 'conflict' ? 'overwrite' : 'sync') : 'skip'; refreshSessionRow(e.target.dataset.sessionCheck); refreshSyncSummaryControls(); }); }
function refreshSyncSessionsSection() { const section = document.querySelector('#syncPanel .sync-sessions'); if (!section) {
    renderSyncPanel();
    return;
} section.innerHTML = `${syncSessionsHeadMarkup()}${renderSessionRows()}`; bindSyncSessionControls(section); refreshSyncToolbarState(); syncMeasureSessionScrollbar(); }
function sessionByName(name) { return (state.sync.scan?.sessions || []).find(s => s.name === name); }
function refreshSessionRow(name) { const row = [...document.querySelectorAll('[data-session-row]')].find(el => el.dataset.sessionRow === name); const session = sessionByName(name); if (!row || !session)
    return; const action = defaultActionFor(session); row.classList.toggle('is-skipped', action === 'skip'); row.classList.toggle('is-selected', action !== 'skip'); const check = row.querySelector('[data-session-check]'); if (check)
    check.checked = action !== 'skip'; const select = row.querySelector('[data-session-action]'); if (select && select.value !== action)
    select.value = action; }
function refreshSessionRowsState() { document.querySelectorAll('[data-session-row]').forEach(row => refreshSessionRow(row.dataset.sessionRow)); refreshSyncSummaryControls(); }
function renderSyncPanel(mode = '', message = '') { const source = state.sync.sourceName; const target = state.sync.targetName; const busy = state.sync.scanning || state.sync.applying; $('syncPanel').innerHTML = `<div class="modal-head sync-head"><div><p class="eyebrow">session sync workspace</p><h2>同步会话</h2><p class="hint">点击 Source 项目后会自动扫描；连线只表示同步意图，确认同步才会写入 Target。</p></div><button class="icon-btn" id="syncClose" type="button">×</button></div><div class="sync-toolbar"><label>Source<select id="syncSource" ${busy ? 'disabled' : ''}>${profileOptions(source, target)}</select></label><button class="ghost icon-only" id="syncSwap" type="button" title="交换 Source / Target" ${busy ? 'disabled' : ''}>⇄</button><label>Target<select id="syncTarget" ${busy ? 'disabled' : ''}>${profileOptions(target, source)}</select></label></div>${mode === 'loading' ? '<div class="sync-loading"><span></span>正在加载项目会话...</div>' : mode === 'error' ? `<div class="sync-loading">${escapeHtml(message)}</div>` : `<div class="sync-body">${renderSyncMap()}</div>${renderSyncSessionsSection()}`}<div class="dialog-toast-region"></div>`; bindSyncPanel(); syncMeasureSessionScrollbar(); syncScrollTargetSelection(); }
function bindSyncPanel() { $('syncClose').onclick = () => $('syncDialog').close(); $('syncSource').onchange = e => { state.sync.sourceName = e.target.value; state.sync.lastResult = null; normalizeSyncPair('source'); loadSyncProjects({ changed: 'source' }); }; $('syncTarget').onchange = e => { state.sync.targetName = e.target.value; state.sync.lastResult = null; normalizeSyncPair('target'); loadSyncProjects({ changed: 'target' }); }; $('syncSwap').onclick = () => { const old = state.sync.sourceName; state.sync.sourceName = state.sync.targetName; state.sync.targetName = old; state.sync.lastResult = null; loadSyncProjects({ preserveProject: true, changed: 'swap' }); }; const search = $('syncProjectSearch'); if (search)
    search.oninput = e => { state.sync.projectQuery = e.target.value; refreshSourceProjectList(); }; bindProjectNodes(document); bindSyncSessionControls(document); }
async function selectSourceProject(projectKey) { if (state.sync.selectedProjectKey === projectKey && state.sync.scanning)
    return; state.sync.selectedProjectKey = projectKey; state.sync.scan = null; state.sync.actions = {}; state.sync.lastResult = null; refreshSyncProjectSelection(); await scanSelectedProject({ partial: true }); }
async function scanSelectedProject(options = {}) { if (!state.sync.selectedProjectKey || !state.sync.sourceName || !state.sync.targetName)
    return; const sourceName = state.sync.sourceName; const targetName = state.sync.targetName; const projectKey = state.sync.selectedProjectKey; const requestId = ++state.sync.requestId; const partial = options.partial && document.querySelector('#syncPanel .sync-sessions'); state.sync.scanning = true; if (!options.keepResult)
    state.sync.lastResult = null; partial ? refreshSyncSessionsSection() : renderSyncPanel(); try {
    const data = await api('/api/sessions/scan', { method: 'POST', body: JSON.stringify({ sourceName, targetName, projectKey }) });
    if (requestId !== state.sync.requestId || state.sync.selectedProjectKey !== projectKey || state.sync.sourceName !== sourceName || state.sync.targetName !== targetName)
        return;
    state.sync.scan = data;
    state.sync.actions = {};
    for (const s of data.sessions) {
        state.sync.actions[s.name] = (s.status === 'copied' || s.status === 'updated') ? 'sync' : 'skip';
    }
    state.sync.scanning = false;
    partial ? refreshSyncSessionsSection() : renderSyncPanel();
}
catch (err) {
    if (requestId !== state.sync.requestId)
        return;
    state.sync.scanning = false;
    toast(err.message);
    partial ? refreshSyncSessionsSection() : renderSyncPanel();
} }
function bulkSetActions(mode) { if (!state.sync.scan)
    return; for (const s of state.sync.scan.sessions) {
    if (mode === 'safe')
        state.sync.actions[s.name] = (s.status === 'copied' || s.status === 'updated') ? 'sync' : 'skip';
    if (mode === 'skip-conflicts' && s.status === 'conflict')
        state.sync.actions[s.name] = 'skip';
    if (mode === 'overwrite-conflicts' && s.status === 'conflict')
        state.sync.actions[s.name] = 'overwrite';
} refreshSessionRowsState(); }
function renderSyncConfirmPanel() { const confirmState = state.sync.confirm || {}; if (confirmState.kind === 'delete-project')
    return renderSyncDeleteProjectConfirm(confirmState.projectKey, confirmState.side || 'source'); if (confirmState.kind === 'delete-session')
    return renderSyncDeleteSessionConfirm(confirmState.sessionName); const selections = confirmState.selections || []; const overwriteCount = selections.filter(s => s.action === 'overwrite').length; $('syncConfirmPanel').innerHTML = `<div class="modal-head"><div><p class="eyebrow">覆盖确认</p><h2>确认覆盖冲突 session</h2><p class="hint">本次会覆盖 Target 中 ${overwriteCount} 个冲突 session。请输入 <strong>overwrite</strong> 后继续。</p></div><button class="icon-btn" id="syncConfirmClose" type="button">×</button></div><div class="sync-confirm-summary"><div class="kv"><span>来源</span><strong>${escapeHtml(state.sync.sourceName)}</strong><span>目标</span><strong>${escapeHtml(state.sync.targetName)}</strong><span>项目</span><strong>${escapeHtml(shortProjectKey(state.sync.selectedProjectKey || '-'))}</strong><span>已选择</span><strong>${selections.length} 条会话</strong></div><label>确认文本<input id="syncOverwriteConfirmText" autocomplete="off" placeholder="overwrite"></label></div><menu class="modal-actions"><button class="ghost" id="syncConfirmCancel" type="button">取消</button><button class="primary danger-primary" id="syncConfirmApply" type="button" disabled>确认覆盖并同步</button></menu><div class="dialog-toast-region"></div>`; $('syncConfirmClose').onclick = closeSyncConfirm; $('syncConfirmCancel').onclick = closeSyncConfirm; const input = $('syncOverwriteConfirmText'); const apply = $('syncConfirmApply'); input.oninput = () => { apply.disabled = input.value.trim() !== 'overwrite'; }; apply.onclick = () => { const next = state.sync.confirm?.selections || []; closeSyncConfirm(); performSyncSessions(next); }; setTimeout(() => input.focus(), 0); }
function renderSyncDeleteProjectConfirm(projectKey, side = 'source') { const isTarget = side === 'target'; const sideLabel = isTarget ? '目标' : '来源'; const profileName = isTarget ? state.sync.targetName : state.sync.sourceName; $('syncConfirmPanel').innerHTML = `<div class="modal-head"><div><p class="eyebrow">删除确认</p><h2>删除${sideLabel}项目</h2><p class="hint">将删除 ${isTarget ? 'Target' : 'Source'} profile <strong>${escapeHtml(profileName)}</strong> 中该项目的所有会话日志与资源目录。</p></div><button class="icon-btn" id="syncConfirmClose" type="button">×</button></div><div class="sync-confirm-summary"><div class="kv"><span>${sideLabel}</span><strong>${escapeHtml(profileName)}</strong><span>项目</span><strong>${escapeHtml(shortProjectKey(projectKey))}</strong></div></div><menu class="modal-actions"><button class="ghost" id="syncConfirmCancel" type="button">取消</button><button class="primary danger-primary" id="syncConfirmApply" type="button">确认删除${sideLabel}项目</button></menu><div class="dialog-toast-region"></div>`; bindSyncDeleteConfirm(() => deleteProject(projectKey, side)); }
function renderSyncDeleteSessionConfirm(sessionName) { $('syncConfirmPanel').innerHTML = `<div class="modal-head"><div><p class="eyebrow">删除确认</p><h2>删除来源会话</h2><p class="hint">将删除 Source 项目中的该 session 文件，以及同名资源目录。</p></div><button class="icon-btn" id="syncConfirmClose" type="button">×</button></div><div class="sync-confirm-summary"><div class="kv"><span>来源</span><strong>${escapeHtml(state.sync.sourceName)}</strong><span>项目</span><strong>${escapeHtml(shortProjectKey(state.sync.selectedProjectKey || '-'))}</strong><span>会话</span><strong>${escapeHtml(sessionName)}</strong></div></div><menu class="modal-actions"><button class="ghost" id="syncConfirmCancel" type="button">取消</button><button class="primary danger-primary" id="syncConfirmApply" type="button">确认删除会话</button></menu><div class="dialog-toast-region"></div>`; bindSyncDeleteConfirm(() => deleteSourceSession(sessionName)); }
function bindSyncDeleteConfirm(applyTask) { $('syncConfirmClose').onclick = closeSyncConfirm; $('syncConfirmCancel').onclick = closeSyncConfirm; $('syncConfirmApply').onclick = () => { closeSyncConfirm(); applyTask(); }; }
function closeSyncConfirm() { state.sync.confirm = null; $('syncConfirmDialog').close(); }
function confirmDeleteProject(projectKey, side = 'source') { if (!projectKey || state.sync.scanning || state.sync.applying)
    return; state.sync.confirm = { kind: 'delete-project', projectKey, side }; renderSyncConfirmPanel(); $('syncConfirmDialog').showModal(); }
function confirmDeleteSession(sessionName) { if (!sessionName || state.sync.scanning || state.sync.applying)
    return; state.sync.confirm = { kind: 'delete-session', sessionName }; renderSyncConfirmPanel(); $('syncConfirmDialog').showModal(); }
async function deleteProject(projectKey, side = 'source') { const isTarget = side === 'target'; const profileName = isTarget ? state.sync.targetName : state.sync.sourceName; try {
    state.sync.applying = true;
    renderSyncPanel();
    await api('/api/sessions/project/delete', { method: 'POST', body: JSON.stringify({ profileName, projectKey }) });
    toast(`${isTarget ? '目标' : '来源'}项目已删除`);
    state.sync.lastResult = null;
    if (isTarget) {
        await loadSyncProjects({ preserveProject: true, projectKey: state.sync.selectedProjectKey, changed: 'target', silent: true });
        if (state.sync.selectedProjectKey)
            await scanSelectedProject({ keepResult: true });
    }
    else {
        state.sync.selectedProjectKey = '';
        state.sync.scan = null;
        state.sync.actions = {};
        await loadSyncProjects({ changed: 'source', silent: true });
    }
}
catch (err) {
    state.sync.applying = false;
    renderSyncPanel();
    toast(err.message);
} }
async function deleteSourceSession(sessionName) { try {
    state.sync.applying = true;
    renderSyncPanel();
    await api('/api/sessions/session/delete', { method: 'POST', body: JSON.stringify({ sourceName: state.sync.sourceName, projectKey: state.sync.selectedProjectKey, sessionName }) });
    toast('来源会话已删除');
    state.sync.lastResult = null;
    await loadSyncProjects({ preserveProject: true, projectKey: state.sync.selectedProjectKey, changed: 'source', silent: true });
    await scanSelectedProject();
}
catch (err) {
    state.sync.applying = false;
    renderSyncPanel();
    toast(err.message);
} }
async function applySyncSessions() { const selections = selectedSyncSessions(); if (!selections.length) {
    toast('没有选中的 session');
    return;
} const overwriteCount = selections.filter(s => s.action === 'overwrite').length; if (overwriteCount) {
    state.sync.confirm = { selections };
    renderSyncConfirmPanel();
    $('syncConfirmDialog').showModal();
    return;
} await performSyncSessions(selections); }
async function performSyncSessions(selections) { try {
    state.sync.applying = true;
    renderSyncPanel();
    const result = await api('/api/sessions/sync', { method: 'POST', body: JSON.stringify({ sourceName: state.sync.sourceName, targetName: state.sync.targetName, projectKey: state.sync.selectedProjectKey, selections }) });
    state.sync.lastResult = result;
    toast(`同步完成 copied=${result.counts.copied}, updated=${result.counts.updated}, overwritten=${result.counts.overwritten}`);
    await loadSyncProjects({ preserveProject: true, projectKey: result.projectKey, keepResult: true, silent: true });
    state.sync.selectedProjectKey = result.projectKey;
    await scanSelectedProject({ keepResult: true });
}
catch (err) {
    state.sync.applying = false;
    renderSyncPanel();
    toast(err.message);
} }
async function load() { const [d, p, upstreamData] = await Promise.all([api('/api/dashboard'), api('/api/profiles'), api('/api/gateway/upstreams')]); state.dashboard = d; state.profiles = p.profiles; state.upstreams = upstreamData.upstreams || []; renderSummary(); renderBoard(); }
async function loadPresets() { if (state.presets.length)
    return; const data = await api('/api/presets'); state.presets = data.presets || []; renderPresetPicker(); }
function presetIcon(preset) {
    const brand = preset.id === 'aicodemirror' ? 'aicodemirror'
        : preset.id === 'deepseek' ? 'deepseek'
            : preset.id === 'mimo' ? 'mimo'
                : preset.type === 'login' ? 'claude' : '';
    const fallback = iconSvg(preset.type === 'gateway' ? 'route' : preset.type === 'login' ? 'user' : 'key');
    return brandIconMarkup(brand, fallback, 'preset-brand-logo');
}
function presetTypeLabel(type) { return type === 'custom-api' ? 'API' : String(type).toUpperCase(); }
function presetCategory(p) { return p.category || (p.type === 'api' ? 'api' : p.type === 'login' ? 'login' : p.type === 'gateway' ? 'gateway' : 'custom'); }
function filteredPresets() { const q = state.presetQuery.toLowerCase(); return [...state.presets].sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999) || a.label.localeCompare(b.label)).filter(p => { const category = presetCategory(p); const okFilter = state.presetFilter === 'all' || category === state.presetFilter; const hay = [p.id, p.label, p.description, p.type, p.category, p.modelSummary, ...(p.tags || []), p.env?.ANTHROPIC_BASE_URL].join(' ').toLowerCase(); return okFilter && (!q || hay.includes(q)); }); }
function selectedPreset() { return state.presets.find(p => p.id === state.selectedPreset) || state.presets[0]; }
function renderPresetPicker() { const list = $('presetList'); if (!list)
    return; const items = filteredPresets(); if (!items.find(p => p.id === state.selectedPreset))
    state.selectedPreset = items[0]?.id || state.presets[0]?.id || ''; list.innerHTML = items.length ? items.map(p => `<button type="button" class="preset-option ${p.id === state.selectedPreset ? 'active' : ''}" data-preset="${escapeHtml(p.id)}"><span class="preset-icon">${presetIcon(p)}</span><span><strong>${escapeHtml(p.label)}</strong><small>${escapeHtml(presetTypeLabel(p.type))} · ${escapeHtml(p.modelSummary || '')}</small></span></button>`).join('') : '<div class="preset-empty">没有匹配的预设</div>'; list.querySelectorAll('[data-preset]').forEach(btn => btn.onclick = () => selectPreset(btn.dataset.preset)); bindPresetControls(); renderPresetDetail(); }
function selectPreset(id) { state.selectedPreset = id; renderPresetPicker(); }
function bindPresetControls() { const search = $('presetSearch'); if (search && !search.dataset.bound) {
    search.dataset.bound = '1';
    search.oninput = e => { state.presetQuery = e.target.value; renderPresetPicker(); const next = $('presetSearch'); if (next) {
        next.focus();
        next.setSelectionRange(next.value.length, next.value.length);
    } };
} if (search)
    search.value = state.presetQuery; const filters = $('presetFilters'); if (filters && !filters.dataset.bound) {
    filters.dataset.bound = '1';
    filters.onclick = e => { const value = e.target.dataset.presetFilter; if (!value)
        return; state.presetFilter = value; renderPresetPicker(); };
} document.querySelectorAll('#presetFilters [data-preset-filter]').forEach(btn => btn.classList.toggle('active', btn.dataset.presetFilter === state.presetFilter)); }
function presetFullConfig(preset) { const env = preset.env || {}; if (preset.type === 'api')
    return { env: { ...env, ANTHROPIC_AUTH_TOKEN: '<API_KEY>' } }; if (preset.type === 'gateway')
    return { profile: { upstreamId: '<UPSTREAM_ID>', model: '<MODEL>', localToken: '<GENERATED>' } }; return {}; }
function renderPresetDetail() {
    const preset = selectedPreset();
    if (!preset)
        return;
    $('presetId').value = preset.id;
    $('newKind').value = preset.type;
    document.querySelectorAll('[data-kind-fields]').forEach(el => { const active = el.dataset.kindFields === preset.type; el.hidden = !active; el.querySelectorAll('input,select,textarea,button').forEach(field => { field.disabled = !active; }); });
    const env = preset.env || {};
    const rows = [];
    if (env.ANTHROPIC_BASE_URL)
        rows.push(['Base URL', env.ANTHROPIC_BASE_URL]);
    if (preset.chatCompletionsUrl)
        rows.push(['Endpoint', preset.chatCompletionsUrl]);
    if (preset.modelSummary)
        rows.push(['Model', preset.modelSummary]);
    const fullConfig = JSON.stringify(presetFullConfig(preset), null, 2);
    $('presetSummary').innerHTML = `<p class="eyebrow">${escapeHtml(presetTypeLabel(preset.type))} preset</p><h3>${escapeHtml(preset.label)}</h3><p>${escapeHtml(preset.description || '')}</p>${rows.length ? `<dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>` : ''}${fullConfig !== '{}' ? `<details class="preset-config"><summary>完整配置</summary><pre>${escapeHtml(fullConfig)}</pre></details>` : ''}`;
    let canCreate = true;
    let unavailableMessage = '';
    if (preset.type === 'gateway') {
        canCreate = bindGatewayBinding('newGateway');
        unavailableMessage = '请先创建一个上游供应商';
    }
    setCreateProfileAvailability(canCreate, unavailableMessage);
    const canReturnToGateway = primaryModalCanReturnTo('gatewayDialog');
    document.querySelectorAll('[data-open-gateway-manager]').forEach(button => {
        button.hidden = canReturnToGateway;
        button.onclick = openGatewayPanel;
    });
}

let collabMeshState = {
    loading: false,
    gatewayOnline: true,
    peers: [],
    blackboard: [],
    supervisorMessages: [],
    supervisorUnread: 0,
    dispatches: [],
    dispatchSummary: {},
    dispatchStateById: {},
    dispatchSnapshotLoaded: false,
    sending: false,
    // Canvas & Viewport State
    zoom: 1.0,
    panX: 0,
    panY: 0,
    isPanning: false,
    isDraggingNode: false,
    panStartX: 0,
    panStartY: 0,
    initialPanX: 0,
    initialPanY: 0,
    // Custom Node Positions: { [peerId]: { x: number, y: number } }
    nodePositions: {},
    hubPosition: { x: 60, y: 40 },
    hubPositionManual: false,
    layoutMode: '',
    // Wire connection dragging:
    activeWire: null,
    tentativeLink: null, // { source, target, createdAt }
    activeP2pLinks: [], // Array<{ source, target, status, isFlowing, expiresAt }>
    hoveredDropTarget: null,
    // Active flying particle animations:
    transmissions: [],
    // Drawers & HUDs (Unified Drawer)
    blackboardOpen: false,
    blackboardFilter: '',
    activityOpen: false,
    supervisorPanelOpen: true,
    supervisorTab: 'inbox',
    activeReplyTarget: '',
    activityLogs: [
        { time: new Date().toLocaleTimeString(), text: 'Multi-Agent Mesh 拓扑网络已就绪', type: 'info' }
    ],
    // Simulation / Demo Mode
    simulationMode: false,
    pollTimer: null,
    // Target-Attached Floating Popover (Flyout beside target node)
    nodeFlyout: {
        open: false,
        targetProfile: '',
        message: '',
        isAsk: false,
        reportBack: true,
        sourceProfile: null
    },
    // Global Broadcast & Batch Dispatch Modal
    dispatchModal: {
        open: false,
        selectedTargets: new Set(),
        message: '',
        reportBack: true,
        activePresetId: ''
    },
    // Preserve reply draft across silent panel refreshes
    replyDraft: '',
    hasInitialFit: false,
    isFullscreen: false
};

const COLLAB_TASK_PRESETS = [
    {
        id: 'review',
        label: '代码审查',
        icon: '🔍',
        prompt: '请审查当前代码库架构规范与潜在隐患，输出诊断报告：'
    },
    {
        id: 'fix',
        label: '排查修复',
        icon: '🐛',
        prompt: '请排查并修复当前未通过的错误与异常日志：'
    },
    {
        id: 'tests',
        label: '生成单测',
        icon: '🧪',
        prompt: '请为当前核心功能模块补充自动化单元测试用例：'
    },
    {
        id: 'docs',
        label: '接口文档',
        icon: '📝',
        prompt: '请梳理当前核心 API 与 MCP 工具定义并输出文档：'
    },
    {
        id: 'custom',
        label: '自定义指令...',
        icon: '✍️',
        prompt: '',
        custom: true
    }
];

const COLLAB_DEMO_PEERS = [
    {
        peerId: 'grok-arch:14208',
        profile: 'grok-arch',
        model: 'grok-2',
        status: 'idle',
        currentFocus: '系统架构分析与多智能体解耦设计',
        activeFiles: ['src/collab/hub.ts', 'src/gateway/server.ts'],
        pid: 14208,
        cwd: 'D:/CodingDev/multi-ccp'
    },
    {
        peerId: 'ds-coder:28412',
        profile: 'ds-coder',
        model: 'deepseek-r1',
        status: 'busy',
        currentFocus: '重构 Collab Canvas 拓扑连线与粒子引擎',
        activeFiles: ['src/web/assets/app.js', 'src/web/assets/gateway.css'],
        pid: 28412,
        cwd: 'D:/CodingDev/multi-ccp'
    },
    {
        peerId: 'claude-qa:39104',
        profile: 'claude-qa',
        model: 'claude-3-7-sonnet',
        status: 'idle',
        currentFocus: '自动化单元测试与协作协议覆盖验证',
        activeFiles: ['tests/collab/hub.test.ts'],
        pid: 39104,
        cwd: 'D:/CodingDev/multi-ccp'
    }
];

const COLLAB_DEMO_BLACKBOARD = [
    {
        id: 'bb-1',
        key: 'feature:collab-mesh-canvas',
        value: 'Canvas-based topology mesh studio initialized with drag-and-drop wiring and animated particle curves.',
        author: 'grok-arch',
        timestamp: Date.now() - 180000
    },
    {
        id: 'bb-2',
        key: 'spec:mcp-stdio-bridge',
        value: 'Standardized MCP communication stdio bridge running across all profiles via gateway proxy.',
        author: 'ds-coder',
        timestamp: Date.now() - 90000
    }
];

function normalizeCollabIdentity(value) {
    return String(value || '').trim().toLowerCase();
}

function collabNetworkSummaryText() {
    const online = collabMeshState.gatewayOnline || collabMeshState.simulationMode;
    const active = collabMeshState.dispatches.filter(item => ['pending', 'waiting', 'processing', 'stalled', 'disconnected'].includes(item.status)).length;
    return `${online ? '网关已联通' : '网关离线'} · ${collabMeshState.peers.length} 个 Agent CLI · ${active} 个协作中 · ${collabMeshState.supervisorUnread} 条未读`;
}

function collabPeerKey(peer) {
    if (!peer) return '';
    const peerId = String(peer.peerId || '').trim();
    if (peerId) return `peer:${encodeURIComponent(peerId)}`;
    const profile = normalizeCollabIdentity(peer.profile);
    const pid = String(peer.pid || 'unknown');
    return `peer:${encodeURIComponent(`${profile}:${pid}`)}`;
}

function collabPeerByKey(key) {
    if (!key) return null;
    const peers = collabMeshState.peers.length ? collabMeshState.peers : (collabMeshState.simulationMode ? COLLAB_DEMO_PEERS : []);
    return peers.find(peer => collabPeerKey(peer) === key) || null;
}

function collabPeerByIdentity(profile, peerId = '') {
    const normalizedProfile = String(profile || '').trim().toLowerCase();
    const peers = collabMeshState.peers.length ? collabMeshState.peers : (collabMeshState.simulationMode ? COLLAB_DEMO_PEERS : []);
    const matches = peers.filter(peer => String(peer.profile || '').trim().toLowerCase() === normalizedProfile);
    if (peerId) return matches.find(peer => String(peer.peerId || '') === String(peerId)) || null;
    return matches.length === 1 ? matches[0] : null;
}

function collabDispatchNodeKey(profile, peerId) {
    const normalized = normalizeCollabIdentity(profile);
    if (!normalized || normalized === 'web-ui' || normalized === 'supervisor' || normalized === '__supervisor__') return '__hub__';
    const peer = collabPeerByIdentity(profile, peerId);
    return peer ? collabPeerKey(peer) : collabPeerKey({ profile, peerId });
}

function collabDispatchVisualState(dispatch) {
    if (!dispatch) return 'idle';
    if (dispatch.status === 'completed') return 'completed';
    if (dispatch.status === 'error' || dispatch.status === 'timeout') return 'error';
    if (dispatch.status === 'disconnected') return 'disconnected';
    if (dispatch.status === 'stalled') return 'stalled';
    if (dispatch.status === 'processing') return 'processing';
    if (dispatch.status === 'pending') return 'pending';
    if (dispatch.status === 'waiting') return 'waiting';
    return 'idle';
}

function formatCollabElapsed(startAt, endAt = Date.now()) {
    const seconds = Math.max(0, Math.floor((Number(endAt) - Number(startAt || endAt)) / 1000));
    if (seconds < 60) return `${seconds}秒`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    if (minutes < 60) return `${minutes}分${String(remainder).padStart(2, '0')}秒`;
    return `${Math.floor(minutes / 60)}小时${String(minutes % 60).padStart(2, '0')}分`;
}

function collabDispatchStatusText(dispatch) {
    const state = collabDispatchVisualState(dispatch);
    if (state === 'disconnected') return 'Agent CLI 已断开，任务仍保留';
    if (state === 'pending') return '目标尚未连接，任务排队中';
    if (state === 'waiting') {
        const elapsed = formatCollabElapsed(dispatch.waitingSince || dispatch.createdAt);
        return `已送达，等待开始处理 ${elapsed}`;
    }
    if (state === 'processing') return `正在处理 · 最近活动 ${formatCollabElapsed(dispatch.lastActivityAt || dispatch.updatedAt)}前`;
    if (state === 'stalled') return `疑似卡住 · 已静默 ${formatCollabElapsed(dispatch.lastActivityAt || dispatch.waitingSince || dispatch.createdAt)}`;
    if (state === 'completed') return `已完成 · ${formatCollabElapsed(dispatch.createdAt, dispatch.completedAt || dispatch.updatedAt)}`;
    if (state === 'error') return dispatch.status === 'timeout' ? '已由人工或兼容逻辑终止' : '执行失败';
    return '在线';
}

function collabDispatchBadgeText(dispatch) {
    const state = collabDispatchVisualState(dispatch);
    if (state === 'disconnected') return '已断连';
    if (state === 'pending') return '排队中';
    if (state === 'waiting') return `等待 ${formatCollabElapsed(dispatch.waitingSince || dispatch.createdAt)}`;
    if (state === 'processing') return '处理中';
    if (state === 'stalled') return '疑似卡住';
    if (state === 'completed') return '已完成';
    if (dispatch.status === 'error') return '失败';
    if (dispatch.status === 'timeout') return '已终止';
    return '在线';
}

function latestCollabDispatchForPeer(peer) {
    const profile = normalizeCollabIdentity(peer?.profile);
    const peerId = String(peer?.peerId || '');
    const matches = (collabMeshState.dispatches || []).filter(dispatch => (
        dispatch.toPeerId ? dispatch.toPeerId === peerId : normalizeCollabIdentity(dispatch.to) === profile
    ));
    const active = matches
        .filter(dispatch => ['pending', 'waiting', 'processing', 'stalled', 'disconnected'].includes(dispatch.status))
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0];
    if (active) return active;
    const terminal = matches.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0];
    if (!terminal) return null;
    if (terminal.status === 'timeout' || terminal.status === 'error') return terminal;
    const tracked = collabMeshState.dispatchStateById?.[terminal.id];
    return tracked?.pulseUntil > Date.now() ? terminal : null;
}

function reconcileCollabDispatches(dispatches) {
    const previous = collabMeshState.dispatchStateById || {};
    const next = {};
    const shouldAnimate = collabMeshState.dispatchSnapshotLoaded;
    const now = Date.now();

    dispatches.forEach(dispatch => {
        const state = collabDispatchVisualState(dispatch);
        const signature = `${dispatch.status}:${dispatch.deliveryStatus}:${dispatch.updatedAt || ''}`;
        const previousEntry = previous[dispatch.id];
        const completedTransition = shouldAnimate && previousEntry?.state !== 'completed' && state === 'completed';
        next[dispatch.id] = {
            signature,
            state,
            pulseUntil: completedTransition ? now + 3_000 : previousEntry?.pulseUntil
        };
        if (!shouldAnimate || previousEntry?.signature === signature) return;

        const source = collabDispatchNodeKey(dispatch.from, dispatch.fromPeerId);
        const target = collabDispatchNodeKey(dispatch.to, dispatch.toPeerId);
        if (!previousEntry && now - Number(dispatch.createdAt || 0) < 12_000) {
            triggerTransmissionAnimation(source, target, '', state === 'disconnected' ? 'disconnected' : 'sending');
        } else if (state === 'completed' && previousEntry?.state !== 'completed') {
            triggerTransmissionAnimation(target, source, '', 'completed');
        } else if (state === 'error' && previousEntry?.state !== 'error') {
            triggerTransmissionAnimation(target, source, '', 'error');
        }

    });

    collabMeshState.dispatchStateById = next;
    collabMeshState.dispatchSnapshotLoaded = true;
    collabMeshState.activeP2pLinks = (collabMeshState.dispatches || [])
        .filter(dispatch => ['pending', 'waiting', 'processing', 'stalled', 'disconnected'].includes(dispatch.status) || now - Number(dispatch.updatedAt || 0) < 8_000)
        .map(dispatch => ({
            source: collabDispatchNodeKey(dispatch.from, dispatch.fromPeerId),
            target: collabDispatchNodeKey(dispatch.to, dispatch.toPeerId),
            status: collabDispatchVisualState(dispatch),
            isFlowing: dispatch.status === 'waiting' || dispatch.status === 'processing',
            expiresAt: Number(dispatch.updatedAt || now) + 8_000,
            dispatchId: dispatch.id
        }));
}

async function openCollabMesh() {
    renderCollabMeshPanel();
    const dialog = $('collabMeshDialog');
    if (dialog && typeof dialog.showModal === 'function') {
        dialog.classList.remove('is-closing');
        dialog.showModal();
        // Force reflow so open animation plays even when dialog was previously open
        void dialog.offsetWidth;
        dialog.classList.add('is-open');
    }
    if (!collabMeshState.nodePositions) collabMeshState.nodePositions = {};
    collabMeshState.hasInitialFit = false;
    await loadCollabMeshData();
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            fitCollabMeshView(true);
            collabMeshState.hasInitialFit = true;
        });
    });
    startCollabLivePolling();
}

function closeCollabMesh() {
    stopCollabLivePolling();
    closeNodeFlyout();
    closeBroadcastDispatchModal();
    const dialog = $('collabMeshDialog');
    if (!dialog) {
        collabMeshState.isFullscreen = false;
        return;
    }

    const finishClose = () => {
        if (dialog.open && typeof dialog.close === 'function') dialog.close();
        dialog.classList.remove('is-fullscreen', 'is-open', 'is-closing');
        collabMeshState.isFullscreen = false;
    };

    if (!dialog.open) {
        finishClose();
        return;
    }

    dialog.classList.add('is-closing');
    dialog.classList.remove('is-open');
    const onEnd = (e) => {
        if (e && e.target !== dialog) return;
        dialog.removeEventListener('animationend', onEnd);
        finishClose();
    };
    dialog.addEventListener('animationend', onEnd);
    // Fallback if animation is disabled
    setTimeout(onEnd, 280);
}

function startCollabLivePolling() {
    stopCollabLivePolling();
    collabMeshState.pollTimer = setInterval(() => {
        if ($('collabMeshDialog')?.open && !collabMeshState.isPanning && !collabMeshState.activeWire && !collabMeshState.isDraggingNode && !collabMeshState.dispatchModal.open && !collabMeshState.nodeFlyout.open) {
            loadCollabMeshData(true);
        }
    }, 4000);
}

function stopCollabLivePolling() {
    if (collabMeshState.pollTimer) {
        clearInterval(collabMeshState.pollTimer);
        collabMeshState.pollTimer = null;
    }
}

async function loadCollabMeshData(silent = false) {
    if (!silent) {
        collabMeshState.loading = true;
    }
    try {
        const res = await api('/api/collab/mesh');
        collabMeshState.gatewayOnline = res.gatewayOnline !== false;

        let peers = (res.peers || []).map(peer => ({ ...peer }));
        let blackboard = (res.blackboard || []).map(entry => ({ ...entry }));
        let supervisorMessages = (res.supervisorMessages || []).map(message => ({
            ...message,
            content: message.content ?? message.message ?? '',
            timestamp: message.timestamp ?? message.createdAt ?? Date.now()
        }));
        let dispatches = (res.dispatches || []).map(dispatch => ({
            ...dispatch,
            createdAt: Number(dispatch.createdAt || Date.now()),
            updatedAt: Number(dispatch.updatedAt || dispatch.createdAt || Date.now())
        }));

        if (collabMeshState.simulationMode) {
            peers = COLLAB_DEMO_PEERS.map(peer => {
                const live = collabMeshState.peers.find(p => collabPeerKey(p) === collabPeerKey(peer));
                return live ? { ...peer, ...live, profile: peer.profile, peerId: peer.peerId } : { ...peer };
            });
            // Keep demo blackboard mutations (e.g. sync chips) instead of resetting every poll
            if (!collabMeshState.blackboard?.length) {
                blackboard = COLLAB_DEMO_BLACKBOARD.map(item => ({ ...item }));
            } else {
                blackboard = collabMeshState.blackboard;
            }
            supervisorMessages = collabMeshState.supervisorMessages;
            dispatches = collabMeshState.dispatches;
            collabMeshState.gatewayOnline = true;
            // Never let live gateway inbox wipe simulated supervisor messages
        }

        collabMeshState.peers = peers;
        collabMeshState.blackboard = blackboard;
        collabMeshState.supervisorMessages = supervisorMessages;
        collabMeshState.supervisorUnread = supervisorMessages.filter(message => !message.readAt).length;
        collabMeshState.dispatches = dispatches;
        collabMeshState.dispatchSummary = res.dispatchSummary || {};
        reconcileCollabDispatches(collabMeshState.dispatches);
        if (!collabPeerByKey(collabMeshState.activeReplyTarget)) {
            collabMeshState.activeReplyTarget = collabMeshState.peers[0] ? collabPeerKey(collabMeshState.peers[0]) : '';
        }
        collabMeshState.lastSyncTime = Date.now();

        reconcileNodePositions();
        syncCollabNodesDom();
        updateCollabWires();
        syncSupervisorPanelDom({ preserveReplyDraft: true });
        if (!collabMeshState.hasInitialFit && $('collabMeshDialog')?.open) {
            requestAnimationFrame(() => fitCollabMeshView(true));
            collabMeshState.hasInitialFit = true;
        }
    } catch (err) {
        if (collabMeshState.simulationMode) {
            if (!collabMeshState.peers.length) {
                collabMeshState.peers = COLLAB_DEMO_PEERS.map(peer => ({ ...peer }));
            }
            if (!collabMeshState.blackboard.length) {
                collabMeshState.blackboard = COLLAB_DEMO_BLACKBOARD.map(item => ({ ...item }));
            }
            collabMeshState.gatewayOnline = true;
            reconcileNodePositions();
            syncCollabNodesDom();
            updateCollabWires();
            syncSupervisorPanelDom({ preserveReplyDraft: true });
        } else {
            collabMeshState.gatewayOnline = false;
            syncCollabNodesDom();
            updateCollabWires();
        }
    } finally {
        collabMeshState.loading = false;
    }
}

function fitCollabMeshView(instant = false) {
    const fit = computeFitViewParams();
    if (instant) {
        collabMeshState.panX = fit.panX;
        collabMeshState.panY = fit.panY;
        collabMeshState.zoom = fit.zoom;
        applyCollabCameraTransform();
        return;
    }
    animateViewportCamera(fit.panX, fit.panY, fit.zoom, 320);
}

function computeAutoLayout() {
    collabMeshState.nodePositions = {};
    collabMeshState.hubPosition = { x: 60, y: 40 };
    collabMeshState.hubPositionManual = false;
    reconcileNodePositions();
    syncCollabNodesDom();
    updateCollabWires();
    fitCollabMeshView(false);
    toast('已自动排布节点布局');
}

function reconcileNodePositions() {
    if (!collabMeshState.nodePositions) collabMeshState.nodePositions = {};

    const viewportWidth = $('collabCanvasViewport')?.clientWidth || window.innerWidth || 900;
    const layoutMode = viewportWidth <= 600 ? 'compact' : 'wide';
    if (collabMeshState.layoutMode && collabMeshState.layoutMode !== layoutMode) {
        collabMeshState.nodePositions = {};
        collabMeshState.hubPositionManual = false;
    }
    collabMeshState.layoutMode = layoutMode;

    if (layoutMode === 'compact') {
        if (!collabMeshState.hubPositionManual) {
            collabMeshState.hubPosition = { x: 130, y: 28 };
        }

        if (!collabMeshState.nodePositions['__blackboard__']) {
            collabMeshState.nodePositions['__blackboard__'] = { x: 24, y: 172 };
        }

        if (!collabMeshState.peers.length) {
            if (!collabMeshState.nodePositions['__onboarding__']) {
                collabMeshState.nodePositions['__onboarding__'] = { x: 111, y: 324 };
            }
            return;
        }

        collabMeshState.peers.forEach((peer, index) => {
            const peerKey = collabPeerKey(peer);
            if (!collabMeshState.nodePositions[peerKey]) {
                collabMeshState.nodePositions[peerKey] = { x: 111, y: 324 + index * 196 };
            }
        });
        return;
    }

    if (!collabMeshState.hubPositionManual) {
        collabMeshState.hubPosition = { x: 60, y: 40 };
    }

    if (!collabMeshState.nodePositions['__blackboard__']) {
        collabMeshState.nodePositions['__blackboard__'] = { x: 380, y: 40 };
    }

    const peers = collabMeshState.peers;
    if (!peers.length) {
        if (!collabMeshState.nodePositions['__onboarding__']) {
            collabMeshState.nodePositions['__onboarding__'] = { x: 380, y: 230 };
        }
        return;
    }

    const startY = 230;
    const cardWidth = 290;
    const cardHeight = 210;
    const gapX = 36;
    const gapY = 32;
    const cols = Math.max(1, Math.min(3, peers.length));

    peers.forEach((peer, index) => {
        const peerKey = collabPeerKey(peer);
        if (!collabMeshState.nodePositions[peerKey]) {
            const col = index % cols;
            const row = Math.floor(index / cols);
            const posX = 60 + col * (cardWidth + gapX);
            const posY = startY + row * (cardHeight + gapY);
            collabMeshState.nodePositions[peerKey] = { x: posX, y: posY };
        }
    });
}

function computeFitViewParams() {
    const viewport = $('collabCanvasViewport');
    if (!viewport) return { panX: 0, panY: 0, zoom: 1.0 };
    const vpW = viewport.clientWidth || 900;
    const vpH = viewport.clientHeight || 600;
    const compactLayout = vpW <= 600;

    const nodeEls = Array.from(document.querySelectorAll('.collab-node'));
    if (!nodeEls.length) return { panX: 0, panY: 0, zoom: 1.0 };

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodeEls.forEach(el => {
        const id = el.dataset.nodeId;
        const pos = id === '__hub__' ? collabMeshState.hubPosition : collabMeshState.nodePositions[id];
        if (pos) {
            const w = el.offsetWidth || (id === '__hub__' ? 240 : 290);
            const h = el.offsetHeight || (id === '__hub__' ? 76 : 210);
            minX = Math.min(minX, pos.x);
            minY = Math.min(minY, pos.y);
            maxX = Math.max(maxX, pos.x + w);
            maxY = Math.max(maxY, pos.y + h);
        }
    });

    if (!isFinite(minX)) return { panX: 0, panY: 0, zoom: 1.0 };

    const dockEl = $('collabTaskDock');
    const dockHeight = dockEl ? (dockEl.offsetHeight + 18) : 96;
    const topInset = compactLayout ? 24 : 36;
    const bottomInset = dockHeight + 20;
    const leftInset = compactLayout ? 18 : 48;
    const rightInset = compactLayout ? 18 : (collabMeshState.supervisorPanelOpen ? 404 : 48);

    const availW = Math.max(320, vpW - leftInset - rightInset);
    const availH = Math.max(260, vpH - topInset - bottomInset);

    const contentW = maxX - minX;
    const contentH = maxY - minY;

    const zoomX = availW / (contentW + 40);
    const zoomY = availH / (contentH + 30);
    const minimumZoom = compactLayout ? 0.62 : 0.38;
    const targetZoom = Math.min(1.15, Math.max(minimumZoom, Math.min(zoomX, zoomY)));

    const contentCenterX = (minX + maxX) / 2;
    const contentCenterY = (minY + maxY) / 2;

    const safeCenterX = leftInset + availW / 2;
    const safeCenterY = topInset + availH / 2;

    const targetPanX = safeCenterX - contentCenterX * targetZoom;
    const targetPanY = safeCenterY - contentCenterY * targetZoom;

    return { panX: targetPanX, panY: targetPanY, zoom: targetZoom };
}

function getNodePortCoords(nodeId, portType = 'output') {
    const nodeEl = document.getElementById(`collab-node-${nodeId}`);
    const fallbackPos = nodeId === '__hub__'
        ? (collabMeshState.hubPosition || { x: 0, y: 0 })
        : (collabMeshState.nodePositions[nodeId] || { x: 0, y: 0 });
    const nodeWidth = nodeEl?.offsetWidth || (nodeId === '__blackboard__' ? 460 : (nodeId === '__hub__' ? 248 : 286));
    const nodeHeight = nodeEl?.offsetHeight || (nodeId === '__blackboard__' ? 140 : (nodeId === '__hub__' ? 84 : 210));
    const posX = nodeEl ? nodeEl.offsetLeft : fallbackPos.x;
    const posY = nodeEl ? nodeEl.offsetTop : fallbackPos.y;

    // Prefer measuring the actual port handle so wires dock to the visible ring/handle.
    // Use getBoundingClientRect deltas (÷ zoom) because ports use CSS transforms.
    if (nodeEl) {
        let portEl = null;
        if (portType === 'output') {
            portEl = nodeEl.querySelector('.collab-port.port-output');
        } else if (portType === 'input') {
            portEl = nodeEl.querySelector('.collab-port.port-input');
        } else if (portType === 'top') {
            portEl = nodeEl.querySelector('.collab-port.port-top');
        } else if (portType === 'bottom') {
            portEl = nodeEl.querySelector('.collab-port.port-bottom');
        }

        const handle = portEl?.querySelector('.port-handle, .port-ring') || portEl;
        if (handle) {
            const nodeRect = nodeEl.getBoundingClientRect();
            const handleRect = handle.getBoundingClientRect();
            const scale = collabMeshState.zoom || 1;
            return {
                x: posX + (handleRect.left - nodeRect.left + handleRect.width / 2) / scale,
                y: posY + (handleRect.top - nodeRect.top + handleRect.height / 2) / scale
            };
        }
    }

    if (portType === 'top') {
        return { x: posX + nodeWidth / 2, y: posY };
    }
    if (portType === 'bottom') {
        return { x: posX + nodeWidth / 2, y: posY + nodeHeight };
    }
    if (portType === 'output') {
        return { x: posX + nodeWidth, y: posY + nodeHeight / 2 };
    }
    return { x: posX, y: posY + nodeHeight / 2 };
}

function clientToCanvasWorld(clientX, clientY) {
    const viewport = $('collabCanvasViewport');
    if (!viewport) return { x: 0, y: 0 };
    const rect = viewport.getBoundingClientRect();
    return {
        x: (clientX - rect.left - collabMeshState.panX) / collabMeshState.zoom,
        y: (clientY - rect.top - collabMeshState.panY) / collabMeshState.zoom
    };
}

function findDropTargetAtWorldPoint(worldX, worldY, excludeId = null) {
    let hovered = null;
    document.querySelectorAll('.collab-node.agent-node').forEach(nodeEl => {
        const profile = nodeEl.dataset.nodeId;
        if (!profile || profile === excludeId) {
            nodeEl.classList.remove('drop-target');
            return;
        }
        const pos = collabMeshState.nodePositions[profile] || {
            x: nodeEl.offsetLeft,
            y: nodeEl.offsetTop
        };
        const w = nodeEl.offsetWidth || 286;
        const h = nodeEl.offsetHeight || 210;
        const hit = worldX >= pos.x - 18 && worldX <= pos.x + w + 18
            && worldY >= pos.y - 18 && worldY <= pos.y + h + 18;
        nodeEl.classList.toggle('drop-target', hit);
        if (hit) hovered = profile;
    });
    return hovered;
}

function renderTaskCapsulesHtml(options = {}) {
    const {
        selectedId = '',
        interactive = true,
        forModal = false
    } = options;
    return COLLAB_TASK_PRESETS.map(preset => {
        const activeClass = selectedId === preset.id ? ' is-active' : '';
        const dragAttr = interactive && !forModal && !preset.custom ? ' draggable="true"' : '';
        const customClass = preset.custom ? ' custom-capsule' : '';
        const modalClass = forModal ? ' modal-capsule' : '';
        const title = preset.custom
            ? '打开自定义指令'
            : (forModal ? `切换到「${preset.label}」模板` : '拖到 Agent 节点立即派发；点击打开派发弹窗');
        return `
            <button class="task-capsule-item${customClass}${modalClass}${activeClass}" type="button"
                data-task-preset-id="${escapeHtml(preset.id)}"
                data-task-preset="${escapeHtml(preset.prompt)}"
                ${dragAttr}
                title="${escapeHtml(title)}">
                <span class="capsule-icon">${preset.icon}</span>
                <span class="capsule-label">${escapeHtml(preset.label)}</span>
            </button>
        `;
    }).join('');
}

function applyCollabCameraTransform() {
    const container = $('collabTransformLayer');
    if (container) {
        container.style.transform = `translate3d(${collabMeshState.panX}px, ${collabMeshState.panY}px, 0) scale(${collabMeshState.zoom})`;
    }
    const indicator = $('collabZoomIndicator');
    if (indicator) {
        indicator.textContent = `${Math.round(collabMeshState.zoom * 100)}%`;
    }
}

let cameraAnimationId = null;
function animateViewportCamera(targetPanX, targetPanY, targetZoom, duration = 300) {
    if (cameraAnimationId) {
        cancelAnimationFrame(cameraAnimationId);
        cameraAnimationId = null;
    }

    const startPanX = collabMeshState.panX;
    const startPanY = collabMeshState.panY;
    const startZoom = collabMeshState.zoom;
    const startTime = performance.now();

    function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        const ease = 1 - Math.pow(1 - progress, 3); // Cubic ease out

        collabMeshState.panX = startPanX + (targetPanX - startPanX) * ease;
        collabMeshState.panY = startPanY + (targetPanY - startPanY) * ease;
        collabMeshState.zoom = startZoom + (targetZoom - startZoom) * ease;

        applyCollabCameraTransform();

        if (progress < 1) {
            cameraAnimationId = requestAnimationFrame(step);
        } else {
            cameraAnimationId = null;
        }
    }

    cameraAnimationId = requestAnimationFrame(step);
}

function stopCollabCameraAnimation() {
    if (cameraAnimationId) {
        cancelAnimationFrame(cameraAnimationId);
        cameraAnimationId = null;
    }
}

function renderCollabMeshPanel() {
    const dialog = $('collabMeshDialog');
    if (!dialog) return;

    dialog.innerHTML = `
        <div class="collab-studio-container" id="collabStudioContainer">
            <!-- Studio Header -->
            <header class="collab-studio-header">
                <div class="collab-header-left">
                    <span class="collab-studio-badge">
                        <span class="pulse-dot"></span>
                        <strong>AGENT OPERATIONS</strong>
                    </span>
                    <span class="collab-network-summary" id="collabNetworkSummary">
                        ${collabNetworkSummaryText()}
                    </span>
                </div>
                <div class="collab-header-right">
                    <div class="collab-tool-group">
                        <button class="collab-tool-btn" id="collabToggleBlackboardBtn" type="button" title="查看共享黑板">
                            ${iconSvg('database')}<span>共享黑板 (${collabMeshState.blackboard.length})</span>
                        </button>
                        <button class="collab-tool-btn ${collabMeshState.supervisorPanelOpen ? 'active' : ''}" id="collabToggleSupervisorBtn" type="button" title="监管收件箱">
                            ${iconSvg('activity')}<span>监管消息 (${collabMeshState.supervisorUnread})</span>
                        </button>
                    </div>
                    <span class="collab-tool-divider"></span>
                    <div class="collab-tool-group">
                        <button class="collab-tool-btn" id="collabAutoLayoutBtn" type="button" title="自动排布节点并居中">
                            ${iconSvg('zap')}<span>自动排布</span>
                        </button>
                        <button class="collab-tool-btn" id="collabToggleDemoBtn" type="button" title="切换模拟演示数据">
                            ${iconSvg('sparkles')}<span>${collabMeshState.simulationMode ? '退出演示' : '演示模式'}</span>
                        </button>
                    </div>
                    <span class="collab-tool-divider"></span>
                    <div class="collab-tool-group">
                        <button class="collab-tool-btn" id="collabRefreshBtn" type="button" title="刷新拓扑状态">${iconSvg('refresh')}</button>
                        <button class="collab-tool-btn" id="collabToggleFullscreenBtn" type="button" title="全屏最大化">${iconSvg('maximize')}</button>
                        <button class="collab-tool-btn close-btn" id="collabCloseBtn" type="button" title="关闭画布 (ESC)">${iconSvg('x')}</button>
                    </div>
                </div>
            </header>

            <!-- Main Canvas Viewport -->
            <div class="collab-studio-viewport ${collabMeshState.supervisorPanelOpen ? 'has-supervisor-panel' : ''}" id="collabCanvasViewport">
                <div class="collab-canvas-grid-bg" aria-hidden="true"></div>
                <div class="collab-transform-layer" id="collabTransformLayer">
                    <!-- SVG Wire Layer -->
                    <svg class="collab-wires-svg" id="collabWiresSvg">
                        <defs>
                            <linearGradient id="wireGradientHub" x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" stop-color="var(--accent)" />
                                <stop offset="100%" stop-color="var(--ink)" />
                            </linearGradient>
                            <linearGradient id="wireGradientBusy" x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" stop-color="var(--blue)" />
                                <stop offset="100%" stop-color="var(--green)" />
                            </linearGradient>
                        </defs>
                        <g id="collabWiresGroup"></g>
                        <g id="collabActiveWireGroup"></g>
                        <g id="collabTransmissionsGroup"></g>
                    </svg>

                    <!-- Dynamic Node Layer -->
                    <div class="collab-nodes-container" id="collabNodesContainer">
                        ${renderCollabNodesHtml()}
                    </div>

                    <!-- Target-Attached Flyout Popover -->
                    <div id="collabNodeFlyoutHost">
                        ${renderCollabNodeFlyoutHtml()}
                    </div>
                </div>

                <!-- Floating Canvas Zoom HUD -->
                <div class="collab-zoom-hud">
                    <button class="collab-hud-btn" id="collabZoomInBtn" type="button" title="放大画布 (Ctrl +)">+</button>
                    <span class="collab-zoom-indicator" id="collabZoomIndicator">100%</span>
                    <button class="collab-hud-btn" id="collabZoomOutBtn" type="button" title="缩小画布 (Ctrl -)">−</button>
                    <button class="collab-hud-btn" id="collabResetViewBtn" type="button" title="重置视角 (1:1)">${iconSvg('maximize')}</button>
                    <button class="collab-hud-btn collab-hud-fit-btn" id="collabFitViewBtn" type="button" title="自适应居中">1:1</button>
                </div>

                <!-- Draggable Task Capsule Dock -->
                <div class="collab-task-dock" id="collabTaskDock">
                    <div class="task-dock-title">
                        <span class="pulse-dot"></span>
                        <span>监管任务模板</span>
                    </div>
                    <div class="task-capsules-row" id="collabTaskCapsulesRow">
                        ${renderTaskCapsulesHtml()}
                    </div>
                </div>

                <!-- Unified Side Drawer -->
                <aside class="collab-supervisor-panel ${collabMeshState.supervisorPanelOpen ? 'open' : ''}" id="collabSupervisorPanel">
                    <div class="supervisor-panel-header">
                        <div class="supervisor-panel-title-area">
                            <span class="eyebrow">AGENT OPS STUDIO</span>
                            <h3>${collabMeshState.supervisorTab === 'blackboard' ? 'Agent CLI 共享黑板' : (collabMeshState.supervisorTab === 'activity' ? '协同调度动态' : '监管收件箱')}</h3>
                        </div>
                        <button class="collab-tool-btn close-btn" id="collabCloseSupervisorBtn" type="button" title="收起面板">${iconSvg('x')}</button>
                    </div>
                    <div class="supervisor-tabs">
                        <button class="supervisor-tab ${collabMeshState.supervisorTab === 'inbox' ? 'active' : ''}" data-supervisor-tab="inbox" type="button">
                            ${iconSvg('activity')}<span>监管消息 (${collabMeshState.supervisorUnread})</span>
                        </button>
                        <button class="supervisor-tab ${collabMeshState.supervisorTab === 'blackboard' ? 'active' : ''}" data-supervisor-tab="blackboard" type="button">
                            ${iconSvg('database')}<span>共享黑板 (${collabMeshState.blackboard.length})</span>
                        </button>
                        <button class="supervisor-tab ${collabMeshState.supervisorTab === 'activity' ? 'active' : ''}" data-supervisor-tab="activity" type="button">
                            <span>调度动态</span>
                        </button>
                    </div>
                    <div class="supervisor-panel-body" id="collabSupervisorPanelBody">
                        ${renderSupervisorDrawerContentHtml()}
                    </div>
                    ${collabMeshState.supervisorTab === 'inbox' ? renderSupervisorReplyDockHtml() : ''}
                </aside>
            </div>

            <!-- Global Broadcast & Batch Dispatch Modal -->
            <dialog class="collab-dispatch-modal" id="collabBroadcastDispatchModal">
                <div class="dispatch-modal-card">
                    <div class="dispatch-modal-header">
                        <div class="modal-title-wrap">
                            <span class="modal-eyebrow">BROADCAST MISSION</span>
                            <h3>向协同网络派发任务</h3>
                        </div>
                        <button class="collab-tool-btn close-btn" id="collabCloseBroadcastModalBtn" type="button">${iconSvg('x')}</button>
                    </div>
                    <div class="dispatch-modal-body">
                        <div class="task-preset-box">
                            <label class="section-label">任务模板：</label>
                            <div class="task-capsules-row modal-presets-row" id="collabModalTaskPresets"></div>
                        </div>
                        <div class="target-selection-box">
                            <label class="section-label">选择接收任务的 Agent：</label>
                            <div class="target-chips-container" id="collabModalTargetChips"></div>
                        </div>
                        <div class="task-input-box">
                            <label class="section-label" for="collabModalTaskInput">任务描述 / 监管指令：</label>
                            <textarea class="task-textarea" id="collabModalTaskInput" rows="3" placeholder="输入要派发的协同任务描述..."></textarea>
                        </div>
                    </div>
                    <div class="dispatch-modal-footer">
                        <button class="ghost btn-sm" id="collabDismissDispatchBtn" type="button">取消</button>
                        <button class="primary btn-sm" id="collabSubmitDispatchBtn" type="button">
                            ${iconSvg('send')}<span>立即广播派发</span>
                        </button>
                    </div>
                </div>
            </dialog>
        </div>
    `;

    bindCollabMeshEvents();
    bindNodeElementEvents();
    bindSupervisorPanelEvents();
    bindBlackboardPreviewClicks();
}

function renderCollabNodesHtml() {
    let html = '';
    const hubPos = collabMeshState.hubPosition || { x: 60, y: 40 };

    // 1. Web UI Supervisor Desk Node (Top-Left Tier 1)
    const hubOnline = collabMeshState.gatewayOnline || collabMeshState.simulationMode;
    html += `
        <div class="collab-node hub-node ${hubOnline ? 'online' : 'offline'}" id="collab-node-__hub__" data-node-id="__hub__" style="left: ${hubPos.x}px; top: ${hubPos.y}px;">
            <div class="collab-node-inner hub-inner">
                <div class="node-avatar hub-avatar">
                    ${iconSvg('shield')}
                </div>
                <div class="node-identity">
                    <div class="node-name-row">
                        <strong class="node-profile-name">Web UI 监管台</strong>
                    </div>
                    <div class="node-desc-row">
                        <span class="hub-status-text">Gateway 通讯层 · ${hubOnline ? '已联通' : '离线'}</span>
                    </div>
                </div>
            </div>
            <div class="collab-port port-output" data-port-source="__hub__" title="从监管台发起广播/指派">
                <span class="port-handle"></span>
                <span class="port-label">发起任务</span>
            </div>
            <div class="collab-port port-bottom" data-port-source="__hub__" title="下发监管任务指令">
                <span class="port-ring"></span>
            </div>
        </div>
    `;

    // 2. Shared Blackboard Canvas Node (Top-Right Tier 1)
    const bbPos = collabMeshState.nodePositions['__blackboard__'] || { x: 380, y: 40 };
    const bb = collabMeshState.blackboard || [];
    html += `
        <div class="collab-node blackboard-node" id="collab-node-__blackboard__" data-node-id="__blackboard__" style="left: ${bbPos.x}px; top: ${bbPos.y}px;">
            <div class="collab-port port-input" data-port-target="__blackboard__" title="写入共享黑板">
                <span class="port-ring"></span>
            </div>
            <div class="blackboard-node-inner">
                <div class="blackboard-node-header">
                    <div class="blackboard-node-title">
                        <span class="blackboard-icon-wrap">${iconSvg('database')}</span>
                        <strong>Agent CLI 共享黑板</strong>
                        <span class="blackboard-node-count-chip">${bb.length} 条共享上下文</span>
                    </div>
                    <div class="blackboard-node-actions">
                        <button class="blackboard-node-action-btn blackboard-node-write-btn" id="collabCanvasWriteBbBtn" type="button" title="写入共享黑板" aria-label="写入共享黑板">
                            ${iconSvg('plus')}
                        </button>
                        <button class="blackboard-node-action-btn" id="collabCanvasViewBbBtn" type="button" title="在侧边栏查看完整黑板">
                            <span>查看全貌 →</span>
                        </button>
                    </div>
                </div>
                <div class="blackboard-items-preview">
                    ${bb.length === 0 ? `
                        <div class="bb-empty-hint">暂无黑板共享记录，Agent 协同产出将同步在此</div>
                    ` : bb.slice(0, 3).map(item => `
                        <div class="blackboard-preview-card" data-bb-key="${escapeHtml(item.key)}" title="${escapeHtml(item.value || '')}">
                            <div class="bb-preview-head">
                                <span class="bb-preview-key">${escapeHtml(item.key)}</span>
                                <span class="bb-preview-author">@${escapeHtml(item.author || 'system')}</span>
                            </div>
                            <div class="bb-preview-text">${escapeHtml(item.value || '')}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
            <div class="collab-port port-bottom" data-port-target="__blackboard__" title="Agent 共享记忆汇聚端口">
                <span class="port-ring"></span>
            </div>
        </div>
    `;

    // 3. Agent CLI Nodes (Tier 2 Bottom Row)
    if (!collabMeshState.peers.length) {
        const onbPos = collabMeshState.nodePositions['__onboarding__'] || { x: 380, y: 230 };
        html += `
            <div class="collab-node onboarding-node" id="collab-node-onboarding" data-node-id="__onboarding__" style="left: ${onbPos.x}px; top: ${onbPos.y}px;">
                <div class="collab-node-inner onboarding-inner">
                    <div class="onboarding-icon">${iconSvg('terminal')}</div>
                    <h4 class="onboarding-title">暂无在线 Agent CLI</h4>
                    <p class="onboarding-desc">在终端启动 Claude Code 会话即可自动接入协同网络：</p>
                    <code class="onboarding-cmd">ccp start &lt;profile-name&gt;</code>
                    <button class="onboarding-demo-btn" id="collabLaunchDemoPromptBtn" type="button">
                        ${iconSvg('sparkles')}<span>启动演示拓扑网络</span>
                    </button>
                </div>
            </div>
        `;
        return html;
    }

    collabMeshState.peers.forEach(peer => {
        const peerKey = collabPeerKey(peer);
        const pos = collabMeshState.nodePositions[peerKey] || { x: 60, y: 230 };
        const glyph = (peer.profile.charAt(0) || 'A').toUpperCase();
        const activeFiles = peer.activeFiles || [];
        const isActiveTarget = collabMeshState.nodeFlyout.open && collabMeshState.nodeFlyout.targetProfile === peerKey;
        const activeDispatch = latestCollabDispatchForPeer(peer);
        const lifecycleState = activeDispatch ? collabDispatchVisualState(activeDispatch) : (peer.responseState || peer.status || 'idle');
        const nodeState = lifecycleState === 'idle' ? (peer.status || 'idle') : lifecycleState;
        const statusLabel = activeDispatch
            ? collabDispatchBadgeText(activeDispatch)
            : (peer.status === 'busy' ? '处理中' : (peer.status === 'waiting' ? '等待中' : '在线'));
        const focusLabel = activeDispatch ? '协作状态' : '工作焦点';
        const focusContent = activeDispatch ? collabDispatchStatusText(activeDispatch) : (peer.currentFocus || '空闲等待协作任务');

        html += `
            <div class="collab-node agent-node ${escapeHtml(nodeState)} ${isActiveTarget ? 'is-active-target' : ''}" id="collab-node-${escapeHtml(peerKey)}" data-node-id="${escapeHtml(peerKey)}" data-collab-state="${escapeHtml(nodeState)}" style="left: ${pos.x}px; top: ${pos.y}px;">
                <div class="collab-port port-input" data-port-target="${escapeHtml(peerKey)}" title="任务接入端口">
                    <span class="port-ring"></span>
                </div>
                <div class="collab-port port-top" data-port-target="${escapeHtml(peerKey)}" title="监管下发 / 记忆同步">
                    <span class="port-ring"></span>
                </div>

                <div class="collab-node-inner">
                    <div class="node-header">
                        <div class="node-avatar ${escapeHtml(nodeState)}">
                            <span class="avatar-glyph">${glyph}</span>
                        </div>
                        <div class="node-identity">
                            <div class="node-name-row">
                                <strong class="node-profile-name" title="@${escapeHtml(peer.profile)}">@${escapeHtml(peer.profile)}</strong>
                                <span class="node-status-badge ${escapeHtml(nodeState)}">
                                    <span class="status-dot-indicator"></span>
                                    <span>${statusLabel}</span>
                                </span>
                            </div>
                            <div class="node-model-row">
                                <span class="node-model-chip" title="模型: ${escapeHtml(peer.model || 'default')}">${escapeHtml(peer.model || 'default')}</span>
                                <span class="node-model-chip" title="CLI 实例: ${escapeHtml(peer.peerId || peerKey)}">${escapeHtml(peer.peerId || peerKey)}</span>
                                ${peer.pid ? `<span class="node-pid-chip">PID:${peer.pid}</span>` : ''}
                            </div>
                        </div>
                    </div>

                    <div class="node-body">
                        <div class="node-focus-box">
                            <div class="focus-label">${iconSvg('target')}<span>${focusLabel}</span></div>
                            <div class="focus-content" title="${escapeHtml(activeDispatch?.error || peer.currentFocus || statusLabel)}">
                                ${escapeHtml(focusContent)}
                            </div>
                        </div>

                        ${activeFiles.length > 0 ? `
                            <div class="node-files-box">
                                <div class="files-label">活跃文件:</div>
                                <div class="node-file-chips">
                                    ${activeFiles.slice(0, 2).map(f => {
                                        const fname = f.split('/').pop().split('\\').pop();
                                        return `<span class="file-chip" title="${escapeHtml(f)}">${iconSvg('fileText')} ${escapeHtml(fname)}</span>`;
                                    }).join('')}
                                    ${activeFiles.length > 2 ? `<span class="file-chip more">+${activeFiles.length - 2}</span>` : ''}
                                </div>
                            </div>
                        ` : ''}
                    </div>

                    <div class="node-footer">
                        <button class="node-action-btn primary-action" type="button" data-action="dispatch-to" data-peer-key="${escapeHtml(peerKey)}">
                            ${iconSvg('zap')}<span>指派任务</span>
                        </button>
                        <button class="node-action-btn ghost-action" type="button" data-action="ask-peer" data-peer-key="${escapeHtml(peerKey)}" title="向 @${escapeHtml(peer.profile)} 快速提问">
                            ${iconSvg('messageSquare')}<span>提问</span>
                        </button>
                    </div>
                </div>

                <div class="collab-port port-output" data-port-source="${escapeHtml(peerKey)}" title="从 @${escapeHtml(peer.profile)} 发起 Agent 协作">
                    <span class="port-handle"></span>
                    <span class="port-label">发起协作</span>
                </div>
            </div>
        `;
    });

    return html;
}

function renderCollabNodeFlyoutHtml() {
    const flyout = collabMeshState.nodeFlyout;
    if (!flyout.open || !flyout.targetProfile) return '';

    const targetKey = flyout.targetProfile;
    const pos = collabMeshState.nodePositions[targetKey] || { x: 500, y: 160 };
    const flyoutLeft = targetKey === '__blackboard__' ? pos.x + 52 : pos.x + 304;
    const flyoutTop = targetKey === '__blackboard__' ? pos.y + 150 : Math.max(10, pos.y - 10);
    const sourceKey = flyout.sourceProfile;
    const sourcePeer = collabPeerByKey(sourceKey);

    if (targetKey === '__blackboard__') {
        return `
            <div class="collab-node-flyout" id="collabNodeFlyout" style="left: ${flyoutLeft}px; top: ${flyoutTop}px;">
                <div class="flyout-header">
                    <div class="flyout-target-badge">
                        <span class="flyout-avatar">${iconSvg('database')}</span>
                        <div class="flyout-target-meta">
                            <strong>写入 Agent CLI 共享黑板</strong>
                            <span class="flyout-sub">${sourcePeer ? `来源 @${escapeHtml(sourcePeer.profile)}` : '来源 Web UI 监管台'}</span>
                        </div>
                    </div>
                    <button class="collab-tool-btn close-btn" id="collabCloseFlyoutBtn" type="button" title="关闭">${iconSvg('x')}</button>
                </div>
                <div class="flyout-body">
                    <label class="flyout-field-label" for="collabBlackboardKeyInput">键</label>
                    <input class="flyout-input" id="collabBlackboardKeyInput" value="${escapeHtml(flyout.blackboardKey || '')}" placeholder="例如 release:plan" />
                    <label class="flyout-field-label" for="collabBlackboardValueInput">内容</label>
                    <textarea class="flyout-textarea" id="collabBlackboardValueInput" placeholder="输入要共享给 Agent CLI 网络的上下文..." rows="4">${escapeHtml(flyout.message || '')}</textarea>
                </div>
                <div class="flyout-footer">
                    <button class="ghost btn-sm" id="collabDismissFlyoutBtn" type="button">取消</button>
                    <button class="primary btn-sm" id="collabSubmitBlackboardBtn" type="button">
                        ${iconSvg('database')}<span>写入黑板</span>
                    </button>
                </div>
            </div>
        `;
    }

    const peer = collabPeerByKey(targetKey);
    if (!peer) return '';
    const targetGlyph = (peer.profile.charAt(0) || 'A').toUpperCase();
    const isPeerToPeer = Boolean(sourcePeer && sourceKey !== targetKey);
    const sourceGlyph = isPeerToPeer ? (sourcePeer.profile.charAt(0) || 'S').toUpperCase() : '';

    return `
        <div class="collab-node-flyout" id="collabNodeFlyout" style="left: ${flyoutLeft}px; top: ${flyoutTop}px;">
            <div class="flyout-header">
                <div class="flyout-target-badge">
                    ${isPeerToPeer ? `
                        <span class="flyout-avatar source">${sourceGlyph}</span>
                        <span class="flyout-arrow">→</span>
                    ` : ''}
                    <span class="flyout-avatar">${targetGlyph}</span>
                    <div class="flyout-target-meta">
                        <strong>${isPeerToPeer ? `@${escapeHtml(sourcePeer.profile)} → @${escapeHtml(peer.profile)}` : `@${escapeHtml(peer.profile)}`}</strong>
                        <span class="flyout-sub">${isPeerToPeer ? `Peer-to-Peer 协作 · ${escapeHtml(peer.peerId || '')}` : `${flyout.isAsk ? '提问咨询' : '协同任务派发'} · ${escapeHtml(peer.peerId || '')}`}</span>
                    </div>
                </div>
                <button class="collab-tool-btn close-btn" id="collabCloseFlyoutBtn" type="button" title="关闭">${iconSvg('x')}</button>
            </div>
            <div class="flyout-body">
                <div class="flyout-prompt-chips">
                    <button class="flyout-chip" type="button" data-prompt="请协助完成当前任务模块并同步上下文：">⚡ 协同开发</button>
                    <button class="flyout-chip" type="button" data-prompt="请根据当前架构方案提供评审意见：">🔍 架构评审</button>
                    <button class="flyout-chip" type="button" data-prompt="请为此功能模块补充自动化单测：">🧪 补充单测</button>
                </div>
                <textarea class="flyout-textarea" id="collabFlyoutTaskInput" placeholder="输入要派发的协同指令..." rows="3">${escapeHtml(flyout.message || '')}</textarea>
            </div>
            <div class="flyout-footer">
                <button class="ghost btn-sm" id="collabDismissFlyoutBtn" type="button">取消</button>
                <button class="primary btn-sm" id="collabSubmitFlyoutBtn" type="button">
                    ${iconSvg('send')}<span>${flyout.isAsk ? '发送提问' : '确认派发'}</span>
                </button>
            </div>
        </div>
    `;
}

function renderCollabBlackboardItemsHtml() {
    let items = collabMeshState.blackboard || [];
    if (collabMeshState.blackboardFilter) {
        const q = collabMeshState.blackboardFilter.toLowerCase();
        items = items.filter(it => (it.key || '').toLowerCase().includes(q) || (it.value || '').toLowerCase().includes(q) || (it.author || '').toLowerCase().includes(q));
    }
    if (!items.length) {
        return `<div class="collab-empty-state">暂无符合条件的共享上下文记录</div>`;
    }
    return items.map(item => `
        <div class="collab-bb-item" data-bb-key="${escapeHtml(item.key)}">
            <div class="bb-item-header">
                <strong class="bb-key">${escapeHtml(item.key)}</strong>
                <span class="bb-author">@${escapeHtml(item.author || 'system')}</span>
            </div>
            <div class="bb-value">${escapeHtml(item.value || '')}</div>
            <div class="bb-footer">
                <button class="ghost btn-xs copy-bb-btn" type="button" data-copy-val="${escapeHtml(item.value || '')}">复制内容</button>
            </div>
        </div>
    `).join('');
}

function renderSupervisorMessagesHtml() {
    const messages = collabMeshState.supervisorMessages || [];
    if (!messages.length) {
        return `<div class="collab-empty-state">暂无监管回报消息</div>`;
    }
    return messages.map(msg => {
        const isUnread = !msg.readAt;
        const kind = msg.kind || 'result';
        return `
            <div class="supervisor-message kind-${kind} ${isUnread ? 'is-unread' : 'is-read'}" data-supervisor-message-id="${escapeHtml(msg.id)}">
                <div class="supervisor-msg-head">
                    <span class="msg-author">@${escapeHtml(msg.from || 'agent')}</span>
                    ${isUnread ? '<span class="supervisor-unread-badge">NEW</span>' : ''}
                    ${msg.late ? '<span class="supervisor-unread-badge is-late">迟到回复</span>' : ''}
                    <span class="msg-time">${new Date(msg.timestamp || Date.now()).toLocaleTimeString()}</span>
                </div>
                <h4>${escapeHtml(msg.title || '任务回报')}</h4>
                <p>${escapeHtml(msg.content || '')}</p>
                <div class="msg-footer">
                    ${isUnread ? `<button class="ghost btn-xs supervisor-mark-read-btn" type="button" data-supervisor-message-id="${escapeHtml(msg.id)}">标记已读</button>` : ''}
                    <button class="ghost btn-xs supervisor-continue-btn" type="button" data-supervisor-agent="${escapeHtml(msg.from)}" data-supervisor-peer-id="${escapeHtml(msg.fromPeerId || '')}" data-supervisor-title="${escapeHtml(msg.title || '')}" data-supervisor-message-id="${escapeHtml(msg.id)}">💬 回复</button>
                </div>
            </div>
        `;
    }).join('');
}

function renderCollabActivityLogsHtml() {
    const logs = collabMeshState.activityLogs || [];
    const dispatchRows = (collabMeshState.dispatches || [])
        .slice()
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        .slice(0, 25)
        .map(dispatch => {
            const state = collabDispatchVisualState(dispatch);
            const from = normalizeCollabIdentity(dispatch.from) === 'web-ui' ? '监管台' : `@${dispatch.from}`;
            const route = dispatch.relayTo
                ? `${from} → @${dispatch.to} → @${dispatch.relayTo}`
                : `${from} → @${dispatch.to}`;
            return `
                <div class="collab-act-item state-${escapeHtml(state)}" data-collab-state="${escapeHtml(state)}" title="${escapeHtml(dispatch.error || '')}">
                    <span class="act-time">${new Date(dispatch.updatedAt || dispatch.createdAt || Date.now()).toLocaleTimeString()}</span>
                    <span class="act-text">${escapeHtml(route)} · ${escapeHtml(collabDispatchStatusText(dispatch))}</span>
                </div>
            `;
        }).join('');
    if (!dispatchRows && !logs.length) {
        return `<div class="collab-empty-state">暂无协同动态日志</div>`;
    }
    const localRows = logs.slice(0, 25).map(l => `
        <div class="collab-act-item ${l.state ? `state-${escapeHtml(l.state)}` : ''} ${l.type ? `type-${escapeHtml(l.type)}` : ''}" ${l.state ? `data-collab-state="${escapeHtml(l.state)}"` : ''}>
            <span class="act-time">${escapeHtml(l.time)}</span>
            <span class="act-text">${escapeHtml(l.text)}</span>
        </div>
    `).join('');
    return dispatchRows + localRows;
}

function renderSupervisorDrawerContentHtml() {
    if (collabMeshState.supervisorTab === 'blackboard') {
        return `
            <div class="side-hud-search">
                ${iconSvg('search')}
                <input id="collabBbSearchInput" placeholder="搜索黑板键值或作者..." value="${escapeHtml(collabMeshState.blackboardFilter)}" />
            </div>
            <div class="collab-bb-list" id="collabBbList">
                ${renderCollabBlackboardItemsHtml()}
            </div>
        `;
    }
    if (collabMeshState.supervisorTab === 'activity') {
        return renderCollabActivityLogsHtml();
    }
    return `
        <div class="supervisor-toolbar">
            <span>${collabMeshState.supervisorUnread ? `${collabMeshState.supervisorUnread} 条未读消息` : '全部消息已读'}</span>
            <button class="ghost btn-sm" id="collabMarkSupervisorReadBtn" type="button" ${collabMeshState.supervisorUnread ? '' : 'disabled'}>全部已读</button>
        </div>
        <div class="supervisor-messages-list" id="supervisorMessagesList">
            ${renderSupervisorMessagesHtml()}
        </div>
    `;
}

function renderSupervisorReplyDockHtml() {
    const peers = collabMeshState.peers.length ? collabMeshState.peers : (collabMeshState.simulationMode ? COLLAB_DEMO_PEERS : []);
    const target = collabMeshState.activeReplyTarget || (peers[0] ? collabPeerKey(peers[0]) : '');
    const targetPeer = collabPeerByKey(target) || peers[0];
    const targetProfile = targetPeer?.profile || '';

    return `
        <div class="supervisor-reply-dock" id="supervisorReplyDock">
            <div class="reply-target-row">
                <div class="reply-target-label">
                    <span>回复目标:</span>
                </div>
                <div class="reply-peer-pills" id="collabReplyPeerPills">
                    ${peers.map(p => `
                        <button class="reply-peer-pill ${collabPeerKey(p) === target ? 'active' : ''}" type="button" data-reply-agent="${escapeHtml(collabPeerKey(p))}" title="切换回复至 @${escapeHtml(p.profile)} · ${escapeHtml(p.peerId || '')}">
                            <span class="pill-avatar">${(p.profile.charAt(0) || 'A').toUpperCase()}</span>
                            <span>@${escapeHtml(p.profile)} <small>${escapeHtml(p.peerId || '')}</small></span>
                        </button>
                    `).join('')}
                </div>
            </div>
            <div class="reply-chips-row">
                <button class="reply-prompt-chip" type="button" data-reply-prompt="请汇报当前任务进度与遇到的阻碍：">🔍 追问进度</button>
                <button class="reply-prompt-chip" type="button" data-reply-prompt="请根据审查意见执行针对性修复：">🐛 针对修复</button>
                <button class="reply-prompt-chip" type="button" data-reply-prompt="请为最新代码补充自动化单元测试用例：">🧪 补充单测</button>
                <button class="reply-prompt-chip" type="button" data-reply-prompt="请梳理当前设计方案并同步到共享黑板：">📝 同步黑板</button>
            </div>
            <div class="reply-input-wrap">
                <textarea class="reply-textarea" id="collabReplyInput" placeholder="输入监管回复指令回复 @${escapeHtml(targetProfile)} (Ctrl+Enter 发送)..." rows="2"></textarea>
                <button class="reply-send-btn" id="collabSendReplyBtn" type="button" title="发送监管回复 (Ctrl+Enter)">
                    ${iconSvg('send')}<span>发送</span>
                </button>
            </div>
        </div>
    `;
}

function syncCollabNodesDom() {
    const container = $('collabNodesContainer');
    if (container) {
        container.innerHTML = renderCollabNodesHtml();
    }
    bindNodeElementEvents();
    bindBlackboardPreviewClicks();
    bindTaskCapsuleDragEvents();
    bindOnboardingDemoButton();
}

function syncSupervisorPanelDom(options = {}) {
    const preserveReplyDraft = options.preserveReplyDraft !== false;
    const existingReply = $('collabReplyInput');
    if (existingReply && preserveReplyDraft) {
        collabMeshState.replyDraft = existingReply.value;
    }

    const body = $('collabSupervisorPanelBody');
    if (body) {
        body.innerHTML = renderSupervisorDrawerContentHtml();
    }
    const dockHost = $('supervisorReplyDock');
    if (collabMeshState.supervisorTab === 'inbox') {
        if (!dockHost) {
            $('collabSupervisorPanel')?.insertAdjacentHTML('beforeend', renderSupervisorReplyDockHtml());
        } else {
            dockHost.outerHTML = renderSupervisorReplyDockHtml();
        }
        const restored = $('collabReplyInput');
        if (restored && preserveReplyDraft && collabMeshState.replyDraft) {
            restored.value = collabMeshState.replyDraft;
        }
    } else {
        if (dockHost) dockHost.remove();
    }

    const summary = $('collabNetworkSummary');
    if (summary) {
        summary.textContent = collabNetworkSummaryText();
        summary.title = '当前 Agent CLI 协作网络状态';
    }

    const panelTitle = document.querySelector('#collabSupervisorPanel h3');
    if (panelTitle) {
        panelTitle.textContent = collabMeshState.supervisorTab === 'blackboard'
            ? 'Agent CLI 共享黑板'
            : (collabMeshState.supervisorTab === 'activity' ? '协同调度动态' : '监管收件箱');
    }

    document.querySelectorAll('[data-supervisor-tab]').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.supervisorTab === collabMeshState.supervisorTab);
    });

    const supervisorBtn = $('collabToggleSupervisorBtn');
    if (supervisorBtn) {
        supervisorBtn.classList.toggle('active', collabMeshState.supervisorPanelOpen && collabMeshState.supervisorTab === 'inbox');
        supervisorBtn.innerHTML = `${iconSvg('activity')}<span>监管消息 (${collabMeshState.supervisorUnread})</span>`;
    }

    const blackboardBtn = $('collabToggleBlackboardBtn');
    if (blackboardBtn) {
        blackboardBtn.classList.toggle('active', collabMeshState.supervisorPanelOpen && collabMeshState.supervisorTab === 'blackboard');
        blackboardBtn.innerHTML = `${iconSvg('database')}<span>共享黑板 (${collabMeshState.blackboard.length})</span>`;
    }

    const demoBtn = $('collabToggleDemoBtn');
    if (demoBtn) {
        demoBtn.innerHTML = `${iconSvg('sparkles')}<span>${collabMeshState.simulationMode ? '退出演示' : '演示模式'}</span>`;
        demoBtn.classList.toggle('active', collabMeshState.simulationMode);
    }

    $('collabSupervisorPanel')?.classList.toggle('open', collabMeshState.supervisorPanelOpen);
    $('collabCanvasViewport')?.classList.toggle('has-supervisor-panel', collabMeshState.supervisorPanelOpen);

    bindSupervisorMessageActions();
    bindSupervisorReplyDockEvents();
    bindBlackboardCopyButtons();
}

function updateCollabWires() {
    const wiresGroup = $('collabWiresGroup');
    if (!wiresGroup) return;

    const hubRight = getNodePortCoords('__hub__', 'output');
    const hubBottom = getNodePortCoords('__hub__', 'bottom');
    const bbTarget = getNodePortCoords('__blackboard__', 'input');
    const bbBottom = getNodePortCoords('__blackboard__', 'bottom');

    let wiresHtml = '';

    // 1. Hub to Blackboard Bridge
    if ($('collab-node-__blackboard__')) {
        const hubToBbPath = `M ${hubRight.x} ${hubRight.y} C ${hubRight.x + 40} ${hubRight.y}, ${bbTarget.x - 40} ${bbTarget.y}, ${bbTarget.x} ${bbTarget.y}`;
        wiresHtml += `<path class="collab-wire hub-bb-wire" d="${hubToBbPath}" />`;
    }

    // 2. Hub to Agents (Downward S-curves docking into Agent top ports)
    collabMeshState.peers.forEach((peer, idx) => {
        const peerKey = collabPeerKey(peer);
        const agentTop = getNodePortCoords(peerKey, 'top');
        const srcX = hubBottom.x + (idx - (collabMeshState.peers.length - 1) / 2) * 16;
        const srcY = hubBottom.y;
        const tgtX = agentTop.x;
        const tgtY = agentTop.y;
        const dy = Math.max(30, tgtY - srcY);

        const pathD = `M ${srcX} ${srcY} C ${srcX} ${srcY + dy * 0.45}, ${tgtX} ${tgtY - dy * 0.45}, ${tgtX} ${tgtY}`;

        const activeDispatch = latestCollabDispatchForPeer(peer);
        const status = activeDispatch ? collabDispatchVisualState(activeDispatch) : (['busy', 'waiting'].includes(peer.status) ? peer.status : 'idle');
        const linkOnline = (collabMeshState.gatewayOnline || collabMeshState.simulationMode) && status !== 'disconnected';
        const availability = linkOnline ? 'online' : 'offline';
        const shouldFlow = linkOnline && ['sending', 'transmitting', 'processing', 'busy', 'waiting'].includes(status);
        const flow = shouldFlow
            ? `<path class="collab-wire-flow status-${status} hub-agent-flow" d="${pathD}" />`
            : '';
        wiresHtml += `<path class="collab-wire status-${status} ${availability}" d="${pathD}" />${flow}`;

        // 3. Agent to Blackboard
        if ($('collab-node-__blackboard__')) {
            const bbPortX = bbBottom.x + (idx - (collabMeshState.peers.length - 1) / 2) * 48;
            const bbPortY = bbBottom.y;
            const memDy = Math.max(30, agentTop.y - bbPortY);
            const agentToBbPath = `M ${agentTop.x} ${agentTop.y} C ${agentTop.x} ${agentTop.y - memDy * 0.45}, ${bbPortX} ${bbPortY + memDy * 0.45}, ${bbPortX} ${bbPortY}`;
            wiresHtml += `<path class="collab-wire memory-link" d="${agentToBbPath}" />`;
        }
    });

    // 4. Peer-to-Peer collaborative links
    const p2pLinks = [...(collabMeshState.activeP2pLinks || [])];
    if (collabMeshState.tentativeLink) {
        p2pLinks.push({ ...collabMeshState.tentativeLink, status: 'tentative' });
    }

    p2pLinks.forEach(link => {
        const p1Port = getNodePortCoords(link.source, 'output');
        const p2Port = getNodePortCoords(link.target, 'input');
        const dx = Math.max(30, Math.abs(p2Port.x - p1Port.x));
        const p2pPath = `M ${p1Port.x} ${p1Port.y} C ${p1Port.x + dx * 0.45} ${p1Port.y}, ${p2Port.x - dx * 0.45} ${p2Port.y}, ${p2Port.x} ${p2Port.y}`;
        const isTentative = link.status === 'tentative';
        const isFlowing = ['sending', 'transmitting', 'processing', 'busy', 'waiting'].includes(link.status) || link.isFlowing;
        const cls = isTentative ? 'p2p-wire tentative' : 'p2p-wire';
        wiresHtml += `<path class="collab-wire ${cls} status-${escapeHtml(link.status || 'idle')}" d="${p2pPath}" />`;
        if (isFlowing) {
            wiresHtml += `<path class="collab-wire-flow status-${escapeHtml(link.status || 'busy')}" d="${p2pPath}" />`;
        }
    });

    wiresGroup.innerHTML = wiresHtml;
}

function updateActiveWireSvg() {
    const activeWireGroup = $('collabActiveWireGroup');
    if (!activeWireGroup) return;

    const wire = collabMeshState.activeWire;
    if (!wire) {
        activeWireGroup.innerHTML = '';
        return;
    }

    const startX = wire.startX;
    const startY = wire.startY;
    const endX = wire.currentX;
    const endY = wire.currentY;

    const dx = Math.max(30, Math.abs(endX - startX));
    const pathD = `M ${startX} ${startY} C ${startX + dx * 0.45} ${startY}, ${endX - dx * 0.45} ${endY}, ${endX} ${endY}`;

    activeWireGroup.innerHTML = `
        <path class="collab-active-wire-path" d="${pathD}" />
        <circle cx="${endX}" cy="${endY}" r="4" fill="var(--green)" />
    `;
}

function buildTransmissionPath(fromProfile, toProfile) {
    const fromId = !fromProfile || fromProfile === 'web-ui' ? '__hub__' : fromProfile;
    const toId = toProfile;

    let fromPort;
    let toPort;
    if (fromId === '__hub__' && toId !== '__blackboard__') {
        // Supervisor dispatch travels hub bottom → agent top
        fromPort = getNodePortCoords('__hub__', 'bottom');
        toPort = getNodePortCoords(toId, 'top');
        const dy = Math.max(36, toPort.y - fromPort.y);
        return `M ${fromPort.x} ${fromPort.y} C ${fromPort.x} ${fromPort.y + dy * 0.45}, ${toPort.x} ${toPort.y - dy * 0.45}, ${toPort.x} ${toPort.y}`;
    }

    fromPort = fromId === '__hub__'
        ? getNodePortCoords('__hub__', 'output')
        : getNodePortCoords(fromId, 'output');
    toPort = toId === '__blackboard__'
        ? getNodePortCoords('__blackboard__', 'input')
        : getNodePortCoords(toId, 'input');

    const dx = Math.max(36, Math.abs(toPort.x - fromPort.x));
    return `M ${fromPort.x} ${fromPort.y} C ${fromPort.x + dx * 0.45} ${fromPort.y}, ${toPort.x - dx * 0.45} ${toPort.y}, ${toPort.x} ${toPort.y}`;
}

function triggerTransmissionAnimation(fromProfile, toProfile, message, status = 'sending') {
    const transmissionGroup = $('collabTransmissionsGroup');
    if (!transmissionGroup) return;

    // Blackboard is shared context only — never animate outbound dispatches from it
    if (fromProfile === '__blackboard__') return;

    const pathD = buildTransmissionPath(fromProfile, toProfile);
    const id = 'tx-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);

    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const visualStatus = ['sending', 'transmitting', 'processing', 'waiting', 'stalled', 'pending', 'completed', 'error', 'timeout', 'disconnected'].includes(status)
        ? status
        : 'sending';
    el.setAttribute('class', `collab-transmission-pulse status-${visualStatus}`);
    el.setAttribute('d', pathD);
    el.setAttribute('id', id);
    el.setAttribute('pathLength', '100');
    transmissionGroup.appendChild(el);

    const targetId = toProfile;
    const targetEl = document.getElementById(`collab-node-${targetId}`);
    if (targetEl) {
        targetEl.classList.add('is-receiving');
        setTimeout(() => targetEl.classList.remove('is-receiving'), 1800);
    }

    setTimeout(() => {
        el.remove();
    }, 2600);
}

function simulateAgentExecution(sender, targets, message, isAsk = false) {
    const peers = collabMeshState.peers.length ? collabMeshState.peers : COLLAB_DEMO_PEERS;
    targets.forEach(targetKey => {
        const peer = peers.find(p => collabPeerKey(p) === targetKey);
        if (peer) {
            peer.status = 'busy';
            peer.currentFocus = `正在处理: ${message.slice(0, 24)}...`;
        }
    });

    syncCollabNodesDom();
    updateCollabWires();

    setTimeout(() => {
        targets.forEach(targetKey => {
            const peer = peers.find(p => collabPeerKey(p) === targetKey);
            const targetName = peer?.profile || targetKey;
            if (peer) {
                peer.status = 'idle';
                peer.currentFocus = '任务执行完成，等待新指令';
            }

            let replyContent = '';
            if (message.includes('审查') || message.includes('review')) {
                replyContent = '已完成代码审查：架构模块解耦良好，已补充边界条件校验，未发现安全隐患。';
            } else if (message.includes('修复') || message.includes('bug') || message.includes('fix')) {
                replyContent = '已定位问题并完成修复：修复了状态同步时可能导致的事件丢失，单测已全部通过。';
            } else if (message.includes('单测') || message.includes('test')) {
                replyContent = '已自动生成并补充 12 个单元测试用例，覆盖率提升至 96.4%，全部断言执行成功。';
            } else if (message.includes('黑板') || message.includes('同步')) {
                replyContent = '已将最新接口规范与架构上下文同步至共享黑板。';
                collabMeshState.blackboard.unshift({
                    id: 'bb-sim-' + Date.now(),
                    key: `sync:${targetName}:${Date.now() % 1000}`,
                    value: `由 @${targetName} 同步的最新协同上下文：${message.slice(0, 30)}`,
                    author: targetName,
                    timestamp: Date.now()
                });
            } else {
                replyContent = `已顺利执行完成指令：“${message.slice(0, 32)}”，当前会话与工作区状态正常。`;
            }

            collabMeshState.supervisorMessages.unshift({
                id: 'sim-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
                from: targetName,
                fromPeerId: peer?.peerId,
                to: 'web-ui',
                title: isAsk ? `回答监管提问 (@${targetName})` : `任务成果回报 (@${targetName})`,
                content: replyContent,
                kind: 'result',
                timestamp: Date.now(),
                readAt: null
            });

            collabMeshState.supervisorUnread++;

            collabMeshState.activityLogs.unshift({
                time: new Date().toLocaleTimeString(),
                text: `@${targetName} ➔ 监管收件箱: ${replyContent.slice(0, 32)}...`,
                type: 'receive'
            });
        });

        if (collabMeshState.activeP2pLinks && collabMeshState.activeP2pLinks.length) {
            collabMeshState.activeP2pLinks = [];
        }

        syncCollabNodesDom();
        updateCollabWires();
        syncSupervisorPanelDom();
         toast(`[演示] ${targets.map(targetKey => '@' + (peers.find(p => collabPeerKey(p) === targetKey)?.profile || targetKey)).join(', ')} 已提交任务处理成果！`);
    }, 2200);
}

async function executeSendCollabTask(targetList, message, fromProfile = null, isAsk = false, reportBack = true) {
    if (!Array.isArray(targetList)) {
        targetList = targetList ? [targetList] : [];
    }
    if (!targetList.length || !message.trim()) {
        toast('请选择至少一个目标 Agent 并输入任务内容');
        return;
    }

    collabMeshState.sending = true;
    const submitBtn = $('collabSubmitDispatchBtn');
    if (submitBtn) submitBtn.disabled = true;
    const flyoutSubmitBtn = $('collabSubmitFlyoutBtn');
    if (flyoutSubmitBtn) flyoutSubmitBtn.disabled = true;

    const senderKey = (fromProfile && fromProfile !== '__hub__') ? fromProfile : '';
    const senderPeer = collabPeerByKey(senderKey);
    const sender = senderPeer?.profile || 'web-ui';
    const targetPeers = targetList.map(targetKey => collabPeerByKey(targetKey));
    if (targetPeers.some(peer => !peer)) {
        toast('目标 Agent CLI 已离线或实例身份已变化，请刷新拓扑后重试');
        collabMeshState.sending = false;
        if (submitBtn) submitBtn.disabled = false;
        if (flyoutSubmitBtn) flyoutSubmitBtn.disabled = false;
        return;
    }
    const targetNames = targetPeers.map(peer => peer.profile);

    if (senderPeer) {
        triggerTransmissionAnimation('__hub__', senderKey, message, 'sending');
    } else {
        targetList.forEach(target => {
            triggerTransmissionAnimation('__hub__', target, message, 'sending');
        });
    }

    try {
        if (collabMeshState.simulationMode) {
            simulateAgentExecution(sender, targetList, message.trim(), isAsk);
            if (collabMeshState.tentativeLink) {
                collabMeshState.activeP2pLinks.push({
                    source: collabMeshState.tentativeLink.source,
                    target: collabMeshState.tentativeLink.target,
                    status: 'busy',
                    isFlowing: true,
                    expiresAt: Date.now() + 4000
                });
                collabMeshState.tentativeLink = null;
            }
            toast(sender !== 'web-ui'
                ? `[演示模式] 已向 @${sender} 注入联系 @${targetNames.join(', @')} 的协作指令`
                : `[演示模式] 已向 ${targetList.length} 个 Agent 派发任务`);
        } else {
            await Promise.all(targetList.map((targetKey, index) => {
                const targetPeer = targetPeers[index];
                return api('/api/collab/send', {
                    method: 'POST',
                    body: JSON.stringify({
                        from: sender,
                        sourcePeerId: senderPeer?.peerId,
                        to: targetPeer.profile,
                        peerId: targetPeer.peerId,
                        message: message.trim(),
                        isAsk,
                        reportBack
                    })
                });
            })
            );
            toast(sender !== 'web-ui'
                ? `监管指令已注入 @${sender}，由其联系 @${targetNames.join(', @')}`
                : (isAsk ? '提问' : '任务') + '已发送至 ' + targetList.length + ' 个 Agent');
        }

        targetList.forEach((target, index) => {
            const targetName = targetNames[index];
            collabMeshState.activityLogs.push({
                time: new Date().toLocaleTimeString(),
                text: sender !== 'web-ui'
                    ? `监管台 ➔ @${sender}: 联系 @${targetName} · "${message.trim().slice(0, 32)}"`
                    : `监管台 ➔ @${targetName}: "${message.trim().slice(0, 32)}"`,
                type: 'send'
            });

            const activeKey = senderPeer ? senderKey : target;
            const p = collabPeerByKey(activeKey);
            if (p) {
                p.status = 'busy';
                p.currentFocus = sender !== 'web-ui'
                    ? `协调 @${targetName}: ${message.trim().slice(0, 20)}...`
                    : `${isAsk ? '回答监管提问' : '处理监管任务'}: ${message.trim().slice(0, 24)}...`;
            }
        });

        collabMeshState.messageInput = '';
        closeNodeFlyout();
        closeBroadcastDispatchModal();

        syncCollabNodesDom();
        updateCollabWires();
    } catch (err) {
        toast('派发失败: ' + err.message);
    } finally {
        collabMeshState.sending = false;
        if (submitBtn) submitBtn.disabled = false;
        if (flyoutSubmitBtn) flyoutSubmitBtn.disabled = false;
    }
}

function openNodeFlyout(targetProfile, presetMessage = '', isAsk = false, sourceProfile = null) {
    collabMeshState.nodeFlyout = {
        open: true,
        targetProfile,
        message: presetMessage,
        isAsk,
        reportBack: true,
        sourceProfile,
        blackboardKey: ''
    };

    document.querySelectorAll('.collab-node.agent-node').forEach(nodeEl => {
        nodeEl.classList.toggle('is-active-target', nodeEl.dataset.nodeId === targetProfile);
    });

    const host = $('collabNodeFlyoutHost');
    if (host) host.innerHTML = renderCollabNodeFlyoutHtml();

    bindFlyoutEvents();

    const input = $('collabFlyoutTaskInput');
    if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }
}

function closeNodeFlyout() {
    collabMeshState.nodeFlyout.open = false;
    document.querySelectorAll('.collab-node.is-active-target').forEach(nodeEl => {
        nodeEl.classList.remove('is-active-target');
    });
    if (collabMeshState.tentativeLink) {
        collabMeshState.tentativeLink = null;
        updateCollabWires();
    }
    const host = $('collabNodeFlyoutHost');
    if (host) host.innerHTML = '';
}

function bindFlyoutEvents() {
    const closeBtn = $('collabCloseFlyoutBtn');
    if (closeBtn) closeBtn.onclick = closeNodeFlyout;

    const dismissBtn = $('collabDismissFlyoutBtn');
    if (dismissBtn) dismissBtn.onclick = closeNodeFlyout;

    const submitBtn = $('collabSubmitFlyoutBtn');
    const input = $('collabFlyoutTaskInput');

    if (collabMeshState.nodeFlyout.targetProfile === '__blackboard__') {
        const blackboardSubmit = $('collabSubmitBlackboardBtn');
        const keyInput = $('collabBlackboardKeyInput');
        const valueInput = $('collabBlackboardValueInput');
        if (valueInput) valueInput.oninput = () => { collabMeshState.nodeFlyout.message = valueInput.value; };
        if (keyInput) keyInput.oninput = () => { collabMeshState.nodeFlyout.blackboardKey = keyInput.value; };
        if (blackboardSubmit) {
            blackboardSubmit.onclick = async () => {
                const key = keyInput?.value.trim() || '';
                const value = valueInput?.value.trim() || '';
                if (!key || !value) {
                    toast('请填写键和值');
                    return;
                }
                blackboardSubmit.disabled = true;
                try {
                    triggerTransmissionAnimation(collabMeshState.nodeFlyout.sourceProfile || '__hub__', '__blackboard__', value);
                    if (collabMeshState.simulationMode) {
                        collabMeshState.blackboard.unshift({
                            id: 'bb-web-sim-' + Date.now(),
                            key,
                            value,
                            author: 'web-ui',
                            timestamp: Date.now()
                        });
                    } else {
                        await api('/api/collab/blackboard', {
                            method: 'POST',
                            body: JSON.stringify({ key, value, author: 'web-ui' })
                        });
                        await loadCollabMeshData(true);
                    }
                    collabMeshState.activityLogs.unshift({
                        time: new Date().toLocaleTimeString(),
                        text: `监管台 ➔ Agent CLI 共享黑板: ${key}`,
                        type: 'send'
                    });
                    closeNodeFlyout();
                    syncCollabNodesDom();
                    updateCollabWires();
                    syncSupervisorPanelDom();
                    toast(collabMeshState.simulationMode ? '[演示模式] 已写入共享黑板' : '已写入共享黑板');
                } catch (err) {
                    toast('黑板写入失败: ' + err.message);
                } finally {
                    blackboardSubmit.disabled = false;
                }
            };
        }
        return;
    }

    if (submitBtn && input) {
        submitBtn.onclick = () => {
            const flyout = collabMeshState.nodeFlyout;
            if (!flyout.targetProfile) return;
            executeSendCollabTask([flyout.targetProfile], input.value, flyout.sourceProfile, flyout.isAsk, flyout.reportBack);
        };

        input.onkeydown = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                const flyout = collabMeshState.nodeFlyout;
                if (!flyout.targetProfile) return;
                executeSendCollabTask([flyout.targetProfile], input.value, flyout.sourceProfile, flyout.isAsk, flyout.reportBack);
            }
        };
    }

    document.querySelectorAll('.flyout-chip').forEach(chip => {
        chip.onclick = () => {
            const prompt = chip.dataset.prompt;
            if (input && prompt) {
                input.value = prompt;
                input.focus();
            }
        };
    });
}

function resolveTaskPreset(presetIdOrMessage = '') {
    if (!presetIdOrMessage) {
        return COLLAB_TASK_PRESETS.find(p => p.custom) || COLLAB_TASK_PRESETS[0];
    }
    const byId = COLLAB_TASK_PRESETS.find(p => p.id === presetIdOrMessage);
    if (byId) return byId;
    const byPrompt = COLLAB_TASK_PRESETS.find(p => p.prompt === presetIdOrMessage);
    if (byPrompt) return byPrompt;
    return {
        id: 'custom',
        label: '自定义指令...',
        icon: '✍️',
        prompt: presetIdOrMessage,
        custom: true
    };
}

function bindDispatchModalPresetEvents() {
    const presetsHost = $('collabModalTaskPresets');
    const input = $('collabModalTaskInput');
    if (!presetsHost) return;

    presetsHost.querySelectorAll('.task-capsule-item').forEach(cap => {
        cap.onclick = () => {
            const presetId = cap.dataset.taskPresetId || 'custom';
            const preset = resolveTaskPreset(presetId);
            collabMeshState.dispatchModal.activePresetId = preset.id;
            presetsHost.querySelectorAll('.task-capsule-item').forEach(item => {
                item.classList.toggle('is-active', item.dataset.taskPresetId === preset.id);
            });
            if (input) {
                if (preset.custom && !preset.prompt) {
                    // keep current text when switching to empty custom
                    input.focus();
                } else {
                    input.value = preset.prompt || '';
                    collabMeshState.dispatchModal.message = input.value;
                    input.focus();
                    input.setSelectionRange(input.value.length, input.value.length);
                }
            }
        };
    });

    if (input) {
        input.oninput = () => {
            collabMeshState.dispatchModal.message = input.value;
            // typing custom content marks custom preset active
            const matched = COLLAB_TASK_PRESETS.find(p => p.prompt && p.prompt === input.value);
            collabMeshState.dispatchModal.activePresetId = matched ? matched.id : 'custom';
            presetsHost.querySelectorAll('.task-capsule-item').forEach(item => {
                item.classList.toggle('is-active', item.dataset.taskPresetId === collabMeshState.dispatchModal.activePresetId);
            });
        };
    }
}

function openBroadcastDispatchModal(presetIdOrMessage = '') {
    const peers = collabMeshState.peers.length
        ? collabMeshState.peers
        : (collabMeshState.simulationMode ? COLLAB_DEMO_PEERS : []);
    const preset = resolveTaskPreset(presetIdOrMessage);

    collabMeshState.dispatchModal = {
        open: true,
        selectedTargets: new Set(peers.map(p => collabPeerKey(p))),
        message: preset.prompt || (typeof presetIdOrMessage === 'string' && !COLLAB_TASK_PRESETS.some(p => p.id === presetIdOrMessage) ? presetIdOrMessage : ''),
        reportBack: true,
        activePresetId: preset.id
    };

    const presetsHost = $('collabModalTaskPresets');
    if (presetsHost) {
        presetsHost.innerHTML = renderTaskCapsulesHtml({
            selectedId: collabMeshState.dispatchModal.activePresetId,
            forModal: true,
            interactive: true
        });
    }

    const chipsContainer = $('collabModalTargetChips');
    if (chipsContainer) {
        if (!peers.length) {
            chipsContainer.innerHTML = `<div class="collab-empty-state">暂无在线 Agent，请先启动 CLI 或开启演示模式</div>`;
        } else {
            chipsContainer.innerHTML = peers.map(p => `
                <button class="target-chip active" data-peer-key="${escapeHtml(collabPeerKey(p))}" type="button">
                    <span>@${escapeHtml(p.profile)} · ${escapeHtml(p.peerId || '')}</span>
                </button>
            `).join('');

            chipsContainer.querySelectorAll('.target-chip').forEach(chip => {
                chip.onclick = () => {
                    const peerKey = chip.dataset.peerKey;
                    if (collabMeshState.dispatchModal.selectedTargets.has(peerKey)) {
                        collabMeshState.dispatchModal.selectedTargets.delete(peerKey);
                        chip.classList.remove('active');
                    } else {
                        collabMeshState.dispatchModal.selectedTargets.add(peerKey);
                        chip.classList.add('active');
                    }
                };
            });
        }
    }

    const input = $('collabModalTaskInput');
    if (input) {
        input.value = collabMeshState.dispatchModal.message || '';
    }

    bindDispatchModalPresetEvents();

    const modal = $('collabBroadcastDispatchModal');
    if (modal && typeof modal.showModal === 'function') {
        modal.classList.remove('is-closing');
        if (!modal.open) modal.showModal();
        void modal.offsetWidth;
        modal.classList.add('is-open');
        if (input) {
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
        }
    }
}

function closeBroadcastDispatchModal() {
    collabMeshState.dispatchModal.open = false;
    const modal = $('collabBroadcastDispatchModal');
    if (!modal) return;

    const finish = () => {
        if (modal.open && typeof modal.close === 'function') modal.close();
        modal.classList.remove('is-open', 'is-closing');
    };

    if (!modal.open) {
        finish();
        return;
    }

    modal.classList.add('is-closing');
    modal.classList.remove('is-open');
    const onEnd = (e) => {
        if (e && e.target !== modal && e.target !== modal.querySelector('.dispatch-modal-card')) return;
        modal.removeEventListener('animationend', onEnd);
        finish();
    };
    modal.addEventListener('animationend', onEnd);
    setTimeout(onEnd, 260);
}

function bindOnboardingDemoButton() {
    const launchDemoPromptBtn = $('collabLaunchDemoPromptBtn');
    if (!launchDemoPromptBtn) return;
    launchDemoPromptBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        collabMeshState.simulationMode = true;
        collabMeshState.hasInitialFit = false;
        loadCollabMeshData().then(() => {
            requestAnimationFrame(() => {
                fitCollabMeshView(false);
                collabMeshState.hasInitialFit = true;
            });
            toast('已启动演示拓扑网络');
        });
    };
}

function clearCapsuleDropTargets() {
    document.querySelectorAll('.collab-node.drop-target').forEach(el => el.classList.remove('drop-target'));
}

function removeCapsuleGhost() {
    document.querySelectorAll('.collab-capsule-ghost').forEach(el => el.remove());
}

function bindTaskCapsuleDragEvents() {
    const dock = $('collabTaskDock');
    const viewport = $('collabCanvasViewport');
    if (!dock) return;

    // Clean previous drag state bindings
    removeCapsuleGhost();
    clearCapsuleDropTargets();

    dock.querySelectorAll('.task-capsule-item').forEach(cap => {
        const presetId = cap.dataset.taskPresetId || 'custom';
        const preset = resolveTaskPreset(presetId);
        const isCustom = !!preset.custom;
        let suppressClick = false;

        // Prefer pointer-based drag so it works even when HTML5 DnD is blocked by canvas transforms
        cap.onpointerdown = (e) => {
            if (isCustom) return;
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();

            const startX = e.clientX;
            const startY = e.clientY;
            let dragging = false;
            let ghost = null;
            let dropTarget = null;

            const ensureGhost = () => {
                if (ghost) return ghost;
                ghost = document.createElement('div');
                ghost.className = 'collab-capsule-ghost';
                ghost.innerHTML = `<span class="capsule-icon">${preset.icon}</span><span class="capsule-label">${escapeHtml(preset.label)}</span>`;
                document.body.appendChild(ghost);
                return ghost;
            };

            const onMove = (moveEvt) => {
                const dx = moveEvt.clientX - startX;
                const dy = moveEvt.clientY - startY;
                if (!dragging && Math.hypot(dx, dy) < 6) return;

                if (!dragging) {
                    dragging = true;
                    suppressClick = true;
                    cap.classList.add('is-capsule-dragging');
                    collabMeshState.isDraggingNode = true; // pause polling while dragging capsule
                    ensureGhost();
                }

                const g = ensureGhost();
                g.style.left = `${moveEvt.clientX + 12}px`;
                g.style.top = `${moveEvt.clientY + 12}px`;

                const world = clientToCanvasWorld(moveEvt.clientX, moveEvt.clientY);
                dropTarget = findDropTargetAtWorldPoint(world.x, world.y, null);
                g.classList.toggle('has-target', !!dropTarget);
            };

            const onUp = (upEvt) => {
                window.removeEventListener('pointermove', onMove, true);
                window.removeEventListener('pointerup', onUp, true);
                window.removeEventListener('pointercancel', onUp, true);
                try {
                    if (cap.hasPointerCapture?.(e.pointerId)) cap.releasePointerCapture(e.pointerId);
                } catch { /* ignore */ }

                cap.classList.remove('is-capsule-dragging');
                collabMeshState.isDraggingNode = false;
                removeCapsuleGhost();

                if (!dragging) {
                    // Treat as click → open dispatch modal with this preset
                    openBroadcastDispatchModal(preset.id);
                    return;
                }

                const world = clientToCanvasWorld(upEvt.clientX, upEvt.clientY);
                const target = findDropTargetAtWorldPoint(world.x, world.y, null) || dropTarget;
                clearCapsuleDropTargets();

                if (target === '__blackboard__') {
                    openNodeFlyout(target, preset.prompt || '', false, '__hub__');
                } else if (target && preset.prompt) {
                    executeSendCollabTask([target], preset.prompt, '__hub__', false, true);
                } else if (target) {
                    openNodeFlyout(target, '', false, '__hub__');
                }

                setTimeout(() => { suppressClick = false; }, 0);
            };

            try {
                cap.setPointerCapture(e.pointerId);
            } catch { /* ignore */ }
            window.addEventListener('pointermove', onMove, true);
            window.addEventListener('pointerup', onUp, true);
            window.addEventListener('pointercancel', onUp, true);
        };

        cap.onclick = (e) => {
            if (suppressClick) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            openBroadcastDispatchModal(preset.id);
        };

        // Disable native HTML5 drag to avoid double-handlers
        cap.removeAttribute('draggable');
        cap.ondragstart = (e) => e.preventDefault();
    });

    // Still allow HTML5 drop as a fallback when browser fires it
    document.querySelectorAll('.collab-node.agent-node').forEach(nodeEl => {
        nodeEl.ondragover = (e) => {
            e.preventDefault();
            nodeEl.classList.add('drop-target');
        };
        nodeEl.ondragleave = (e) => {
            if (!nodeEl.contains(e.relatedTarget)) nodeEl.classList.remove('drop-target');
        };
        nodeEl.ondrop = (e) => {
            e.preventDefault();
            e.stopPropagation();
            nodeEl.classList.remove('drop-target');
            const profile = nodeEl.dataset.nodeId;
            if (!profile) return;
            let prompt = e.dataTransfer.getData('text/plain') || '';
            const raw = e.dataTransfer.getData('application/x-collab-task');
            if (raw) {
                try { prompt = JSON.parse(raw).prompt || prompt; } catch { /* ignore */ }
            }
            if (!prompt.trim()) {
                openNodeFlyout(profile, '', false, '__hub__');
                return;
            }
            executeSendCollabTask([profile], prompt, '__hub__', false, true);
        };
    });

    // Prevent canvas panning while interacting with dock
    if (viewport) {
        dock.onpointerdown = (e) => e.stopPropagation();
    }
}

function bindBlackboardPreviewClicks() {
    const writeBbBtn = $('collabCanvasWriteBbBtn');
    if (writeBbBtn) {
        writeBbBtn.onclick = (e) => {
            e.stopPropagation();
            openNodeFlyout('__blackboard__', '', false, '__hub__');
        };
    }

    const viewBbBtn = $('collabCanvasViewBbBtn');
    if (viewBbBtn) {
        viewBbBtn.onclick = (e) => {
            e.stopPropagation();
            collabMeshState.supervisorPanelOpen = true;
            collabMeshState.supervisorTab = 'blackboard';
            $('collabSupervisorPanel')?.classList.add('open');
            $('collabCanvasViewport')?.classList.add('has-supervisor-panel');
            syncSupervisorPanelDom();
        };
    }

    const bbNodeEl = $('collab-node-__blackboard__');
    if (bbNodeEl) {
        bbNodeEl.onclick = (e) => {
            if (e.target.closest('.collab-port') || e.target.closest('button')) return;
            collabMeshState.supervisorPanelOpen = true;
            collabMeshState.supervisorTab = 'blackboard';
            $('collabSupervisorPanel')?.classList.add('open');
            $('collabCanvasViewport')?.classList.add('has-supervisor-panel');
            syncSupervisorPanelDom();
        };
    }

    document.querySelectorAll('.blackboard-preview-card').forEach(card => {
        card.onclick = (e) => {
            e.stopPropagation();
            const key = card.dataset.bbKey;
            collabMeshState.supervisorPanelOpen = true;
            collabMeshState.supervisorTab = 'blackboard';
            if (key) collabMeshState.blackboardFilter = key;
            $('collabSupervisorPanel')?.classList.add('open');
            $('collabCanvasViewport')?.classList.add('has-supervisor-panel');
            syncSupervisorPanelDom();
        };
    });
}

function bindBlackboardCopyButtons() {
    document.querySelectorAll('.copy-bb-btn').forEach(btn => {
        btn.onclick = async () => {
            const val = btn.dataset.copyVal || '';
            try {
                await navigator.clipboard.writeText(val);
                toast('黑板内容已复制到剪贴板');
            } catch {
                toast('复制失败');
            }
        };
    });
}

async function markSupervisorMessagesRead(ids = []) {
    const targetIds = (ids || []).filter(Boolean);
    if (!targetIds.length) return 0;

    let marked = 0;
    targetIds.forEach(id => {
        const message = collabMeshState.supervisorMessages.find(entry => entry.id === id);
        if (message && !message.readAt) {
            message.readAt = Date.now();
            marked += 1;
        }
    });
    if (marked) {
        collabMeshState.supervisorUnread = Math.max(0, collabMeshState.supervisorUnread - marked);
    }

    if (!collabMeshState.simulationMode) {
        try {
            await api('/api/collab/supervisor/read', {
                method: 'POST',
                body: JSON.stringify({ ids: targetIds })
            });
        } catch {
            // Ignore read acknowledgement failures; local state already updated
        }
    }
    return marked;
}

function bindSupervisorMessageActions() {
    document.querySelectorAll('.supervisor-mark-read-btn').forEach(button => {
        button.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const id = button.dataset.supervisorMessageId
                || button.closest('[data-supervisor-message-id]')?.dataset.supervisorMessageId;
            if (!id) return;
            await markSupervisorMessagesRead([id]);
            syncSupervisorPanelDom({ preserveReplyDraft: true });
            toast('已标记为已读');
        };
    });

    document.querySelectorAll('.supervisor-continue-btn').forEach(button => {
        button.onclick = async () => {
            const profile = button.dataset.supervisorAgent;
            if (!profile || profile === 'web-ui') return;
            const peer = collabPeerByIdentity(profile, button.dataset.supervisorPeerId || '');
            if (!peer) {
                toast('对应 Agent 已离线或同名身份存在歧义，请刷新拓扑后重试');
                return;
            }
            const title = button.dataset.supervisorTitle || '监管消息';
            const id = button.dataset.supervisorMessageId
                || button.closest('[data-supervisor-message-id]')?.dataset.supervisorMessageId;
            if (id) {
                await markSupervisorMessagesRead([id]);
            }
            collabMeshState.activeReplyTarget = collabPeerKey(peer);
            syncSupervisorPanelDom({ preserveReplyDraft: false });
            const replyInput = $('collabReplyInput');
            if (replyInput) {
                replyInput.value = `关于“${title}”：`;
                collabMeshState.replyDraft = replyInput.value;
                replyInput.focus();
            }
        };
    });
}

function bindSupervisorPanelEvents() {
    const toggle = $('collabToggleSupervisorBtn');
    if (toggle) {
        toggle.onclick = () => {
            if (collabMeshState.supervisorPanelOpen && collabMeshState.supervisorTab === 'inbox') {
                collabMeshState.supervisorPanelOpen = false;
            } else {
                collabMeshState.supervisorPanelOpen = true;
                collabMeshState.supervisorTab = 'inbox';
            }
            $('collabSupervisorPanel')?.classList.toggle('open', collabMeshState.supervisorPanelOpen);
            $('collabCanvasViewport')?.classList.toggle('has-supervisor-panel', collabMeshState.supervisorPanelOpen);
            syncSupervisorPanelDom();
            const fit = computeFitViewParams();
            animateViewportCamera(fit.panX, fit.panY, fit.zoom, 280);
        };
    }

    const bbToggle = $('collabToggleBlackboardBtn');
    if (bbToggle) {
        bbToggle.onclick = () => {
            if (collabMeshState.supervisorPanelOpen && collabMeshState.supervisorTab === 'blackboard') {
                collabMeshState.supervisorPanelOpen = false;
            } else {
                collabMeshState.supervisorPanelOpen = true;
                collabMeshState.supervisorTab = 'blackboard';
            }
            $('collabSupervisorPanel')?.classList.toggle('open', collabMeshState.supervisorPanelOpen);
            $('collabCanvasViewport')?.classList.toggle('has-supervisor-panel', collabMeshState.supervisorPanelOpen);
            syncSupervisorPanelDom();
            const fit = computeFitViewParams();
            animateViewportCamera(fit.panX, fit.panY, fit.zoom, 280);
        };
    }

    const close = $('collabCloseSupervisorBtn');
    if (close) {
        close.onclick = () => {
            collabMeshState.supervisorPanelOpen = false;
            $('collabSupervisorPanel')?.classList.remove('open');
            $('collabCanvasViewport')?.classList.remove('has-supervisor-panel');
            $('collabToggleSupervisorBtn')?.classList.remove('active');
            $('collabToggleBlackboardBtn')?.classList.remove('active');
            const fit = computeFitViewParams();
            animateViewportCamera(fit.panX, fit.panY, fit.zoom, 280);
        };
    }

    document.querySelectorAll('[data-supervisor-tab]').forEach(tab => {
        tab.onclick = () => {
            collabMeshState.supervisorTab = tab.dataset.supervisorTab || 'inbox';
            document.querySelectorAll('[data-supervisor-tab]').forEach(candidate => {
                candidate.classList.toggle('active', candidate === tab);
            });
            syncSupervisorPanelDom();
        };
    });

    const markAll = $('collabMarkSupervisorReadBtn');
    if (markAll) {
        markAll.onclick = async () => {
            try {
                await api('/api/collab/supervisor/read', {
                    method: 'POST',
                    body: JSON.stringify({ all: true })
                });
                const now = Date.now();
                collabMeshState.supervisorMessages.forEach(message => {
                    if (!message.readAt) message.readAt = now;
                });
                collabMeshState.supervisorUnread = 0;
                syncSupervisorPanelDom();
            } catch (err) {
                toast('更新监管收件箱失败: ' + err.message);
            }
        };
    }

    bindSupervisorMessageActions();
    bindSupervisorReplyDockEvents();
}

function bindSupervisorReplyDockEvents() {
    document.querySelectorAll('[data-reply-agent]').forEach(pill => {
        pill.onclick = () => {
            const peerKey = pill.dataset.replyAgent;
            const peer = collabPeerByKey(peerKey);
            if (!peer) return;
            collabMeshState.activeReplyTarget = peerKey;
            document.querySelectorAll('[data-reply-agent]').forEach(p => {
                p.classList.toggle('active', p.dataset.replyAgent === peerKey);
            });
            const input = $('collabReplyInput');
            if (input) {
                input.placeholder = `输入监管回复指令回复 @${peer.profile} (Ctrl+Enter 发送)...`;
                input.focus();
            }
        };
    });

    document.querySelectorAll('[data-reply-prompt]').forEach(chip => {
        chip.onclick = () => {
            const input = $('collabReplyInput');
            if (input) {
                input.value = chip.dataset.replyPrompt || '';
                collabMeshState.replyDraft = input.value;
                input.focus();
            }
        };
    });

    const sendBtn = $('collabSendReplyBtn');
    const replyInput = $('collabReplyInput');

    if (replyInput) {
        replyInput.oninput = () => {
            collabMeshState.replyDraft = replyInput.value;
        };
    }

    const handleSend = async () => {
        const peers = collabMeshState.peers.length ? collabMeshState.peers : (collabMeshState.simulationMode ? COLLAB_DEMO_PEERS : []);
        const target = collabMeshState.activeReplyTarget || (peers[0] ? collabPeerKey(peers[0]) : '');
        const targetPeer = collabPeerByKey(target);
        const text = replyInput ? replyInput.value.trim() : '';
        if (!targetPeer || !text) {
            toast('请输入回复内容');
            return;
        }

        triggerTransmissionAnimation('__hub__', target, text);
        collabMeshState.activityLogs.unshift({
            time: new Date().toLocaleTimeString(),
            text: `已向 @${targetPeer.profile} 发送监管指令: ${text.slice(0, 36)}...`,
            type: 'dispatch'
        });

        if (replyInput) replyInput.value = '';
        collabMeshState.replyDraft = '';

        if (collabMeshState.simulationMode) {
            simulateAgentExecution('web-ui', [target], text, false);
            toast(`[演示] 已向 @${targetPeer.profile} 发送回复指令`);
            // simulateAgentExecution will refresh inbox when replies arrive; keep draft empty
            return;
        }

        try {
            await api('/api/collab/send', {
                method: 'POST',
                body: JSON.stringify({
                    from: 'web-ui',
                    to: targetPeer.profile,
                    peerId: targetPeer.peerId,
                    message: text,
                    isAsk: false,
                    reportBack: true
                })
            });

            toast(`已发送指令给 @${targetPeer.profile}`);
        } catch (err) {
            toast('发送失败: ' + err.message);
        }
    };

    if (sendBtn) sendBtn.onclick = handleSend;
    if (replyInput) {
        replyInput.onkeydown = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                handleSend();
            }
        };
    }
}

function bindNodeElementEvents() {
    const viewport = $('collabCanvasViewport');

    // Dragging Nodes
    document.querySelectorAll('.collab-node').forEach(nodeEl => {
        const nodeId = nodeEl.dataset.nodeId;
        if (!nodeId) return;

        nodeEl.onpointerdown = (e) => {
            if (e.target.closest('button') || e.target.closest('.collab-port') || e.target.closest('input') || e.target.closest('textarea')) {
                return;
            }
            e.stopPropagation();

            let isNodeDragging = true;
            collabMeshState.isDraggingNode = true;
            nodeEl.classList.add('is-dragging');
            nodeEl.setPointerCapture(e.pointerId);

            const startClientX = e.clientX;
            const startClientY = e.clientY;
            const initialX = parseFloat(nodeEl.style.left) || (nodeId === '__hub__' ? collabMeshState.hubPosition.x : (collabMeshState.nodePositions[nodeId]?.x || 0));
            const initialY = parseFloat(nodeEl.style.top) || (nodeId === '__hub__' ? collabMeshState.hubPosition.y : (collabMeshState.nodePositions[nodeId]?.y || 0));

            nodeEl.onpointermove = (moveEvt) => {
                if (!isNodeDragging) return;
                const dx = (moveEvt.clientX - startClientX) / collabMeshState.zoom;
                const dy = (moveEvt.clientY - startClientY) / collabMeshState.zoom;

                const newX = Math.round(initialX + dx);
                const newY = Math.round(initialY + dy);

                if (nodeId === '__hub__' || nodeId === '__onboarding__') {
                    if (nodeId === '__hub__') {
                        collabMeshState.hubPosition = { x: newX, y: newY };
                        collabMeshState.hubPositionManual = true;
                    }
                    else collabMeshState.nodePositions['__onboarding__'] = { x: newX, y: newY };
                } else {
                    collabMeshState.nodePositions[nodeId] = { x: newX, y: newY };
                }

                nodeEl.style.left = `${newX}px`;
                nodeEl.style.top = `${newY}px`;

                if (collabMeshState.nodeFlyout.open && collabMeshState.nodeFlyout.targetProfile === nodeId) {
                    const flyoutEl = $('collabNodeFlyout');
                    if (flyoutEl) {
                        flyoutEl.style.left = `${nodeId === '__blackboard__' ? newX + 52 : newX + 304}px`;
                        flyoutEl.style.top = `${nodeId === '__blackboard__' ? newY + 150 : Math.max(10, newY - 10)}px`;
                    }
                }

                updateCollabWires();
            };

            const stopNodeDrag = () => {
                isNodeDragging = false;
                collabMeshState.isDraggingNode = false;
                nodeEl.classList.remove('is-dragging');
                nodeEl.onpointermove = null;
                nodeEl.onpointerup = null;
                nodeEl.onpointercancel = null;
            };

            nodeEl.onpointerup = stopNodeDrag;
            nodeEl.onpointercancel = stopNodeDrag;
        };
    });

    // Dragging source ports (output / bottom with data-port-source) to connect wire
    document.querySelectorAll('.collab-port[data-port-source]').forEach(portEl => {
        portEl.onpointerdown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const sourceId = portEl.dataset.portSource;
            // Blackboard is shared context only — no outbound wiring / dispatch
            if (!sourceId || sourceId === '__blackboard__' || !viewport) return;

            const portType = portEl.classList.contains('port-bottom')
                ? 'bottom'
                : (portEl.classList.contains('port-top') ? 'top' : 'output');
            const startPort = getNodePortCoords(sourceId, portType);
            const world = clientToCanvasWorld(e.clientX, e.clientY);

            collabMeshState.activeWire = {
                sourceId,
                portType,
                startX: startPort.x,
                startY: startPort.y,
                currentX: world.x,
                currentY: world.y,
                targetId: null
            };

            try {
                portEl.setPointerCapture(e.pointerId);
            } catch {
                // ignore capture failures
            }
            updateActiveWireSvg();

            const onMove = (moveEvt) => {
                if (!collabMeshState.activeWire) return;
                const point = clientToCanvasWorld(moveEvt.clientX, moveEvt.clientY);
                collabMeshState.activeWire.currentX = point.x;
                collabMeshState.activeWire.currentY = point.y;
                collabMeshState.activeWire.targetId = findDropTargetAtWorldPoint(
                    point.x,
                    point.y,
                    collabMeshState.activeWire.sourceId
                );
                updateActiveWireSvg();
            };

            const onUp = () => {
                portEl.removeEventListener('pointermove', onMove);
                portEl.removeEventListener('pointerup', onUp);
                portEl.removeEventListener('pointercancel', onUp);
                try {
                    if (portEl.hasPointerCapture?.(e.pointerId)) {
                        portEl.releasePointerCapture(e.pointerId);
                    }
                } catch {
                    // ignore
                }

                if (!collabMeshState.activeWire) return;
                const target = collabMeshState.activeWire.targetId;
                const source = collabMeshState.activeWire.sourceId;
                document.querySelectorAll('.collab-node').forEach(el => el.classList.remove('drop-target'));
                collabMeshState.activeWire = null;
                updateActiveWireSvg();

                if (target) {
                    if (source && source !== '__hub__' && source !== '__blackboard__' && source !== target) {
                        collabMeshState.tentativeLink = {
                            source,
                            target,
                            createdAt: Date.now()
                        };
                        updateCollabWires();
                    }
                    openNodeFlyout(target, '', false, source);
                }
            };

            portEl.addEventListener('pointermove', onMove);
            portEl.addEventListener('pointerup', onUp);
            portEl.addEventListener('pointercancel', onUp);
        };
    });

    // Node Footer Direct Action Buttons -> Open Flyout
    document.querySelectorAll('[data-action="dispatch-to"]').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const peerKey = btn.dataset.peerKey;
            openNodeFlyout(peerKey, '', false, '__hub__');
        };
    });

    document.querySelectorAll('[data-action="ask-peer"]').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const peerKey = btn.dataset.peerKey;
            const peer = collabPeerByKey(peerKey);
            if (!peer) return;
            openNodeFlyout(peerKey, `请问 @${peer.profile}，当前工作区进度如何？是否有需要协同解决的问题？`, true, '__hub__');
        };
    });
}

function bindCollabMeshEvents() {
    const closeBtn = $('collabCloseBtn');
    if (closeBtn) closeBtn.onclick = closeCollabMesh;

    const refreshBtn = $('collabRefreshBtn');
    if (refreshBtn) refreshBtn.onclick = () => loadCollabMeshData().then(() => toast('已刷新拓扑状态'));

    const toggleFullscreenBtn = $('collabToggleFullscreenBtn');
    if (toggleFullscreenBtn) {
        toggleFullscreenBtn.onclick = () => {
            collabMeshState.isFullscreen = !collabMeshState.isFullscreen;
            const dialog = $('collabMeshDialog');
            if (dialog) {
                dialog.classList.toggle('is-fullscreen', collabMeshState.isFullscreen);
            }
            toggleFullscreenBtn.innerHTML = iconSvg(collabMeshState.isFullscreen ? 'minimize' : 'maximize');
            toggleFullscreenBtn.title = collabMeshState.isFullscreen ? '还原窗口' : '全屏最大化';

            setTimeout(() => {
                const fit = computeFitViewParams();
                animateViewportCamera(fit.panX, fit.panY, fit.zoom, 300);
            }, 260);
        };
    }

    const autoLayoutBtn = $('collabAutoLayoutBtn');
    if (autoLayoutBtn) autoLayoutBtn.onclick = computeAutoLayout;

    const toggleDemoBtn = $('collabToggleDemoBtn');
    if (toggleDemoBtn) {
        toggleDemoBtn.onclick = () => {
            collabMeshState.simulationMode = !collabMeshState.simulationMode;
            collabMeshState.hasInitialFit = false;
            if (collabMeshState.simulationMode) {
                // Seed demo data once when entering simulation
                if (!collabMeshState.peers.length) {
                    collabMeshState.peers = COLLAB_DEMO_PEERS.map(peer => ({ ...peer }));
                }
                if (!collabMeshState.blackboard.length) {
                    collabMeshState.blackboard = COLLAB_DEMO_BLACKBOARD.map(item => ({ ...item }));
                }
            }
            loadCollabMeshData().then(() => {
                requestAnimationFrame(() => {
                    fitCollabMeshView(false);
                    collabMeshState.hasInitialFit = true;
                });
            });
            toast(collabMeshState.simulationMode ? '已切换至演示拓扑网络' : '已返回实时网关数据');
        };
    }

    bindOnboardingDemoButton();

    // Zoom & Pan Canvas Controls
    const viewport = $('collabCanvasViewport');

    const zoomAroundCenter = (factor) => {
        const vp = $('collabCanvasViewport');
        const cx = vp ? vp.clientWidth / 2 : 450;
        const cy = vp ? vp.clientHeight / 2 : 300;
        const nextZoom = Math.min(2.2, Math.max(0.35, collabMeshState.zoom * factor));
        const scaleChange = nextZoom / collabMeshState.zoom;
        const nextPanX = cx - (cx - collabMeshState.panX) * scaleChange;
        const nextPanY = cy - (cy - collabMeshState.panY) * scaleChange;
        animateViewportCamera(nextPanX, nextPanY, nextZoom, 280);
    };

    const zoomInBtn = $('collabZoomInBtn');
    if (zoomInBtn) zoomInBtn.onclick = () => zoomAroundCenter(1.22);
    const zoomOutBtn = $('collabZoomOutBtn');
    if (zoomOutBtn) zoomOutBtn.onclick = () => zoomAroundCenter(0.82);
    const resetViewBtn = $('collabResetViewBtn');
    if (resetViewBtn) {
        resetViewBtn.onclick = () => {
            animateViewportCamera(0, 0, 1.0, 320);
        };
    }
    const fitViewBtn = $('collabFitViewBtn');
    if (fitViewBtn) {
        fitViewBtn.onclick = () => fitCollabMeshView(false);
    }

    // Canvas Background Panning (wire drag is handled on ports themselves)
    if (viewport) {
        viewport.onpointerdown = (e) => {
            if (e.target.closest('.collab-node') || e.target.closest('.collab-node-flyout') || e.target.closest('.collab-port') || e.target.closest('.collab-task-dock') || e.target.closest('.collab-supervisor-panel') || e.target.closest('.collab-zoom-hud') || e.target.closest('.collab-dispatch-modal')) {
                return;
            }
            if (collabMeshState.nodeFlyout.open) {
                closeNodeFlyout();
            }

            stopCollabCameraAnimation();
            collabMeshState.isPanning = true;
            collabMeshState.panStartX = e.clientX;
            collabMeshState.panStartY = e.clientY;
            collabMeshState.initialPanX = collabMeshState.panX;
            collabMeshState.initialPanY = collabMeshState.panY;
            viewport.classList.add('is-panning');
            viewport.setPointerCapture(e.pointerId);
        };

        viewport.onpointermove = (e) => {
            if (!collabMeshState.isPanning) return;
            const dx = e.clientX - collabMeshState.panStartX;
            const dy = e.clientY - collabMeshState.panStartY;
            collabMeshState.panX = collabMeshState.initialPanX + dx;
            collabMeshState.panY = collabMeshState.initialPanY + dy;
            applyCollabCameraTransform();
        };

        const endPan = () => {
            if (collabMeshState.isPanning) {
                collabMeshState.isPanning = false;
                viewport.classList.remove('is-panning');
            }
        };

        viewport.onpointerup = endPan;
        viewport.onpointercancel = endPan;

        viewport.onwheel = (e) => {
            // Let side panel / dock / flyout / modal scroll natively — don't steal for canvas zoom
            if (e.target.closest('.collab-supervisor-panel')
                || e.target.closest('.collab-task-dock')
                || e.target.closest('.collab-node-flyout')
                || e.target.closest('.collab-dispatch-modal')
                || e.target.closest('textarea')
                || e.target.closest('input')
                || e.target.closest('.supervisor-messages-list')
                || e.target.closest('.collab-bb-list')
                || e.target.closest('.supervisor-panel-body')) {
                return;
            }

            e.preventDefault();
            stopCollabCameraAnimation();

            const rect = viewport.getBoundingClientRect();
            const cursorX = e.clientX - rect.left;
            const cursorY = e.clientY - rect.top;

            const worldX = (cursorX - collabMeshState.panX) / collabMeshState.zoom;
            const worldY = (cursorY - collabMeshState.panY) / collabMeshState.zoom;

            const zoomFactor = Math.exp(-e.deltaY * 0.0022);
            const targetZoom = Math.min(2.2, Math.max(0.35, collabMeshState.zoom * zoomFactor));

            collabMeshState.zoom = targetZoom;
            collabMeshState.panX = cursorX - worldX * targetZoom;
            collabMeshState.panY = cursorY - worldY * targetZoom;

            applyCollabCameraTransform();
        };
    }

    // Draggable Task Capsules from Dock
    bindTaskCapsuleDragEvents();

    // Broadcast Modal Actions
    const closeBroadcastBtn = $('collabCloseBroadcastModalBtn');
    if (closeBroadcastBtn) closeBroadcastBtn.onclick = closeBroadcastDispatchModal;

    const dismissModalBtn = $('collabDismissDispatchBtn');
    if (dismissModalBtn) dismissModalBtn.onclick = closeBroadcastDispatchModal;

    const submitDispatchBtn = $('collabSubmitDispatchBtn');
    if (submitDispatchBtn) {
        submitDispatchBtn.onclick = () => {
            const targets = Array.from(collabMeshState.dispatchModal.selectedTargets);
            const input = $('collabModalTaskInput');
            const message = input ? input.value : '';
            executeSendCollabTask(targets, message, null, false, collabMeshState.dispatchModal.reportBack);
        };
    }
}

function bind() {
    hydrateIcons();
    $('refreshBtn').onclick = () => load().then(() => toast('已刷新'));
    $('topCollabMesh').onclick = () => openCollabMesh();
    $('topSyncWorkspace').onclick = () => openSyncWorkspace(state.selected || 'main');
    $('drawerClose').onclick = closeDrawer;
    document.querySelectorAll('[data-dialog-close]').forEach(btn => btn.addEventListener('click', () => {
        resetNewProfileForm();
        const dialogId = btn.dataset.dialogClose;
        if (dialogId === 'newProfileDialog' || dialogId === 'gatewayDialog') closePrimaryModal(dialogId);
        else $(dialogId).close();
    }));
    document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        if (dialog.id === 'syncConfirmDialog') { closeSyncConfirm(); return; }
        if (dialog.id === 'collabMeshDialog') { closeCollabMesh(); return; }
        if (dialog.id === 'newProfileDialog') resetNewProfileForm();
        if (dialog.id === 'newProfileDialog' || dialog.id === 'gatewayDialog') closePrimaryModal(dialog.id);
        else dialog.close();
    }));
    ['newProfileDialog', 'gatewayDialog'].forEach(id => $(id).addEventListener('close', () => handlePrimaryModalClose(id)));
    $('collabMeshDialog')?.addEventListener('close', () => closeCollabMesh());
    $('themeToggle').onclick = () => {
        const dark = document.documentElement.dataset.theme === 'dark';
        document.documentElement.dataset.theme = dark ? 'light' : 'dark';
        localStorage.setItem('ccp-ui-theme', dark ? 'light' : 'dark');
        $('themeToggle').innerHTML = dark ? iconSvg('moon') : iconSvg('sun');
        $('themeToggle').title = dark ? '切换深色' : '切换浅色';
        $('themeToggle').setAttribute('aria-label', dark ? '切换深色' : '切换浅色');
    };
    const saved = localStorage.getItem('ccp-ui-theme') || 'light';
    document.documentElement.dataset.theme = saved;
    $('themeToggle').innerHTML = saved === 'dark' ? iconSvg('sun') : iconSvg('moon');
    $('themeToggle').title = saved === 'dark' ? '切换浅色' : '切换深色';
    $('themeToggle').setAttribute('aria-label', saved === 'dark' ? '切换浅色' : '切换深色');
    $('newProfileBtn').onclick = () => void openNewProfileDialog();
    $('newProfileName').oninput = validateNewProfileName;
    $('createProfileSubmit').onclick = createProfile;
}

function validateNewProfileName() {
    const input = $('newProfileName');
    if (!input) return;
    const reservedNames = new Set(['main', 'web-ui', 'supervisor', '__supervisor__']);
    input.setCustomValidity(reservedNames.has(input.value.trim().toLowerCase()) ? '该名称是多 Agent 协议保留身份，请使用其他 Profile 名称。' : '');
}

function resetNewProfileForm() {
    const formEl = $('newProfileForm');
    if (!formEl) return;
    formEl.reset();
    validateNewProfileName();
    state.selectedPreset = 'custom-api';
    state.presetQuery = '';
    state.presetFilter = 'all';
    if (state.presets.length) renderPresetPicker();
}

async function createProfile() {
    const formEl = $('newProfileForm');
    validateNewProfileName();
    if (!formEl.reportValidity()) {
        const invalid = formEl.querySelector(':invalid');
        toast(invalid?.closest('label')?.textContent?.trim() ? ('请检查：' + invalid.closest('label').textContent.trim()) : '请完善必填项');
        invalid?.focus();
        return;
    }
    const formData = new FormData(formEl);
    const preset = selectedPreset();
    const kind = preset?.type || String(formData.get('kind') || '');
    const raw = Object.fromEntries(formData.entries());
    const name = String(raw.name || '').trim();
    let url = '/api/profiles/preset';
    let payload = { presetId: String(raw.presetId || ''), name, kind, token: String(raw.token || '') };
    if (kind === 'custom-api') {
        url = '/api/profiles/api';
        payload = { name, baseUrl: String(raw.baseUrl || ''), token: String(raw.customToken || ''), model: String(raw.model || '') };
    }
    else if (kind === 'login') {
        url = '/api/profiles/login';
        payload = { name };
    }
    else if (kind === 'gateway') {
        payload = {
            presetId: String(raw.presetId || ''),
            name,
            kind: 'gateway',
            upstreamId: String(raw.gatewayUpstream || ''),
            model: String(raw.gatewayModel || '')
        };
    }
    try {
        await api(url, { method: 'POST', body: JSON.stringify(payload) });
        closePrimaryModal('newProfileDialog');
        resetNewProfileForm();
        await load();
        const createdName = name;
        await selectProfile(createdName);
        toast('Profile "' + name + '" 已创建');
    } catch (err) {
        toast('创建失败: ' + err.message);
    }
}

window.openCollabMesh = openCollabMesh;
window.closeCollabMesh = closeCollabMesh;
window.executeSendCollabTask = executeSendCollabTask;
window.loadCollabMeshData = loadCollabMeshData;

bind();
load().catch(err => toast('加载失败: ' + err.message));
