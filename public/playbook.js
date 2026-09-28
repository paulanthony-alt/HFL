// Playbook: field drawing, the touch editor, play animation and PNG export.
// Field coords: x 0–100 (sideline to sideline), y 0–120 (offense attacks toward y = 0).

export const FIELD = { w: 100, h: 120, los: 78, endZone: 12 };
const OFF_COLORS = ['#ffffff', '#9aa4b2', '#ff6b1a', '#35c7ff', '#ffd23f', '#7cff6b', '#f7a8ff'];
const DEF_COLOR = '#ff4d6d';

const o = (id, label, x, y, color) => ({ id, label, side: 'O', x, y, color });
const d = (id, label, x, y) => ({ id, label, side: 'D', x, y, color: DEF_COLOR });

export const FORMATIONS = {
  spread: { name: 'Spread', players: [o('o1', 'QB', 50, 92, OFF_COLORS[0]), o('o2', 'C', 50, 80, OFF_COLORS[1]), o('o3', 'X', 12, 80, OFF_COLORS[2]), o('o4', 'Z', 88, 80, OFF_COLORS[3]), o('o5', 'S', 70, 82, OFF_COLORS[4])] },
  trips: { name: 'Trips', players: [o('o1', 'QB', 50, 92, OFF_COLORS[0]), o('o2', 'C', 50, 80, OFF_COLORS[1]), o('o3', 'X', 10, 80, OFF_COLORS[2]), o('o4', 'Y', 70, 81, OFF_COLORS[3]), o('o5', 'Z', 88, 80, OFF_COLORS[4])] },
  stack: { name: 'Stack', players: [o('o1', 'QB', 50, 92, OFF_COLORS[0]), o('o2', 'C', 50, 80, OFF_COLORS[1]), o('o3', 'X', 20, 80, OFF_COLORS[2]), o('o4', 'Y', 80, 80, OFF_COLORS[3]), o('o5', 'Z', 80, 86, OFF_COLORS[4])] },
  bunch: { name: 'Bunch', players: [o('o1', 'QB', 50, 92, OFF_COLORS[0]), o('o2', 'C', 50, 80, OFF_COLORS[1]), o('o3', 'X', 72, 80, OFF_COLORS[2]), o('o4', 'Y', 78, 84, OFF_COLORS[3]), o('o5', 'Z', 84, 80, OFF_COLORS[4])] },
  backfield: { name: 'Shotgun RB', players: [o('o1', 'QB', 50, 92, OFF_COLORS[0]), o('o2', 'C', 50, 80, OFF_COLORS[1]), o('o3', 'X', 12, 80, OFF_COLORS[2]), o('o4', 'Z', 88, 80, OFF_COLORS[3]), o('o5', 'RB', 60, 93, OFF_COLORS[4])] },
};
export const DEFENSES = {
  none: { name: 'No defense', players: [] },
  man: { name: 'Man', players: [d('d1', 'R', 50, 72), d('d2', 'C', 14, 72), d('d3', 'C', 86, 72), d('d4', 'C', 70, 70), d('d5', 'S', 50, 55)] },
  zone: { name: 'Zone', players: [d('d1', 'R', 50, 72), d('d2', 'F', 20, 66), d('d3', 'F', 80, 66), d('d4', 'D', 30, 48), d('d5', 'D', 70, 48)] },
};

export function newPlay(formation = 'spread') {
  return { name: '', notes: '', formation, players: structuredClone(FORMATIONS[formation].players), routes: [] };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const r1 = (n) => Math.round(n * 10) / 10;

// --- geometry
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function simplify(points, eps) {
  // Ramer–Douglas–Peucker: turns a wobbly finger path into clean cuts.
  if (points.length < 3) return points;
  const [a, b] = [points[0], points[points.length - 1]];
  let maxD = 0, idx = 0;
  const len = dist(a, b) || 1e-9;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const dd = Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / len;
    if (dd > maxD) { maxD = dd; idx = i; }
  }
  if (maxD <= eps) return [a, b];
  return [...simplify(points.slice(0, idx + 1), eps).slice(0, -1), ...simplify(points.slice(idx), eps)];
}
function pathLength(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]); return L; }
function pointAt(pts, t) {
  const total = pathLength(pts);
  let target = total * t;
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i]);
    if (target <= seg || i === pts.length - 1) {
      const f = seg ? Math.min(1, target / seg) : 1;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
    }
    target -= seg;
  }
  return pts[pts.length - 1];
}

// --- rendering (attributes only, no CSS, so the same SVG exports cleanly to PNG)
function fieldBackground() {
  const lines = [];
  for (let y = FIELD.endZone; y <= FIELD.h; y += 10) lines.push(`<line x1="0" y1="${y}" x2="100" y2="${y}" stroke="#ffffff" stroke-opacity="0.18" stroke-width="0.4"/>`);
  for (let y = FIELD.endZone + 2; y < FIELD.h; y += 2) {
    lines.push(`<line x1="33" y1="${y}" x2="35" y2="${y}" stroke="#ffffff" stroke-opacity="0.12" stroke-width="0.3"/>`);
    lines.push(`<line x1="65" y1="${y}" x2="67" y2="${y}" stroke="#ffffff" stroke-opacity="0.12" stroke-width="0.3"/>`);
  }
  return `
    <defs>
      <linearGradient id="turf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f6b35"/><stop offset="1" stop-color="#155226"/></linearGradient>
    </defs>
    <rect x="0" y="0" width="100" height="120" fill="url(#turf)"/>
    ${[...Array(12)].map((_, i) => (i % 2 ? `<rect x="0" y="${i * 10}" width="100" height="10" fill="#000" fill-opacity="0.05"/>` : '')).join('')}
    <rect x="0" y="0" width="100" height="${FIELD.endZone}" fill="#0e3d1c"/>
    <text x="50" y="8.6" text-anchor="middle" font-family="Impact, 'Arial Black', sans-serif" font-size="7" letter-spacing="3" fill="#ffffff" fill-opacity="0.35">HFL</text>
    ${lines.join('')}
    <line x1="0" y1="${FIELD.los}" x2="100" y2="${FIELD.los}" stroke="#4da3ff" stroke-width="0.7" stroke-opacity="0.9"/>
  `;
}

function routeSVG(r, color, extra = '') {
  const pts = r.points;
  const dAttr = 'M' + pts.map((p) => `${p[0]} ${p[1]}`).join(' L');
  const [ax, ay] = pts[pts.length - 2];
  const [bx, by] = pts[pts.length - 1];
  const ang = Math.atan2(by - ay, bx - ax);
  let tip = '';
  if (r.style === 'block') {
    const px = Math.cos(ang + Math.PI / 2) * 2.4, py = Math.sin(ang + Math.PI / 2) * 2.4;
    tip = `<line x1="${r1(bx - px)}" y1="${r1(by - py)}" x2="${r1(bx + px)}" y2="${r1(by + py)}" stroke="${color}" stroke-width="1" stroke-linecap="round"/>`;
  } else {
    const s = 2.6;
    const p1 = [bx - s * Math.cos(ang - 0.45), by - s * Math.sin(ang - 0.45)];
    const p2 = [bx - s * Math.cos(ang + 0.45), by - s * Math.sin(ang + 0.45)];
    tip = `<polygon points="${bx},${by} ${r1(p1[0])},${r1(p1[1])} ${r1(p2[0])},${r1(p2[1])}" fill="${color}"/>`;
  }
  const dash = r.style === 'motion' ? ' stroke-dasharray="1.6 1.4"' : '';
  return `<g data-route="${esc(r.id)}" ${extra}>
    <path d="${dAttr}" fill="none" stroke="transparent" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${dAttr}" fill="none" stroke="${color}" stroke-width="0.9" stroke-linecap="round" stroke-linejoin="round"${dash}/>
    ${tip}</g>`;
}

function playerSVG(p, selected) {
  const ring = selected ? `<circle r="5.4" fill="none" stroke="#ffd23f" stroke-width="0.8"/>` : '';
  const fs = p.label.length > 2 ? 2.4 : 3;
  if (p.side === 'D') {
    return `<g data-pid="${esc(p.id)}" transform="translate(${p.x} ${p.y})">${ring}
      <circle r="3.6" fill="#1b1b1f" fill-opacity="0.55" stroke="${p.color}" stroke-width="0.7"/>
      <text y="1.05" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="${fs}" fill="${p.color}">${esc(p.label)}</text></g>`;
  }
  return `<g data-pid="${esc(p.id)}" transform="translate(${p.x} ${p.y})">${ring}
    <circle r="3.8" fill="${p.color}" stroke="#0b0b0d" stroke-width="0.5"/>
    <text y="1.05" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="${fs}" fill="#0b0b0d">${esc(p.label)}</text></g>`;
}

export function playSVG(play, { selected = null, cls = '', title = false } = {}) {
  const colorOf = Object.fromEntries(play.players.map((p) => [p.id, p.color]));
  const order = { motion: 0, block: 1, route: 2 };
  const routes = [...play.routes].sort((a, b) => order[a.style] - order[b.style]);
  const heading = title && play.name
    ? `<text x="97" y="117" text-anchor="end" font-family="Impact, 'Arial Black', sans-serif" font-size="4.4" fill="#ffffff" fill-opacity="0.8">${esc(play.name)}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 120" class="${cls}" preserveAspectRatio="xMidYMid meet">
    ${fieldBackground()}
    <g>${routes.map((r) => routeSVG(r, colorOf[r.pid] || '#fff')).join('')}</g>
    <g>${play.players.map((p) => playerSVG(p, p.id === selected)).join('')}</g>
    ${heading}
  </svg>`;
}

// Runs players along their routes: pre-snap motion first, then everything else.
export function animatePlay(svgEl, play, { onDone } = {}) {
  const groups = Object.fromEntries([...svgEl.querySelectorAll('[data-pid]')].map((g) => [g.dataset.pid, g]));
  const byPlayer = {};
  for (const r of play.routes) (byPlayer[r.pid] ||= {})[r.style === 'motion' ? 'motion' : 'main'] = r.points;
  const hasMotion = play.routes.some((r) => r.style === 'motion');
  const T_MOTION = hasMotion ? 900 : 0, T_PAUSE = hasMotion ? 250 : 0, T_MAIN = 2000;
  const start = performance.now();
  let raf;
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const frame = (now) => {
    const el = now - start;
    for (const p of play.players) {
      const g = groups[p.id];
      if (!g) continue;
      const rs = byPlayer[p.id] || {};
      let pos = [p.x, p.y];
      if (rs.motion) pos = pointAt(rs.motion, ease(Math.min(1, el / Math.max(1, T_MOTION))));
      if (rs.main && el > T_MOTION + T_PAUSE) pos = pointAt(rs.main, ease(Math.min(1, (el - T_MOTION - T_PAUSE) / T_MAIN)));
      g.setAttribute('transform', `translate(${r1(pos[0])} ${r1(pos[1])})`);
    }
    if (el < T_MOTION + T_PAUSE + T_MAIN + 700) raf = requestAnimationFrame(frame);
    else onDone?.();
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

export async function playToPngBlob(play) {
  const svg = playSVG(play, { title: true }).replace('<svg ', '<svg width="1000" height="1200" ');
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const canvas = Object.assign(document.createElement('canvas'), { width: 1000, height: 1200 });
    canvas.getContext('2d').drawImage(img, 0, 0, 1000, 1200);
    return await new Promise((res) => canvas.toBlob(res, 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------
// Editor

export class PlayEditor {
  constructor(root, play, { onSave, onDelete, onShare, onChange } = {}) {
    this.root = root;
    this.play = structuredClone(play);
    this.cb = { onSave, onDelete, onShare, onChange };
    this.mode = 'draw';
    this.style = 'route';
    this.selected = null;
    this.undo = [];
    this.drag = null;
    this.stopAnim = null;
    this.dirty = false;
    this.render();
  }

  snapshot() {
    this.undo.push(JSON.stringify({ players: this.play.players, routes: this.play.routes }));
    if (this.undo.length > 50) this.undo.shift();
    this.dirty = true;
    this.cb.onChange?.();
  }

  render() {
    const p = this.play;
    const sel = p.players.find((x) => x.id === this.selected);
    const btn = (group, val, label, cur) => `<button type="button" class="seg ${cur === val ? 'on' : ''}" data-${group}="${val}">${label}</button>`;
    this.root.innerHTML = `
      <div class="pb-tools">
        <div class="segs">${btn('mode', 'draw', '✏️ Draw', this.mode)}${btn('mode', 'move', '✋ Move', this.mode)}${btn('mode', 'erase', '🧽 Erase', this.mode)}</div>
        <div class="segs ${this.mode === 'draw' ? '' : 'dim'}">${btn('style', 'route', '➚ Route', this.style)}${btn('style', 'motion', '⤳ Motion', this.style)}${btn('style', 'block', '⊥ Block', this.style)}</div>
      </div>
      <div class="pb-field">${playSVG(p, { selected: this.selected, cls: 'pb-svg' })}</div>
      <p class="pb-hint">${{
        draw: 'Drag from a player to draw his route. Tap a player to rename or recolor.',
        move: 'Drag players to line them up. Their routes move with them.',
        erase: 'Tap a route to delete it, or tap a player to clear all his routes.',
      }[this.mode]}</p>
      ${sel ? `
        <div class="pb-sel card-lite">
          <label>Label <input maxlength="3" value="${esc(sel.label)}" data-sel-label></label>
          <div class="swatches">${[...OFF_COLORS, DEF_COLOR].map((c) => `<button type="button" class="sw ${sel.color === c ? 'on' : ''}" style="background:${c}" data-color="${c}" aria-label="color ${c}"></button>`).join('')}</div>
          <button type="button" class="btn ghost sm" data-act="remove-player">Remove</button>
        </div>` : ''}
      <div class="pb-row">
        <button type="button" class="btn ghost sm" data-act="undo" ${this.undo.length ? '' : 'disabled'}>↶ Undo</button>
        <button type="button" class="btn ghost sm" data-act="clear">Clear routes</button>
        <button type="button" class="btn ghost sm" data-act="add-o">+ Offense</button>
        <button type="button" class="btn ghost sm" data-act="add-d">+ Defense</button>
        <button type="button" class="btn sm hot" data-act="animate">▶ Run it</button>
      </div>
      <div class="pb-row">
        <label class="grow">Formation
          <select data-formation>${Object.entries(FORMATIONS).map(([k, f]) => `<option value="${k}" ${p.formation === k ? 'selected' : ''}>${f.name}</option>`).join('')}</select>
        </label>
        <label class="grow">Defense
          <select data-defense><option value="">—</option>${Object.entries(DEFENSES).map(([k, f]) => `<option value="${k}">${f.name}</option>`).join('')}</select>
        </label>
      </div>
      <label>Play name <input data-name maxlength="60" placeholder="e.g. Mesh Madness" value="${esc(p.name)}"></label>
      <label>Notes <textarea data-notes maxlength="600" rows="3" placeholder="Reads, who's the first look, what to do if they blitz…">${esc(p.notes)}</textarea></label>
      <div class="pb-row">
        <button type="button" class="btn hot grow" data-act="save">💾 Save to playbook</button>
        ${this.play.id ? `<button type="button" class="btn ghost" data-act="share">📤 Share</button>` : ''}
        ${this.play.id ? `<button type="button" class="btn ghost danger" data-act="delete">🗑</button>` : ''}
      </div>`;
    this.bind();
  }

  bind() {
    const root = this.root;
    root.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { this.mode = b.dataset.mode; this.render(); }));
    root.querySelectorAll('[data-style]').forEach((b) => (b.onclick = () => { this.style = b.dataset.style; this.mode = 'draw'; this.render(); }));
    root.querySelectorAll('[data-color]').forEach((b) => (b.onclick = () => {
      const sel = this.play.players.find((x) => x.id === this.selected);
      if (!sel) return;
      this.snapshot(); sel.color = b.dataset.color; this.render();
    }));
    const lab = root.querySelector('[data-sel-label]');
    if (lab) lab.oninput = () => {
      const sel = this.play.players.find((x) => x.id === this.selected);
      sel.label = lab.value.toUpperCase().slice(0, 3);
      this.dirty = true;
      this.redrawField();
    };
    root.querySelector('[data-name]').oninput = (e) => { this.play.name = e.target.value; this.dirty = true; };
    root.querySelector('[data-notes]').oninput = (e) => { this.play.notes = e.target.value; this.dirty = true; };
    root.querySelector('[data-formation]').onchange = (e) => {
      const f = FORMATIONS[e.target.value];
      this.snapshot();
      const defense = this.play.players.filter((x) => x.side === 'D');
      this.play.formation = e.target.value;
      this.play.players = [...structuredClone(f.players), ...defense];
      const ids = new Set(this.play.players.map((x) => x.id));
      this.play.routes = this.play.routes.filter((r) => ids.has(r.pid) && this.play.players.find((x) => x.id === r.pid).side === 'D');
      this.selected = null;
      this.render();
    };
    root.querySelector('[data-defense]').onchange = (e) => {
      if (!e.target.value) return;
      this.snapshot();
      const offense = this.play.players.filter((x) => x.side === 'O');
      const oIds = new Set(offense.map((x) => x.id));
      this.play.players = [...offense, ...structuredClone(DEFENSES[e.target.value].players)];
      this.play.routes = this.play.routes.filter((r) => oIds.has(r.pid));
      this.render();
    };
    root.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => this.action(b.dataset.act)));
    this.bindField();
  }

  redrawField() {
    const wrap = this.root.querySelector('.pb-field');
    wrap.innerHTML = playSVG(this.play, { selected: this.selected, cls: 'pb-svg' });
    this.bindField();
  }

  svgPoint(svg, e) {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const r = pt.matrixTransform(svg.getScreenCTM().inverse());
    return [Math.min(100, Math.max(0, r.x)), Math.min(120, Math.max(0, r.y))];
  }

  bindField() {
    const svg = this.root.querySelector('.pb-svg');
    svg.onpointerdown = (e) => {
      if (this.stopAnim) return;
      const pg = e.target.closest('[data-pid]');
      const rg = e.target.closest('[data-route]');
      const at = this.svgPoint(svg, e);
      if (this.mode === 'erase') {
        if (rg) { this.snapshot(); this.play.routes = this.play.routes.filter((r) => r.id !== rg.dataset.route); this.redrawField(); this.root.querySelector('[data-act=undo]').disabled = false; }
        else if (pg) { this.snapshot(); this.play.routes = this.play.routes.filter((r) => r.pid !== pg.dataset.pid); this.redrawField(); this.root.querySelector('[data-act=undo]').disabled = false; }
        return;
      }
      if (!pg) return;
      e.preventDefault();
      svg.setPointerCapture(e.pointerId);
      const pl = this.play.players.find((x) => x.id === pg.dataset.pid);
      this.drag = { pid: pl.id, start: at, pts: [[pl.x, pl.y]], moved: false, before: JSON.stringify({ players: this.play.players, routes: this.play.routes }) };
    };
    svg.onpointermove = (e) => {
      const dr = this.drag;
      if (!dr) return;
      const at = this.svgPoint(svg, e);
      if (dist(at, dr.start) > 1.5) dr.moved = true;
      const pl = this.play.players.find((x) => x.id === dr.pid);
      if (this.mode === 'move') {
        const dx = at[0] - pl.x, dy = at[1] - pl.y;
        pl.x = r1(at[0]); pl.y = r1(at[1]);
        for (const r of this.play.routes) if (r.pid === pl.id) r.points = r.points.map(([x, y]) => [r1(Math.min(100, Math.max(0, x + dx))), r1(Math.min(120, Math.max(0, y + dy)))]);
        this.redrawFieldLight();
      } else if (dist(at, dr.pts[dr.pts.length - 1]) > 1.2) {
        dr.pts.push(at);
        this.drawPreview(svg, dr.pts, pl.color);
      }
    };
    const end = () => {
      const dr = this.drag;
      if (!dr) return;
      this.drag = null;
      const pl = this.play.players.find((x) => x.id === dr.pid);
      if (!dr.moved) {
        this.selected = this.selected === pl.id ? null : pl.id;
        if (this.mode === 'move') Object.assign(this.play, JSON.parse(dr.before));
        this.render();
        return;
      }
      if (this.mode === 'move') {
        this.undo.push(dr.before); this.dirty = true; this.cb.onChange?.();
        this.render();
        return;
      }
      let pts = simplify(dr.pts, 2.2).map(([x, y]) => [r1(x), r1(y)]);
      if (pathLength(pts) < 3) { this.redrawField(); return; }
      this.snapshot();
      // A route after pre-snap motion starts where the motion ended.
      const motion = this.play.routes.find((r) => r.pid === pl.id && r.style === 'motion');
      if (this.style !== 'motion' && motion) pts[0] = motion.points[motion.points.length - 1];
      this.play.routes = this.play.routes.filter((r) => !(r.pid === pl.id && (r.style === this.style || (this.style !== 'motion' && r.style !== 'motion'))));
      this.play.routes.push({ id: Math.random().toString(36).slice(2, 10), pid: pl.id, style: this.style, points: pts.slice(0, 80) });
      this.render();
    };
    svg.onpointerup = end;
    svg.onpointercancel = end;
  }

  redrawFieldLight() {
    // Cheap redraw during drags: swap the SVG contents without rebinding handlers.
    const svg = this.root.querySelector('.pb-svg');
    const tmp = document.createElement('div');
    tmp.innerHTML = playSVG(this.play, { selected: this.selected, cls: 'pb-svg' });
    svg.innerHTML = tmp.firstElementChild.innerHTML;
  }

  drawPreview(svg, pts, color) {
    let path = svg.querySelector('#pb-preview');
    if (!path) {
      path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.id = 'pb-preview';
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-width', '0.9');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-dasharray', this.style === 'motion' ? '1.6 1.4' : 'none');
      svg.appendChild(path);
    }
    path.setAttribute('stroke', color);
    path.setAttribute('d', 'M' + pts.map((p) => `${r1(p[0])} ${r1(p[1])}`).join(' L'));
  }

  action(act) {
    const p = this.play;
    if (act === 'undo') {
      const last = this.undo.pop();
      if (last) Object.assign(p, JSON.parse(last));
      this.render();
    } else if (act === 'clear') {
      if (!p.routes.length) return;
      this.snapshot(); p.routes = []; this.render();
    } else if (act === 'add-o' || act === 'add-d') {
      const side = act === 'add-o' ? 'O' : 'D';
      if (p.players.filter((x) => x.side === side).length >= 7) return;
      this.snapshot();
      const id = side.toLowerCase() + Math.random().toString(36).slice(2, 7);
      const n = p.players.filter((x) => x.side === side).length;
      p.players.push(side === 'O'
        ? o(id, 'W', 30 + n * 5, 84, OFF_COLORS[(n + 2) % OFF_COLORS.length])
        : d(id, 'D', 30 + n * 8, 64));
      this.selected = id;
      this.render();
    } else if (act === 'remove-player') {
      this.snapshot();
      p.players = p.players.filter((x) => x.id !== this.selected);
      p.routes = p.routes.filter((r) => r.pid !== this.selected);
      this.selected = null;
      this.render();
    } else if (act === 'animate') {
      if (this.stopAnim) return;
      this.selected = null;
      this.redrawField();
      const svg = this.root.querySelector('.pb-svg');
      this.stopAnim = animatePlay(svg, p, { onDone: () => { this.stopAnim = null; this.redrawField(); } });
    } else if (act === 'save') {
      this.cb.onSave?.(structuredClone(p), this);
    } else if (act === 'share') {
      this.cb.onShare?.(structuredClone(p));
    } else if (act === 'delete') {
      this.cb.onDelete?.(p);
    }
  }

  destroy() {
    this.stopAnim?.();
  }
}
