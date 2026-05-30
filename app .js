/* ══════════════════════════════════════════
   NEXUS — PERSONAL NETWORK AGENT
   Main Application JavaScript
   Backend: Coral Agent (local_source.yaml)
══════════════════════════════════════════ */

'use strict';

// ─────────────────────────────────────────
//  CORAL API CONFIG
//  Coral runs locally via: coral serve local_source.yaml
//  Default port: 3000  ← change CORAL_PORT if you used --port
// ─────────────────────────────────────────
const CORAL_BASE  = 'http://localhost:3000';
const CORAL_TABLE = 'local_network';          // matches `name:` in yaml

// Helper: run a SQL query against Coral and return rows array
async function coralQuery(sql) {
  const res = await fetch(`${CORAL_BASE}/query`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`Coral HTTP ${res.status}: ${res.statusText}`);
  const json = await res.json();
  // Coral wraps results in { rows: [...] } or returns the array directly
  return Array.isArray(json) ? json : (json.rows ?? json.data ?? []);
}

// Show/hide a status banner at top of page
function setBackendStatus(online) {
  let banner = document.getElementById('coral-status-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'coral-status-banner';
    banner.style.cssText = [
      'position:fixed','bottom:12px','right:16px','z-index:9999',
      'padding:6px 14px','border-radius:4px','font-family:var(--font-mono,monospace)',
      'font-size:11px','letter-spacing:.08em','pointer-events:none',
      'transition:opacity .4s',
    ].join(';');
    document.body.appendChild(banner);
  }
  if (online) {
    banner.textContent  = '⬡ CORAL BACKEND ONLINE';
    banner.style.background = 'rgba(0,245,255,.12)';
    banner.style.border     = '1px solid rgba(0,245,255,.5)';
    banner.style.color      = '#00f5ff';
    setTimeout(() => { banner.style.opacity = '0'; }, 4000);
  } else {
    banner.textContent  = '⚠ CORAL OFFLINE — using local cache';
    banner.style.background = 'rgba(255,200,0,.12)';
    banner.style.border     = '1px solid rgba(255,200,0,.5)';
    banner.style.color      = '#ffc800';
    banner.style.opacity    = '1';
  }
}

// ─────────────────────────────────────────
//  STATE
//  • connections  ← social_influencers  + manually added cards
//  • events       ← upcoming_events     + manually added events
//  • interactions ← interaction_ledger  (read-only CRM data)
//  localStorage is the offline/write-back store.
// ─────────────────────────────────────────
let connections  = JSON.parse(localStorage.getItem('nexus_connections')  || '[]');
let events       = JSON.parse(localStorage.getItem('nexus_events')       || '[]');
let interactions = JSON.parse(localStorage.getItem('nexus_interactions') || '[]');
let calYear, calMonth;

// ─────────────────────────────────────────
//  BOOT: pull all three tables from Coral
// ─────────────────────────────────────────
async function syncFromCoral() {
  try {
    const [influencers, eventsData, ledger] = await Promise.all([
      coralQuery(`SELECT * FROM ${CORAL_TABLE}.social_influencers`),
      coralQuery(`SELECT * FROM ${CORAL_TABLE}.upcoming_events`),
      coralQuery(`SELECT * FROM ${CORAL_TABLE}.interaction_ledger`),
    ]);

    setBackendStatus(true);

    // ── social_influencers → connections ──────────────────────────────────
    // Only merge rows not already present (keyed by influencer_id)
    const existingIds = new Set(connections.map(c => c._coral_id).filter(Boolean));
    const newConns = influencers
      .filter(row => !existingIds.has(row.influencer_id))
      .map(row => ({
        id         : 'coral_' + row.influencer_id,
        _coral_id  : row.influencer_id,
        name       : row.full_name        || '',
        role       : row.primary_industry || '',
        field      : mapIndustryToField(row.primary_industry),
        linkedin   : row.linkedin_url     || '',
        github     : '',                         // not in schema
        score      : clamp(Number(row.influence_score) || 0, 0, 100),
        notes      : `X: ${row.x_handle || '—'}  |  Event: ${row.attending_event_id || '—'}`,
        addedAt    : new Date().toISOString(),
        _source    : 'coral',
      }));

    if (newConns.length) {
      connections = [...connections, ...newConns];
      save();
      addLog(`Coral: loaded ${newConns.length} influencer(s)`);
    }

    // ── upcoming_events → events ──────────────────────────────────────────
    const existingEventIds = new Set(events.map(e => e._coral_id).filter(Boolean));
    const newEvts = eventsData
      .filter(row => !existingEventIds.has(row.event_id))
      .map(row => ({
        id       : 'coral_evt_' + row.event_id,
        _coral_id: row.event_id,
        title    : row.event_name  || 'Untitled Event',
        date     : parseCoralDate(row.event_date),
        time     : '',
        type     : row.industry    || 'Conference',
        desc     : `${row.location || ''} — ${row.attendee_count || 0} attendees`,
        _source  : 'coral',
      }));

    if (newEvts.length) {
      events = [...events, ...newEvts];
      save();
      addLog(`Coral: loaded ${newEvts.length} event(s)`);
    }

    // ── interaction_ledger → interactions (dashboard CRM panel) ───────────
    interactions = ledger.map(row => ({
      id       : row.interaction_id,
      name     : row.person_name       || '',
      lastSeen : row.last_contact_date || null,
      status   : row.status            || '',
      notes    : row.notes             || '',
    }));
    localStorage.setItem('nexus_interactions', JSON.stringify(interactions));
    if (interactions.length) addLog(`Coral: loaded ${interactions.length} CRM record(s)`);

    // Re-render everything with fresh data
    updateDashboard();
    renderConnections();
    renderCalendar();
    renderRankings();

  } catch (err) {
    console.warn('[Coral] Could not reach backend:', err.message);
    setBackendStatus(false);
    addLog('Coral offline — showing cached data');
  }
}

// Map Coral industry strings to the fixed field options in the UI
function mapIndustryToField(industry) {
  if (!industry) return 'Research';
  const i = industry.toLowerCase();
  if (i.includes('ai') || i.includes('ml') || i.includes('machine')) return 'AI / ML';
  if (i.includes('web') || i.includes('front') || i.includes('full')) return 'Web Dev';
  if (i.includes('data')) return 'Data Science';
  if (i.includes('design') || i.includes('ux') || i.includes('ui'))  return 'Design';
  if (i.includes('devops') || i.includes('cloud') || i.includes('infra')) return 'DevOps';
  if (i.includes('block') || i.includes('crypto') || i.includes('web3'))  return 'Blockchain';
  if (i.includes('cyber') || i.includes('security') || i.includes('sec'))  return 'Cybersecurity';
  return 'Research';
}

// Normalise various date strings from Coral to YYYY-MM-DD
function parseCoralDate(raw) {
  if (!raw) return new Date().toISOString().split('T')[0];
  // already ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  // MM/DD/YYYY
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  // Try native parse
  const d = new Date(raw);
  return isNaN(d) ? new Date().toISOString().split('T')[0] : d.toISOString().split('T')[0];
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// ─────────────────────────────────────────
//  GLITTER CURSOR
// ─────────────────────────────────────────
(function initGlitter() {
  const canvas = document.getElementById('glitter-canvas');
  const ctx    = canvas.getContext('2d');
  let W, H;
  const particles = [];
  let mouseX = -200, mouseY = -200;
  let lastX = -200, lastY = -200;

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  const COLORS = [
    'rgba(0,245,255,',
    'rgba(0,128,255,',
    'rgba(0,255,208,',
    'rgba(128,0,255,',
    'rgba(255,255,255,',
  ];

  function spawnParticles(x, y, count) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 2.5 + 0.5;
      const size  = Math.random() * 4 + 1;
      const color = COLORS[Math.floor(Math.random() * COLORS.length)];
      particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1,
        size,
        alpha: 1,
        decay: Math.random() * 0.025 + 0.015,
        color,
        glow : Math.random() > 0.6,
        shape: Math.random() > 0.5 ? 'circle' : 'star',
      });
    }
  }

  function drawStar(ctx, x, y, r) {
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    ctx.stroke();
  }

  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    const dx   = mouseX - lastX;
    const dy   = mouseY - lastY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 4) {
      spawnParticles(mouseX, mouseY, Math.min(Math.floor(dist / 3) + 1, 6));
      lastX = mouseX;
      lastY = mouseY;
    }
  });

  document.addEventListener('mousemove', (e) => {
    document.documentElement.style.setProperty('--cx', e.clientX + 'px');
    document.documentElement.style.setProperty('--cy', e.clientY + 'px');
  });

  function animate() {
    ctx.clearRect(0, 0, W, H);
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x  += p.vx;
      p.y  += p.vy;
      p.vy += 0.05;
      p.alpha -= p.decay;
      if (p.alpha <= 0) { particles.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = p.alpha;
      if (p.glow) { ctx.shadowBlur = 10; ctx.shadowColor = p.color + '0.8)'; }
      ctx.strokeStyle = p.color + p.alpha + ')';
      ctx.fillStyle   = p.color + p.alpha + ')';
      ctx.lineWidth   = 1;
      if (p.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else {
        drawStar(ctx, p.x, p.y, p.size * 1.5);
      }
      ctx.restore();
    }
    requestAnimationFrame(animate);
  }
  animate();
})();

// ─────────────────────────────────────────
//  NAVIGATION
// ─────────────────────────────────────────
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    const section = document.getElementById(btn.dataset.section);
    if (section) section.classList.add('active');
    if (btn.dataset.section === 'rankings')  renderRankings();
    if (btn.dataset.section === 'calendar')  renderCalendar();
    if (btn.dataset.section === 'dashboard') updateDashboard();
  });
});

// ─────────────────────────────────────────
//  DASHBOARD
// ─────────────────────────────────────────
function animateCount(el, target, duration = 800) {
  const start = parseInt(el.textContent) || 0;
  const diff  = target - start;
  const steps = 30;
  let step    = 0;
  const interval = setInterval(() => {
    step++;
    el.textContent = Math.round(start + diff * (step / steps));
    if (step >= steps) { el.textContent = target; clearInterval(interval); }
  }, duration / steps);
}

function updateDashboard() {
  animateCount(document.getElementById('stat-connections'), connections.length);
  animateCount(document.getElementById('stat-events'),  events.length);
  animateCount(document.getElementById('stat-fields'),
    [...new Set(connections.map(c => c.field))].length);

  const top = connections.length
    ? Math.max(...connections.map(c => c.score))
    : 0;
  animateCount(document.getElementById('stat-top'), top);

  // Recent connections panel
  const list = document.getElementById('recent-list');
  if (!connections.length) {
    list.innerHTML = '<div class="empty-state">No connections yet. Add your network →</div>';
  } else {
    const recent = [...connections].reverse().slice(0, 5);
    list.innerHTML = recent.map(c => `
      <div class="recent-item">
        <div class="recent-avatar">${initials(c.name)}</div>
        <div class="recent-info">
          <div class="recent-name">${esc(c.name)}</div>
          <div class="recent-role">${esc(c.role)} · ${esc(c.field)}</div>
        </div>
        ${c._source === 'coral'
          ? '<span style="font-size:9px;color:#00f5ff;opacity:.7;margin-left:auto">CORAL</span>'
          : ''}
      </div>
    `).join('');
  }

  // CRM / interaction ledger panel (re-use activity-log for now; we inject below recent)
  renderInteractionLedger();
}

// Render interaction_ledger rows in the activity-log panel
function renderInteractionLedger() {
  const log = document.getElementById('activity-log');
  if (!interactions.length) return;

  // Clear old CRM entries, keep SYS entries
  Array.from(log.querySelectorAll('.log-entry.crm')).forEach(e => e.remove());

  // Prepend newest CRM rows (up to 10)
  const slice = interactions.slice(0, 10).reverse();
  slice.forEach(row => {
    const entry = document.createElement('div');
    entry.className = 'log-entry crm';
    const statusColor = row.status.toLowerCase().includes('active')
      ? '#00f5ff' : row.status.toLowerCase().includes('pending')
      ? '#ffc800' : '#888';
    entry.innerHTML = `
      <span class="log-time" style="color:${statusColor}">${esc(row.status.toUpperCase().slice(0,6))}</span>
      <span class="log-msg">${esc(row.name)}${row.lastSeen ? ' · ' + row.lastSeen : ''}</span>
    `;
    log.appendChild(entry);
  });
}

function addLog(msg) {
  const log  = document.getElementById('activity-log');
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${esc(msg)}</span>`;
  log.prepend(entry);
  while (log.children.length > 30) log.removeChild(log.lastChild);
}

// ─────────────────────────────────────────
//  CONNECTIONS
// ─────────────────────────────────────────
function renderConnections(list = connections) {
  const grid = document.getElementById('connections-grid');
  if (!list.length) {
    grid.innerHTML = `
      <div class="empty-state-big">
        <div class="empty-icon">◈</div>
        <div>No nodes in your network yet</div>
        <div class="empty-sub">Click + ADD NODE to begin</div>
      </div>`;
    return;
  }
  grid.innerHTML = list.map(c => `
    <div class="connection-card" data-id="${c.id}">
      <button class="card-delete" onclick="deleteConnection('${c.id}')">✕</button>
      ${c._source === 'coral'
        ? '<span class="card-source-badge" style="position:absolute;top:8px;left:10px;font-size:9px;color:#00f5ff;opacity:.6;font-family:monospace">CORAL</span>'
        : ''}
      <div class="card-top">
        <div class="card-avatar">${initials(c.name)}</div>
        <div class="card-info">
          <div class="card-name">${esc(c.name)}</div>
          <div class="card-role">${esc(c.role)}</div>
          <span class="card-field">${esc(c.field)}</span>
        </div>
      </div>
      <div class="card-score-row">
        <span class="score-label">SCORE</span>
        <div class="score-bar-wrap">
          <div class="score-bar-fill" style="width:${c.score}%"></div>
        </div>
        <span class="score-num">${c.score}</span>
      </div>
      <div class="card-links">
        ${c.linkedin
          ? `<a class="profile-link linkedin" href="${esc(c.linkedin)}" target="_blank" rel="noopener">
               <span class="link-icon">in</span> LINKEDIN
             </a>`
          : `<span class="profile-link" style="opacity:.3;cursor:default">NO LINKEDIN</span>`
        }
        ${c.github
          ? `<a class="profile-link github" href="${esc(c.github)}" target="_blank" rel="noopener">
               <span class="link-icon">⬡</span> GITHUB
             </a>`
          : `<span class="profile-link" style="opacity:.3;cursor:default">NO GITHUB</span>`
        }
      </div>
      ${c.notes
        ? `<div class="card-notes" style="margin-top:6px;font-size:10px;color:#888;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.notes)}">${esc(c.notes)}</div>`
        : ''}
    </div>
  `).join('');
}

// Search + filter
document.getElementById('search-input').addEventListener('input', applyFilters);
document.getElementById('field-filter').addEventListener('change', applyFilters);

function applyFilters() {
  const q     = document.getElementById('search-input').value.toLowerCase();
  const field = document.getElementById('field-filter').value;
  const filtered = connections.filter(c => {
    const matchQ = !q || c.name.toLowerCase().includes(q) || c.role.toLowerCase().includes(q);
    const matchF = !field || c.field === field;
    return matchQ && matchF;
  });
  renderConnections(filtered);
}

function deleteConnection(id) {
  connections = connections.filter(c => c.id !== id);
  save();
  renderConnections();
  renderRankings();
  updateDashboard();
  addLog('Connection removed');
}

// ─────────────────────────────────────────
//  ADD CONNECTION MODAL
// ─────────────────────────────────────────
const modalOverlay = document.getElementById('modal-overlay');
const scoreRange   = document.getElementById('f-score');
const scoreDisplay = document.getElementById('score-display');

document.getElementById('open-modal-btn').addEventListener('click', () => {
  modalOverlay.classList.add('open');
});
document.getElementById('modal-close').addEventListener('click', () => {
  modalOverlay.classList.remove('open');
});
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) modalOverlay.classList.remove('open');
});
scoreRange.addEventListener('input', () => {
  scoreDisplay.textContent = scoreRange.value;
});

document.getElementById('submit-connection').addEventListener('click', () => {
  const name     = document.getElementById('f-name').value.trim();
  const role     = document.getElementById('f-role').value.trim();
  const field    = document.getElementById('f-field').value;
  const linkedin = document.getElementById('f-linkedin').value.trim();
  const github   = document.getElementById('f-github').value.trim();
  const score    = parseInt(scoreRange.value);
  const notes    = document.getElementById('f-notes').value.trim();

  if (!name) { highlight('f-name'); return; }

  const conn = {
    id     : 'c_' + Date.now(),
    name, role, field, linkedin, github, score, notes,
    addedAt: new Date().toISOString(),
    _source: 'manual',
  };

  connections.push(conn);
  save();
  renderConnections();
  updateDashboard();
  addLog(`New connection: ${name}`);
  modalOverlay.classList.remove('open');
  clearForm(['f-name','f-role','f-linkedin','f-github','f-notes']);
  scoreRange.value = 50;
  scoreDisplay.textContent = '50';
});

// ─────────────────────────────────────────
//  RANKINGS
// ─────────────────────────────────────────
let rankField = '';

document.querySelectorAll('.rank-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.rank-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    rankField = btn.dataset.field;
    renderRankings();
  });
});

function renderRankings() {
  const list = document.getElementById('rankings-list');
  let data = [...connections];
  if (rankField) data = data.filter(c => c.field === rankField);
  data.sort((a, b) => b.score - a.score);

  if (!data.length) {
    list.innerHTML = '<div class="empty-state">No connections match this filter</div>';
    return;
  }

  list.innerHTML = data.map((c, i) => {
    const rank = i + 1;
    const rankClass = rank === 1 ? 'rank-1' : rank === 2 ? 'rank-2' : rank === 3 ? 'rank-3' : 'rank-other';
    return `
      <div class="rank-row">
        <span class="rank-number ${rankClass}">${rank <= 3 ? ['①','②','③'][rank-1] : rank}</span>
        <div class="rank-profile">
          <div class="rank-avatar">${initials(c.name)}</div>
          <div>
            <div class="rank-name">${esc(c.name)}</div>
            <div class="rank-role">${esc(c.role)}</div>
          </div>
        </div>
        <span class="rank-field-tag">${esc(c.field)}</span>
        <div class="rank-score-cell">
          <div class="rank-score-bar">
            <div class="rank-score-fill" style="width:${c.score}%"></div>
          </div>
          <span class="rank-score-num">${c.score}</span>
        </div>
        <div class="rank-links">
          ${c.linkedin ? `<a class="rank-link" href="${esc(c.linkedin)}" target="_blank" rel="noopener">LI</a>` : ''}
          ${c.github   ? `<a class="rank-link" href="${esc(c.github)}"   target="_blank" rel="noopener">GH</a>` : ''}
          ${c._source === 'coral'
            ? '<span style="font-size:9px;color:#00f5ff;opacity:.6;font-family:monospace;margin-left:4px">◈</span>'
            : ''}
        </div>
      </div>
    `;
  }).join('');
}

// ─────────────────────────────────────────
//  CALENDAR
// ─────────────────────────────────────────
(function initCal() {
  const now = new Date();
  calYear  = now.getFullYear();
  calMonth = now.getMonth();
})();

document.getElementById('prev-month').addEventListener('click', () => {
  calMonth--;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  renderCalendar();
});

document.getElementById('next-month').addEventListener('click', () => {
  calMonth++;
  if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
});

const MONTHS = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE',
                'JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];

function renderCalendar() {
  document.getElementById('cal-month-year').textContent = `${MONTHS[calMonth]} ${calYear}`;

  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';

  const firstDay    = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const today       = new Date();

  const eventDates = new Set(
    events
      .map(e => new Date(e.date))
      .filter(d => d.getFullYear() === calYear && d.getMonth() === calMonth)
      .map(d => d.getDate())
  );

  for (let i = 0; i < firstDay; i++) {
    const cell = document.createElement('div');
    cell.className = 'cal-day empty';
    grid.appendChild(cell);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const cell = document.createElement('div');
    cell.className = 'cal-day';
    cell.textContent = d;

    const isToday = d === today.getDate()
      && calMonth === today.getMonth()
      && calYear  === today.getFullYear();
    if (isToday)         cell.classList.add('today');
    if (eventDates.has(d)) cell.classList.add('has-event');

    cell.addEventListener('click', () => scrollToEventsOnDate(calYear, calMonth, d));
    grid.appendChild(cell);
  }

  renderEvents();
}

function renderEvents() {
  const el     = document.getElementById('events-list');
  const sorted = [...events].sort((a, b) => new Date(a.date) - new Date(b.date));

  if (!sorted.length) {
    el.innerHTML = '<div class="empty-state">No events scheduled</div>';
    return;
  }

  el.innerHTML = sorted.map(ev => {
    const d   = new Date(ev.date + 'T00:00:00');
    const day = d.getDate();
    const mon = MONTHS[d.getMonth()].slice(0, 3);
    return `
      <div class="event-item" data-date="${ev.date}">
        <div class="event-date-block">
          <span class="event-day-num">${String(day).padStart(2,'0')}</span>
          <span class="event-mon">${mon}</span>
        </div>
        <div class="event-details">
          <div class="event-title">
            ${esc(ev.title)}
            ${ev._source === 'coral'
              ? ' <span style="font-size:9px;color:#00f5ff;opacity:.6;font-family:monospace">◈ CORAL</span>'
              : ''}
          </div>
          <div class="event-time">${ev.time || ev.desc || '—'} &nbsp;·&nbsp; ${d.getFullYear()}</div>
          <span class="event-type-badge">${esc(ev.type)}</span>
        </div>
        <button class="event-delete" onclick="deleteEvent('${ev.id}')">✕</button>
      </div>
    `;
  }).join('');
}

function scrollToEventsOnDate(y, m, d) {
  const dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const item = document.querySelector(`.event-item[data-date="${dateStr}"]`);
  if (item) item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

window.deleteEvent = function(id) {
  events = events.filter(e => e.id !== id);
  save();
  renderCalendar();
  updateDashboard();
  addLog('Event removed');
};

// ─────────────────────────────────────────
//  ADD EVENT MODAL
// ─────────────────────────────────────────
const eventModal = document.getElementById('event-modal-overlay');

document.getElementById('open-event-modal-btn').addEventListener('click', () => {
  eventModal.classList.add('open');
  document.getElementById('e-date').value = new Date().toISOString().split('T')[0];
});

document.getElementById('event-modal-close').addEventListener('click', () => {
  eventModal.classList.remove('open');
});

eventModal.addEventListener('click', (e) => {
  if (e.target === eventModal) eventModal.classList.remove('open');
});

document.getElementById('submit-event').addEventListener('click', () => {
  const title = document.getElementById('e-title').value.trim();
  const date  = document.getElementById('e-date').value;
  const time  = document.getElementById('e-time').value;
  const type  = document.getElementById('e-type').value;
  const desc  = document.getElementById('e-desc').value.trim();

  if (!title) { highlight('e-title'); return; }
  if (!date)  { highlight('e-date');  return; }

  const ev = {
    id: 'e_' + Date.now(),
    title, date, time, type, desc,
    _source: 'manual',
  };

  events.push(ev);
  save();
  renderCalendar();
  updateDashboard();
  addLog(`Event scheduled: ${title}`);
  eventModal.classList.remove('open');
  clearForm(['e-title','e-desc']);
  document.getElementById('e-time').value = '';
});

// ─────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────
function save() {
  localStorage.setItem('nexus_connections',  JSON.stringify(connections));
  localStorage.setItem('nexus_events',       JSON.stringify(events));
}

function initials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function highlight(id) {
  const el = document.getElementById(id);
  el.style.borderColor = 'var(--red)';
  el.style.boxShadow   = '0 0 10px rgba(255,34,68,0.4)';
  el.focus();
  setTimeout(() => { el.style.borderColor = ''; el.style.boxShadow = ''; }, 2000);
}

function clearForm(ids) {
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
}

// Expose globals used by inline onclick handlers
window.deleteConnection = deleteConnection;

// ─────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────
// 1. Paint the UI immediately from localStorage cache
updateDashboard();
renderConnections();
renderCalendar();

setTimeout(() => addLog('Dashboard loaded'), 300);
setTimeout(() => addLog(`${connections.length} connections in cache`), 600);
setTimeout(() => addLog(`${events.length} events in cache`), 900);

// 2. Then pull live data from Coral (non-blocking)
syncFromCoral();
