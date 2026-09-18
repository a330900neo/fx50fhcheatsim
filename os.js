/* =====================================================================
   os.js  —  CasioOS  (demo build 0.3)
   ---------------------------------------------------------------------
   A guest operating system for the fx-50FH II web replica.

   CONTRACT WITH THE FIRMWARE
   --------------------------
   os.js is given control of the LCD and the key stream, and NOTHING else.
   It cannot touch the DOM, the page, or the calculator's own state.

   The firmware hands us an `api` object on boot:

     api.screen   -> { ctx, width, height, colors:{bg,fg,dim,mid} }
     api.invalidate()          request a repaint
     api.exit()                shut down, hand the LCD back to the calculator
     api.battery()             0.0 - 1.0
     api.signal()              0 - 4
     api.now()                 Date object

   We must expose an object on `window.CASIO_OS` with:

     name, version
     boot(api)     called once when the OS starts
     onKey(ev)     ev = { type:'press'|'keydown'|'keyup', key, shift,
                          alpha, hyp, duration, time }
     render(ctx, w, h)   draw one frame of the LCD
     shutdown()    tear down timers

   Drop a new app into the APPS array and it appears on the homescreen.
   ===================================================================== */
(function () {
  'use strict';

  var OS = { name: 'CasioOS', version: '0.3' };

  var api = null, SC = null, W = 0, H = 0, COL = null;

  /* -----------------------------------------------------------------
     The LCD is monochrome only while the calculator firmware owns it.
     Once the OS boots, the backlight comes on and we get colour.
     ----------------------------------------------------------------- */
  var T = {
    bg0:     '#0e1526',
    bg1:     '#182238',
    panel:   'rgba(255,255,255,0.055)',
    panelHi: 'rgba(255,255,255,0.10)',
    line:    'rgba(255,255,255,0.14)',
    text:    '#e9eef7',
    dim:     'rgba(233,238,247,0.58)',
    faint:   'rgba(233,238,247,0.30)',
    accent:  '#4ad6c6',
    accent2: '#ffb454',
    formula: '#9ecbff',
    answer:  '#7ee7a8',
    good:    '#5ddb8a',
    warn:    '#ffcc55',
    bad:     '#ff6b6b'
  };

  function paintBackground(ctx) {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, T.bg1);
    g.addColorStop(1, T.bg0);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  var clockTimer = null;
  var view = 'home';      // 'home' | 'app'
  var homeIndex = 0;
  var activeApp = null;

  /* ---------------------------------------------------------------
     Small drawing helpers
     --------------------------------------------------------------- */
  function font(ctx, size, weight) {
    ctx.font = (weight ? weight + ' ' : '') + size +
      'px "DejaVu Sans Mono", "Menlo", monospace';
  }
  function text(ctx, str, x, y, size, color, weight, align) {
    font(ctx, size, weight);
    ctx.fillStyle = color || COL.fg;
    ctx.textBaseline = 'top';
    ctx.textAlign = align || 'left';
    ctx.fillText(str, x, y);
    ctx.textAlign = 'left';
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);      ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  function wrapText(ctx, str, maxW, size) {
    font(ctx, size);
    var words = String(str).split(' '), lines = [], line = '';
    for (var i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = words[i]; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }

  /* ---------------------------------------------------------------
     Status bar: clock, signal strength, battery
     --------------------------------------------------------------- */
  var BAR_H = 26;

  function drawStatusBar(ctx) {
    ctx.fillStyle = T.panel;
    ctx.fillRect(0, 0, W, BAR_H);
    ctx.fillStyle = T.line;
    ctx.fillRect(0, BAR_H - 1, W, 1);

    var d = api.now();
    var hh = ('0' + d.getHours()).slice(-2), mm = ('0' + d.getMinutes()).slice(-2);
    text(ctx, hh + ':' + mm, 10, 5, 16, T.accent, 'bold');
    text(ctx, OS.name, W / 2, 6, 14, T.dim, '', 'center');

    // signal bars
    var sig = api.signal(), sx = W - 100;
    for (var i = 0; i < 4; i++) {
      var bh = 5 + i * 4;
      ctx.fillStyle = i < sig ? T.accent : T.faint;
      ctx.fillRect(sx + i * 7, BAR_H - 7 - bh, 5, bh);
    }

    // battery, coloured by level
    var lvl = api.battery(), bx = W - 58, by = 6, bw = 38, bh2 = 14;
    var col = lvl > 0.5 ? T.good : (lvl > 0.2 ? T.warn : T.bad);
    ctx.strokeStyle = T.faint; ctx.lineWidth = 1.5;
    roundRect(ctx, bx, by, bw, bh2, 3); ctx.stroke();
    ctx.fillStyle = T.faint;
    ctx.fillRect(bx + bw + 2, by + 4, 3, 6);
    ctx.fillStyle = col;
    roundRect(ctx, bx + 2.5, by + 2.5, Math.max(2, (bw - 5) * lvl), bh2 - 5, 1.5);
    ctx.fill();
  }

  /* ---------------------------------------------------------------
     Number formatting — DSE conventions
     --------------------------------------------------------------- */
  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  // exact-ish values print plainly, otherwise 3 significant figures
  function sf(x, digits) {
    if (!isNum(x)) return '?';
    digits = digits || 3;
    if (Math.abs(x - Math.round(x)) < 1e-9) return String(Math.round(x));
    var r = Number(x.toPrecision(digits));
    return String(r);
  }
  // raw-ish value for substitution lines
  function raw(x) {
    if (!isNum(x)) return '?';
    if (Math.abs(x - Math.round(x)) < 1e-9) return String(Math.round(x));
    return String(Number(x.toPrecision(6)));
  }
  function isExact(x) { return Math.abs(x - Math.round(x)) < 1e-9; }
  function corr(x) { return isExact(x) ? '' : ' (cor. to 3 sig. fig.)'; }

  /* ---------------------------------------------------------------
     TriangleFind — the solver
     ---------------------------------------------------------------
     Standard labelling: side a is opposite angle A, etc.
     Returns { v: solvedValues, steps: [...] }
     Each step: { title, lines: [..], produced: 'c' }
     --------------------------------------------------------------- */
  var D2R = Math.PI / 180;
  function sinD(d) { return Math.sin(d * D2R); }
  function cosD(d) { return Math.cos(d * D2R); }
  function asinD(x) { return Math.asin(Math.max(-1, Math.min(1, x))) / D2R; }
  function acosD(x) { return Math.acos(Math.max(-1, Math.min(1, x))) / D2R; }

  function angName(k) { return '\u2220' + k; }

  function solveTriangle(known) {
    var v = {}, k;
    for (k in known) if (isNum(known[k])) v[k] = known[k];
    var steps = [];
    var has = function (x) { return isNum(v[x]); };
    var guard = 0, changed = true;

    while (changed && guard++ < 24) {
      changed = false;

      /* --- angle sum of triangle --- */
      var angs = ['A', 'B', 'C'];
      var kn = angs.filter(has);
      if (kn.length === 2) {
        var miss = angs.filter(function (x) { return !has(x); })[0];
        v[miss] = 180 - v[kn[0]] - v[kn[1]];
        steps.push({
          title: '\u2220 sum of \u25B3',
          produced: miss,
          lines: [
            angName(miss) + ' = 180\u00B0 \u2212 ' + angName(kn[0]) + ' \u2212 ' + angName(kn[1]),
            '     = 180\u00B0 \u2212 ' + raw(v[kn[0]]) + '\u00B0 \u2212 ' + raw(v[kn[1]]) + '\u00B0',
            angName(miss) + ' = ' + sf(v[miss]) + '\u00B0' + corr(v[miss])
          ]
        });
        changed = true;
      }

      /* --- cosine formula: 2 sides + included angle -> 3rd side --- */
      var cosSide = [['a', 'b', 'c', 'A'], ['b', 'c', 'a', 'B'], ['c', 'a', 'b', 'C']];
      for (var i = 0; i < cosSide.length; i++) {
        var s = cosSide[i][0], p = cosSide[i][1], q = cosSide[i][2], an = cosSide[i][3];
        if (!has(s) && has(p) && has(q) && has(an)) {
          var sq = v[p] * v[p] + v[q] * v[q] - 2 * v[p] * v[q] * cosD(v[an]);
          if (sq <= 0) continue;
          v[s] = Math.sqrt(sq);
          steps.push({
            title: 'By cosine formula',
            produced: s,
            lines: [
              s + '\u00B2 = ' + p + '\u00B2 + ' + q + '\u00B2 \u2212 2' + p + q + ' cos ' + angName(an),
              s + '\u00B2 = ' + raw(v[p]) + '\u00B2 + ' + raw(v[q]) + '\u00B2 \u2212 2(' + raw(v[p]) +
                ')(' + raw(v[q]) + ') cos ' + raw(v[an]) + '\u00B0',
              s + '\u00B2 = ' + sf(sq, 6),
              s + ' = ' + sf(v[s]) + corr(v[s])
            ]
          });
          changed = true;
        }
      }

      /* --- cosine formula: 3 sides -> any angle --- */
      var cosAng = [['A', 'a', 'b', 'c'], ['B', 'b', 'c', 'a'], ['C', 'c', 'a', 'b']];
      for (var j = 0; j < cosAng.length; j++) {
        var an2 = cosAng[j][0], op = cosAng[j][1], p2 = cosAng[j][2], q2 = cosAng[j][3];
        if (!has(an2) && has(op) && has(p2) && has(q2)) {
          var cv = (v[p2] * v[p2] + v[q2] * v[q2] - v[op] * v[op]) / (2 * v[p2] * v[q2]);
          if (cv < -1 || cv > 1) continue;
          v[an2] = acosD(cv);
          steps.push({
            title: 'By cosine formula',
            produced: an2,
            lines: [
              'cos ' + angName(an2) + ' = (' + p2 + '\u00B2 + ' + q2 + '\u00B2 \u2212 ' + op + '\u00B2) / (2' + p2 + q2 + ')',
              'cos ' + angName(an2) + ' = (' + raw(v[p2]) + '\u00B2 + ' + raw(v[q2]) + '\u00B2 \u2212 ' +
                raw(v[op]) + '\u00B2) / (2(' + raw(v[p2]) + ')(' + raw(v[q2]) + '))',
              'cos ' + angName(an2) + ' = ' + sf(cv, 6),
              angName(an2) + ' = ' + sf(v[an2]) + '\u00B0' + corr(v[an2])
            ]
          });
          changed = true;
        }
      }

      /* --- sine formula --- */
      var pairs = [['a', 'A'], ['b', 'B'], ['c', 'C']];
      var base = null;
      for (var z = 0; z < pairs.length; z++) {
        if (has(pairs[z][0]) && has(pairs[z][1])) { base = pairs[z]; break; }
      }
      if (base) {
        var ks = base[0], ka = base[1];
        var ratio = v[ks] / sinD(v[ka]);
        for (var y = 0; y < pairs.length; y++) {
          var ts = pairs[y][0], ta = pairs[y][1];
          if (ts === ks) continue;
          if (has(ta) && !has(ts)) {
            v[ts] = ratio * sinD(v[ta]);
            steps.push({
              title: 'By sine formula',
              produced: ts,
              lines: [
                ts + ' / sin ' + angName(ta) + ' = ' + ks + ' / sin ' + angName(ka),
                ts + ' = ' + ks + ' sin ' + angName(ta) + ' / sin ' + angName(ka),
                ts + ' = ' + raw(v[ks]) + ' sin ' + raw(v[ta]) + '\u00B0 / sin ' + raw(v[ka]) + '\u00B0',
                ts + ' = ' + sf(v[ts]) + corr(v[ts])
              ]
            });
            changed = true;
          } else if (has(ts) && !has(ta)) {
            var sv = v[ts] / ratio;
            if (sv > 1 || sv < -1) continue;
            v[ta] = asinD(sv);
            steps.push({
              title: 'By sine formula',
              produced: ta,
              lines: [
                'sin ' + angName(ta) + ' / ' + ts + ' = sin ' + angName(ka) + ' / ' + ks,
                'sin ' + angName(ta) + ' = ' + ts + ' sin ' + angName(ka) + ' / ' + ks,
                'sin ' + angName(ta) + ' = ' + raw(v[ts]) + ' sin ' + raw(v[ka]) + '\u00B0 / ' + raw(v[ks]),
                'sin ' + angName(ta) + ' = ' + sf(sv, 6),
                angName(ta) + ' = ' + sf(v[ta]) + '\u00B0' + corr(v[ta]),
                '(taking the acute angle)'
              ]
            });
            changed = true;
          }
        }
      }

      /* --- area from 2 sides + included angle --- */
      var areaSets = [['b', 'c', 'A'], ['a', 'c', 'B'], ['a', 'b', 'C']];
      for (var m = 0; m < areaSets.length; m++) {
        var s1 = areaSets[m][0], s2 = areaSets[m][1], ia = areaSets[m][2];
        if (!has('S') && has(s1) && has(s2) && has(ia)) {
          v.S = 0.5 * v[s1] * v[s2] * sinD(v[ia]);
          steps.push({
            title: 'Area of \u25B3',
            produced: 'S',
            lines: [
              'Area = \u00BD ' + s1 + s2 + ' sin ' + angName(ia),
              '     = \u00BD(' + raw(v[s1]) + ')(' + raw(v[s2]) + ') sin ' + raw(v[ia]) + '\u00B0',
              'Area = ' + sf(v.S) + corr(v.S)
            ]
          });
          changed = true;
        }
      }

      /* --- Heron's formula: 3 sides -> area --- */
      if (!has('S') && has('a') && has('b') && has('c')) {
        var sp = (v.a + v.b + v.c) / 2;
        var inner = sp * (sp - v.a) * (sp - v.b) * (sp - v.c);
        if (inner > 0) {
          v.S = Math.sqrt(inner);
          steps.push({
            title: "By Heron's formula",
            produced: 'S',
            lines: [
              's = (a + b + c) / 2 = ' + sf(sp, 6),
              'Area = \u221A[s(s\u2212a)(s\u2212b)(s\u2212c)]',
              '     = \u221A[' + raw(sp) + '(' + raw(sp - v.a) + ')(' + raw(sp - v.b) + ')(' + raw(sp - v.c) + ')]',
              'Area = ' + sf(v.S) + corr(v.S)
            ]
          });
          changed = true;
        }
      }

      /* --- reverse area: area + 2 sides -> included angle --- */
      for (var n = 0; n < areaSets.length; n++) {
        var r1 = areaSets[n][0], r2 = areaSets[n][1], ra = areaSets[n][2];
        if (has('S') && has(r1) && has(r2) && !has(ra)) {
          var sv2 = 2 * v.S / (v[r1] * v[r2]);
          if (sv2 > 1 || sv2 < 0) continue;
          v[ra] = asinD(sv2);
          steps.push({
            title: 'Area of \u25B3',
            produced: ra,
            lines: [
              'Area = \u00BD ' + r1 + r2 + ' sin ' + angName(ra),
              raw(v.S) + ' = \u00BD(' + raw(v[r1]) + ')(' + raw(v[r2]) + ') sin ' + angName(ra),
              'sin ' + angName(ra) + ' = ' + sf(sv2, 6),
              angName(ra) + ' = ' + sf(v[ra]) + '\u00B0' + corr(v[ra]),
              '(taking the acute angle)'
            ]
          });
          changed = true;
        }
      }

      /* --- reverse area: area + 1 side -> the other side, given angle --- */
      for (var q3 = 0; q3 < areaSets.length; q3++) {
        var t1 = areaSets[q3][0], t2 = areaSets[q3][1], ta2 = areaSets[q3][2];
        if (has('S') && has(ta2)) {
          if (has(t1) && !has(t2)) {
            v[t2] = 2 * v.S / (v[t1] * sinD(v[ta2]));
            steps.push({
              title: 'Area of \u25B3',
              produced: t2,
              lines: [
                'Area = \u00BD ' + t1 + t2 + ' sin ' + angName(ta2),
                t2 + ' = 2(Area) / (' + t1 + ' sin ' + angName(ta2) + ')',
                t2 + ' = 2(' + raw(v.S) + ') / (' + raw(v[t1]) + ' sin ' + raw(v[ta2]) + '\u00B0)',
                t2 + ' = ' + sf(v[t2]) + corr(v[t2])
              ]
            });
            changed = true;
          }
        }
      }
    }
    return { v: v, steps: steps };
  }

  /* ---------------------------------------------------------------
     TriangleFind — the app
     --------------------------------------------------------------- */
  var FIELDS = [
    { id: 'a', label: 'side  a', unit: '' },
    { id: 'b', label: 'side  b', unit: '' },
    { id: 'c', label: 'side  c', unit: '' },
    { id: 'A', label: 'angle A', unit: '\u00B0' },
    { id: 'B', label: 'angle B', unit: '\u00B0' },
    { id: 'C', label: 'angle C', unit: '\u00B0' },
    { id: 'S', label: 'area',    unit: '' }
  ];
  var LABEL_OF = { a: 'side a', b: 'side b', c: 'side c',
                   A: '\u2220A', B: '\u2220B', C: '\u2220C', S: 'area' };

  var TriangleFind = {
    id: 'triangle',
    title: 'TriangleFind',
    icon: '\u25B3',
    blurb: 'Solve any triangle, DSE working shown',

    enter: function () {
      this.mode = 'input';
      this.buf = { a: '', b: '', c: '', A: '', B: '', C: '', S: '' };
      this.cursor = 0;
      this.targets = [];
      this.tIndex = 0;
      this.result = null;
      this.scroll = 0;
      this.flash = '';
    },

    knownValues: function () {
      var out = {};
      for (var k in this.buf) {
        if (this.buf[k] !== '' && !isNaN(parseFloat(this.buf[k]))) out[k] = parseFloat(this.buf[k]);
      }
      return out;
    },

    key: function (e) {
      if (e.type !== 'press') return;
      var k = e.key;
      if (this.mode === 'input') return this.keyInput(k);
      if (this.mode === 'target') return this.keyTarget(k);
      return this.keyResult(k);
    },

    keyInput: function (k) {
      var f = FIELDS[this.cursor].id;
      if (/^[0-9]$/.test(k)) { if (this.buf[f].length < 9) this.buf[f] += k; }
      else if (k === 'dot') { if (this.buf[f].indexOf('.') < 0) this.buf[f] += '.'; }
      else if (k === 'del') { this.buf[f] = this.buf[f].slice(0, -1); }
      else if (k === 'up') { this.cursor = (this.cursor + FIELDS.length - 1) % FIELDS.length; }
      else if (k === 'down') { this.cursor = (this.cursor + 1) % FIELDS.length; }
      else if (k === 'ac') { OS.goHome(); }
      else if (k === 'exe') {
        var known = this.knownValues();
        if (Object.keys(known).length < 3) { this.flash = 'Need at least 3 values'; }
        else {
          this.solved = solveTriangle(known);
          this.targets = [];
          var self = this;
          ['a', 'b', 'c', 'A', 'B', 'C', 'S'].forEach(function (id) {
            if (!(id in known)) self.targets.push(id);
          });
          this.targets.push('ALL');
          this.tIndex = 0;
          this.mode = 'target';
          this.flash = '';
        }
      }
      api.invalidate();
    },

    keyTarget: function (k) {
      if (k === 'up') this.tIndex = (this.tIndex + this.targets.length - 1) % this.targets.length;
      else if (k === 'down') this.tIndex = (this.tIndex + 1) % this.targets.length;
      else if (k === 'ac') this.mode = 'input';
      else if (k === 'exe') {
        var want = this.targets[this.tIndex];
        var sol = this.solved;
        var lines = [];
        var stepsToShow = sol.steps;
        if (want !== 'ALL') {
          var idx = -1;
          for (var i = 0; i < sol.steps.length; i++) {
            if (sol.steps[i].produced === want) { idx = i; break; }
          }
          stepsToShow = idx >= 0 ? sol.steps.slice(0, idx + 1) : sol.steps;
        }
        if (!stepsToShow.length) {
          lines.push({ t: 'h', s: 'Not enough information' });
          lines.push({ t: 'n', s: 'Three angles alone fix only the' });
          lines.push({ t: 'n', s: 'shape, not the size. Give a side.' });
        } else {
          stepsToShow.forEach(function (st, i) {
            lines.push({ t: 'h', s: (i + 1) + '. ' + st.title });
            st.lines.forEach(function (L) { lines.push({ t: 'n', s: L }); });
            lines.push({ t: 'sp', s: '' });
          });
          if (want !== 'ALL' && isNum(sol.v[want])) {
            lines.push({ t: 'a', s: '\u2234 ' + LABEL_OF[want] + ' = ' + sf(sol.v[want]) +
              (want === 'A' || want === 'B' || want === 'C' ? '\u00B0' : '') });
          } else if (want === 'ALL') {
            lines.push({ t: 'h', s: 'Summary' });
            ['a', 'b', 'c', 'A', 'B', 'C', 'S'].forEach(function (id) {
              if (isNum(sol.v[id])) {
                lines.push({ t: 'a', s: LABEL_OF[id] + ' = ' + sf(sol.v[id]) +
                  (id === 'A' || id === 'B' || id === 'C' ? '\u00B0' : '') });
              }
            });
          }
        }
        this.result = lines;
        this.scroll = 0;
        this.mode = 'result';
      }
      api.invalidate();
    },

    keyResult: function (k) {
      var vis = 10;
      if (k === 'down') this.scroll = Math.min(Math.max(0, this.result.length - vis), this.scroll + 1);
      else if (k === 'up') this.scroll = Math.max(0, this.scroll - 1);
      else if (k === 'right') this.scroll = Math.min(Math.max(0, this.result.length - vis), this.scroll + vis);
      else if (k === 'left') this.scroll = Math.max(0, this.scroll - vis);
      else if (k === 'ac') this.mode = 'target';
      else if (k === 'exe') this.mode = 'input';
      api.invalidate();
    },

    render: function (ctx) {
      if (this.mode === 'input') this.renderInput(ctx);
      else if (this.mode === 'target') this.renderTarget(ctx);
      else this.renderResult(ctx);
    },

    renderInput: function (ctx) {
      text(ctx, 'TriangleFind', 12, BAR_H + 6, 16, T.accent2, 'bold');
      text(ctx, 'enter what you know', 130, BAR_H + 8, 13, T.dim);
      var top = BAR_H + 28, rowH = 24, boxX = 104, boxW = 120;
      for (var i = 0; i < FIELDS.length; i++) {
        var f = FIELDS[i], y = top + i * rowH, sel = i === this.cursor;
        if (sel) {
          ctx.fillStyle = T.panelHi;
          roundRect(ctx, 6, y - 2, 240, rowH - 3, 5); ctx.fill();
          ctx.fillStyle = T.accent;
          roundRect(ctx, 6, y - 2, 3, rowH - 3, 1.5); ctx.fill();
        }
        text(ctx, f.label, 16, y + 2, 15, sel ? T.text : T.dim, sel ? 'bold' : '');
        ctx.strokeStyle = sel ? T.accent : T.line; ctx.lineWidth = 1;
        roundRect(ctx, boxX, y, boxW, rowH - 5, 4); ctx.stroke();
        var val = this.buf[f.id];
        var show = val + (sel ? '|' : '');
        text(ctx, show || '\u2013', boxX + 7, y + 2, 15,
          val ? T.accent2 : T.faint, val ? 'bold' : '');
        if (f.unit) text(ctx, f.unit, boxX + boxW + 5, y + 2, 14, T.faint);
      }
      this.sketch(ctx, 262, BAR_H + 18, W - 276, H - BAR_H - 48);
      var msg = this.flash || 'EXE = choose what to find    AC = home';
      text(ctx, msg, 12, H - 20, 13, this.flash ? T.warn : T.faint, this.flash ? 'bold' : '');
    },

    sketch: function (ctx, x, y, w, h) {
      var P = { A: [x + w * 0.16, y + h * 0.86],
                B: [x + w * 0.92, y + h * 0.86],
                C: [x + w * 0.56, y + h * 0.10] };
      ctx.beginPath();
      ctx.moveTo(P.A[0], P.A[1]); ctx.lineTo(P.B[0], P.B[1]);
      ctx.lineTo(P.C[0], P.C[1]); ctx.closePath();
      ctx.fillStyle = 'rgba(74,214,198,0.10)'; ctx.fill();
      ctx.strokeStyle = T.accent; ctx.lineWidth = 2; ctx.stroke();
      text(ctx, 'A', P.A[0] - 15, P.A[1] - 3, 13, T.accent2, 'bold');
      text(ctx, 'B', P.B[0] + 5, P.B[1] - 3, 13, T.accent2, 'bold');
      text(ctx, 'C', P.C[0] - 4, P.C[1] - 17, 13, T.accent2, 'bold');
      text(ctx, 'c', (P.A[0] + P.B[0]) / 2 - 4, P.A[1] + 3, 12, T.dim);
      text(ctx, 'a', (P.B[0] + P.C[0]) / 2 + 5, (P.B[1] + P.C[1]) / 2 - 8, 12, T.dim);
      text(ctx, 'b', (P.A[0] + P.C[0]) / 2 - 14, (P.A[1] + P.C[1]) / 2 - 8, 12, T.dim);
    },

    renderTarget: function (ctx) {
      text(ctx, 'What do you want to find?', 12, BAR_H + 6, 15, T.accent2, 'bold');
      var top = BAR_H + 30, rowH = 26;
      var start = Math.max(0, Math.min(this.tIndex - 3, this.targets.length - 6));
      for (var i = start; i < Math.min(this.targets.length, start + 6); i++) {
        var y = top + (i - start) * rowH, sel = i === this.tIndex;
        var id = this.targets[i];
        var name = id === 'ALL' ? 'Solve everything' : LABEL_OF[id];
        if (sel) {
          ctx.fillStyle = T.accent;
          roundRect(ctx, 10, y - 4, W - 20, rowH - 3, 6); ctx.fill();
        }
        text(ctx, name, 24, y, 16, sel ? T.bg0 : T.text, sel ? 'bold' : '');
      }
      text(ctx, 'EXE = solve    AC = back', 12, H - 20, 13, T.faint);
    },

    renderResult: function (ctx) {
      var top = BAR_H + 6, rowH = 19, vis = 10;
      var end = Math.min(this.result.length, this.scroll + vis);
      for (var i = this.scroll; i < end; i++) {
        var L = this.result[i], y = top + (i - this.scroll) * rowH;
        if (L.t === 'sp') continue;
        if (L.t === 'h') {
          ctx.fillStyle = T.accent2;
          roundRect(ctx, 10, y + 2, 3, rowH - 6, 1.5); ctx.fill();
          text(ctx, L.s, 20, y, 14, T.accent2, 'bold');
        } else if (L.t === 'a') {
          ctx.fillStyle = 'rgba(126,231,168,0.14)';
          roundRect(ctx, 10, y - 2, W - 56, rowH - 1, 4); ctx.fill();
          text(ctx, L.s, 18, y, 14, T.answer, 'bold');
        } else {
          text(ctx, L.s, 24, y, 13, T.formula);
        }
      }
      if (this.result.length > vis) {
        var trackH = H - top - 26;
        ctx.fillStyle = T.line;
        roundRect(ctx, W - 13, top, 5, trackH, 2.5); ctx.fill();
        ctx.fillStyle = T.accent;
        var kh = Math.max(18, trackH * vis / this.result.length);
        var ky = top + (trackH - kh) * (this.scroll / Math.max(1, this.result.length - vis));
        roundRect(ctx, W - 13, ky, 5, kh, 2.5); ctx.fill();
      }
      text(ctx, '\u25B2\u25BC scroll   AC = back   EXE = new', 12, H - 18, 12, T.faint);
    }
  };

  /* ---------------------------------------------------------------
     About app — shows the OS is a real guest, not a calculator mode
     --------------------------------------------------------------- */
  var About = {
    id: 'about',
    title: 'About',
    icon: '\u2139',
    blurb: 'System information',
    enter: function () { this.scroll = 0; },
    key: function (e) { if (e.type === 'press' && e.key === 'ac') OS.goHome(); },
    render: function (ctx) {
      text(ctx, OS.name + ' v' + OS.version, 14, BAR_H + 10, 18, T.accent, 'bold');
      var lines = [
        'Loaded from os.js as a guest OS.',
        'It controls only the LCD and reads',
        'the key stream \u2014 nothing else.',
        '',
        'Host:    fx-50FH II web replica',
        'Screen:  ' + W + ' x ' + H + ' px, colour',
        'Unlock:  SOS in morse on MODE',
        'Exit:    ON, or AC from home'
      ];
      for (var i = 0; i < lines.length; i++) {
        text(ctx, lines[i], 14, BAR_H + 38 + i * 19, 13,
          i < 3 ? T.dim : T.formula);
      }
      text(ctx, 'AC = home', 14, H - 20, 12, T.faint);
    }
  };

  var APPS = [TriangleFind, About];

  /* ---------------------------------------------------------------
     Homescreen
     --------------------------------------------------------------- */
  function renderHome(ctx) {
    var tileW = 160, tileH = 84, gap = 18;
    var totalW = APPS.length * tileW + (APPS.length - 1) * gap;
    var x0 = (W - totalW) / 2, y0 = BAR_H + 44;

    text(ctx, 'Home', 14, BAR_H + 12, 14, T.dim);

    for (var i = 0; i < APPS.length; i++) {
      var app = APPS[i], x = x0 + i * (tileW + gap), sel = i === homeIndex;

      ctx.fillStyle = sel ? T.panelHi : T.panel;
      roundRect(ctx, x, y0, tileW, tileH, 10); ctx.fill();
      ctx.strokeStyle = sel ? T.accent : T.line;
      ctx.lineWidth = sel ? 2 : 1;
      roundRect(ctx, x, y0, tileW, tileH, 10); ctx.stroke();

      // icon chip
      ctx.fillStyle = sel ? T.accent : T.faint;
      roundRect(ctx, x + 12, y0 + 12, 30, 30, 7); ctx.fill();
      text(ctx, app.icon, x + 20, y0 + 16, 20, T.bg0, 'bold');

      text(ctx, app.title, x + 50, y0 + 17, 16, sel ? T.text : T.dim, 'bold');
      var blurb = wrapText(ctx, app.blurb, tileW - 24, 12);
      for (var b = 0; b < Math.min(2, blurb.length); b++) {
        text(ctx, blurb[b], x + 12, y0 + 50 + b * 14, 12, T.faint);
      }
    }
    text(ctx, '\u25C0\u25B6 select    EXE = open    AC or ON = calculator',
      W / 2, H - 22, 12, T.faint, '', 'center');
  }

  /* ---------------------------------------------------------------
     OS lifecycle
     --------------------------------------------------------------- */
  OS.goHome = function () {
    view = 'home';
    activeApp = null;
    api.invalidate();
  };

  OS.boot = function (hostApi) {
    api = hostApi;
    SC = api.screen;
    W = SC.width; H = SC.height; COL = SC.colors;
    view = 'home'; homeIndex = 0; activeApp = null;
    clockTimer = setInterval(function () { api.invalidate(); }, 1000);
    api.invalidate();
  };

  OS.shutdown = function () {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = null;
    activeApp = null;
  };

  OS.onKey = function (e) {
    if (view === 'app' && activeApp) {
      activeApp.key(e);
      return;
    }
    if (e.type !== 'press') return;
    if (e.key === 'left') homeIndex = (homeIndex + APPS.length - 1) % APPS.length;
    else if (e.key === 'right') homeIndex = (homeIndex + 1) % APPS.length;
    else if (e.key === 'up') homeIndex = (homeIndex + APPS.length - 1) % APPS.length;
    else if (e.key === 'down') homeIndex = (homeIndex + 1) % APPS.length;
    else if (e.key === 'exe') {
      activeApp = APPS[homeIndex];
      activeApp.enter();
      view = 'app';
    } else if (e.key === 'ac') {
      api.exit();
      return;
    }
    api.invalidate();
  };

  OS.render = function (ctx, w, h) {
    W = w; H = h;
    paintBackground(ctx);
    drawStatusBar(ctx);
    if (view === 'app' && activeApp) activeApp.render(ctx);
    else renderHome(ctx);
  };

  /* expose + auto-register */
  window.CASIO_OS = OS;
  if (window.CASIO && typeof window.CASIO.registerOS === 'function') {
    window.CASIO.registerOS(OS);
  }
})();
