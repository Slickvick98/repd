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
var viewWorkout = null;        // index into D.workouts for detail view
var workoutBackView = 'history'; // where the detail view returns to
var logMode = 'menu';          // Log tab sub-screen: menu | program | template

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
function e1rm(w, r) { w = parseFloat(w); r = parseInt(r, 10); if (!w || !r) return 0; if (r <= 1) return Math.round(w); return Math.round(w * (1 + r / 30)); }

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

function syncCls() { return sync.state === 'ok' ? 'ok' : sync.state === 'err' ? 'err' : sync.state === 'busy' ? 'busy' : ''; }
function ghDelete(path, message, sha) {
  return fetch(ghUrl(path), {
    method: 'DELETE', headers: ghHeaders(),
    body: JSON.stringify({ message: message, sha: sha, branch: cfg.branch })
  }).then(function (r) {
    if (!r.ok) return r.text().then(function (t) { throw new Error('DELETE ' + r.status + ' ' + t); });
    return r.json();
  });
}

function setSync(state, msg) { sync.state = state; sync.msg = msg; if (view === 'settings') renderSyncDot(); if (view === 'dash') renderSyncMini(); }
function renderSyncMini() { var el = $('syncmini'); if (!el) return; el.className = 'dot ' + syncCls(); el.title = sync.msg; }

/* Pull rolling JSON from Git on startup (so multiple devices stay current). */
function pullFromGit() {
  if (!gitConfigured()) { setSync('idle', 'Local only (no Git configured)'); return Promise.resolve(); }
  setSync('busy', 'Pulling from Git\u2026');
  return ghGet(cfg.jsonPath).then(function (res) {
    if (res && res.content) {
      var remote = JSON.parse(b64decode(res.content));
      D = mergeSeed(remote);
      ensureData();
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
    return ghGet(fname).then(function (r) {
      return ghPut(fname, sessionMarkdown(workout), 'log: ' + workout.name + ' ' + dayStr(workout.date), r ? r.sha : null);
    });
  }).then(function () {
    setSync('ok', 'Synced \u00b7 ' + new Date().toLocaleTimeString());
    toast('Saved + committed to Git');
  }).catch(function (e) {
    setSync('err', 'Save failed: ' + e.message);
    toast('Git save failed (kept local). See Settings.');
  });
}

/* Push just the rolling JSON (templates, edits to data) without a markdown log. */
function syncDataJson(message) {
  cacheData();
  if (!gitConfigured()) { return Promise.resolve(); }
  setSync('busy', 'Saving…');
  return ghGet(cfg.jsonPath).then(function (r) {
    return ghPut(cfg.jsonPath, JSON.stringify(D, null, 2), message, r ? r.sha : null);
  }).then(function () { setSync('ok', 'Synced · ' + new Date().toLocaleTimeString()); })
    .catch(function (e) { setSync('err', 'Save failed: ' + e.message); });
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
  if (!remote.templates) remote.templates = [];
  if (!remote.routines || !remote.routines.length) {
    remote.routines = (D && D.routines) ? D.routines : [];
    remote.program = (D && D.program) ? D.program : remote.program;
  }
  return remote;
}

function ensureData() {
  if (!D.workouts) D.workouts = [];
  if (!D.prs) D.prs = {};
  if (!D.bodyweight) D.bodyweight = [];
  if (!D.splits) D.splits = [];
  if (!D.templates) D.templates = [];
  // ---- programs library migration ----
  if (!D.programs) {
    D.programs = [];
    if (D.program && D.program.name) {
      var blocks = D.program.blocks || {};
      D.programs.push({
        id: 'pg-orig', name: D.program.name, method: D.program.method || '', split: D.program.split || '',
        blocks: blocks, periodized: Object.keys(blocks).length > 0,
        routines: D.routines ? JSON.parse(JSON.stringify(D.routines)) : []
      });
    }
  }
  if (D.activeProgramId === undefined || D.activeProgramId === null) {
    D.activeProgramId = D.programs[0] ? D.programs[0].id : null;
  }
  if (!D.programStart) {
    if (D.workouts.length) {
      var ds = D.workouts.map(function (w) { return new Date(w.date); }).sort(function (a, b) { return a - b; });
      D.programStart = dayStr(ds[0].toISOString());
    } else { D.programStart = dayStr(todayISO()); }
  }
  applyActiveProgram();
}
function deriveSplit(routines) {
  var seen = {}, names = [];
  (routines || []).forEach(function (r) { if (!seen[r.name]) { seen[r.name] = 1; names.push(r.name); } });
  return names.join(' / ');
}
function activeProgram() {
  if (!D.programs || !D.programs.length) return null;
  return D.programs.filter(function (p) { return p.id === D.activeProgramId; })[0] || D.programs[0];
}
/* mirror the active program into D.program / D.routines so every view works unchanged */
function applyActiveProgram() {
  var p = activeProgram();
  if (!p) return;
  D.activeProgramId = p.id;
  D.program = { name: p.name, method: p.method || '', split: p.split || deriveSplit(p.routines), blocks: p.blocks || {} };
  D.routines = JSON.parse(JSON.stringify(p.routines || []));
}
function setActiveProgram(id) {
  D.activeProgramId = id;
  D.programStart = dayStr(todayISO());   // new activation resets the week clock
  applyActiveProgram();
  recomputePRs(); cacheData();
  view = 'program'; programBlock = null; programDay = null;
  render(); window.scrollTo(0, 0);
  syncDataJson('set active program: ' + (D.program ? D.program.name : ''));
  toast('Active program set');
}
function deleteProgram(id) {
  var p = (D.programs || []).filter(function (x) { return x.id === id; })[0];
  if (!p) return;
  if (!confirm('Delete program "' + p.name + '"? Logged workouts are kept.')) return;
  D.programs = D.programs.filter(function (x) { return x.id !== id; });
  if (D.activeProgramId === id) { D.activeProgramId = D.programs[0] ? D.programs[0].id : null; applyActiveProgram(); }
  render();
  syncDataJson('delete program: ' + p.name);
}
function parseProgramJson(text) {
  var o = JSON.parse(text);
  if (!o || !o.name) throw new Error('missing "name"');
  var days = o.days || o.routines || [];
  if (!days.length) throw new Error('needs a "days" array');
  var pid = 'pg' + Date.now().toString(36);
  var routines = days.map(function (d, i) {
    if (!d.name || !d.exercises || !d.exercises.length) throw new Error('each day needs "name" and "exercises"');
    return {
      id: pid + '-' + i, name: String(d.name), block: (d.block != null ? d.block : ''),
      phase: d.phase || '', weeks: d.weeks || '', deloadWeek: d.deloadWeek || '', derived: !!d.derived,
      exercises: d.exercises.map(function (e) {
        return { name: String(e.name), type: e.type || '', sets: parseInt(e.sets, 10) || 3,
          reps: String(e.reps == null ? '' : e.reps), rpe: String(e.rpe == null ? '' : e.rpe), rest: parseInt(e.rest, 10) || 90 };
      })
    };
  });
  var blocks = o.blocks || {};
  return { id: pid, name: String(o.name), method: o.method || '', split: o.split || deriveSplit(routines),
    blocks: blocks, periodized: Object.keys(blocks).length > 0, routines: routines };
}
function bootData() {
  // start from cache if present, else seed file
  var cached = null;
  try { cached = JSON.parse(localStorage.getItem(DATA_KEY)); } catch (e) {}
  if (cached) { D = cached; ensureData(); return Promise.resolve(); }
  return fetch('data/seed.json').then(function (r) { return r.json(); }).then(function (seed) {
    D = seed; ensureData(); cacheData();
  });
}

/* ---------- PRs ---------- */
/* Tracks both a weight PR (best est. 1RM) and a rep PR (most reps in one set).
   Exercises with any bodyweight set (non-numeric weight, e.g. pull-ups) are
   flagged bodyweight:true so the UI shows a rep-max instead of est. 1RM. */
function recomputePRs() {
  var prs = {};
  var i, j, k;
  for (i = 0; i < D.workouts.length; i++) {       // chronological (oldest first)
    var w = D.workouts[i];
    for (j = 0; j < w.exercises.length; j++) {
      var ex = w.exercises[j];
      for (k = 0; k < ex.sets.length; k++) {
        var s = ex.sets[k];
        if (!s.done) continue;
        var rp = parseInt(s.reps, 10);
        if (!rp) continue;
        var wt = parseFloat(s.weight);
        var hasW = !isNaN(wt) && wt > 0;
        var rec = prs[ex.name] || { bestWeight: 0, bestE1RM: 0, date: w.date, bestReps: 0, repsDate: w.date, repsAtBest: 0, bodyweight: false };
        if (rp > rec.bestReps) { rec.bestReps = rp; rec.repsDate = w.date; }
        if (hasW) {
          if (wt > rec.bestWeight) { rec.bestWeight = wt; rec.repsAtBest = rp; rec.date = w.date; }
          else if (wt === rec.bestWeight) { if (rp > rec.repsAtBest) rec.repsAtBest = rp; rec.date = w.date; }
        } else {
          rec.bodyweight = true;
        }
        prs[ex.name] = rec;
      }
    }
  }
  // est. 1RM is derived from the top-weight working set (1 rep => the weight itself)
  Object.keys(prs).forEach(function (n) { var r = prs[n]; r.bestE1RM = r.bestWeight ? e1rm(r.bestWeight, r.repsAtBest) : 0; });
  D.prs = prs;
}
/* weight-PR progression: a point only when a new heaviest weight is logged */
function weightPRSeries(name) {
  var pts = [], maxW = 0, i, j, k;
  var sorted = D.workouts.slice().sort(function (a, b) { return new Date(a.date) - new Date(b.date); });
  for (i = 0; i < sorted.length; i++) {
    var w = sorted[i], top = 0;
    for (j = 0; j < w.exercises.length; j++) {
      if (w.exercises[j].name !== name) continue;
      var sets = w.exercises[j].sets;
      for (k = 0; k < sets.length; k++) {
        if (!sets[k].done) continue;
        var wt = parseFloat(sets[k].weight), rp = parseInt(sets[k].reps, 10);
        if (!isNaN(wt) && wt > 0 && rp && wt > top) top = wt;
      }
    }
    if (top > maxW) { maxW = top; pts.push({ x: dayStr(w.date), y: maxW }); }
  }
  return pts;
}
/* max reps in a single set per session, chronological (for bodyweight lifts) */
function repsSeries(name) {
  var pts = [], i, j, k;
  var sorted = D.workouts.slice().sort(function (a, b) { return new Date(a.date) - new Date(b.date); });
  for (i = 0; i < sorted.length; i++) {
    var w = sorted[i], best = 0;
    for (j = 0; j < w.exercises.length; j++) {
      if (w.exercises[j].name !== name) continue;
      var sets = w.exercises[j].sets;
      for (k = 0; k < sets.length; k++) { if (sets[k].done) { var rp = parseInt(sets[k].reps, 10); if (rp > best) best = rp; } }
    }
    if (best > 0) pts.push({ x: dayStr(w.date), y: best });
  }
  return pts;
}
function isRepPR(p) { return !!(p && (p.bodyweight || !p.bestE1RM)); }

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
  renderStartBar();
  if (view === 'dash') renderSyncMini();
  if (view === 'history') initHistorySwipe();
  if (view === 'body') { drawBodyCharts(); drawBodyPRChart(); }
  if (view === 'progress') drawProgressChart();
}
function renderStartBar() {
  var sb = $('startbar');
  if (!sb) return;
  if (view === 'dash' && !active && hasProgram()) {
    sb.innerHTML = '<div class="inner"><button class="btn" onclick="go(\'log\')">Start a workout</button></div>';
    sb.style.display = 'block';
  } else {
    sb.style.display = 'none';
    sb.innerHTML = '';
  }
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
  el.innerHTML = '<span class="dot ' + syncCls() + '"></span><span class="muted" style="font-size:12px">' + esc(sync.msg) + '</span>';
}

function viewHtml() {
  if (active) return logActiveHtml();
  if (view === 'dash') return dashHtml();
  if (view === 'program') return programHtml();
  if (view === 'programs') return programsHtml();
  if (view === 'workout') return workoutHtml();
  if (view === 'log') return logHtml();
  if (view === 'history') return historyHtml();
  if (view === 'body') return bodyHtml();
  if (view === 'progress') return progressHtml();
  if (view === 'settings') return settingsHtml();
  return '';
}

/* ---------- Dashboard ---------- */
function hasProgram() { return !!(D.program && D.program.name && D.routines && D.routines.length); }
function splitOrder() { return ((D.program && D.program.split) || '').split('/').map(function (s) { return s.trim(); }).filter(Boolean); }
function lastWorkout() { return D.workouts.length ? D.workouts[D.workouts.length - 1] : null; }
function nextWorkoutName() {
  var order = splitOrder(); if (!order.length) return null;
  var last = lastWorkout(); if (!last) return order[0];
  var idx = -1, i;
  for (i = 0; i < order.length; i++) { if (order[i].toLowerCase() === String(last.name).toLowerCase()) { idx = i; break; } }
  return idx === -1 ? order[0] : order[(idx + 1) % order.length];
}
function programTotalWeeks() {
  var b = D.program && D.program.blocks; if (!b) return 0;
  var max = 0;
  Object.keys(b).forEach(function (k) {
    var dl = parseInt(b[k].deload, 10) || 0; if (dl > max) max = dl;
    var parts = String(b[k].weeks || '').split('-'); var hi = parseInt(parts[parts.length - 1], 10) || 0; if (hi > max) max = hi;
  });
  return max;
}
function isPeriodized() { return programTotalWeeks() > 0; }
function programProgress() {
  var total = programTotalWeeks();
  var start = D.programStart ? new Date(D.programStart) : (D.workouts.length ? new Date(D.workouts[0].date) : new Date(todayISO()));
  var weeks = Math.floor((Date.now() - start.getTime()) / (7 * 24 * 3600 * 1000)) + 1;
  if (weeks < 1) weeks = 1;
  if (total && weeks > total) weeks = total;
  return { week: weeks, total: total, pct: total ? Math.round(weeks / total * 100) : 0, periodized: total > 0 };
}

function dashHtml() {
  var n = D.workouts.length;
  var bw = D.bodyweight.length ? D.bodyweight[D.bodyweight.length - 1].value : '\u2014';
  var prCount = Object.keys(D.prs).length;
  var h = '';
  if (hasProgram()) {
    var pr = programProgress();
    var nextN = nextWorkoutName();
    var last = lastWorkout();
    var lblsm = 'font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)';
    h += '<div class="card" onclick="openProgram()" style="cursor:pointer">';
    h += '<div class="row"><div style="font-family:\'Archivo Expanded\',Archivo,sans-serif;font-weight:800;font-size:16px">' + esc(D.program.name) + '</div>' +
      '<span id="syncmini" class="dot"></span></div>';
    h += '<div class="muted" style="font-size:12px;margin-top:2px">' + esc(D.program.split) + '</div>';
    if (pr.periodized) {
      h += '<div class="row" style="margin-top:12px"><span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.08em">Week ' + pr.week + ' of ' + pr.total + '</span>' +
        '<span class="mono" style="font-size:12px;color:var(--accent)">' + pr.pct + '%</span></div>';
      h += '<div class="pbar"><i style="width:' + pr.pct + '%"></i></div>';
    } else {
      h += '<div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin-top:12px">' + D.routines.length + ' training days</div>';
    }
    h += '<div class="row" style="margin-top:14px;gap:10px;align-items:center">' +
      '<div style="flex:1"><div style="' + lblsm + '">Previous</div><div style="font-weight:700;margin-top:2px">' + (last ? esc(last.name) : '\u2014') + '</div>' +
      (last ? '<div class="muted" style="font-size:11px">' + niceDate(last.date) + '</div>' : '') + '</div>' +
      '<div style="color:var(--muted);font-size:18px">\u2192</div>' +
      '<div style="flex:1;text-align:right"><div style="' + lblsm + '">Next</div><div style="font-weight:700;margin-top:2px;color:var(--accent)">' + (nextN ? esc(nextN.toUpperCase()) : '\u2014') + '</div></div>' +
      '</div>';
    h += '<div class="muted" style="font-size:11px;margin-top:14px;text-align:right">View full program \u203a</div>';
    h += '</div>';
  }
  h += '<div class="grid">' +
    statCard(n, 'Workouts') +
    statCard(prCount, 'PRs tracked') +
    statCard(weekCount(), 'This week') +
    statCard(bw, 'Bodyweight') +
    '</div>';
  if (n) {
    h += '<div style="margin:18px 2px 10px"><h2 style="font-size:15px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin:0">Previous Sessions</h2></div>';
    var sorted = D.workouts.map(function (w, i) { return { w: w, i: i }; }).reverse();
    sorted.slice(0, 3).forEach(function (o) { h += sessionCard(o.w, o.i, 'dash'); });
    if (sorted.length > 3) h += '<div class="muted" style="text-align:center;font-size:12px;margin-top:4px">See all ' + sorted.length + ' in History</div>';
  } else {
    h += emptyState('No sessions yet', 'Tap Start a workout to log your first.');
  }
  h += '<div style="height:84px"></div>';
  return h;
}
function sessionCard(w, idx, from) {
  return '<button class="rcard scard" onclick="openWorkout(' + idx + ',\'' + from + '\')">' +
    '<div class="row"><div><div style="font-weight:700;font-size:16px">' + esc(w.name) + '</div>' +
    '<div class="muted" style="font-size:12.5px;margin-top:2px">' + niceDate(w.date) + ' \u00b7 ' + w.exercises.length + ' exercises \u00b7 ' + totalVolume(w).toLocaleString() + ' lb</div></div>' +
    (w.block ? '<span class="pill accent">Block ' + w.block + '</span>' : '') + '</div></button>';
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

/* ---------- Workout detail (read-only view of a past session) ---------- */
function openWorkout(idx, from) { viewWorkout = idx; workoutBackView = from || 'history'; view = 'workout'; render(); window.scrollTo(0, 0); }
function workoutHtml() {
  var w = D.workouts[viewWorkout];
  if (!w) return emptyState('Not found', 'That session is unavailable.');
  var h = '';
  h += '<div class="card"><div class="row" style="margin-bottom:12px"><button class="btn ghost sm" onclick="go(\'' + workoutBackView + '\')">\u2190 Back</button>' +
    '<button class="btn sm" onclick="startEdit(' + viewWorkout + ')">Edit</button></div>';
  h += '<div class="row"><div><div style="font-family:\'Archivo Expanded\',Archivo,sans-serif;font-weight:800;font-size:24px">' + esc(w.name) + '</div>' +
    '<div class="muted" style="font-size:13px;margin-top:2px">' + niceDate(w.date) + (w.block ? ' \u00b7 Block ' + w.block : '') + ' \u00b7 ' + totalVolume(w).toLocaleString() + ' lb vol</div></div>' +
    '<span class="pill accent">' + w.exercises.length + ' ex</span></div>';
  var chips = [];
  if (w.week) chips.push('Week ' + esc(w.week));
  if (w.bodyweight) chips.push('BW ' + esc(w.bodyweight));
  if (w.sleep) chips.push('Sleep ' + esc(w.sleep));
  if (w.energy) chips.push('Energy ' + esc(w.energy));
  if (chips.length) { h += '<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px">'; chips.forEach(function (c) { h += '<span class="pill">' + c + '</span>'; }); h += '</div>'; }
  h += '</div>';
  w.exercises.forEach(function (ex) {
    h += '<div class="ex">';
    h += '<div class="row"><div><div class="name">' + esc(ex.name) + '</div>' + (ex.scheme ? '<div class="scheme">' + esc(ex.scheme) + '</div>' : '') + '</div>';
    if (ex.skipped) h += '<span class="pill" style="background:rgba(139,145,158,.18);color:var(--muted)">Skipped</span>';
    else if (ex.superset) h += '<div class="ss">SS</div>';
    h += '</div>';
    if (!ex.skipped) {
      (ex.sets || []).forEach(function (s, si) {
        var val = (s.weight || '\u2014') + ' \u00d7 ' + (s.reps || '\u2014') + (s.rpe ? ' @ RPE ' + s.rpe : '');
        h += '<div class="setline"><span class="lbl">S' + (si + 1) + '</span><span class="mono val">' + esc(val) + '</span>' +
          '<span class="' + (s.done ? 'setok' : 'setno') + '">' + (s.done ? '\u2713' : '\u00b7') + '</span></div>';
      });
    }
    if (ex.note) h += '<div class="muted" style="font-size:12px;margin-top:8px">' + esc(ex.note) + '</div>';
    h += '</div>';
  });
  if (w.notes) h += '<div class="card"><h2>Post-session</h2><div>' + esc(w.notes) + '</div></div>';
  h += '<div style="height:20px"></div>';
  return h;
}

/* ---------- Program explorer (drill-down: overview -> block -> day) ---------- */
var programBlock = null, programDay = null, importOpen = false;
var BLOCK_GOALS = {
  '1': { goal: 'Build the muscle base — moderate loads and higher reps. Add reps week to week, then add weight (double progression).', scheme: 'Compounds 8–10 · Isolation 12–15 · RPE 7–8' },
  '2': { goal: 'Bridge hypertrophy into strength — heavier compounds while keeping solid volume on isolation work.', scheme: 'Compounds 6–8 · Isolation 8–12 · RPE 8' },
  '3': { goal: 'Peak strength — low-rep heavy compounds at high effort; isolation work maintains muscle.', scheme: 'Compounds 4–6 · Isolation 6–10 · RPE 8–9' }
};
function blockMeta(b) { return (D.program.blocks && (D.program.blocks[b] || D.program.blocks[String(b)])) || {}; }
function blockOf(week) {
  var b = (D.program && D.program.blocks) || {}, keys = Object.keys(b), i;
  for (i = 0; i < keys.length; i++) {
    var parts = String(b[keys[i]].weeks || '').split('-');
    var lo = parseInt(parts[0], 10), hi = parseInt(parts[parts.length - 1], 10), dl = parseInt(b[keys[i]].deload, 10);
    if ((week >= lo && week <= hi) || week === dl) return parseInt(keys[i], 10) || keys[i];
  }
  return keys.length ? (parseInt(keys[0], 10) || 1) : 1;
}
function isDeloadWeek(week) {
  var b = (D.program && D.program.blocks) || {};
  return Object.keys(b).some(function (k) { return parseInt(b[k].deload, 10) === week; });
}
function blockColor(b) { return b === 1 ? 'var(--accent)' : b === 2 ? 'var(--accent2)' : b === 3 ? 'var(--good)' : 'var(--accent2)'; }
function progDayCard(r) {
  return '<button class="rcard scard" onclick="progOpenDay(\'' + r.id + '\')">' +
    '<div class="row"><div><div style="font-weight:800;font-size:17px">' + esc(r.name) + '</div>' +
    '<div class="muted" style="font-size:12px;margin-top:2px">' + r.exercises.length + ' exercises</div></div>' +
    '<div style="display:flex;gap:8px;align-items:center">' +
    (r.derived ? '<span class="pill derived">derived</span>' : '') +
    '<span class="muted" style="font-size:18px">›</span></div></div></button>';
}
function fmtRest(sec) { sec = parseInt(sec, 10) || 0; if (sec < 60) return sec + 's'; return Math.floor(sec / 60) + ':' + pad(sec % 60); }
function blockRoutines(b) { return D.routines.filter(function (r) { return r.block === b; }); }
function openProgram() { view = 'program'; programBlock = null; programDay = null; render(); window.scrollTo(0, 0); }
function progOpenBlock(b) { programBlock = b; programDay = null; render(); window.scrollTo(0, 0); }
function progOpenDay(rid) { programDay = rid; render(); window.scrollTo(0, 0); }

function programHtml() {
  if (!hasProgram()) return emptyState('No program', 'No active program is configured.');
  if (programDay) return programDayHtml();
  if (programBlock) return programBlockHtml();
  return programOverviewHtml();
}
function programOverviewHtml() {
  var pr = programProgress();
  var periodized = isPeriodized();
  var h = '<div class="card"><div class="row" style="margin-bottom:12px">' +
    '<button class="btn ghost sm" onclick="go(\'dash\')">← Back</button>' +
    '<button class="btn ghost sm" onclick="openPrograms()">Programs ⇄</button></div>';
  h += '<div style="font-family:\'Archivo Expanded\',Archivo,sans-serif;font-weight:800;font-size:22px">' + esc(D.program.name) + '</div>';
  if (D.program.method) h += '<div class="muted" style="font-size:12.5px;margin-top:4px">' + esc(D.program.method) + '</div>';
  h += '<div class="muted" style="font-size:12.5px">' + esc(D.program.split) + '</div>';
  if (periodized) {
    var total = pr.total, prevBlock = 0;
    h += '<div style="margin-top:14px;display:flex">';
    for (var wk = 1; wk <= total; wk++) {
      var b = blockOf(wk), dl = isDeloadWeek(wk), cur = (wk === pr.week);
      var style = 'flex:1;min-width:0;height:34px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#0e0f12;background:' + blockColor(b) + ';' +
        (dl ? 'opacity:.4;' : '') + (cur ? 'outline:2px solid var(--txt);outline-offset:1px;' : '') + (wk > 1 ? 'margin-left:' + (b !== prevBlock ? '8' : '3') + 'px;' : '');
      h += '<div style="' + style + '">' + wk + '</div>';
      prevBlock = b;
    }
    h += '</div><div class="muted" style="font-size:11px;margin-top:8px">Week ' + pr.week + ' of ' + total + ' · faded = deload week</div>';
  } else {
    h += '<div class="muted" style="font-size:12px;margin-top:10px">' + D.routines.length + ' training days · simple program</div>';
  }
  h += '</div>';
  if (periodized) {
    var pBlocks = Object.keys(D.program.blocks).map(function (k) { return parseInt(k, 10); }).sort(function (a, b) { return a - b; });
    pBlocks.forEach(function (b) {
      var m = blockMeta(b), g = BLOCK_GOALS[String(b)] || {}, cur = blockOf(pr.week) === b;
      var nDays = blockRoutines(b).length;
      h += '<button class="rcard scard" onclick="progOpenBlock(' + b + ')">' +
        '<div class="row"><div style="font-family:\'Archivo Expanded\',Archivo,sans-serif;font-weight:800;font-size:16px">Block ' + b + '</div>' +
        (cur ? '<span class="pill accent">Current</span>' : '<span class="muted" style="font-size:18px">›</span>') + '</div>' +
        '<div style="font-weight:700;margin-top:2px">' + esc(m.phase || '') + '</div>' +
        '<div class="muted" style="font-size:12px;margin-top:2px">Weeks ' + esc(m.weeks || '') + ' · Deload wk ' + esc(m.deload || '') + ' · ' + nDays + ' days</div>' +
        (g.goal ? '<div class="muted" style="font-size:12.5px;line-height:1.45;margin-top:8px">' + esc(g.goal) + '</div>' : '') +
        '</button>';
    });
  } else {
    h += '<div style="margin:14px 2px 10px"><h2 style="font-size:15px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin:0">Training days</h2></div>';
    D.routines.forEach(function (r) { h += progDayCard(r); });
  }
  h += '<div style="height:16px"></div>';
  return h;
}
function programBlockHtml() {
  var b = programBlock, m = blockMeta(b), g = BLOCK_GOALS[String(b)] || {};
  var h = '<div class="card"><button class="btn ghost sm" onclick="openProgram()" style="margin-bottom:12px">← Program</button>';
  h += '<div style="font-family:\'Archivo Expanded\',Archivo,sans-serif;font-weight:800;font-size:22px">Block ' + b + '</div>';
  h += '<div style="font-weight:700;margin-top:2px">' + esc(m.phase || '') + '</div>';
  h += '<div class="muted" style="font-size:12.5px;margin-top:2px">Weeks ' + esc(m.weeks || '') + ' · Deload week ' + esc(m.deload || '') + '</div>';
  if (g.goal) h += '<div style="font-size:13px;line-height:1.5;margin-top:10px">' + esc(g.goal) + '</div>';
  if (g.scheme) h += '<div style="margin-top:10px"><span class="pill">' + esc(g.scheme) + '</span></div>';
  h += '</div>';
  h += '<div style="margin:14px 2px 10px"><h2 style="font-size:15px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin:0">Training days</h2></div>';
  blockRoutines(b).forEach(function (r) { h += progDayCard(r); });
  h += '<div style="height:16px"></div>';
  return h;
}
function programDayHtml() {
  var r = D.routines.filter(function (x) { return x.id === programDay; })[0];
  if (!r) return emptyState('Not found', 'That day is unavailable.');
  var m = blockMeta(r.block);
  var h = '<div class="card"><button class="btn ghost sm" onclick="progOpenBlock(' + r.block + ')" style="margin-bottom:12px">← Block ' + r.block + '</button>';
  h += '<div class="row"><div><div style="font-family:\'Archivo Expanded\',Archivo,sans-serif;font-weight:800;font-size:24px">' + esc(r.name) + '</div>' +
    '<div class="muted" style="font-size:12.5px;margin-top:2px">' + (r.block ? 'Block ' + r.block + ' · ' : '') + esc(m.phase || '') + '</div></div>' +
    (r.derived ? '<span class="pill derived">derived</span>' : '') + '</div>';
  h += '<button class="btn" style="margin-top:12px" onclick="startWorkout(\'' + r.id + '\')">Start this workout</button></div>';
  r.exercises.forEach(function (e, i) {
    h += '<div class="ex"><div class="row"><div><div class="name">' + (i + 1) + '. ' + esc(e.name) + '</div>' +
      '<div class="scheme">' + e.sets + ' × ' + esc(e.reps) + ' @ RPE ' + esc(e.rpe) + ' · rest ' + fmtRest(e.rest) + '</div></div>' +
      (e.superset ? '<div class="ss">SS</div>' : '') + '</div></div>';
  });
  h += '<div style="height:16px"></div>';
  return h;
}

/* ---------- Programs library (list / set active / delete / import) ---------- */
function openPrograms() { view = 'programs'; importOpen = false; render(); window.scrollTo(0, 0); }
function toggleImport() { importOpen = !importOpen; render(); }
function doImport() {
  var el = $('impText'); if (!el) return;
  var prog;
  try { prog = parseProgramJson(el.value); } catch (e) { toast('Invalid JSON: ' + e.message); return; }
  D.programs.push(prog);
  importOpen = false;
  if (confirm('Added “' + prog.name + '”. Set it as your active program now?')) {
    setActiveProgram(prog.id);
  } else {
    render(); toast('Program added'); syncDataJson('add program: ' + prog.name);
  }
}
function programsHtml() {
  var h = '<div class="card"><button class="btn ghost sm" onclick="go(\'dash\')" style="margin-bottom:12px">← Back</button><h2>Programs</h2>';
  h += '<button class="btn" onclick="toggleImport()">' + (importOpen ? 'Cancel import' : 'Import program (JSON)') + '</button>';
  if (importOpen) {
    h += '<textarea id="impText" placeholder="Paste program JSON…" spellcheck="false" autocapitalize="off" style="width:100%;height:150px;margin-top:10px;background:var(--bg3);border:1px solid var(--line);color:var(--txt);border-radius:11px;padding:12px;font-family:monospace;font-size:12px"></textarea>';
    h += '<button class="btn sm" style="margin-top:8px;width:100%" onclick="doImport()">Add program</button>';
    h += '<div class="muted" style="font-size:11px;line-height:1.55;margin-top:10px">Keys: name, method, split (optional), blocks (optional, for periodized), and days[] — each day has name, optional block, and exercises[] with name, sets, reps, rpe, rest. Omit blocks for a simple program.</div>';
  }
  h += '</div>';
  if (!D.programs.length) { h += emptyState('No programs', 'Import one above to get started.'); return h; }
  D.programs.forEach(function (p) {
    var active = p.id === D.activeProgramId;
    h += '<div class="ex"><div class="row" style="align-items:flex-start"><div style="flex:1"><div class="name">' + esc(p.name) + (active ? ' <span class="pill accent">Active</span>' : '') + '</div>' +
      '<div class="scheme">' + (p.routines ? p.routines.length : 0) + ' days · ' + (p.periodized ? 'periodized' : 'simple') + '</div></div></div>';
    h += '<div class="row" style="gap:8px;margin-top:10px">';
    if (!active) h += '<button class="btn sm" style="flex:1" onclick="setActiveProgram(\'' + p.id + '\')">Set active</button>';
    else h += '<button class="btn ghost sm" style="flex:1" onclick="openProgram()">View</button>';
    h += '<button class="btn ghost sm" onclick="deleteProgram(\'' + p.id + '\')" style="color:var(--bad)">Delete</button>';
    h += '</div></div>';
  });
  h += '<div style="height:16px"></div>';
  return h;
}

/* ---------- Log: chooser ---------- */
function logHtml() {
  if (logMode === 'program') return logPickerHtml();
  if (logMode === 'template') return logTemplatesHtml();
  return logMenuHtml();
}
function setLogMode(m) { logMode = m; render(); window.scrollTo(0, 0); }
function logMenuHtml() {
  var nT = (D.templates || []).length;
  var h = '<div class="card"><h2>Start a workout</h2>';
  h += '<button class="btn" onclick="setLogMode(\'program\')">From program</button>';
  h += '<button class="btn ghost" style="margin-top:8px" onclick="startBlank()">From scratch</button>';
  h += '<button class="btn ghost" style="margin-top:8px" onclick="setLogMode(\'template\')">From template' + (nT ? ' (' + nT + ')' : '') + '</button>';
  h += '</div>';
  return h;
}
function logTemplatesHtml() {
  var t = D.templates || [];
  var h = '<div class="card"><button class="btn ghost sm" onclick="setLogMode(\'menu\')" style="margin-bottom:10px">← Back</button><h2>Templates</h2>';
  if (!t.length) h += '<div class="muted" style="font-size:13px;line-height:1.5">No templates yet. Start any workout and tap “Save as template” to reuse it later.</div>';
  h += '</div>';
  t.forEach(function (tpl) {
    h += '<div class="ex"><div class="row" style="align-items:flex-start"><div style="flex:1"><div class="name">' + esc(tpl.name) + '</div>' +
      '<div class="scheme">' + tpl.exercises.length + ' exercises</div></div>' +
      '<button class="exbtn del" onclick="deleteTemplate(\'' + tpl.id + '\')">✕</button></div>' +
      '<button class="btn sm" style="margin-top:10px;width:100%" onclick="startTemplate(\'' + tpl.id + '\')">Start this</button></div>';
  });
  return h;
}

/* ---------- Log: routine picker ---------- */
function logPickerHtml() {
  var h = '<div class="card"><button class="btn ghost sm" onclick="setLogMode(\'menu\')" style="margin-bottom:10px">← Back</button><h2>Pick a day</h2>';
  var periodized = isPeriodized();
  var meta = null;
  if (periodized) {
    var keys = Object.keys(D.program.blocks).map(function (k) { return parseInt(k, 10); }).sort(function (a, b) { return a - b; });
    if (keys.indexOf(blockTab) < 0) blockTab = keys[0];
    h += '<div class="blocknav">';
    keys.forEach(function (b) { h += '<button class="' + (blockTab === b ? 'on' : '') + '" onclick="setBlock(' + b + ')">Block ' + b + '</button>'; });
    h += '</div>';
    meta = blockMeta(blockTab);
  }
  if (meta) h += '<div class="muted" style="font-size:13px;margin-bottom:4px">Weeks ' + esc(meta.weeks) + ' \u00b7 ' + esc(meta.phase) + ' \u00b7 deload wk ' + esc(meta.deload) + '</div>';
  h += '</div>';
  h += '<div class="grid">';
  (periodized ? D.routines.filter(function (r) { return r.block === blockTab; }) : D.routines).forEach(function (r) {
    h += '<button class="rcard" onclick="startWorkout(\'' + r.id + '\')">' +
      '<div class="day">' + esc(r.name) + '</div>' +
      '<div class="meta">' + r.exercises.length + ' exercises</div>' +
      (r.derived ? '<div style="margin-top:8px"><span class="pill derived">derived</span></div>' : '') +
      '</button>';
  });
  h += '</div>';
  if (D.routines.some(function (r) { return r.derived; })) {
    h += '<div class="card" style="margin-top:6px"><div class="muted" style="font-size:12.5px;line-height:1.5">' +
      'Cards marked <span class="pill derived">derived</span> were generated from your documented scheme — verify against your vault.' +
      '</div></div>';
  }
  return h;
}
function setBlock(b) { blockTab = b; render(); }

/* ---------- Log: active workout ---------- */
function makeActive(name, block, exList) {
  active = {
    id: uid(), date: todayISO(), name: name, block: block || '',
    week: '', bodyweight: '', sleep: '', energy: '', notes: '', editIndex: null,
    exercises: exList.map(function (e) {
      var sets = [], n = e.setCount || 3, i;
      for (i = 0; i < n; i++) sets.push({ weight: '', reps: '', rpe: (e.rpe ? String(e.rpe).split('-')[0] : ''), done: false });
      return { name: e.name, superset: e.superset || null, rest: e.rest || 60, scheme: e.scheme || '', note: '', sets: sets };
    })
  };
  prefillLastWeights(active);
  view = 'log'; render(); window.scrollTo(0, 0);
}
function startWorkout(rid) {
  var r = D.routines.filter(function (x) { return x.id === rid; })[0];
  if (!r) return;
  makeActive(r.name, r.block, r.exercises.map(function (e) {
    return { name: e.name, setCount: e.sets, rpe: e.rpe, rest: e.rest, superset: e.superset,
      scheme: e.sets + ' x ' + e.reps + ' @ RPE ' + e.rpe + ' \u00b7 rest ' + (e.rest || 60) + 's' };
  }));
}
function startBlank() {
  var name = prompt('Workout name', 'Workout');
  if (name === null) return;
  makeActive((name || 'Workout').trim() || 'Workout', '', []);
}
function startTemplate(tid) {
  var t = (D.templates || []).filter(function (x) { return x.id === tid; })[0];
  if (!t) return;
  makeActive(t.name, '', t.exercises.map(function (e) {
    return { name: e.name, setCount: e.sets, rest: e.rest, superset: e.superset, scheme: e.scheme || '' };
  }));
}
function startEdit(idx) {
  var w = D.workouts[idx];
  if (!w) return;
  active = JSON.parse(JSON.stringify(w));
  active.editIndex = idx;
  active.exercises.forEach(function (e) { if (!e.sets) e.sets = []; });
  stopTimer(); view = 'log'; render(); window.scrollTo(0, 0);
}
function addExercise() {
  var name = prompt('Exercise name');
  if (!name || !name.trim()) return;
  active.exercises.push({ name: name.trim(), superset: null, rest: 60, scheme: '', note: '', sets: [{ weight: '', reps: '', rpe: '', done: false }] });
  render();
}
function removeExercise(ei) {
  if (!confirm('Remove ' + active.exercises[ei].name + '?')) return;
  active.exercises.splice(ei, 1); render();
}
function toggleSkip(ei) { active.exercises[ei].skipped = !active.exercises[ei].skipped; render(); }
function removeSet(ei) { var ex = active.exercises[ei]; if (ex.sets.length > 1) { ex.sets.pop(); render(); } }
function saveAsTemplate() {
  var name = prompt('Template name', active.name || 'My Template');
  if (!name || !name.trim()) return;
  if (!D.templates) D.templates = [];
  D.templates.push({
    id: 't' + Date.now().toString(36),
    name: name.trim(),
    exercises: active.exercises.map(function (e) {
      return { name: e.name, sets: (e.sets ? e.sets.length : 3), scheme: e.scheme || '', rest: e.rest || 60, superset: e.superset || null };
    })
  });
  toast('Template saved'); syncDataJson('template: ' + name.trim());
}
function deleteTemplate(tid) {
  if (!confirm('Delete this template?')) return;
  D.templates = (D.templates || []).filter(function (t) { return t.id !== tid; });
  render(); syncDataJson('delete template');
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
  var isEdit = active.editIndex != null;
  var h = '';
  h += '<div class="card">';
  h += '<label class="muted" style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px">Workout name</label>';
  h += '<input value="' + esc(active.name) + '" oninput="active.name=this.value" placeholder="e.g. Push" ' +
    'autocapitalize="words" style="width:100%;background:var(--bg3);border:1px solid var(--line);color:var(--txt);border-radius:10px;padding:11px;font-weight:700;margin-bottom:12px">';
  h += '<div class="row" style="gap:8px">' +
    miniField('Week', 'week', active.week, 'wk') +
    miniField('BW', 'bodyweight', active.bodyweight, 'lb') +
    miniField('Sleep', 'sleep', active.sleep, 'hr') +
    miniField('Energy', 'energy', active.energy, '/10') +
    '</div></div>';
  active.exercises.forEach(function (ex, ei) {
    h += '<div class="ex">';
    h += '<div class="row" style="align-items:flex-start"><div style="flex:1"><div class="name">' + esc(ex.name) + '</div>' +
      (ex.scheme ? '<div class="scheme">' + esc(ex.scheme) + '</div>' : '') + '</div>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
      '<button class="exbtn' + (ex.skipped ? ' on' : '') + '" onclick="toggleSkip(' + ei + ')">' + (ex.skipped ? 'Unskip' : 'Skip') + '</button>' +
      '<button class="exbtn del" onclick="removeExercise(' + ei + ')">\u2715</button></div>';
    h += '</div>';
    if (ex.skipped) {
      h += '<div style="margin-top:10px"><span class="pill" style="background:rgba(139,145,158,.18);color:var(--muted)">Skipped today</span></div>';
    } else {
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
      h += '<div class="row" style="gap:8px;margin-top:10px">' +
        '<button class="btn ghost sm" onclick="addSet(' + ei + ')">+ set</button>' +
        (ex.sets.length > 1 ? '<button class="btn ghost sm" onclick="removeSet(' + ei + ')">\u2212 set</button>' : '') +
        '</div>';
    }
    h += '</div>';
  });
  h += '<button class="btn ghost" onclick="addExercise()" style="margin-bottom:12px">+ Add exercise</button>';
  h += '<div class="card"><div class="field" style="margin:0"><label>Post-session notes</label>' +
    '<input value="' + esc(active.notes) + '" oninput="active.notes=this.value" placeholder="Top set, issues, next time\u2026"></div></div>';
  if (!isEdit) h += '<button class="btn ghost" onclick="saveAsTemplate()" style="margin-bottom:12px">Save as template</button>';
  h += '<div style="height:80px"></div>';
  h += '<div class="finishbar"><div class="inner"><div class="row" style="gap:10px">' +
    '<button class="btn ghost" style="flex:1" onclick="cancelWorkout()">' + (isEdit ? 'Cancel' : 'Discard') + '</button>' +
    '<button class="btn" style="flex:2" onclick="finishWorkout()">' + (isEdit ? 'Save changes' : 'Finish &amp; sync') + '</button>' +
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
  if (s.done && active.editIndex == null) { startTimer(active.exercises[ei].rest || 60); }
}
function addSet(ei) {
  var ex = active.exercises[ei];
  ex.sets.push({ weight: '', reps: '', rpe: '', done: false });
  render();
}
function cancelWorkout() {
  var isEdit = active.editIndex != null;
  if (!confirm(isEdit ? 'Discard changes to this workout?' : 'Discard this workout? Nothing will be saved.')) return;
  var idx = active.editIndex;
  active = null; stopTimer();
  if (isEdit) { viewWorkout = idx; view = 'workout'; } else { view = 'log'; logMode = 'menu'; }
  render();
}
function finishWorkout() {
  if (!active.name || !active.name.trim()) { toast('Name your workout first'); return; }
  var isEdit = active.editIndex != null;
  var logged = 0;
  active.exercises.forEach(function (ex) { if (!ex.skipped) ex.sets.forEach(function (s) { if (s.done) logged++; }); });
  if (logged === 0 && !confirm('No sets marked done. Save anyway?')) return;
  // record latest bodyweight if entered (new workouts only)
  if (!isEdit && active.bodyweight && !isNaN(parseFloat(active.bodyweight))) {
    D.bodyweight.push({ date: dayStr(active.date), value: parseFloat(active.bodyweight) });
  }
  var clean = JSON.parse(JSON.stringify(active));
  var idx = clean.editIndex;
  delete clean.routineId; delete clean.editIndex;
  clean.exercises.forEach(function (e) { delete e.prev; });
  if (isEdit) { D.workouts[idx] = clean; } else { D.workouts.push(clean); }
  recomputePRs();
  cacheData();
  active = null; stopTimer();
  if (isEdit) { viewWorkout = idx; view = 'workout'; } else { view = 'history'; }
  render();
  pushWorkout(clean);
}

/* ---------- History ---------- */
function historyHtml() {
  if (!D.workouts.length) return emptyState('No workouts yet', 'Start your first session from the Log tab.');
  var h = '<div style="margin:2px 2px 10px"><h2 style="font-size:15px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin:0">History</h2></div>';
  h += '<div class="muted" style="font-size:11px;margin:0 2px 10px">Swipe a workout left to delete</div>';
  var sorted = D.workouts.map(function (w, i) { return { w: w, i: i }; }).reverse();
  sorted.forEach(function (o) { h += historySessionCard(o.w, o.i); });
  h += '<div style="height:12px"></div>';
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
function historySessionCard(w, idx) {
  return '<div class="swipe-wrap">' +
    '<button class="swipe-act swipe-tpl" onclick="saveWorkoutAsTemplate(' + idx + ')" aria-label="Save as template">Save<br>Template</button>' +
    '<button class="swipe-act swipe-del" onclick="deleteWorkout(' + idx + ')" aria-label="Delete">✕</button>' +
    '<div class="swipe-card rcard" data-idx="' + idx + '">' +
    '<div class="row"><div><div style="font-weight:700;font-size:16px">' + esc(w.name) + '</div>' +
    '<div class="muted" style="font-size:12.5px;margin-top:2px">' + niceDate(w.date) + ' · ' + w.exercises.length + ' exercises · ' + totalVolume(w).toLocaleString() + ' lb</div></div>' +
    (w.block ? '<span class="pill accent">Block ' + w.block + '</span>' : '') +
    '</div></div></div>';
}
function saveWorkoutAsTemplate(idx) {
  var w = D.workouts[idx];
  if (!w) return;
  var name = prompt('Template name', w.name || 'Template');
  if (!name || !name.trim()) { render(); return; }
  if (!D.templates) D.templates = [];
  D.templates.push({
    id: 't' + Date.now().toString(36),
    name: name.trim(),
    exercises: w.exercises.map(function (e) {
      return { name: e.name, sets: (e.sets ? e.sets.length : 3), scheme: e.scheme || '', rest: e.rest || 60, superset: e.superset || null };
    })
  });
  render();
  toast('Saved as template');
  syncDataJson('template from workout: ' + name.trim());
}
function deleteWorkout(idx) {
  var w = D.workouts[idx];
  if (!w) return;
  if (!confirm('Delete this ' + w.name + ' session (' + niceDate(w.date) + ')? This can’t be undone.')) return;
  D.workouts.splice(idx, 1);
  recomputePRs(); cacheData(); render();
  toast('Workout deleted');
  syncDataJson('delete workout: ' + w.name + ' ' + dayStr(w.date)).then(function () { return deleteLogFile(w); });
}
function deleteLogFile(w) {
  if (!gitConfigured()) return Promise.resolve();
  var fname = cfg.logsDir.replace(/\/$/, '') + '/' + dayStr(w.date) + '-' + w.name.toLowerCase() + '.md';
  return ghGet(fname).then(function (r) {
    if (r && r.sha) return ghDelete(fname, 'delete log: ' + fname, r.sha);
  }).catch(function () {});
}
/* Swipe-left-to-reveal-delete on History cards. Distinguishes horizontal swipe
   from vertical scroll / pull-to-refresh, and treats a no-move touch as a tap. */
function initHistorySwipe() {
  var cards = document.querySelectorAll('#app .swipe-card');
  Array.prototype.forEach.call(cards, function (card) {
    var idx = parseInt(card.getAttribute('data-idx'), 10);
    var startX = 0, startY = 0, dx = 0, dragging = false, decided = false, horizontal = false, open = false;
    var OPEN = -144, THRESH = 60;
    var wrap = card.parentNode;
    function setX(x) { card.style.transform = 'translateX(' + x + 'px)'; }
    function close() { open = false; card.style.transition = 'transform .2s ease'; setX(0); card.classList.remove('open'); wrap.classList.remove('revealed'); }
    function openCard() { open = true; card.style.transition = 'transform .2s ease'; setX(OPEN); card.classList.add('open'); wrap.classList.add('revealed'); }
    card.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX; startY = e.touches[0].clientY;
      dx = 0; dragging = true; decided = false; horizontal = false;
      card.style.transition = '';
    }, { passive: true });
    card.addEventListener('touchmove', function (e) {
      if (!dragging) return;
      var ddx = e.touches[0].clientX - startX, ddy = e.touches[0].clientY - startY;
      if (!decided && (Math.abs(ddx) > 8 || Math.abs(ddy) > 8)) { decided = true; horizontal = Math.abs(ddx) > Math.abs(ddy); }
      if (!horizontal) return;
      e.preventDefault(); e.stopPropagation();
      wrap.classList.add('revealed');
      dx = (open ? OPEN : 0) + ddx;
      if (dx > 0) dx = 0; if (dx < OPEN - 16) dx = OPEN - 16;
      setX(dx);
    }, { passive: false });
    function end() {
      if (!dragging) return; dragging = false;
      if (!decided) { if (open) close(); else openWorkout(idx, 'history'); return; }
      if (!horizontal) return;
      if (dx <= -THRESH) openCard(); else close();
    }
    card.addEventListener('touchend', end, { passive: true });
    card.addEventListener('touchcancel', end, { passive: true });
  });
}

/* ---------- Body (bodyweight + PRs) ---------- */
function bodyHtml() {
  var h = '';
  h += '<div class="card"><h2>Log bodyweight</h2>' +
    '<div class="row" style="gap:10px">' +
    '<input id="bwInput" class="mono" inputmode="decimal" placeholder="lb" style="flex:1;background:var(--bg3);border:1px solid var(--line);color:var(--txt);border-radius:11px;padding:12px;text-align:center">' +
    '<button class="btn sm" onclick="logBW()">Add</button></div></div>';
  h += '<div class="card"><h2>Bodyweight</h2><canvas id="bwChart" height="160"></canvas></div>';
  // PR explorer: dropdown selector + inline est-1RM chart
  var names = prNamesSorted();
  h += '<div class="card"><h2>Personal records</h2>';
  if (!names.length) { h += '<div class="muted">Log some sets and your PRs show up here.</div></div>'; return h; }
  if (!bodyPR || names.indexOf(bodyPR) < 0) bodyPR = defaultPR(names);
  var coreNames = names.filter(isCore), restNames = names.filter(function (n) { return !isCore(n); });
  function opt(n) { return '<option' + (n === bodyPR ? ' selected' : '') + '>' + esc(n) + '</option>'; }
  h += '<select id="prSel" onchange="setPRExercise(this.value)" style="width:100%;background:var(--bg3);border:1px solid var(--line);color:var(--txt);border-radius:11px;padding:12px;font-weight:700">';
  if (coreNames.length) { h += '<optgroup label="Core lifts">'; coreNames.forEach(function (n) { h += opt(n); }); h += '</optgroup>'; }
  if (restNames.length) { h += '<optgroup label="Other exercises">'; restNames.forEach(function (n) { h += opt(n); }); h += '</optgroup>'; }
  h += '</select>';
  var p = D.prs[bodyPR];
  if (isRepPR(p)) {
    h += '<div class="row" style="margin-top:14px;align-items:flex-end">' +
      '<div><div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)">Rep max (1 set)</div>' +
      '<div class="big" style="font-size:30px">' + p.bestReps + '<span style="font-size:14px;font-weight:700;color:var(--muted)"> reps</span></div></div>' +
      '<div style="text-align:right"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)">Bodyweight</div>' +
      (p.bestWeight ? '<div style="font-weight:700;font-size:18px;margin-top:4px">+' + p.bestWeight + ' lb top</div>' : '<div class="muted" style="font-size:13px;margin-top:6px">no added load</div>') +
      '<div class="muted" style="font-size:11px">' + niceDate(p.repsDate) + '</div></div></div>';
    h += '<div class="muted" style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;margin-top:14px">Rep max over time</div>';
  } else {
    h += '<div class="row" style="margin-top:14px;align-items:flex-end">' +
      '<div><div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)">Best est. 1RM</div>' +
      '<div class="big" style="font-size:30px">' + p.bestE1RM + '<span style="font-size:14px;font-weight:700;color:var(--muted)"> lb</span></div></div>' +
      '<div style="text-align:right"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)">Top weight</div>' +
      '<div style="font-weight:700;font-size:18px;margin-top:4px">' + p.bestWeight + ' lb</div>' +
      '<div class="muted" style="font-size:11px">' + niceDate(p.date) + '</div></div></div>';
    h += '<div class="muted" style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;margin-top:14px">Top weight over time (PRs)</div>';
  }
  h += '<canvas id="prChart" height="160" style="margin-top:8px"></canvas>';
  h += '</div>';
  return h;
}
/* core-lift grouping for the PR selector (Big 3 + OHP + Row + Pull-ups) */
var bodyPR = null;
var CORE_PATTERNS = ['back squat', 'bench press', 'deadlift', 'ohp', 'overhead press', 'barbell row', 'pull-up', 'pull up'];
function isCore(name) { var n = String(name).toLowerCase(); return CORE_PATTERNS.some(function (c) { return n.indexOf(c) > -1; }); }
function prNamesSorted() {
  var names = Object.keys(D.prs);
  return names.filter(isCore).sort().concat(names.filter(function (n) { return !isCore(n); }).sort());
}
function defaultPR(names) {
  var pref = ['back squat', 'bench press', 'deadlift', 'overhead press', 'ohp', 'barbell row', 'pull-up'];
  var i, j;
  for (i = 0; i < pref.length; i++) for (j = 0; j < names.length; j++) { if (names[j].toLowerCase().indexOf(pref[i]) > -1) return names[j]; }
  return names[0];
}
function setPRExercise(n) { bodyPR = n; render(); }
function drawBodyPRChart() {
  if (!bodyPR || !$('prChart')) return;
  var p = D.prs[bodyPR];
  if (isRepPR(p)) lineChart($('prChart'), repsSeries(bodyPR), getCss('--accent2'));
  else lineChart($('prChart'), weightPRSeries(bodyPR), getCss('--accent'));
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
  h += '<div class="card"><h2>Programs</h2>' +
    '<div class="muted" style="font-size:12.5px;line-height:1.5;margin-bottom:10px">Switch the active program, import a new one, or manage your library.</div>' +
    '<button class="btn ghost" onclick="openPrograms()">Manage programs</button></div>';
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
  if (v === 'log' && !active) logMode = 'menu';
  view = v; render(); window.scrollTo(0, 0);
}
function toggleTheme() { cfg.theme = (cfg.theme === 'light' ? 'dark' : 'light'); saveCfg(); render(); }

function emptyState(title, sub) {
  return '<div class="empty"><div style="font-weight:700;font-size:18px;color:var(--txt)">' + esc(title) + '</div>' +
    '<div style="margin-top:6px">' + esc(sub) + '</div></div>';
}

/* ---------- pull to refresh ---------- */
/* Custom top pull-to-refresh + rubber-band on every menu view. Disabled while a
   workout is active so it never fights with logging inputs. Pulling past the
   threshold re-pulls the rolling JSON from Git; a short pull bungees back. */
function initPullToRefresh() {
  var THRESH = 70, MAX = 120, DAMP = 0.5;
  var appEl = $('app'), ind = $('ptr');
  if (!appEl || !ind) return;
  var ic = ind.querySelector('.ptr-ic');
  var startY = 0, dist = 0, pulling = false, ready = false, refreshing = false;

  function atTop() { return (window.scrollY || document.documentElement.scrollTop || 0) <= 0; }
  function clearTransition() { appEl.style.transition = ''; ind.style.transition = ''; }
  function animateBack() {
    appEl.style.transition = 'transform .25s ease';
    ind.style.transition = 'opacity .25s ease, transform .25s ease';
    appEl.style.transform = '';
    ind.style.opacity = '0';
    ind.style.transform = 'translateX(-50%) translateY(0)';
    setTimeout(clearTransition, 260);
  }
  function reset() { if (dist !== 0) { appEl.style.transform = ''; ind.style.opacity = '0'; dist = 0; ready = false; ind.classList.remove('ready'); } }

  document.addEventListener('touchstart', function (e) {
    if (refreshing || active || e.touches.length !== 1 || !atTop()) { pulling = false; return; }
    startY = e.touches[0].clientY; pulling = true; dist = 0; ready = false;
  }, { passive: true });

  document.addEventListener('touchmove', function (e) {
    if (!pulling || refreshing) return;
    var dy = e.touches[0].clientY - startY;
    if (dy <= 0 || !atTop()) { reset(); return; }
    e.preventDefault();
    dist = Math.min(MAX, dy * DAMP);
    appEl.style.transform = 'translateY(' + dist + 'px)';
    ind.style.opacity = '' + Math.min(1, dist / THRESH);
    ind.style.transform = 'translateX(-50%) translateY(' + Math.min(dist, THRESH + 6) + 'px)';
    if (ic) ic.style.transform = 'rotate(' + Math.round(dist * 2.6) + 'deg)';
    ready = dist >= THRESH;
    ind.classList.toggle('ready', ready);
  }, { passive: false });

  function end() {
    if (!pulling || refreshing) { pulling = false; return; }
    pulling = false;
    if (!ready) { animateBack(); return; }
    refreshing = true;
    ind.classList.remove('ready'); ind.classList.add('spinning');
    appEl.style.transition = 'transform .2s ease';
    appEl.style.transform = 'translateY(52px)';
    ind.style.transition = 'transform .2s ease, opacity .2s ease';
    ind.style.opacity = '1';
    ind.style.transform = 'translateX(-50%) translateY(52px)';
    if (ic) ic.style.transform = '';
    var finish = function () { refreshing = false; ready = false; ind.classList.remove('spinning'); animateBack(); };
    var task = gitConfigured() ? pullFromGit() : Promise.resolve();
    task.then(function () {
      recomputePRs(); cacheData(); render();
      if (gitConfigured()) toast('Refreshed');
    }).catch(function () {}).then(function () { setTimeout(finish, 350); });
  }
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', function () { if (pulling && !refreshing) { pulling = false; animateBack(); } }, { passive: true });
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
  initPullToRefresh();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(function (reg) { try { reg.update(); } catch (e) {} }).catch(function () {});
    var refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (refreshing) return; refreshing = true; window.location.reload();
    });
  }
}
boot();
