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
        refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.5 6.2"/><path d="M3 12A9 9 0 0 1 18.5 5.8"/><path d="M18.5 3.5v4.8h-4.8"/><path d="M5.5 20.5v-4.8h4.8"/></svg>',
        plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
        search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
        history: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/></svg>',
        terminal: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/></svg>',
        trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>',
        power: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v10"/><path d="M18.4 6.6a8 8 0 1 1-12.8 0"/></svg>',
        fileText: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h6"/></svg>',
        pencil: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
        eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
        eyeOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18"/><path d="M10.6 6.2A10.6 10.6 0 0 1 12 6c6.5 0 10 6 10 6s-.8 1.4-2.1 2.8"/><path d="M6.6 6.6C3.6 8.4 2 12 2 12s3.5 6 10 6a10.2 10.2 0 0 0 4.1-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>'
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
    await Promise.all([loadRoutes(), loadPresets()]);
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
function bind() { hydrateIcons(); $('refreshBtn').onclick = () => load().then(() => toast('已刷新')); $('topSyncWorkspace').onclick = () => openSyncWorkspace(state.selected || 'main'); $('drawerClose').onclick = closeDrawer; document.querySelectorAll('[data-dialog-close]').forEach(btn => btn.addEventListener('click', () => { resetNewProfileForm(); const dialogId = btn.dataset.dialogClose; if (dialogId === 'newProfileDialog' || dialogId === 'gatewayDialog') closePrimaryModal(dialogId); else $(dialogId).close(); })); document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target !== dialog)
    return; if (dialog.id === 'syncConfirmDialog') {
    closeSyncConfirm();
    return;
} if (dialog.id === 'newProfileDialog')
    resetNewProfileForm(); if (dialog.id === 'newProfileDialog' || dialog.id === 'gatewayDialog') closePrimaryModal(dialog.id); else dialog.close(); })); ['newProfileDialog', 'gatewayDialog'].forEach(id => $(id).addEventListener('close', () => handlePrimaryModalClose(id))); $('themeToggle').onclick = () => { const dark = document.documentElement.dataset.theme === 'dark'; document.documentElement.dataset.theme = dark ? 'light' : 'dark'; localStorage.setItem('ccp-ui-theme', dark ? 'light' : 'dark'); $('themeToggle').innerHTML = dark ? iconSvg('moon') : iconSvg('sun'); $('themeToggle').title = dark ? '切换深色' : '切换浅色'; $('themeToggle').setAttribute('aria-label', dark ? '切换深色' : '切换浅色'); }; const saved = localStorage.getItem('ccp-ui-theme') || 'light'; document.documentElement.dataset.theme = saved; $('themeToggle').innerHTML = saved === 'dark' ? iconSvg('sun') : iconSvg('moon'); $('themeToggle').title = saved === 'dark' ? '切换浅色' : '切换深色'; $('themeToggle').setAttribute('aria-label', saved === 'dark' ? '切换浅色' : '切换深色'); $('newProfileBtn').onclick = () => void openNewProfileDialog(); $('createProfileSubmit').onclick = createProfile; }
function resetNewProfileForm() { const formEl = $('newProfileForm'); if (!formEl)
    return; formEl.reset(); state.selectedPreset = 'custom-api'; state.presetQuery = ''; state.presetFilter = 'all'; if (state.presets.length)
    renderPresetPicker(); }
async function createProfile() { const formEl = $('newProfileForm'); if (!formEl.reportValidity()) {
    const invalid = formEl.querySelector(':invalid');
    toast(invalid?.closest('label')?.textContent?.trim() ? `请检查：${invalid.closest('label').textContent.trim()}` : '请完善必填项');
    invalid?.focus();
    return;
} const form = new FormData(formEl); const preset = selectedPreset(); const kind = preset?.type || form.get('kind'); const raw = Object.fromEntries(form.entries()); let url = '/api/profiles/preset'; let body = { presetId: raw.presetId, name: raw.name, kind, token: raw.token }; if (kind === 'custom-api') {
    url = '/api/profiles/api';
    body = { name: raw.name, baseUrl: raw.baseUrl, token: raw.customToken || '', model: raw.model || '' };
}
else if (kind === 'login') {
    url = '/api/profiles/login';
    body = { name: raw.name };
}
else if (kind === 'gateway') {
    body = { presetId: raw.presetId, name: raw.name, kind: 'gateway', upstreamId: raw.gatewayUpstream || '', model: raw.gatewayModel || '' };
}
api(url, { method: 'POST', body: JSON.stringify(body) }).then(async () => {
    const createdName = String(raw.name || '').trim();
    closePrimaryModal('newProfileDialog');
    resetNewProfileForm();
    toast('Profile 已创建');
    if (kind === 'gateway') {
        const current = await api('/api/gateway/status');
        if (!current.running && confirm('Gateway 尚未运行，是否立即启动？'))
            await api('/api/gateway/start', { method: 'POST' });
    }
    await load();
    if ($('gatewayDialog')?.open)
        await openGatewayPanel();
    if (createdName) {
        try {
            await selectProfile(createdName);
        }
        catch (err) {
            toast(err.message);
        }
    }
}).catch(err => toast(err.message)); }
bind();
load().catch(err => toast(err.message));
