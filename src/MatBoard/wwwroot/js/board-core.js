/* MatBoard – the canvas, part 1: the state of a board, how things are drawn, the geometry and how changes are applied (and undone).
   board-net.js talks to the server, board-ui.js is the hands (tools, selection, text editing).
   Everything is drawn as SVG with plain attributes (no stylesheet needed), so a copy of the drawing is a valid SVG file: that is the export.
   An item: { id, k (kind), x, y, w, h, r (degrees), z, d (the rest: text, colours ...) }. A change: { o:'add', i:item } | { o:'upd', id, x?, y?, w?, h?, r?, z?, d? } | { o:'del', id }.
   In d, a key set to null is removed (upd). */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var FONT = "Inter, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
  var MB = window.MB = window.MB || {};

  // ---- small helpers -----------------------------------------------------------------------------------------------------
  var TEXTS = {};
  try { TEXTS = JSON.parse(document.getElementById('mb-texts').textContent); } catch (e) { /* no texts: the keys are shown */ }
  MB.t = function (key) {
    var s = TEXTS[key] || key;
    for (var i = 1; i < arguments.length; i++) { s = s.replace('{' + (i - 1) + '}', arguments[i]); }
    return s;
  };
  MB.el = function (tag, attrs, parent) {
    var n = document.createElementNS(NS, tag);
    if (attrs) { for (var k in attrs) { if (attrs[k] !== null && attrs[k] !== undefined) { n.setAttribute(k, attrs[k]); } } }
    if (parent) { parent.appendChild(n); }
    return n;
  };
  MB.html = function (tag, cls, parent) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (parent) { parent.appendChild(n); }
    return n;
  };
  MB.icon = function (name, cls) {
    var s = MB.el('svg', { 'class': 'mat-icon' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true', focusable: 'false' });
    MB.el('use', { href: '#mat-i-' + name }, s);
    return s;
  };
  MB.uid = function () {
    if (window.crypto && crypto.randomUUID) { return crypto.randomUUID(); }
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  };
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  MB.clone = clone;
  function num(v, fallback) { return typeof v === 'number' && isFinite(v) ? v : fallback; }

  var handlers = {};
  MB.on = function (name, fn) { (handlers[name] = handlers[name] || []).push(fn); };
  MB.emit = function (name, a, b) { (handlers[name] || []).forEach(function (fn) { try { fn(a, b); } catch (e) { if (window.console) { console.error(e); } } }); };

  // ---- the state -----------------------------------------------------------------------------------------------------------
  var root = document.getElementById('mb-board');
  if (!root) { return; }
  var S = MB.S = {
    root: root,
    canvas: document.getElementById('mb-canvas'),
    world: document.getElementById('mb-world'),
    overlay: document.getElementById('mb-overlay'),
    paper: document.getElementById('mb-paper'),
    id: parseInt(root.getAttribute('data-board'), 10),
    link: root.getAttribute('data-link') || '',
    guest: root.getAttribute('data-guest') === '1',
    role: root.getAttribute('data-role') || 'viewer',
    background: root.getAttribute('data-background') || 'dots',
    items: new Map(),
    nodes: new Map(),
    refs: new Map(),
    sel: new Set(),
    view: { x: 0, y: 0, k: 1 },
    maxZ: 0,
    minZ: 0,
    rev: 0,
    editing: null,
    ink: '#1f1e1b',
    sorted: null,
    ready: false,
  };
  S.canEdit = function () { return S.role === 'editor' || S.role === 'owner'; };

  MB.PALETTE = ['#fff2a8', '#ffd6a5', '#ffadad', '#fdc5f5', '#d0bfff', '#a5d8ff', '#99e9f2', '#b2f2bb', '#e9ecef', '#ffffff'];
  MB.INKS = ['#1e1e1e', '#e03131', '#f08c00', '#2f9e44', '#1971c2', '#7048e8', '#c2255c', '#868e96'];

  var DEFAULTS = {
    sticky: { w: 200, h: 200, d: { fill: '#fff2a8', fs: 22, align: 'center', text: '' } },
    text: { w: 260, h: 36, d: { fs: 24, align: 'left', text: '' } },
    rect: { w: 220, h: 130, d: { fill: '#ffffff', sw: 2, fs: 20, text: '' } },
    ellipse: { w: 220, h: 140, d: { fill: '#ffffff', sw: 2, fs: 20, text: '' } },
    diamond: { w: 220, h: 160, d: { fill: '#ffffff', sw: 2, fs: 20, text: '' } },
    triangle: { w: 200, h: 170, d: { fill: '#ffffff', sw: 2, fs: 20, text: '' } },
    frame: { w: 520, h: 340, d: { title: '', stroke: '#adb5bd' } },
    line: { w: 0, h: 0, d: { sw: 3, ah: 'end', st: 'straight' } },
    pen: { w: 0, h: 0, d: { sw: 4 } },
    image: { w: 320, h: 240, d: {} },
  };
  MB.defaults = function (kind) { return clone(DEFAULTS[kind]); };
  MB.hasText = function (k) { return k === 'sticky' || k === 'text' || k === 'rect' || k === 'ellipse' || k === 'diamond' || k === 'triangle'; };
  MB.isShape = function (k) { return k === 'rect' || k === 'ellipse' || k === 'diamond' || k === 'triangle'; };

  /** A new item of a kind at a place (not yet added: act([{o:'add', i:item}]) does that). Frames go behind everything, the rest in front. */
  MB.newItem = function (kind, props) {
    var base = DEFAULTS[kind];
    var it = { id: MB.uid(), k: kind, x: 0, y: 0, w: base.w, h: base.h, r: 0, z: 0, d: clone(base.d) };
    for (var key in props) { if (key === 'd') { for (var dk in props.d) { it.d[dk] = props.d[dk]; } } else { it[key] = props[key]; } }
    it.z = kind === 'frame' ? --S.minZ : ++S.maxZ;
    return it;
  };

  function readInk() {
    var c = getComputedStyle(root).getPropertyValue('--mat-text').trim();
    return c || '#1f1e1b';
  }
  function refreshInk() {
    var next = readInk();
    if (next !== S.ink) { S.ink = next; drawAll(); }
  }

  // ---- text layout -----------------------------------------------------------------------------------------------------------
  var measure = document.createElement('canvas').getContext('2d');
  var wrapCache = new Map();

  /** The lines of a text in a width (explicit line breaks, words, and a word that is longer than the line is broken). */
  function wrap(text, fs, maxW) {
    var key = fs + '|' + Math.round(maxW) + '|' + text;
    var hit = wrapCache.get(key);
    if (hit) { return hit; }
    measure.font = fs + 'px ' + FONT;
    var out = [];
    String(text).split('\n').forEach(function (para) {
      if (para === '') { out.push(''); return; }
      var line = '';
      para.split(' ').forEach(function (word) {
        var test = line ? line + ' ' + word : word;
        if (measure.measureText(test).width <= maxW) { line = test; return; }
        if (line) { out.push(line); line = ''; }
        if (measure.measureText(word).width > maxW) {
          var chunk = '';
          Array.from(word).forEach(function (ch) {
            if (chunk && measure.measureText(chunk + ch).width > maxW) { out.push(chunk); chunk = ch; } else { chunk += ch; }
          });
          line = chunk;
        } else { line = word; }
      });
      out.push(line);
    });
    if (wrapCache.size > 3000) { wrapCache.clear(); }
    wrapCache.set(key, out);
    return out;
  }
  MB.wrap = wrap;

  /** The text in a box: the font gets smaller (to 10) until it fits the height. */
  function fit(text, fs, bw, bh) {
    var size = fs, lines = wrap(text, size, bw);
    while (isFinite(bh) && size > 10 && lines.length * size * 1.25 > bh) { size -= 1; lines = wrap(text, size, bw); }
    return { fs: size, lines: lines };
  }
  MB.fitText = fit;

  function drawText(g, text, bx, by, bw, bh, fs, color, align, valign) {
    if (!text) { return; }
    var f = fit(text, fs, bw, bh), lh = f.fs * 1.25, total = f.lines.length * lh;
    var top = valign === 'top' || !isFinite(bh) ? by : by + Math.max(0, (bh - total) / 2);
    var anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
    var x = align === 'left' ? bx : align === 'right' ? bx + bw : bx + bw / 2;
    var t = MB.el('text', { x: x, y: top, 'font-family': FONT, 'font-size': f.fs, fill: color, 'text-anchor': anchor, 'pointer-events': 'none' }, g);
    t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
    f.lines.forEach(function (line, i) {
      var s = MB.el('tspan', { x: x, y: top + f.fs * 0.95 + i * lh }, t);
      s.textContent = line === '' ? '​' : line;
    });
  }

  /** The height a text item needs for its width (a text item has no fixed height: it grows with its text). */
  MB.textHeight = function (it) {
    var fs = it.d.fs || 24, lines = wrap(it.d.text || ' ', fs, Math.max(20, it.w));
    return Math.max(fs * 1.25 + 4, lines.length * fs * 1.25 + 4);
  };

  // ---- geometry --------------------------------------------------------------------------------------------------------------
  function rotPt(x, y, deg) {
    var a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return { x: x * c - y * s, y: x * s + y * c };
  }
  function center(it) { return { x: it.x + it.w / 2, y: it.y + it.h / 2 }; }
  function corners(it) {
    var c = center(it), hw = it.w / 2, hh = it.h / 2;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(function (p) {
      var r = rotPt(p[0], p[1], it.r || 0);
      return { x: c.x + r.x, y: c.y + r.y };
    });
  }
  function aabb(it) {
    var cs = corners(it), x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    cs.forEach(function (p) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  MB.rotPt = rotPt; MB.center = center; MB.corners = corners; MB.aabb = aabb;

  /** The point of the edge of a shape that lies in the direction of a point (where a connector meets it). */
  function anchor(it, toward) {
    var c = center(it), hw = Math.max(1, it.w / 2), hh = Math.max(1, it.h / 2);
    var p = rotPt(toward.x - c.x, toward.y - c.y, -(it.r || 0));
    if (p.x === 0 && p.y === 0) { return c; }
    var t;
    if (it.k === 'ellipse') { t = 1 / Math.sqrt(Math.pow(p.x / hw, 2) + Math.pow(p.y / hh, 2)); }
    else if (it.k === 'diamond') { t = 1 / (Math.abs(p.x) / hw + Math.abs(p.y) / hh); }
    else { t = Math.min(Math.abs(p.x) > 1e-9 ? hw / Math.abs(p.x) : Infinity, Math.abs(p.y) > 1e-9 ? hh / Math.abs(p.y) : Infinity); }
    t = Math.min(1, t);
    var q = rotPt(p.x * t, p.y * t, it.r || 0);
    return { x: c.x + q.x, y: c.y + q.y };
  }

  /** The two ends of a connector as drawn: attached ends follow their items, loose ones stay where they are. */
  function lineEnds(it) {
    var a = it.d.a || { x: it.x, y: it.y }, b = it.d.b || { x: it.x + it.w, y: it.y + it.h };
    var ta = a.id ? S.items.get(a.id) : null, tb = b.id ? S.items.get(b.id) : null;
    var fromA = ta ? ta : null, fromB = tb ? tb : null;
    var pa = { x: num(a.x, 0), y: num(a.y, 0) }, pb = { x: num(b.x, 0), y: num(b.y, 0) };
    if (fromA && fromB) { pa = anchor(fromA, center(fromB)); pb = anchor(fromB, center(fromA)); }
    else if (fromA) { pa = anchor(fromA, pb); }
    else if (fromB) { pb = anchor(fromB, pa); }
    return { a: pa, b: pb, attachedA: !!fromA, attachedB: !!fromB };
  }
  MB.lineEnds = lineEnds;

  function linePath(pa, pb, style) {
    var dx = pb.x - pa.x, dy = pb.y - pa.y, d, tail, tip = pb;
    if (style === 'curve') {
      var horizontal = Math.abs(dx) >= Math.abs(dy);
      var c1 = horizontal ? { x: pa.x + dx / 2, y: pa.y } : { x: pa.x, y: pa.y + dy / 2 };
      var c2 = horizontal ? { x: pb.x - dx / 2, y: pb.y } : { x: pb.x, y: pb.y - dy / 2 };
      d = 'M' + pa.x + ' ' + pa.y + 'C' + c1.x + ' ' + c1.y + ' ' + c2.x + ' ' + c2.y + ' ' + pb.x + ' ' + pb.y;
      tail = { from: c2, to: tip, start: { from: c1, to: pa } };
    } else if (style === 'elbow') {
      var h = Math.abs(dx) >= Math.abs(dy), mid;
      if (h) { mid = (pa.x + pb.x) / 2; d = 'M' + pa.x + ' ' + pa.y + 'L' + mid + ' ' + pa.y + 'L' + mid + ' ' + pb.y + 'L' + pb.x + ' ' + pb.y; tail = { from: { x: mid, y: pb.y }, to: tip, start: { from: { x: mid, y: pa.y }, to: pa } }; }
      else { mid = (pa.y + pb.y) / 2; d = 'M' + pa.x + ' ' + pa.y + 'L' + pa.x + ' ' + mid + 'L' + pb.x + ' ' + mid + 'L' + pb.x + ' ' + pb.y; tail = { from: { x: pb.x, y: mid }, to: tip, start: { from: { x: pa.x, y: mid }, to: pa } }; }
    } else {
      d = 'M' + pa.x + ' ' + pa.y + 'L' + pb.x + ' ' + pb.y;
      tail = { from: pa, to: pb, start: { from: pb, to: pa } };
    }
    return { d: d, end: tail, start: tail.start };
  }

  function arrowHead(g, seg, size, color) {
    var dx = seg.to.x - seg.from.x, dy = seg.to.y - seg.from.y, len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.001) { return; }
    var ux = dx / len, uy = dy / len, bx = seg.to.x - ux * size, by = seg.to.y - uy * size, px = -uy * size * 0.5, py = ux * size * 0.5;
    MB.el('path', { d: 'M' + seg.to.x + ' ' + seg.to.y + 'L' + (bx + px) + ' ' + (by + py) + 'L' + (bx - px) + ' ' + (by - py) + 'Z', fill: color, 'pointer-events': 'none' }, g);
  }

  /** Is a point on an item? (margin in world units; a line is hit near its path, a frame only at its border and title.) */
  function contains(it, x, y, margin) {
    if (it.k === 'line') {
      var e = lineEnds(it), dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, len2 = dx * dx + dy * dy;
      var t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - e.a.x) * dx + (y - e.a.y) * dy) / len2));
      var px = e.a.x + t * dx, py = e.a.y + t * dy;
      return Math.sqrt((x - px) * (x - px) + (y - py) * (y - py)) <= margin + (it.d.sw || 3) / 2 + 4;
    }
    var c = center(it), p = rotPt(x - c.x, y - c.y, -(it.r || 0)), hw = it.w / 2, hh = it.h / 2;
    if (it.k === 'frame') {
      var inside = Math.abs(p.x) <= hw + margin && Math.abs(p.y) <= hh + margin;
      var inner = Math.abs(p.x) <= hw - margin * 1.5 && Math.abs(p.y) <= hh - margin * 1.5;
      var title = p.x >= -hw && p.x <= -hw + Math.min(320, it.w) && p.y <= -hh + margin && p.y >= -hh - 34;
      return (inside && !inner) || title;
    }
    if (it.k === 'ellipse') { return Math.pow(p.x / (hw + margin), 2) + Math.pow(p.y / (hh + margin), 2) <= 1; }
    return Math.abs(p.x) <= hw + margin && Math.abs(p.y) <= hh + margin;
  }

  function sortedItems() {
    if (!S.sorted) { S.sorted = Array.from(S.items.values()).sort(function (a, b) { return a.z - b.z; }); }
    return S.sorted;
  }

  /** The topmost item at a world point. opts.connectable: only things a connector can be attached to; opts.exclude: an id to skip. */
  MB.itemAt = function (x, y, opts) {
    opts = opts || {};
    var list = sortedItems(), margin = 6 / S.view.k;
    for (var i = list.length - 1; i >= 0; i--) {
      var it = list[i];
      if (opts.exclude && it.id === opts.exclude) { continue; }
      if (opts.connectable && (it.k === 'line' || it.k === 'pen' || it.k === 'frame')) { continue; }
      if (contains(it, x, y, margin)) { return it; }
    }
    return null;
  };

  /** The rectangle that holds some items (all of them when no ids are given), or null. */
  MB.bounds = function (ids) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
    (ids ? ids.map(function (id) { return S.items.get(id); }) : Array.from(S.items.values())).forEach(function (it) {
      if (!it) { return; }
      var b = aabb(it);
      any = true; x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    });
    return any ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  };

  // ---- drawing ---------------------------------------------------------------------------------------------------------------
  function ink(color) { return !color || color === 'auto' ? S.ink : color; }

  function shapeColors(d) { return { fill: d.fill || 'none', stroke: d.stroke === 'none' ? 'none' : (d.stroke || S.ink), sw: d.sw || 2 }; }

  var builders = {
    sticky: function (g, it) {
      var d = it.d;
      MB.el('rect', { x: 2, y: 5, width: it.w, height: it.h, rx: 3, fill: '#000', opacity: 0.13, 'pointer-events': 'none' }, g);
      MB.el('rect', { width: it.w, height: it.h, rx: 3, fill: d.fill || '#fff2a8', 'pointer-events': 'all' }, g);
      if (!(S.editing && S.editing.id === it.id)) { drawText(g, d.text, 16, 16, it.w - 32, it.h - 32, d.fs || 22, d.color || '#1f1e1b', d.align || 'center', 'middle'); }
    },
    text: function (g, it) {
      var d = it.d, h = MB.textHeight(it);
      it.h = h;
      MB.el('rect', { width: it.w, height: h, fill: 'transparent', 'pointer-events': 'all' }, g);
      if (!(S.editing && S.editing.id === it.id)) { drawText(g, d.text, 0, 2, it.w, Infinity, d.fs || 24, ink(d.color), d.align || 'left', 'top'); }
    },
    shape: function (g, it) {
      var d = it.d, c = shapeColors(d), w = it.w, h = it.h, box;
      var common = { fill: c.fill, stroke: c.stroke, 'stroke-width': c.sw, 'stroke-linejoin': 'round', 'pointer-events': 'all' };
      if (it.k === 'ellipse') { MB.el('ellipse', Object.assign({ cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2 }, common), g); box = [w * 0.14, h * 0.15, w * 0.72, h * 0.7]; }
      else if (it.k === 'diamond') { MB.el('polygon', Object.assign({ points: [w / 2, 0, w, h / 2, w / 2, h, 0, h / 2].join(' ') }, common), g); box = [w * 0.25, h * 0.25, w * 0.5, h * 0.5]; }
      else if (it.k === 'triangle') { MB.el('polygon', Object.assign({ points: [w / 2, 0, w, h, 0, h].join(' ') }, common), g); box = [w * 0.27, h * 0.42, w * 0.46, h * 0.5]; }
      else { MB.el('rect', Object.assign({ width: w, height: h, rx: 6 }, common), g); box = [12, 12, w - 24, h - 24]; }
      if (!(S.editing && S.editing.id === it.id)) { drawText(g, d.text, box[0], box[1], Math.max(10, box[2]), box[3], d.fs || 20, d.color && d.color !== 'auto' ? d.color : (c.fill === 'none' ? S.ink : '#1f1e1b'), d.align || 'center', 'middle'); }
    },
    frame: function (g, it) {
      var d = it.d;
      MB.el('rect', { width: it.w, height: it.h, fill: d.fill || S.ink, 'fill-opacity': d.fill ? 0.55 : 0.05, stroke: d.stroke || '#adb5bd', 'stroke-width': 1.5, 'pointer-events': 'none' }, g);
      MB.el('rect', { width: it.w, height: it.h, fill: 'none', stroke: 'transparent', 'stroke-width': 14, 'pointer-events': 'stroke' }, g);
      MB.el('rect', { x: 0, y: -34, width: Math.min(320, it.w), height: 34, fill: 'transparent', 'pointer-events': 'all' }, g);
      var title = d.title || MB.t('Js.Board.Frame');
      if (!(S.editing && S.editing.id === it.id)) {
        var t = MB.el('text', { x: 2, y: -10, 'font-family': FONT, 'font-size': 18, 'font-weight': 600, fill: d.title ? ink(null) : '#868e96', 'fill-opacity': d.title ? 0.75 : 1, 'pointer-events': 'none' }, g);
        t.textContent = title.length > 60 ? title.slice(0, 58) + '…' : title;
      }
    },
    line: function (g, it) {
      var d = it.d, e = lineEnds(it), color = ink(d.stroke), sw = d.sw || 3, p = linePath(e.a, e.b, d.st);
      // the box of the line (derived, never sent): selection, marquee and "fit" use it
      var x0 = Math.min(e.a.x, e.b.x), y0 = Math.min(e.a.y, e.b.y);
      it.x = x0; it.y = y0; it.w = Math.abs(e.b.x - e.a.x); it.h = Math.abs(e.b.y - e.a.y); it.r = 0;
      MB.el('path', { d: p.d, fill: 'none', stroke: 'transparent', 'stroke-width': Math.max(sw, 16), 'pointer-events': 'stroke' }, g);
      MB.el('path', { d: p.d, fill: 'none', stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': d.dash ? '8 6' : null, 'pointer-events': 'none' }, g);
      var size = Math.max(11, sw * 4);
      if (d.ah === 'end' || d.ah === 'both') { arrowHead(g, p.end, size, color); }
      if (d.ah === 'start' || d.ah === 'both') { arrowHead(g, { from: p.start.from, to: p.start.to }, size, color); }
    },
    pen: function (g, it) {
      var d = it.d, pts = d.pts || [], color = ink(d.stroke), sw = d.sw || 4;
      if (pts.length < 2) { return; }
      var sx = d.bw ? it.w / d.bw : 1, sy = d.bh ? it.h / d.bh : 1;
      var path = 'M' + pts[0] + ' ' + pts[1];
      if (pts.length === 2) { path += 'L' + pts[0] + ' ' + pts[1]; }
      for (var i = 2; i < pts.length - 2; i += 2) { path += 'Q' + pts[i] + ' ' + pts[i + 1] + ' ' + (pts[i] + pts[i + 2]) / 2 + ' ' + (pts[i + 1] + pts[i + 3]) / 2; }
      if (pts.length > 2) { path += 'L' + pts[pts.length - 2] + ' ' + pts[pts.length - 1]; }
      var inner = MB.el('g', { transform: 'scale(' + sx + ' ' + sy + ')' }, g);
      MB.el('path', { d: path, fill: 'none', stroke: 'transparent', 'stroke-width': Math.max(sw, 16), 'stroke-linecap': 'round', 'pointer-events': 'stroke' }, inner);
      MB.el('path', { d: path, fill: 'none', stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'pointer-events': 'none' }, inner);
    },
    image: function (g, it) {
      var src = it.d.src;
      if (typeof src === 'string' && src.indexOf('data:image/') === 0) {
        MB.el('image', { href: src, width: it.w, height: it.h, preserveAspectRatio: 'none', 'pointer-events': 'all' }, g);
      } else {
        MB.el('rect', { width: it.w, height: it.h, fill: '#e9ecef', 'pointer-events': 'all' }, g);
      }
    },
  };
  builders.rect = builders.ellipse = builders.diamond = builders.triangle = builders.shape;

  function transformOf(it) {
    var s = 'translate(' + it.x + ' ' + it.y + ')';
    return it.r ? s + ' rotate(' + it.r + ' ' + it.w / 2 + ' ' + it.h / 2 + ')' : s;
  }

  function draw(it) {
    var g = S.nodes.get(it.id);
    if (!g) { g = MB.el('g', { 'data-id': it.id, 'data-kind': it.k }, S.world); S.nodes.set(it.id, g); }
    g.textContent = '';
    var build = builders[it.k];
    if (build) { build(g, it); }
    g.setAttribute('transform', it.k === 'line' ? '' : transformOf(it));
    if (it.k === 'line') { g.removeAttribute('transform'); }
  }

  function drawLinesOf(id) {
    var lines = S.refs.get(id);
    if (!lines) { return; }
    lines.forEach(function (lineId) { var line = S.items.get(lineId); if (line) { draw(line); } });
  }

  function drawAll() {
    S.items.forEach(function (it) { draw(it); });
    MB.emit('items');
  }
  MB.drawAll = drawAll;
  /** Draws one item again (and the connectors attached to it). */
  MB.drawItem = function (id) { var it = S.items.get(id); if (it) { draw(it); drawLinesOf(id); } };

  function reorder() {
    S.sorted = null;
    sortedItems().forEach(function (it) { var n = S.nodes.get(it.id); if (n) { S.world.appendChild(n); } });
  }

  function link(it) {
    unlink(it);
    if (it.k !== 'line') { return; }
    var ids = [];
    ['a', 'b'].forEach(function (end) {
      var target = it.d[end] && it.d[end].id;
      if (target) { ids.push(target); if (!S.refs.has(target)) { S.refs.set(target, new Set()); } S.refs.get(target).add(it.id); }
    });
    it._refs = ids;
  }
  function unlink(it) {
    (it._refs || []).forEach(function (target) { var set = S.refs.get(target); if (set) { set.delete(it.id); } });
    it._refs = [];
  }

  // ---- the view ---------------------------------------------------------------------------------------------------------------
  function paintPaper() {
    var bg = S.background, k = S.view.k, mult = k < 0.3 ? 4 : k < 0.6 ? 2 : 1;
    S.paper.setAttribute('fill', bg === 'none' ? 'none' : 'url(#mb-pat-' + bg + ')');
    var p = document.getElementById('mb-pat-' + bg);
    if (p) { p.setAttribute('patternTransform', 'translate(' + S.view.x + ' ' + S.view.y + ') scale(' + (k * mult) + ')'); }
  }
  MB.setBackground = function (bg) { S.background = ['dots', 'grid', 'lines', 'none'].indexOf(bg) >= 0 ? bg : 'dots'; paintPaper(); };

  var saveViewTimer = 0;
  function setView(v, quiet) {
    var k = Math.max(0.05, Math.min(4, v.k));
    S.view = { x: v.x, y: v.y, k: k };
    S.world.setAttribute('transform', 'translate(' + S.view.x + ' ' + S.view.y + ') scale(' + k + ')');
    paintPaper();
    if (!quiet) { MB.emit('view'); }
    clearTimeout(saveViewTimer);
    saveViewTimer = setTimeout(function () { try { localStorage.setItem('mb.view.' + S.id, JSON.stringify(S.view)); } catch (e) { /* private mode */ } }, 400);
  }
  MB.setView = setView;

  MB.canvasRect = function () { return S.canvas.getBoundingClientRect(); };
  MB.toWorld = function (cx, cy) { var r = S.canvas.getBoundingClientRect(); return { x: (cx - r.left - S.view.x) / S.view.k, y: (cy - r.top - S.view.y) / S.view.k }; };
  MB.toScreen = function (wx, wy) { return { x: wx * S.view.k + S.view.x, y: wy * S.view.k + S.view.y }; };

  /** Zoom by a factor around a point of the canvas (screen pixels, relative to the canvas). */
  MB.zoomAt = function (sx, sy, factor) {
    var k = Math.max(0.05, Math.min(4, S.view.k * factor)), f = k / S.view.k;
    setView({ x: sx - (sx - S.view.x) * f, y: sy - (sy - S.view.y) * f, k: k });
  };
  MB.zoomCenter = function (factor) { var r = MB.canvasRect(); MB.zoomAt(r.width / 2, r.height / 2, factor); };
  MB.zoomTo = function (k) { var r = MB.canvasRect(); MB.zoomAt(r.width / 2, r.height / 2, k / S.view.k); };

  /** Show some items (everything when no ids are given) as large as fits, with some air around. */
  MB.fit = function (ids) {
    var r = MB.canvasRect(), b = MB.bounds(ids);
    if (!b) { setView({ x: r.width / 2, y: r.height / 2, k: 1 }); return; }
    var pad = Math.min(80, Math.min(r.width, r.height) * 0.12);
    var k = Math.max(0.05, Math.min(1.5, (r.width - pad * 2) / Math.max(1, b.w), (r.height - pad * 2) / Math.max(1, b.h)));
    setView({ x: r.width / 2 - (b.x + b.w / 2) * k, y: r.height / 2 - (b.y + b.h / 2) * k, k: k });
  };

  MB.centerOnWorld = function () { var r = MB.canvasRect(); return MB.toWorld(r.left + r.width / 2, r.top + r.height / 2); };

  // ---- applying changes ------------------------------------------------------------------------------------------------------
  function normalize(i) {
    var it = {
      id: String(i.id), k: i.k, x: num(i.x, 0), y: num(i.y, 0), w: Math.max(0, num(i.w, 0)), h: Math.max(0, num(i.h, 0)), r: num(i.r, 0), z: Math.round(num(i.z, 0)),
      d: i.d && typeof i.d === 'object' ? i.d : {},
    };
    return it;
  }

  function trackZ(it) { if (it.z > S.maxZ) { S.maxZ = it.z; } if (it.z < S.minZ) { S.minZ = it.z; } }

  var GEOM = ['x', 'y', 'w', 'h', 'r', 'z'];

  /** Applies changes to the state and the drawing; fills `inverse` (when given) with the changes that undo them, in the order they were made. */
  function applyOps(ops, inverse) {
    var needOrder = false, selectionChanged = false;
    ops.forEach(function (op) {
      var it;
      if (op.o === 'add') {
        var item = normalize(op.i);
        var prev = S.items.get(item.id);
        if (inverse) { inverse.push(prev ? { o: 'add', i: clone(stripLocal(prev)) } : { o: 'del', id: item.id }); }
        if (prev) { unlink(prev); }
        S.items.set(item.id, item);
        trackZ(item);
        link(item);
        draw(item);
        drawLinesOf(item.id);
        needOrder = true;
      } else if (op.o === 'upd') {
        it = S.items.get(op.id);
        if (!it) { return; }
        if (inverse) {
          var back = { o: 'upd', id: op.id };
          GEOM.forEach(function (key) { if (op[key] !== undefined) { back[key] = it[key]; } });
          if (op.d) { back.d = {}; Object.keys(op.d).forEach(function (key) { back.d[key] = it.d[key] === undefined ? null : clone(it.d[key]); }); }
          inverse.push(back);
        }
        var geometryOnly = !op.d && op.w === undefined && op.h === undefined;
        GEOM.forEach(function (key) { if (op[key] !== undefined) { it[key] = key === 'z' ? Math.round(num(op[key], it.z)) : num(op[key], it[key]); } });
        if (op.z !== undefined) { trackZ(it); needOrder = true; }
        if (op.d) {
          Object.keys(op.d).forEach(function (key) { if (op.d[key] === null) { delete it.d[key]; } else { it.d[key] = op.d[key]; } });
          if (it.k === 'line') { link(it); }
        }
        if (geometryOnly && it.k !== 'line' && S.nodes.get(it.id)) { S.nodes.get(it.id).setAttribute('transform', transformOf(it)); } else { draw(it); }
        drawLinesOf(it.id);
      } else if (op.o === 'del') {
        it = S.items.get(op.id);
        if (!it) { return; }
        if (inverse) { inverse.push({ o: 'add', i: clone(stripLocal(it)) }); }
        unlink(it);
        S.items.delete(it.id);
        var node = S.nodes.get(it.id);
        if (node) { node.remove(); S.nodes.delete(it.id); }
        if (S.sel.delete(it.id)) { selectionChanged = true; }
        if (S.editing && S.editing.id === it.id) { MB.emit('editcancel'); }
        drawLinesOf(it.id);
        S.sorted = null;
      }
    });
    if (needOrder) { reorder(); }
    S.sorted = null;
    MB.emit('items');
    if (selectionChanged) { MB.emit('selection'); }
  }
  function stripLocal(it) { var c = Object.assign({}, it); delete c._refs; return c; }

  // ---- history (what this person did, undone and redone) ---------------------------------------------------------------------
  var H = { undo: [], redo: [] };
  MB.canUndo = function () { return H.undo.length > 0; };
  MB.canRedo = function () { return H.redo.length > 0; };

  function send(ops) { if (MB.net && ops.length) { MB.net.send(ops); } }

  /** A change made by the person: applied, kept for undo, sent to the others. */
  MB.act = function (ops) {
    if (!S.canEdit() || !ops.length) { return; }
    var inverse = [];
    applyOps(ops, inverse);
    H.undo.push({ fwd: clone(ops), back: inverse.reverse() });
    if (H.undo.length > 100) { H.undo.shift(); }
    H.redo = [];
    send(ops);
    MB.emit('history');
  };
  /** A change that is sent but not kept for undo (the steps of a drag; the end of it is recorded). */
  MB.live = function (ops) {
    if (!S.canEdit() || !ops.length) { return; }
    applyOps(ops);
    send(ops);
  };
  /** Keeps a finished gesture for undo: `fwd` is what it did, `back` what undoes it. */
  MB.record = function (fwd, back) {
    if (!fwd.length) { return; }
    H.undo.push({ fwd: clone(fwd), back: clone(back) });
    if (H.undo.length > 100) { H.undo.shift(); }
    H.redo = [];
    MB.emit('history');
  };
  MB.undo = function () {
    var step = H.undo.pop();
    if (!step) { return; }
    applyOps(step.back);
    send(clone(step.back));
    H.redo.push(step);
    MB.emit('history');
  };
  MB.redo = function () {
    var step = H.redo.pop();
    if (!step) { return; }
    applyOps(step.fwd);
    send(clone(step.fwd));
    H.undo.push(step);
    MB.emit('history');
  };

  /** Changes that came from somebody else (or from the server): applied, not sent, not in the history. */
  MB.applyRemote = function (ops) { applyOps(ops); };

  /** Replaces everything on the board with what the server says (the first load and after a reconnect). */
  MB.load = function (snapshot) {
    S.items.forEach(function (it) { unlink(it); });
    S.items.clear();
    S.nodes.forEach(function (n) { n.remove(); });
    S.nodes.clear();
    S.refs.clear();
    S.maxZ = 0; S.minZ = 0;
    var keep = Array.from(S.sel);
    S.sel.clear();
    (snapshot.items || []).forEach(function (raw) {
      var it = normalize(raw);
      S.items.set(it.id, it);
      trackZ(it);
    });
    S.items.forEach(function (it) { link(it); });
    S.rev = snapshot.revision || 0;
    if (snapshot.name) { document.getElementById('mb-title').textContent = snapshot.name; }
    if (snapshot.background) { MB.setBackground(snapshot.background); }
    S.sorted = null;
    drawAll();
    reorder();
    keep.forEach(function (id) { if (S.items.has(id)) { S.sel.add(id); } });
    MB.emit('selection');
  };

  MB.select = function (ids) {
    S.sel = new Set(ids.filter(function (id) { return S.items.has(id); }));
    MB.emit('selection');
  };

  MB.setRole = function (role) {
    S.role = role;
    root.setAttribute('data-role', role);
    MB.emit('role');
  };

  // ---- the page -------------------------------------------------------------------------------------------------------------
  S.ink = readInk();
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (media && media.addEventListener) { media.addEventListener('change', function () { setTimeout(refreshInk, 50); }); }
  new MutationObserver(function () { setTimeout(refreshInk, 50); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-scheme', 'class'] });

  // the first view: where the person was last time, else everything
  MB.restoreView = function () {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem('mb.view.' + S.id) || 'null'); } catch (e) { saved = null; }
    if (saved && typeof saved.k === 'number' && isFinite(saved.x) && isFinite(saved.y)) { setView(saved, true); MB.emit('view'); } else { MB.fit(); }
  };
  paintPaper();
})();
