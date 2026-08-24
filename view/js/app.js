// ============================================
// app.js — the view's only state holder (PC increment 1).
// Talks REST to the backend (same-origin, cookie auth), attaches to the
// conversation event stream, feeds render.js. Never assembles system
// prompts, never talks to the gateway, never runs tools.
// ============================================
import * as R from './render.js';

const $ = (s) => document.querySelector(s);

let es = null;
let chatId = null;
let models = [];

// ---------- context / usage display ----------

function fmtTokens(n) {
    if (!Number.isFinite(n)) return '?';
    if (n >= 1000000) return Math.round(n / 100000) / 10 + 'M';
    if (n >= 1000) return Math.round(n / 100) / 10 + 'K';
    return String(n);
}

function windowSize() {
    const model = models.find(m => m.id === $('#v-model').value);
    return model?.capabilities?.contextWindow || null;
}

function showContext(context) {
    const el = $('#v-context');
    if (!el) return;
    if (!context || context.used_tokens === undefined) { el.style.display = 'none'; return; }
    el.style.display = '';
    const est = context.isEstimate ? '~' : '';
    let text = `${est}${fmtTokens(context.used_tokens)}`;
    const win = context.window_size || windowSize();
    if (win) {
        const pct = Math.min(100, Math.max(0, (context.used_tokens / win) * 100));
        text += ` / ${fmtTokens(win)} Tokens`;
        el.dataset.pct = String(pct);
        el.style.setProperty('--ctx-pct', pct + '%');
    } else {
        text += ' Tokens';
        el.dataset.pct = '0';
    }
    el.textContent = text;
    const dbg = Object.entries(context).filter(([k]) => k !== 'isEstimate').map(([k, v]) => `${k}: ${v}`).join('\n');
    el.title = dbg || text;
}

// ---------- auth ----------

async function api(method, path, body) {
    const res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    return { status: res.status, ok: res.ok, data: await res.json().catch(() => null) };
}

async function checkAuth() {
    const r = await api('GET', '/api/auth/session').catch(() => ({ status: 0 }));
    if (r.status === 200) return true;
    showLogin();
    return false;
}

function showLogin() {
    $('#v-login').style.display = 'flex';
}

async function doLogin() {
    const r = await api('POST', '/api/auth/login', {
        username: $('#login-user').value.trim(),
        password: $('#login-pass').value
    });
    if (r.status === 200) {
        $('#v-login').style.display = 'none';
        boot();
    } else {
        $('#login-err').textContent = r.data?.error || `login failed (${r.status})`;
    }
}

// ---------- chat list ----------

async function loadChats(selectFirst = false) {
    const r = await api('GET', '/api/chats');
    if (r.status !== 200) { showLogin(); return; }
    const list = $('#v-chats');
    list.innerHTML = '';
    for (const s of r.data?.data || []) {
        const item = document.createElement('div');
        item.className = 'chat-item' + (s.id === chatId ? ' active' : '');
        item.dataset.id = s.id;
        const title = document.createElement('div');
        title.className = 'chat-title';
        title.textContent = s.title || s.id;
        const sub = document.createElement('div');
        sub.className = 'chat-sub';
        sub.textContent = `${s.messageCount ?? 0} msg${s.mode === 'arena' ? ' · arena' : ''}`;
        item.append(title, sub);
        item.onclick = () => openChat(s.id);
        list.appendChild(item);
    }
    if (selectFirst && !chatId) {
        const first = list.querySelector('.chat-item');
        if (first) openChat(first.dataset.id);
    }
}

async function newChat() {
    const model = $('#v-model').value || (models.find(m => m.type === 'chat' || !m.type))?.id;
    const r = await api('POST', '/api/chats', { title: 'New Chat', mode: 'direct', model });
    if (r.status !== 201) return;
    await loadChats();
    openChat(r.data.id);
}

// ---------- conversation stream ----------

function detach() {
    if (es) { es.close(); es = null; }
}

async function openChat(id) {
    detach();
    chatId = id;
    document.querySelectorAll('.chat-item').forEach(el => el.classList.toggle('active', el.dataset.id === id));
    R.clear();

    // snapshot via the events stream (snapshot event carries the view form)
    es = new EventSource(`/api/chats/${id}/events`);
    es.addEventListener('snapshot', (e) => {
        const snap = JSON.parse(e.data);
        R.renderSnapshot(snap.messages || [], { title: snap.meta?.title });
        if (snap.meta?.title) $('#v-title').value = snap.meta.title;
        $('#v-sysprompt').value = snap.meta?.systemPrompt || '';
        if (snap.inFlight) {
            R.beginStream({ messageId: snap.inFlight.id, model: snap.inFlight.model });
            R.streamDelta({ content: snap.inFlight.content, reasoningContent: snap.inFlight.reasoning_content });
            setRunning(true);
        }
        showContext(snap.lastRun?.context || null);
    });
    es.addEventListener('run.start', (e) => {
        const d = JSON.parse(e.data);
        R.beginStream({ messageId: d.messageId, model: d.model });
        setRunning(true);
    });
    es.addEventListener('delta', (e) => {
        R.streamDelta(JSON.parse(e.data));
    });
    es.addEventListener('tool.start', (e) => R.toolStart(JSON.parse(e.data)));
    es.addEventListener('tool.end', (e) => R.toolEnd(JSON.parse(e.data)));
    es.addEventListener('msg.assistant', (e) => R.finalizeAssistant(JSON.parse(e.data)));
    es.addEventListener('msg.user', (e) => R.upsertMessage(JSON.parse(e.data)));
    es.addEventListener('msg.deleted', (e) => R.removeMessage(JSON.parse(e.data).messageId));
    es.addEventListener('run.end', (e) => {
        const d = JSON.parse(e.data);
        setRunning(false);
        showContext(d.context || null);
        if (d.finishReason === 'aborted') R.runLine('aborted');
        if (d.finishReason === 'error') R.runLine('error');
        loadChats(); // refresh counts/titles
    });
    es.addEventListener('error', (e) => {
        if (e.data) R.errorLine(JSON.parse(e.data).message || 'error');
    });
    es.addEventListener('embed.status', (e) => R.embedStatus(JSON.parse(e.data)));

    // session meta: system prompt (user portion only), model
    const r = await api('GET', `/api/chats/${id}`);
    if (r.status === 200) {
        $('#v-model').value = r.data.session?.model || $('#v-model').value;
        $('#v-sysprompt').value = r.data.session?.systemPrompt || '';
        $('#v-title').value = r.data.session?.title || '';
    }
}

function setRunning(on) {
    $('#v-send').style.display = on ? 'none' : '';
    $('#v-abort').style.display = on ? '' : 'none';
}

// ---------- send / abort / edit ----------

async function send() {
    if (!chatId) await newChat();
    if (!chatId) return;
    const inp = $('#v-input');
    const content = inp.value.trim();
    if (!content) return;
    inp.value = '';
    const r = await api('POST', `/api/chats/${chatId}/send`, { content });
    if (r.status !== 201) R.errorLine(r.data?.error || `send failed (${r.status})`);
}

async function abort() {
    if (!chatId) return;
    await api('POST', `/api/chats/${chatId}/abort`);
}

let syspromptTimer = null;
function queueSyspromptSave() {
    clearTimeout(syspromptTimer);
    syspromptTimer = setTimeout(async () => {
        if (!chatId) return;
        await api('PATCH', `/api/chats/${chatId}`, { systemPrompt: $('#v-sysprompt').value });
    }, 600);
}

let titleTimer = null;
function queueTitleSave() {
    clearTimeout(titleTimer);
    titleTimer = setTimeout(async () => {
        if (!chatId) return;
        const title = $('#v-title').value.trim();
        if (!title) return;
        await api('PATCH', `/api/chats/${chatId}`, { title });
        loadChats();
    }, 600);
}

// ---------- models ----------

async function loadModels() {
    const r = await api('GET', '/api/models');
    if (r.status !== 200) return;
    models = (r.data?.data || []).filter(m => m.type === 'chat' || !m.type);
    const sel = $('#v-model');
    const prev = sel.value;
    sel.innerHTML = '';
    for (const m of models) {
        const o = document.createElement('option');
        o.value = m.id;
        o.textContent = m.id;
        sel.appendChild(o);
    }
    if (prev && models.some(m => m.id === prev)) sel.value = prev;
}

async function onModelChange() {
    if (!chatId) return;
    await api('PATCH', `/api/chats/${chatId}`, { model: $('#v-model').value });
}

// ---------- boot ----------

async function boot() {
    await loadModels();
    await loadChats(true);
}

function wire() {
    $('#v-send').onclick = send;
    $('#v-abort').onclick = abort;
    $('#v-abort').style.display = 'none';
    $('#v-new').onclick = () => newChat();
    $('#v-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    $('#v-sysprompt').addEventListener('input', queueSyspromptSave);
    $('#v-title').addEventListener('input', queueTitleSave);
    $('#v-model').addEventListener('change', onModelChange);
    $('#login-btn').onclick = doLogin;
    $('#login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    $('#v-refresh').onclick = () => { loadChats(); loadModels(); };
    R.setDeleteHandler(async (messageId) => {
        if (!chatId || !messageId) return;
        if (!confirm('Delete this message?')) return;
        const r = await api('DELETE', `/api/chats/${chatId}/messages/${messageId}`);
        if (r.status === 200) R.removeMessage(messageId);
        else if (r.data?.error) R.errorLine(r.data.error);
    });
}

wire();
checkAuth().then(ok => { if (ok) boot(); });
