/* Repd Fitness PWA
   Style notes: var + traditional function expressions, HTML built by string
   concatenation (no nested template literals), single rolling JSON as source of
   truth, per-session markdown export to Git on finish. */

var CFG_KEY = 'repd_cfg';
var DATA_KEY = 'repd_data';

var D = null;                 // app data (source of truth, mirrored to Git)
var cfg = null;               // settings
var view = 'dash';            // current tab
var active = null;            // active in-progress workout
var blockTab = 1;             // selected block in Log view
var sync = { state: 'idle', msg: 'Not configured' };
var timer = { id: null, left: 0 };
var charts = {};

/* ---------- utilities ---------- */
function $(id) { return document.getElementById(id); }
function esc(s) {
  s = (s == null) ? '' : String(s);
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function todayISO() { return new Date().toISOString(); }
function dayStr(iso) {
  var d = new Date(iso);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function pad(n) { return (n < 10 ? '0' : '') + n; }
function niceDate(iso) {
  var d = new Date(iso);
  var m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return m[d.getMonth()] + ' ' + d.getDate();
}
function uid() { return 'w' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }
function e1rm(w, r) { w = parseFloat(w); r = parseInt(r, 10); if (!w || !r) return 0; return Math.round(w * (1 + r / 30)); }

function toast(msg) {
  var t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.classList.remove('on'); }, 2200);
}

function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64decode(b) { return decodeURIComponent(escape(atob(b.replace(/\n/g, '')))); }

/* ---------- persistence ---------- */
function loadCfg() {
  try { cfg = JSON.parse(localStorage.getItem(CFG_KEY)) || {}; }
  catch (e) { cfg = {}; }
  if (!cfg.branch) cfg.branch = 'main';
  if (!cfg.jsonPath) cfg.jsonPath = 'data/workouts.json';
  if (!cfg.logsDir) cfg.logsDir = 'logs';
  if (!cfg.theme) cfg.theme = 'dark';
}
function saveCfg() { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }
function cacheData() { localStorage.setItem(DATA_KEY, JSON.stringify(D)); }

function gitConfigured() { return !!(cfg.token && cfg.owner && cfg.repo); }

/* ---------- GitHub Contents API ---------- */
function ghHeaders() {
  return {
    'Authorization': 'Bearer ' + cfg.token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}
function ghUrl(path) {
  return 'https://api.github.com/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + path;
}
function ghGet(path) {
  return fetch(ghUrl(path) + '?ref=' + encodeURIComponent(cfg.branch), { headers: ghHeaders() })
    .then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('GET ' + r.status);
      return r.json();
    });
}
function ghPut(path, contentStr, message, sha) {
  var body = { message: message, content: b64encode(contentStr), branch: cfg.branch };
  if (sha) body.sha = sha;
  return fetch(ghUrl(path), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) })
    .then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('PUT ' + r.status + ' ' + t); });
      return r.json();
    });
}

function setSync(state, msg) { sync.state = state; sync.msg = msg; if (view === 'settings' || view === 'dash') renderSyncDot(); }

/* Pull rolling JSON from Git on startup (so multiple devices stay current). */
function pullFromGit() {
  if (!gitConfigured()) { setSync('idle', 'Local only (no Git configured)'); return Promise.resolve(); }
  setSync('busy', 'Pulling from Git\u2026');
  return ghGet(cfg.jsonPath).then(function (res) {
    if (res && res.content) {
      var remote = JSON.parse(b64decode(res.content));
      D = mergeSeed(remote);
      cacheData();
      setSync('ok', 'Synced \u00b7 ' + new Date().toLocaleTimeString());
    } else {
      setSync('ok', 'No remote file yet \u00b7 first save will create it');
    }
  }).catch(function (e) {
    setSync('err', 'Pull failed: ' + e.message);
  });
}

/* Push rolling JSON + write per-session markdown log. */
function pushWorkout(workout) {
  if (!gitConfigured()) { toast('Saved locally (Git not configured)'); return Promise.resolve(); }
  setSync('busy', 'Saving to Git\u2026');
  // 1) read current sha for the json file, 2) PUT json, 3) PUT new md log.
  return ghGet(cfg.jsonPath).then(function (res) {
    var sha = res ? res.sha : null;
    var msg = 'workout: ' + workout.name + ' ' + dayStr(workout.date);
    return ghPut(cfg.jsonPath, JSON.stringify(D, null, 2), msg, sha);
  }).then(function () {
    var fname = cfg.logsDir.replace(/\/$/, '') + '/' + dayStr(workout.date) + '-' + workout.name.toLowerCase() + '.md';
    return ghPut(fname, sessionMarkdown(workout), 'log: ' + workout.name + ' ' + dayStr(workout.date));
  }).then(function () {
    setSync('ok', 'Synced \u00b7 ' + new Date().toLocaleTimeString());
    toast('Saved + committed to Git');
  }).catch(function (e) {
    setSync('err', 'Save failed: ' + e.message);
    toast('Git save failed (kept local). See Settings.');
  });
}

/* ---------- Obsidian Dataview-compatible session markdown ---------- */
function sessionMarkdown(w) {
  var L = [];
  L.push('---');
  L.push('Date:: ' + dayStr(w.date));
  L.push('Block:: ' + (w.block || ''));
  L.push('Week:: ' + (w.week || ''));
  L.push('Day:: ' + w.name);
  L.push('Bodyweight:: ' + (w.bodyweight || ''));
  L.push('Sleep:: ' + (w.sleep || ''));
  L.push('Energy:: ' + (w.energy || ''));
  L.push('---');
  L.push('');
  L.push('# ' + w.name + ' \u2014 ' + dayStr(w.date));
  L.push('');
  var i, j;
  for (i = 0; i < w.exercises.length; i++) {
    var ex = w.exercises[i];
    L.push('### ' + ex.name);
    if (ex.scheme) L.push('*' + ex.scheme + '*');
    for (j = 0; j < ex.sets.length; j++) {
      var s = ex.sets[j];
      var box = s.done ? '[x]' : '[ ]';
      var val = (s.weight || '') + ' x ' + (s.reps || '') + (s.rpe ? ' @ ' + s.rpe : '');
      L.push('- ' + box + ' S' + (j + 1) + ': ' + val);
    }
    if (ex.note) L.push('Notes: ' + ex.note);
    L.push('');
  }
  if (w.notes) {
    L.push('**Post-session:** ' + w.notes);
    L.push('');
  }
  return L.join('\n');
}

/* ---------- seed / merge ---------- */
function mergeSeed(remote) {
  // Ensure all keys exist; keep the program routines from seed if remote lacks them.
  remote = remote || {};
  if (!remote.workouts) remote.workouts = [];
  if (!remote.prs) remote.prs = {};
  if (!remote.bodyweight) remote.bodyweight = [];
  if (!remote.splits) remote.splits = [];
  if (!remote.routines || !remote.routines.length) {
    remote.routines = (D && D.routines) ? D.routines : [];
    remote.program = (D && D.program) ? D.program : remote.program;
  }
  return remote;
}

function bootData() {
  // start from cache if present, else seed file
  var cached = null;
  try { cached = JSON.parse(localStorage.getItem(DATA_KEY)); } catch (e) {}
  if (cached) { D = cached; return Promise.resolve(); }
  return fetch('data/seed.json').then(function (r) { return r.json(); }).then(function (seed) {
    D = seed; cacheData();
  });
}

/* ---------- PRs ---------- */
function recomputePRs() {
  var prs = {};
  var i, j, k;
  for (i = 0; i < D.workouts.length; i++) {
    var w = D.workouts[i];
    for (j = 0; j < w.exercises.length; j++) {
      var ex = w.exercises[j];
      for (k = 0; k < ex.sets.length; k++) {
        var s = ex.sets[k];
        if (!s.done) continue;
        var wt = parseFloat(s.weight), rp = parseInt(s.reps, 10);
        if (!wt || !rp) continue;
        var est = e1rm(wt, rp);
        var rec = prs[ex.name] || { bestWeight: 0, bestE1RM: 0, date: w.date };
        if (wt > rec.bestWeight) rec.bestWeight = wt;
        if (est > rec.bestE1RM) { rec.bestE1RM = est; rec.date = w.date; }
        prs[ex.name] = rec;
      }
    }
  }
  D.prs = prs;
}

/* exercise history for progress chart: best e1RM per session, chronological */
function exerciseSeries(name) {
  var pts = [];
  var i, j, k;
  var sorted = D.workouts.slice().sort(function (a, b) { return new Date(a.date) - new Date(b.date); });
  for (i = 0; i < sorted.length; i++) {
    var w = sorted[i], best = 0;
    for (j = 0; j < w.exercises.length; j++) {
      if (w.exercises[j].name !== name) continue;
      var sets = w.exercises[j].sets;
      for (k = 0; k < sets.length; k++) {
        if (!sets[k].done) continue;
        var est = e1rm(sets[k].weight, sets[k].reps);
        if (est > best) best = est;
      }
    }
    if (best > 0) pts.push({ x: dayStr(w.date), y: best });
  }
  return pts;
}

/* ---------- minimal canvas line chart (no deps, offline-safe) ---------- */
function lineChart(canvas, pts, color) {
  if (!canvas) return;
  var dpr = window.devicePixelRatio || 1;
  var cssW = canvas.clientWidth || 300, cssH = 160;
  canvas.width = cssW * dpr; canvas.height = cssH * dpr;
  var ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);
  if (!pts.length) {
    ctx.fillStyle = getCss('--muted'); ctx.font = '13px Archivo, sans-serif';
    ctx.textAlign = 'center'; ctx.fillText('No data yet', cssW / 2, cssH / 2);
    return;
  }
  var pad = 26, pl = 34;
  var ys = pts.map(function (p) { return p.y; });
  var ymin = Math.min.apply(null, ys), ymax = Math.max.apply(null, ys);
  if (ymin === ymax) { ymin = ymin - 5; ymax = ymax + 5; }
  var pr = pad - 6;
  function X(i) { return pl + (cssW - pl - pad) * (pts.length === 1 ? 0.5 : i / (pts.length - 1)); }
  function Y(v) { return pr + (cssH - pr - pad) * (1 - (v - ymin) / (ymax - ymin)); }
  // grid + axis labels
  ctx.strokeStyle = getCss('--line'); ctx.fillStyle = getCss('--muted');
  ctx.font = '10px IBM Plex Mono, monospace'; ctx.textAlign = 'right';
  var g;
  for (g = 0; g <= 2; g++) {
    var v = ymin + (ymax - ymin) * (g / 2);
    var yy = Y(v);
    ctx.beginPath(); ctx.moveTo(pl, yy); ctx.lineTo(cssW - pad, yy); ctx.globalAlpha = .5; ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillText(Math.round(v), pl - 6, yy + 3);
  }
  // line
  ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.beginPath();
  pts.forEach(function (p, i) { var x = X(i), y = Y(p.y); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
  // dots
  ctx.fillStyle = color;
  pts.forEach(function (p, i) { ctx.beginPath(); ctx.arc(X(i), Y(p.y), 3.2, 0, 7); ctx.fill(); });
  // x labels (first + last)
  ctx.fillStyle = getCss('--muted'); ctx.textAlign = 'center';
  ctx.fillText(pts[0].x.slice(5), X(0), cssH - 8);
  if (pts.length > 1) ctx.fillText(pts[pts.length - 1].x.slice(5), X(pts.length - 1), cssH - 8);
}
function getCss(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

/* ---------- rest timer ---------- */
function startTimer(sec) {
  stopTimer();
  timer.left = sec;
  var el = $('timer'); el.classList.add('on');
  renderTimer();
  timer.id = setInterval(function () {
    timer.left--;
    if (timer.left <= 0) { stopTimer(); if (navigator.vibrate) navigator.vibrate(200); }
    else renderTimer();
  }, 1000);
}
function renderTimer() {
  var m = Math.floor(timer.left / 60), s = timer.left % 60;
  $('timer').innerHTML = '<span>\u23f1 ' + m + ':' + pad(s) + '</span>' +
    '<button onclick="stopTimer()">\u00d7</button>';
}
function stopTimer() { if (timer.id) clearInterval(timer.id); timer.id = null; $('timer').classList.remove('on'); }

/* ====================================================================== */
/* RENDERING                                                              */
/* ====================================================================== */
function render() {
  document.documentElement.setAttribute('data-theme', cfg.theme === 'light' ? 'light' : 'dark');
  $('app').innerHTML = topBar() + viewHtml();
  renderTabs();
  if (view === 'body') drawBodyCharts();
  if (view === 'progress') drawProgressChart();
}

function topBar() {
  var sub = active ? ('Logging \u00b7 ' + esc(active.name)) : 'Train. Log. Progress.';
  return '<div class="top">' +
    '<div class="brand"><span class="logo">REPD</span><span class="sub">' + sub + '</span></div>' +
    '<button class="iconbtn" onclick="toggleTheme()">' + (cfg.theme === 'light' ? '\u263e' : '\u2600') + '</button>' +
    '</div>';
}

function renderSyncDot() {
  var el = $('syncdot');
  if (!el) return;
  var cls = sync.state === 'ok' ? 'ok' : sync.state === 'err' ? 'err' : sync.state === 'busy' ? 'busy' : '';
  el.innerHTML = '<span class="dot ' + cls + '"></span><span class="muted" style="font-size:12px">' + esc(sync.msg) + '</span>';
}

function viewHtml() {
  if (active) return logActiveHtml();
  if (view === 'dash') return dashHtml();
  if (view === 'log') return logPickerHtml();
  if (view === 'history') return historyHtml();
  if (view === 'body') return bodyHtml();
  if (view === 'progress') return progressHtml();
  if (view === 'settings') return settingsHtml();
  return '';
}

/* ---------- Dashboard ---------- */
function dashHtml() {
  var n = D.workouts.length;
  var last = n ? D.workouts[n - 1] : null;
  var bw = D.bodyweight.length ? D.bodyweight[D.bodyweight.length - 1].value : '\u2014';
  var prCount = Object.keys(D.prs).length;
  var streak = weekCount();
  var h = '';
  h += '<div class="card"><div id="syncdot" class="row"></div></div>';
  h += '<div class="grid">' +
    statCard(n, 'Workouts') +
    statCard(prCount, 'PRs tracked') +
    statCard(streak, 'This week') +
    statCard(bw, 'Bodyweight') +
    '</div>';
  h += '<button class="btn" onclick="go(\'log\')" style="margin:6px 0 14px">Start a workout</button>';
  if (last) {
    h += '<div class="card"><h2>Last session</h2>' +
      '<div class="row"><div><div style="font-weight:700;font-size:17px">' + esc(last.name) +
      '</div><div class="muted" style="font-size:13px">' + niceDate(last.date) + ' \u00b7 ' +
      last.exercises.length + ' exercises</div></div>' +
      '<span class="pill accent">Block ' + (last.block || '?') + '</span></div></div>';
  }
  h += '<div class="card"><h2>Program</h2>' +
    '<div style="font-weight:700">' + esc(D.program.name) + '</div>' +
    '<div class="muted" style="font-size:13px;margin-top:4px">' + esc(D.program.split) + '</div>' +
    '<div class="muted" style="font-size:13px">' + esc(D.program.method) + '</div></div>';
  return h;
}
function statCard(v, label) {
  return '<div class="card" style="margin:0"><div class="big">' + esc(v) + '</div>' +
    '<div class="muted" style="font-size:12px;margin-top:4px;text-transform:uppercase;letter-spacing:.08em">' + esc(label) + '</div></div>';
}
function weekCount() {
  var now = new Date(); var monday = new Date(now);
  var day = (now.getDay() + 6) % 7; monday.setDate(now.getDate() - day); monday.setHours(0, 0, 0, 0);
  return D.workouts.filter(function (w) { return new Date(w.date) >= monday; }).length;
}

/* ---------- Log: routine picker ---------- */
function logPickerHtml() {
  var h = '<div class="card"><h2>Pick a day</h2>';
  h += '<div class="blocknav">';
  [1, 2, 3].forEach(function (b) {
    h += '<button class="' + (blockTab === b ? 'on' : '') + '" onclick="setBlock(' + b + ')">Block ' + b + '</button>';
  });
  h += '</div>';
  var meta = D.program.blocks[blockTab] || D.program.blocks[String(blockTab)];
  if (meta) h += '<div class="muted" style="font-size:13px;margin-bottom:4px">Weeks ' + esc(meta.weeks) + ' \u00b7 ' + esc(meta.phase) + ' \u00b7 deload wk ' + esc(meta.deload) + '</div>';
  h += '</div>';
  h += '<div class="grid">';
  D.routines.filter(function (r) { return r.block === blockTab; }).forEach(function (r) {
    h += '<button class="rcard" onclick="startWorkout(\'' + r.id + '\')">' +
      '<div class="day">' + esc(r.name) + '</div>' +
      '<div class="meta">' + r.exercises.length + ' exercises</div>' +
      (r.derived ? '<div style="margin-top:8px"><span class="pill derived">derived</span></div>'
                 : '<div style="margin-top:8px"><span class="pill">from vault</span></div>') +
      '</button>';
  });
  h += '</div>';
  h += '<div class="card" style="margin-top:6px"><div class="muted" style="font-size:12.5px;line-height:1.5">' +
    'Block 1 + Block 3 Upper/Lower are loaded exactly from your Obsidian files. ' +
    'Cards marked <span class="pill derived">derived</span> were generated from your documented scheme ' +
    '(B2: 6-8 compound / 8-12 isolation @ RPE 8; B3: 4-6 / 6-10 @ RPE 8-9). Verify against your vault and tell me any corrections.' +
    '</div></div>';
  return h;
}
function setBlock(b) { blockTab = b; render(); }

/* ---------- Log: active workout ---------- */
function startWorkout(rid) {
  var r = D.routines.filter(function (x) { return x.id === rid; })[0];
  if (!r) return;
  active = {
    id: uid(), date: todayISO(), routineId: r.id, name: r.name, block: r.block,
    week: '', bodyweight: '', sleep: '', energy: '', notes: '',
    exercises: r.exercises.map(function (e) {
      var sets = [];
      for (var i = 0; i < e.sets; i++) sets.push({ weight: '', reps: '', rpe: (e.rpe || '').split('-')[0], done: false });
      return {
        name: e.name, superset: e.superset || null, rest: e.rest || 60,
        scheme: e.sets + ' x ' + e.reps + ' @ RPE ' + e.rpe + ' \u00b7 rest ' + (e.rest || 60) + 's',
        note: '', sets: sets
      };
    })
  };
  prefillLastWeights(active);
  view = 'log';
  render();
  window.scrollTo(0, 0);
}
function prefillLastWeights(w) {
  // suggest last used weight/reps for each exercise as placeholders
  for (var i = w.exercises.length - 1; i >= 0; i--) {}
  w.exercises.forEach(function (ex) {
    var prev = lastSetFor(ex.name);
    ex.prev = prev; // {weight, reps} or null
  });
}
function lastSetFor(name) {
  for (var i = D.workouts.length - 1; i >= 0; i--) {
    var w = D.workouts[i];
    for (var j = 0; j < w.exercises.length; j++) {
      if (w.exercises[j].name === name) {
        var sets = w.exercises[j].sets.filter(function (s) { return s.done && s.weight; });
        if (sets.length) return { weight: sets[sets.length - 1].weight, reps: sets[sets.length - 1].reps };
      }
    }
  }
  return null;
}

function logActiveHtml() {
  var h = '';
  h += '<div class="card"><div class="row" style="gap:8px">' +
    miniField('Week', 'week', active.week, 'wk') +
    miniField('BW', 'bodyweight', active.bodyweight, 'lb') +
    miniField('Sleep', 'sleep', active.sleep, 'hr') +
    miniField('Energy', 'energy', active.energy, '/10') +
    '</div></div>';
  active.exercises.forEach(function (ex, ei) {
    h += '<div class="ex">';
    h += '<div class="row"><div><div class="name">' + esc(ex.name) + '</div>' +
      '<div class="scheme">' + esc(ex.scheme) + '</div></div>';
    if (ex.superset) h += '<div class="ss">SS</div>';
    h += '</div>';
    if (ex.prev) h += '<div class="muted" style="font-size:12px;margin-top:6px">Last: ' + esc(ex.prev.weight) + ' \u00d7 ' + esc(ex.prev.reps) + '</div>';
    h += '<div class="fieldhead"><span></span><span>WEIGHT</span><span>REPS</span><span>RPE</span><span></span></div>';
    ex.sets.forEach(function (s, si) {
      var ph = ex.prev ? ex.prev.weight : '';
      var phr = ex.prev ? ex.prev.reps : '';
      h += '<div class="setrow">' +
        '<div class="lbl">S' + (si + 1) + '</div>' +
        inp(ei, si, 'weight', s.weight, ph) +
        inp(ei, si, 'reps', s.reps, phr) +
        inp(ei, si, 'rpe', s.rpe, '') +
        '<button class="chk ' + (s.done ? 'on' : '') + '" onclick="toggleSet(' + ei + ',' + si + ')">' + (s.done ? '\u2713' : '') + '</button>' +
        '</div>';
    });
    h += '<button class="btn ghost sm" style="margin-top:10px" onclick="addSet(' + ei + ')">+ set</button>';
    h += '</div>';
  });
  h += '<div class="card"><div class="field" style="margin:0"><label>Post-session notes</label>' +
    '<input value="' + esc(active.notes) + '" oninput="active.notes=this.value" placeholder="Top set, issues, next time\u2026"></div></div>';
  h += '<div style="height:70px"></div>';
  h += '<div class="finishbar"><div class="inner"><div class="row" style="gap:10px">' +
    '<button class="btn ghost" style="flex:1" onclick="cancelWorkout()">Discard</button>' +
    '<button class="btn" style="flex:2" onclick="finishWorkout()">Finish &amp; sync</button>' +
    '</div></div></div>';
  return h;
}
function miniField(label, key, val, suffix) {
  return '<div style="flex:1"><label class="muted" style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px">' + esc(label) + '</label>' +
    '<input class="mono" style="width:100%;background:var(--bg3);border:1px solid var(--line);color:var(--txt);border-radius:9px;padding:9px 6px;text-align:center" ' +
    'value="' + esc(val) + '" oninput="active.' + key + '=this.value" placeholder="' + esc(suffix) + '"></div>';
}
function inp(ei, si, field, val, ph) {
  return '<input class="mono" inputmode="decimal" value="' + esc(val) + '" placeholder="' + esc(ph) + '" ' +
    'oninput="setField(' + ei + ',' + si + ',\'' + field + '\',this.value)">';
}
function setField(ei, si, field, val) { active.exercises[ei].sets[si][field] = val; }
function toggleSet(ei, si) {
  var s = active.exercises[ei].sets[si];
  s.done = !s.done;
  render();
  if (s.done) { startTimer(active.exercises[ei].rest || 60); }
}
function addSet(ei) {
  var ex = active.exercises[ei];
  ex.sets.push({ weight: '', reps: '', rpe: '', done: false });
  render();
}
function cancelWorkout() {
  if (!confirm('Discard this workout? Nothing will be saved.')) return;
  active = null; stopTimer(); view = 'log'; render();
}
function finishWorkout() {
  var logged = 0;
  active.exercises.forEach(function (ex) { ex.sets.forEach(function (s) { if (s.done) logged++; }); });
  if (logged === 0 && !confirm('No sets marked done. Save anyway?')) return;
  // record latest bodyweight if entered
  if (active.bodyweight && !isNaN(parseFloat(active.bodyweight))) {
    D.bodyweight.push({ date: dayStr(active.date), value: parseFloat(active.bodyweight) });
  }
  var clean = JSON.parse(JSON.stringify(active));
  delete clean.routineId;
  D.workouts.push(clean);
  recomputePRs();
  cacheData();
  var w = clean;
  active = null; stopTimer(); view = 'history'; render();
  pushWorkout(w);
}

/* ---------- History ---------- */
function historyHtml() {
  if (!D.workouts.length) return emptyState('No workouts yet', 'Start your first session from the Log tab.');
  var h = '<div class="card"><h2>History</h2>';
  var sorted = D.workouts.slice().reverse();
  sorted.forEach(function (w) {
    var vol = totalVolume(w);
    h += '<div class="hitem"><div><div style="font-weight:700">' + esc(w.name) +
      '</div><div class="muted" style="font-size:12.5px">' + niceDate(w.date) + ' \u00b7 Block ' + (w.block || '?') + ' \u00b7 ' + vol.toLocaleString() + ' lb vol</div></div>' +
      '<span class="pill accent">' + w.exercises.length + '</span></div>';
  });
  h += '</div>';
  return h;
}
function totalVolume(w) {
  var v = 0;
  w.exercises.forEach(function (ex) {
    ex.sets.forEach(function (s) {
      if (s.done) { var a = parseFloat(s.weight), b = parseInt(s.reps, 10); if (a && b) v += a * b; }
    });
  });
  return Math.round(v);
}

/* ---------- Body (bodyweight + PRs) ---------- */
function bodyHtml() {
  var h = '';
  h += '<div class="card"><h2>Log bodyweight</h2>' +
    '<div class="row" style="gap:10px">' +
    '<input id="bwInput" class="mono" inputmode="decimal" placeholder="lb" style="flex:1;background:var(--bg3);border:1px solid var(--line);color:var(--txt);border-radius:11px;padding:12px;text-align:center">' +
    '<button class="btn sm" onclick="logBW()">Add</button></div></div>';
  h += '<div class="card"><h2>Bodyweight</h2><canvas id="bwChart" height="160"></canvas></div>';
  // PR list
  var names = Object.keys(D.prs).sort();
  h += '<div class="card"><h2>Personal records</h2>';
  if (!names.length) h += '<div class="muted">Log some sets and your PRs show up here.</div>';
  names.forEach(function (n) {
    var p = D.prs[n];
    h += '<div class="hitem"><div><div style="font-weight:700">' + esc(n) + '</div>' +
      '<div class="muted" style="font-size:12px">est. 1RM ' + p.bestE1RM + ' lb \u00b7 ' + niceDate(p.date) + '</div></div>' +
      '<button class="btn ghost sm" onclick="showProgress(\'' + esc(n).replace(/'/g, "\\'") + '\')">chart</button></div>';
  });
  h += '</div>';
  return h;
}
function logBW() {
  var v = parseFloat($('bwInput').value);
  if (!v) { toast('Enter a number'); return; }
  D.bodyweight.push({ date: dayStr(todayISO()), value: v });
  cacheData(); drawBodyCharts(); toast('Logged ' + v + ' lb');
  // push bodyweight-only update to git json (no markdown)
  if (gitConfigured()) {
    setSync('busy', 'Saving\u2026');
    ghGet(cfg.jsonPath).then(function (res) {
      return ghPut(cfg.jsonPath, JSON.stringify(D, null, 2), 'bodyweight ' + v + ' ' + dayStr(todayISO()), res ? res.sha : null);
    }).then(function () { setSync('ok', 'Synced'); }).catch(function (e) { setSync('err', e.message); });
  }
  render();
}
function drawBodyCharts() {
  var pts = D.bodyweight.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; })
    .map(function (b) { return { x: b.date, y: b.value }; });
  lineChart($('bwChart'), pts, getCss('--accent2'));
}

/* ---------- Progress (per exercise) ---------- */
var progressName = null;
function showProgress(n) { progressName = n; view = 'progress'; render(); }
function progressHtml() {
  var names = Object.keys(D.prs).sort();
  var h = '<div class="card"><h2>Exercise progress</h2>' +
    '<select id="progSel" onchange="progressName=this.value;drawProgressChart()" style="width:100%;background:var(--bg3);border:1px solid var(--line);color:var(--txt);border-radius:11px;padding:12px">';
  names.forEach(function (n) {
    h += '<option' + (n === progressName ? ' selected' : '') + '>' + esc(n) + '</option>';
  });
  h += '</select></div>';
  h += '<div class="card"><h2>Estimated 1RM</h2><canvas id="progChart" height="160"></canvas></div>';
  if (!names.length) return emptyState('No data yet', 'Finish a workout to see progress.');
  if (!progressName) progressName = names[0];
  return h;
}
function drawProgressChart() {
  if (!progressName) return;
  lineChart($('progChart'), exerciseSeries(progressName), getCss('--accent'));
}

/* ---------- Settings ---------- */
function settingsHtml() {
  var h = '<div class="card"><div id="syncdot" class="row"></div></div>';
  h += '<div class="card"><h2>Git sync (GitHub)</h2>' +
    settingField('GitHub token (fine-grained, repo contents R/W)', 'token', cfg.token, 'password') +
    settingField('Owner (your username)', 'owner', cfg.owner, 'text') +
    settingField('Repo name', 'repo', cfg.repo, 'text') +
    settingField('Branch', 'branch', cfg.branch, 'text') +
    settingField('JSON path', 'jsonPath', cfg.jsonPath, 'text') +
    settingField('Logs folder', 'logsDir', cfg.logsDir, 'text') +
    '<button class="btn" style="margin-top:6px" onclick="saveSettings()">Save</button>' +
    '<button class="btn ghost" style="margin-top:8px" onclick="testSync()">Test connection (pull)</button>' +
    '<button class="btn ghost" style="margin-top:8px" onclick="pushNow()">Force push current data</button>' +
    '</div>';
  h += '<div class="card"><h2>Data</h2>' +
    '<div class="muted" style="font-size:12.5px;line-height:1.5;margin-bottom:10px">Source of truth is your Git repo. Local storage is a cache and may be cleared by iOS after long inactivity, so keep sync on.</div>' +
    '<button class="btn ghost" onclick="exportData()">Export workouts.json</button>' +
    '<button class="btn ghost" style="margin-top:8px" onclick="resetData()">Reset to program seed</button>' +
    '</div>';
  return h;
}
function settingField(label, key, val, type) {
  return '<div class="field"><label>' + esc(label) + '</label>' +
    '<input type="' + type + '" value="' + esc(val || '') + '" oninput="cfg.' + key + '=this.value" autocapitalize="off" autocomplete="off" spellcheck="false"></div>';
}
function saveSettings() { saveCfg(); toast('Settings saved'); pullFromGit(); }
function testSync() { pullFromGit().then(function () { render(); }); }
function pushNow() {
  if (!gitConfigured()) { toast('Configure Git first'); return; }
  setSync('busy', 'Pushing\u2026');
  ghGet(cfg.jsonPath).then(function (res) {
    return ghPut(cfg.jsonPath, JSON.stringify(D, null, 2), 'manual push ' + dayStr(todayISO()), res ? res.sha : null);
  }).then(function () { setSync('ok', 'Pushed'); toast('Pushed to Git'); })
    .catch(function (e) { setSync('err', e.message); toast('Push failed'); });
}
function exportData() {
  var blob = new Blob([JSON.stringify(D, null, 2)], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'workouts.json'; a.click();
}
function resetData() {
  if (!confirm('Reset local data to the program seed? Git data is untouched.')) return;
  localStorage.removeItem(DATA_KEY);
  fetch('data/seed.json').then(function (r) { return r.json(); }).then(function (s) { D = s; cacheData(); render(); toast('Reset done'); });
}

/* ---------- tabs ---------- */
function renderTabs() {
  var tabs = [
    ['dash', '\u25c9', 'Home'],
    ['log', '\u2b06', 'Log'],
    ['history', '\u2630', 'History'],
    ['body', '\u2696', 'Body'],
    ['settings', '\u2699', 'Settings']
  ];
  var h = '';
  tabs.forEach(function (t) {
    var on = (view === t[0] || (view === 'progress' && t[0] === 'body')) ? 'on' : '';
    h += '<button class="' + on + '" onclick="go(\'' + t[0] + '\')"><span class="ic">' + t[1] + '</span>' + t[2] + '</button>';
  });
  $('tabs').innerHTML = h;
}
function go(v) {
  if (active && v !== 'log') {
    if (!confirm('Leave the active workout? It will be discarded.')) return;
    active = null; stopTimer();
  }
  view = v; render(); window.scrollTo(0, 0);
}
function toggleTheme() { cfg.theme = (cfg.theme === 'light' ? 'dark' : 'light'); saveCfg(); render(); }

function emptyState(title, sub) {
  return '<div class="empty"><div style="font-weight:700;font-size:18px;color:var(--txt)">' + esc(title) + '</div>' +
    '<div style="margin-top:6px">' + esc(sub) + '</div></div>';
}

/* ---------- boot ---------- */
function boot() {
  loadCfg();
  bootData().then(function () {
    render();
    return pullFromGit();
  }).then(function () {
    recomputePRs(); cacheData(); render();
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
}
boot();
