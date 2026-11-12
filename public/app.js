// minimi client: vanilla JS, no build step. Streams SSE from POST /api/chat.

const $ = (sel) => document.querySelector(sel);
const els = {
  messages: $('#messages'),
  empty: $('#empty'),
  input: $('#input'),
  send: $('#send'),
  composer: $('#composer'),
  convList: $('#convList'),
  convTitle: $('#convTitle'),
  newChat: $('#newChat'),
  debug: $('#debug'),
  debugBody: $('#debugBody'),
  debugToggle: $('#debugToggle'),
  sidebar: $('#sidebar'),
  menuBtn: $('#menuBtn'),
  health: $('#health'),
  app: $('#app'),
  scrim: $('#scrim'),
  sidebarClose: $('#sidebarClose'),
  newChatTop: $('#newChatTop'),
  debugClose: $('#debugClose'),
  jump: $('#jumpBtn'),
};

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
let conversationId = new URLSearchParams(location.hash.slice(1)).get('c') || null;
let busy = false;
let serverNow = null; // FAKE_NOW-aware "today" for the history labels

// Layout modes; keep in sync with the breakpoints in style.css.
const drawerMQ = matchMedia('(max-width: 1023px)'); // sidebar is an off-canvas drawer
const overlayMQ = matchMedia('(max-width: 1279px)'); // debug panel floats over the chat

const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;

// ---------- utils ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function fmtDay(iso) {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtTime(iso) {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d.length === 10 ? d + 'T12:00:00' : d);
  return dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// ---------- tiny markdown renderer (escape first, then format) ----------

function inline(s, sources) {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  out = out.replace(/\[(S\d+)\]/g, (m, id) => {
    const s = sources?.find((x) => x.id === id);
    if (!s) return '';
    const tip = `${s.domain} · ${s.tier}${s.publishedAt ? ' · published ' + fmtDate(s.publishedAt) : ''} · checked ${fmtDate(s.retrievedAt)}`;
    return `<a class="cite ${s.tier}" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(tip)}">${id}</a>`;
  });
  return out;
}

function renderMarkdown(md, sources) {
  const lines = String(md ?? '').replace(/\r/g, '').split('\n');
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      html.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const row = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = row(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) body.push(row(lines[i++]));
      html.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${inline(h, sources)}</th>`).join('')}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c, sources)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      html.push(`<h${h[1].length}>${inline(h[2], sources)}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.map((it) => `<li>${inline(it, sources)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      html.push(`<blockquote>${inline(buf.join(' '), sources)}</blockquote>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      html.push('<hr>');
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*\||\s*([-*•]|\d+[.)])\s+|>)/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) buf.push(lines[i++]);
    html.push(`<p>${buf.map((b) => inline(b, sources)).join('<br>')}</p>`);
  }
  return html.join('');
}

// ---------- rendering ----------

function sourcesHtml(sources) {
  if (!sources?.length) return '';
  const chip = (s) =>
    `<a class="src" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.title || s.url)}"><span class="sid">${s.id}</span><span class="dom">${esc(s.domain)}</span><span class="tier ${s.tier}">${s.tier}</span><span class="date">${
      s.publishedAt ? fmtDate(s.publishedAt) : 'checked ' + fmtDate(s.retrievedAt)
    }</span></a>`;
  const cited = sources.filter((s) => s.cited);
  const other = sources.filter((s) => !s.cited);
  return `${cited.length ? `<div class="sources">${cited.map(chip).join('')}</div>` : ''}${
    other.length ? `<details class="more-src"><summary>${other.length} more source${other.length > 1 ? 's' : ''} searched</summary><div class="sources">${other.map(chip).join('')}</div></details>` : ''
  }`;
}

function addUser(text, at) {
  els.empty?.remove();
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = `<div class="meta">${at ? fmtTime(at) : ''}</div><div class="bubble">${esc(text)}</div>`;
  els.messages.appendChild(div);
  scroll();
}

function addAssistant() {
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.innerHTML = `<div class="msg-head"><span class="avatar">${icon('logo')}</span><span>minimi</span></div><div class="status" role="status"><span class="dot"></span><span class="status-text">Thinking…</span></div><details class="trail" hidden><summary>Steps</summary><ul></ul></details><div class="bubble md"></div><div class="src-wrap"></div>`;
  els.messages.appendChild(div);
  scroll();
  const bubble = div.querySelector('.bubble');
  return {
    el: div,
    status(text) {
      div.querySelector('.status-text').textContent = text;
      const trail = div.querySelector('.trail');
      trail.hidden = false;
      const li = document.createElement('li');
      li.textContent = text;
      trail.querySelector('ul').appendChild(li);
    },
    draft(md) {
      bubble.classList.toggle('streaming', !!md);
      bubble.innerHTML = renderMarkdown(md, []);
      scroll(true);
    },
    final(md, sources) {
      div.querySelector('.status')?.remove();
      bubble.classList.remove('streaming');
      bubble.innerHTML = renderMarkdown(md, sources);
      div.querySelector('.src-wrap').innerHTML = sourcesHtml(sources);
    },
    error(msg) {
      div.querySelector('.status')?.remove();
      bubble.classList.remove('streaming');
      bubble.innerHTML = `<div class="error" role="alert">${icon('alert')}<span>${esc(msg)}</span></div>`;
    },
  };
}

function scroll(onlyIfNear = false) {
  const m = els.messages;
  if (onlyIfNear && m.scrollHeight - m.scrollTop - m.clientHeight > 200) return updateJump();
  m.scrollTop = m.scrollHeight;
  updateJump();
}

// "Jump to latest" appears once the reader scrolls away from the bottom.
function updateJump() {
  const m = els.messages;
  els.jump.hidden = m.scrollHeight - m.scrollTop - m.clientHeight < 320;
}
els.messages.addEventListener('scroll', updateJump, { passive: true });
new ResizeObserver(updateJump).observe(els.messages);
els.jump.addEventListener('click', () => {
  const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
});

// ---------- debug drawer ----------

function renderDebug(d) {
  if (!d) return;
  const t = d.timings || {};
  const kv = (o) => `<div class="kv">${Object.entries(o).map(([k, v]) => `<span>${esc(k)}</span><span>${esc(v)}</span>`).join('')}</div>`;
  const stat = (k, v) => `<div class="stat"><span class="stat-k">${esc(k)}</span><span class="stat-v">${esc(v ?? '–')}<small>ms</small></span></div>`;
  const parts = [];
  parts.push(
    `<h4>Timings & model</h4><div class="stat-grid">${stat('resolve dates', t.resolveMs)}${stat('memory retrieval', t.retrieveMs)}${stat('first answer token', t.firstTokenMs)}${stat('total', t.totalMs)}</div>${kv({ model: d.model || '–', rounds: d.rounds?.length ?? '–', 'tavily credits': d.credits ?? 0 })}`,
  );
  if (d.fallbacks?.length) parts.push(`<h4>Fallbacks</h4><pre>${esc(d.fallbacks.map((f) => `${f.from}: ${f.reason}`).join('\n'))}</pre>`);
  parts.push(`<h4>Router</h4>${kv({ 'memory intent': d.route?.memoryIntent, 'change intent': d.route?.changeIntent })}`);
  parts.push(
    `<h4>Resolved dates</h4>${
      d.windows?.length
        ? `<table>${d.windows.map((w) => `<tr><td>"${esc(w.phrase)}"</td><td>${esc(w.label)}</td><td>${w.confidence}</td></tr>`).join('')}</table>`
        : '<p class="muted">none</p>'
    }`,
  );
  const mem = d.memory || {};
  parts.push(`<h4>Injected memory</h4>${mem.block || d.memoryBlock ? `<pre>${esc(mem.block || d.memoryBlock)}</pre>` : '<p class="muted">none</p>'}`);
  if (d.searches?.length)
    parts.push(
      `<h4>Searches</h4><table><tr><th>kind</th><th>query</th><th>res</th><th>ms</th></tr>${d.searches
        .map(
          (s) =>
            `<tr><td>${esc(s.kind)}</td><td>${esc(s.query)}${s.params?.include_domains?.length ? `<br><span class="muted">domains: ${esc(s.params.include_domains.join(', '))}</span>` : ''}${
              s.params?.start_date ? `<br><span class="muted">since ${esc(s.params.start_date)}</span>` : ''
            }${s.error ? `<br><span class="pill changed">${esc(s.error)}</span>` : ''}</td><td>${s.results}</td><td>${s.ms}${s.cacheHit ? ' (cache)' : ''}</td></tr>`,
        )
        .join('')}</table>`,
    );
  if (d.diff?.length)
    parts.push(
      `<h4>Diff (computed in code)</h4><table><tr><th>item</th><th>then</th><th>now</th><th></th></tr>${d.diff
        .map((r) => `<tr><td>${esc(r.entity)}${r.plan ? ` (${esc(r.plan)})` : ''}<br><span class="muted">${esc(r.attribute)}</span></td><td>${esc(r.then.value)}<br><span class="muted">${esc(r.then.asOf)}${r.then.demo ? ' DEMO' : ''}</span></td><td>${esc(r.now.value ?? '–')}<br><span class="muted">${esc(r.now.domain ?? r.note ?? '')}</span></td><td><span class="pill ${r.status}">${r.status.replace('_', ' ')}</span></td></tr>`)
        .join('')}</table>`,
    );
  if (d.claimCheck?.length)
    parts.push(
      `<h4>Answer claims checked against sources</h4><table>${d.claimCheck
        .map((c) => `<tr><td>${esc(c.entity)} ${esc(c.attribute)}</td><td>${esc(c.value)} ${esc(c.sources.join(','))}</td><td><span class="pill ${c.supported ? 'unchanged' : c.approximate ? 'cant_verify' : 'changed'}">${c.supported ? 'supported' : c.approximate ? 'estimate' : 'unsupported'}</span></td></tr>`)
        .join('')}</table>`,
    );
  if (d.citations) parts.push(`<h4>Citations</h4>${kv({ used: d.citations.used.join(', ') || '–', 'dropped (invalid)': d.citations.dropped.join(', ') || '–' })}`);
  els.debugBody.innerHTML = parts.join('');
}

function setDebug(open, persist = true) {
  els.debugToggle.checked = open;
  els.debug.hidden = !open;
  if (persist) {
    try {
      localStorage.setItem('minimi.debug', open ? '1' : '0');
    } catch {}
  }
}
els.debugToggle.addEventListener('change', () => {
  setDebug(els.debugToggle.checked);
  if (els.debugToggle.checked && overlayMQ.matches) closeSidebar();
});
els.debugClose.addEventListener('click', () => {
  setDebug(false);
  els.debugToggle.focus();
});
try {
  // Restore the panel only where it sits beside the chat; on smaller screens it
  // would cover the conversation on every load, so it waits for the toggle.
  if (localStorage.getItem('minimi.debug') === '1' && !overlayMQ.matches) setDebug(true, false);
} catch {}

// ---------- sidebar (inline + collapsible on desktop, drawer below 1024px) ----------

function syncSidebarA11y() {
  const expanded = drawerMQ.matches ? els.app.classList.contains('sidebar-open') : !els.app.classList.contains('sidebar-collapsed');
  els.menuBtn.setAttribute('aria-expanded', String(expanded));
}
function openSidebar() {
  els.app.classList.add('sidebar-open');
  syncSidebarA11y();
  setTimeout(() => (els.convList.querySelector('.conv-item.active') || els.newChat).focus({ preventScroll: true }), 50);
}
function closeSidebar(restoreFocus = false) {
  if (!els.app.classList.contains('sidebar-open')) return;
  els.app.classList.remove('sidebar-open');
  syncSidebarA11y();
  if (restoreFocus) els.menuBtn.focus();
}
function toggleSidebar() {
  if (drawerMQ.matches) {
    if (els.app.classList.contains('sidebar-open')) closeSidebar();
    else openSidebar();
  } else {
    const collapsed = els.app.classList.toggle('sidebar-collapsed');
    try {
      localStorage.setItem('minimi.sidebar', collapsed ? 'collapsed' : 'open');
    } catch {}
    syncSidebarA11y();
  }
}
try {
  if (localStorage.getItem('minimi.sidebar') === 'collapsed') els.app.classList.add('sidebar-collapsed');
} catch {}
drawerMQ.addEventListener('change', () => {
  els.app.classList.remove('sidebar-open');
  syncSidebarA11y();
});
syncSidebarA11y();

els.sidebarClose.addEventListener('click', () => closeSidebar(true));
els.scrim.addEventListener('click', () => {
  closeSidebar();
  if (overlayMQ.matches && !els.debug.hidden) setDebug(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (drawerMQ.matches && els.app.classList.contains('sidebar-open')) {
    closeSidebar(true);
  } else if (overlayMQ.matches && !els.debug.hidden) {
    setDebug(false);
    els.debugToggle.focus();
  }
});

// ---------- conversations ----------

// Group heading: "Today" / "Yesterday" with the date beside it, else the full day.
function dayLabel(iso) {
  const d = new Date(iso);
  const today = serverNow ? new Date(serverNow) : new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86400000);
  const short = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  if (diff === 0) return `Today<span class="conv-day-date">${esc(short)}</span>`;
  if (diff === 1) return `Yesterday<span class="conv-day-date">${esc(short)}</span>`;
  return esc(d.getFullYear() === today.getFullYear() ? short : fmtDay(iso));
}
const fmtClock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

let lastConversations = [];
async function loadConversations() {
  const list = await fetch('/api/conversations').then((r) => r.json()).catch(() => []);
  lastConversations = list;
  renderConversations(list);
}

function renderConversations(list) {
  const groups = new Map();
  for (const c of list) {
    const day = fmtDay(c.started_at);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(c);
  }
  els.convList.innerHTML =
    [...groups.values()]
      .map(
        (cs) =>
          `<h2 class="conv-day">${dayLabel(cs[0].started_at)}</h2><ul class="conv-group">${cs
            .map((c) => {
              const active = c.id === conversationId;
              return `<li><button type="button" class="conv-item${active ? ' active' : ''}"${active ? ' aria-current="page"' : ''} data-id="${esc(c.id)}" title="${esc(c.title)} · ${esc(fmtTime(c.started_at))}"><span class="conv-title">${esc(c.title)}</span><time class="conv-time" datetime="${esc(c.started_at)}">${esc(fmtClock(c.started_at))}</time></button></li>`;
            })
            .join('')}</ul>`,
      )
      .join('') || '<p class="conv-empty"><strong>No conversations yet.</strong>Your chats will appear here, grouped by day.</p>';
}

els.convList.addEventListener('click', (e) => {
  const btn = e.target.closest('.conv-item');
  if (!btn) return;
  openConversation(btn.dataset.id);
  closeSidebar();
});

async function openConversation(id) {
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
  if (!res.ok) return newChat();
  const conv = await res.json();
  conversationId = conv.id;
  location.hash = `c=${conv.id}`;
  els.convTitle.textContent = conv.title;
  els.messages.innerHTML = '';
  let lastDebug = null;
  for (const m of conv.messages) {
    if (m.role === 'user') addUser(m.content, m.created_at);
    else {
      const a = addAssistant();
      a.final(m.content, m.sources);
      lastDebug = m.debug;
    }
  }
  renderDebug(lastDebug);
  loadConversations();
}

function newChat() {
  conversationId = null;
  history.replaceState(null, '', location.pathname);
  els.convTitle.textContent = 'New conversation';
  els.messages.innerHTML = '';
  els.messages.appendChild(emptyState);
  updateJump();
  loadConversations();
  closeSidebar();
  els.input.focus();
}
const emptyState = els.empty;
els.newChat.addEventListener('click', newChat);
els.newChatTop.addEventListener('click', newChat);
els.menuBtn.addEventListener('click', toggleSidebar);
emptyState.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  els.input.value = b.dataset.prompt || b.textContent.trim();
  send();
});

// ---------- sending ----------

async function send() {
  const text = els.input.value.trim();
  if (!text || busy) return;
  busy = true;
  els.send.disabled = true;
  els.input.value = '';
  autosize();
  addUser(text, new Date().toISOString());
  const a = addAssistant();
  let draft = '';

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, conversationId, tz }),
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let finished = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        let data = '';
        for (const l of raw.split('\n')) {
          if (l.startsWith('event:')) event = l.slice(6).trim();
          else if (l.startsWith('data:')) data += l.slice(5).trim();
        }
        const ev = data ? JSON.parse(data) : {};
        if (event === 'meta') {
          if (!conversationId) {
            conversationId = ev.conversationId;
            location.hash = `c=${conversationId}`;
            els.convTitle.textContent = text.slice(0, 70);
          }
        } else if (event === 'status') a.status(ev.text);
        else if (event === 'token') {
          draft += ev.text;
          a.draft(draft);
        } else if (event === 'reset') {
          draft = '';
          a.draft('');
        } else if (event === 'final') {
          finished = true;
          a.final(ev.text, ev.sources);
        } else if (event === 'debug') renderDebug(ev.data);
        else if (event === 'error') {
          finished = true;
          a.error(ev.message);
        }
      }
    }
    if (!finished) a.error('The connection closed before the answer finished.');
  } catch (err) {
    a.error(`Request failed: ${err.message}`);
  } finally {
    busy = false;
    els.send.disabled = false;
    loadConversations();
    els.input.focus();
  }
}

els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(200, els.input.scrollHeight) + 'px';
}
els.input.addEventListener('input', autosize);

// ---------- boot ----------

fetch('/api/health')
  .then((r) => r.json())
  .then((h) => {
    const ready = !!h.models?.length && h.search !== 'missing key';
    els.health.innerHTML = `<div class="health-row" title="${esc((h.models || []).join(' → ') || 'no model')}"><span class="health-dot${ready ? '' : ' off'}" aria-hidden="true"></span><span class="health-model">${esc(h.models?.[0] ?? 'no model')}</span></div><div class="health-meta"><span>search · ${esc(h.search)}</span>${h.fakeNow ? `<span class="health-fake">FAKE_NOW ${esc(h.fakeNow)}</span>` : ''}</div>`;
    if (h.now) {
      serverNow = h.now;
      if (lastConversations.length) renderConversations(lastConversations);
    }
  })
  .catch(() => {
    els.health.innerHTML = `<div class="health-row"><span class="health-dot off" aria-hidden="true"></span><span>Server unreachable</span></div>`;
  });
loadConversations();
if (conversationId) openConversation(conversationId);
