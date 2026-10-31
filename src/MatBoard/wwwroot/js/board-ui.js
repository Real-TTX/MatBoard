/* MatBoard – the canvas, part 3: the hands. Tools, selection, moving / resizing / rotating, text editing, the bar over the selection, clipboard, images, export, keys.
   Pointer events do mouse, pen and touch alike; two fingers pan and zoom. Every change goes through MB.act (history + sent) or MB.live (a step of a gesture; the end is recorded). */
(function () {
  'use strict';

  var MB = window.MB;
  if (!MB || !MB.S) { return; }
  var S = MB.S, t = MB.t;
  var canvas = S.canvas, overlay = S.overlay, root = S.root;
  var editor = document.getElementById('mb-editor');
  var ctxBar = document.getElementById('mb-ctx');
  var fileInput = document.getElementById('mb-file');

  var SHAPES = ['rect', 'ellipse', 'diamond', 'triangle'];
  var TEXT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 80, 96];
  var WIDTHS = [2, 3, 5, 8, 12];
  var HANDLES = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] };
  var CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

  var pointerSeen = false, tool = 'select', drag = null, spaceDown = false, lastWorld = { x: 0, y: 0 }, lastTap = { time: 0, x: 0, y: 0 };
  var pointers = new Map(), overlayFrame = 0, ctxPop = null;

  function r2(n) { return Math.round(n * 100) / 100; }
  function sel() { return Array.from(S.sel).map(function (id) { return S.items.get(id); }).filter(Boolean); }
  function toast(message, tone) { if (window.MatUi && MatUi.toast) { MatUi.toast(message, { tone: tone || 'info' }); } }
  function isTyping(target) {
    return target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
  }

  // ---- tools -----------------------------------------------------------------------------------------------------------------
  var toolButtons = Array.from(root.querySelectorAll('[data-tool]'));
  var shapesPop = document.getElementById('mb-shapes-pop'), shapesBtn = document.getElementById('mb-shapes-btn');
  var stampPop = document.getElementById('mb-stamp-pop'), stampBtn = document.getElementById('mb-stamp-btn');
  MB.STAMPS.forEach(function (e) {
    var b = MB.html('button', 'mb-tool mb-tool--emoji', stampPop);
    b.type = 'button';
    b.textContent = e;
    b.setAttribute('aria-label', e);
    b.addEventListener('click', function () { S.stamp = e; stampBtn.querySelector('.mb-tool__emoji').textContent = e; closePops(); setTool('stamp'); });
  });

  function setTool(name) {
    if (!S.canEdit() && name !== 'select' && name !== 'hand') { name = 'select'; }
    endEdit(true);
    tool = name;
    toolButtons.forEach(function (b) {
      var on = b.getAttribute('data-tool') === name || (b === shapesBtn && SHAPES.indexOf(name) >= 0);
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (SHAPES.indexOf(name) >= 0) {
      var use = shapesBtn.querySelector('use');
      use.setAttribute('href', '#mat-i-' + (name === 'rect' ? 'square' : name));
    }
    canvas.setAttribute('data-tool', name);
    if (name !== 'select') { MB.select([]); }
  }

  toolButtons.forEach(function (b) {
    b.addEventListener('click', function () {
      var name = b.getAttribute('data-tool');
      if (name === 'shape') { stampPop.hidden = true; shapesPop.hidden = !shapesPop.hidden; shapesBtn.setAttribute('aria-expanded', String(!shapesPop.hidden)); return; }
      if (b === stampBtn) { shapesPop.hidden = true; stampPop.hidden = !stampPop.hidden; stampBtn.setAttribute('aria-expanded', String(!stampPop.hidden)); return; }
      shapesPop.hidden = true;
      stampPop.hidden = true;
      setTool(name);
    });
  });
  document.getElementById('mb-image-btn').addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () {
    Array.from(fileInput.files).forEach(function (f) { addImageFile(f, MB.centerOnWorld()); });
    fileInput.value = '';
  });

  // ---- role: a viewer sees the board, a person who may edit works on it -------------------------------------------------------
  function applyRole() {
    var edit = S.canEdit();
    root.classList.toggle('mb-readonly', !edit);
    var badge = document.getElementById('mb-role');
    if (badge) { badge.textContent = t('Js.Board.Role.' + S.role); badge.hidden = S.role === 'owner'; }
    if (!edit) { setTool(tool === 'hand' ? 'hand' : 'select'); endEdit(false); }
    updateHint();
    drawOverlay();
    renderCtx();
  }
  MB.on('role', applyRole);

  // ---- the view: zoom controls ---------------------------------------------------------------------------------------------------
  var zoomValue = document.getElementById('mb-zoom-value');
  MB.on('view', function () { zoomValue.textContent = Math.round(S.view.k * 100) + '%'; scheduleOverlay(); placeEditor(); });
  document.getElementById('mb-zoom-in').addEventListener('click', function () { MB.zoomCenter(1.25); });
  document.getElementById('mb-zoom-out').addEventListener('click', function () { MB.zoomCenter(0.8); });
  document.getElementById('mb-zoom-fit').addEventListener('click', function () { MB.fit(); });
  zoomValue.addEventListener('click', function () { MB.zoomTo(1); });

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = MB.canvasRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    // a mouse wheel zooms (steps of 100, or lines), a trackpad scrolls (small, smooth values) and pinches (ctrl)
    var mouse = e.deltaMode !== 0 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50);
    if (e.ctrlKey || e.metaKey || mouse) {
      var amount = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      MB.zoomAt(sx, sy, Math.exp(-amount * (e.ctrlKey ? 0.01 : 0.0016)));
    } else {
      MB.setView({ x: S.view.x - e.deltaX, y: S.view.y - e.deltaY, k: S.view.k });
    }
  }, { passive: false });

  // ---- the hint on an empty board ---------------------------------------------------------------------------------------------
  var hint = document.getElementById('mb-hint');
  function updateHint() {
    if (!hint) { return; }
    hint.hidden = !S.ready || S.items.size > 0;
    hint.textContent = S.canEdit() ? t('Js.Board.Hint') : t('Js.Board.Hint.View');
  }
  MB.on('items', updateHint);
  MB.on('loaded', function () { applyRole(); updateHint(); });

  // ---- history buttons --------------------------------------------------------------------------------------------------------
  var undoBtn = document.getElementById('mb-undo'), redoBtn = document.getElementById('mb-redo');
  MB.on('history', function () { undoBtn.disabled = !MB.canUndo(); redoBtn.disabled = !MB.canRedo(); });
  undoBtn.addEventListener('click', function () { endEdit(true); MB.undo(); });
  redoBtn.addEventListener('click', function () { endEdit(true); MB.redo(); });

  // ---- the overlay: the selection, its handles, the marquee and the previews of a gesture ----------------------------------------
  function sv(tag, attrs) { return MB.el(tag, attrs, overlay); }
  function scheduleOverlay() { if (!overlayFrame) { overlayFrame = requestAnimationFrame(function () { overlayFrame = 0; drawOverlay(); renderCtx(); }); } }
  MB.on('selection', function () { ctxPop = null; scheduleOverlay(); });
  MB.on('items', scheduleOverlay);

  function screenPts(points) { return points.map(function (p) { var s = MB.toScreen(p.x, p.y); return s.x + ',' + s.y; }).join(' '); }

  function handleSet(it) {
    if (it.k === 'text') { return ['e', 'w']; }
    if (it.k === 'comment') { return []; }
    if (it.k === 'sticky' || it.k === 'image' || it.k === 'pen' || it.k === 'stamp') { return ['nw', 'ne', 'se', 'sw']; }
    return Object.keys(HANDLES);
  }
  function canRotate(it) { return it.k !== 'frame' && it.k !== 'line' && it.k !== 'comment'; }
  function canQuickConnect(it) { return (it.k === 'sticky' || MB.isShape(it.k)) && !it.r; }
  var QUICK = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };

  function drawOverlay() {
    overlay.textContent = '';
    overlay.setAttribute('pointer-events', 'none');
    var items = sel(), edit = S.canEdit(), k = S.view.k;
    if (items.length === 1 && items[0].k === 'line') {
      var e = MB.lineEnds(items[0]), a = MB.toScreen(e.a.x, e.a.y), b = MB.toScreen(e.b.x, e.b.y);
      if (edit) {
        sv('circle', { cx: a.x, cy: a.y, r: 7, 'class': 'mb-handle mb-handle--end', 'data-handle': 'a', 'pointer-events': 'all' }).style.cursor = 'crosshair';
        sv('circle', { cx: b.x, cy: b.y, r: 7, 'class': 'mb-handle mb-handle--end', 'data-handle': 'b', 'pointer-events': 'all' }).style.cursor = 'crosshair';
      }
    } else if (items.length === 1) {
      var it = items[0], cs = MB.corners(it);
      sv('polygon', { points: screenPts(cs), 'class': 'mb-sel' });
      if (MB.isLocked(it)) {
        var lockBox = MB.aabb(it), lockAt = MB.toScreen(lockBox.x + lockBox.w, lockBox.y);
        var badge = MB.el('svg', { x: lockAt.x - 9, y: lockAt.y - 24, width: 18, height: 18, viewBox: '0 0 24 24', 'class': 'mb-lockbadge' }, overlay);
        MB.el('use', { href: '#mat-i-lock' }, badge);
      } else if (edit && !(drag && (drag.type === 'move'))) {
        var c = MB.center(it);
        handleSet(it).forEach(function (name) {
          var h = HANDLES[name], p = MB.rotPt(h[0] * it.w / 2, h[1] * it.h / 2, it.r || 0), s = MB.toScreen(c.x + p.x, c.y + p.y);
          var rect = sv('rect', { x: s.x - 5, y: s.y - 5, width: 10, height: 10, rx: 2, 'class': 'mb-handle', 'data-handle': name, 'pointer-events': 'all' });
          rect.style.cursor = CURSORS[name];
        });
        if (canRotate(it)) {
          var top = MB.rotPt(0, -it.h / 2, it.r || 0), knob = MB.rotPt(0, -it.h / 2 - 30 / k, it.r || 0);
          var s0 = MB.toScreen(c.x + top.x, c.y + top.y), s1 = MB.toScreen(c.x + knob.x, c.y + knob.y);
          sv('line', { x1: s0.x, y1: s0.y, x2: s1.x, y2: s1.y, 'class': 'mb-sel mb-sel--stem' });
          var rot = sv('circle', { cx: s1.x, cy: s1.y, r: 6, 'class': 'mb-handle mb-handle--rotate', 'data-handle': 'rotate', 'pointer-events': 'all' });
          rot.style.cursor = 'grab';
        }
        if (canQuickConnect(it) && !drag) {
          Object.keys(QUICK).forEach(function (dir) {
            var v = QUICK[dir], at = MB.toScreen(c.x + v[0] * it.w / 2, c.y + v[1] * it.h / 2);
            var q = sv('circle', { cx: at.x + v[0] * 26, cy: at.y + v[1] * 26, r: 8, 'class': 'mb-handle mb-handle--quick', 'data-handle': 'qc-' + dir, 'pointer-events': 'all' });
            q.style.cursor = 'copy';
            MB.el('title', {}, q).textContent = t('Js.Board.QuickConnect');
          });
        }
      }
    } else if (items.length > 1) {
      var bb = MB.bounds(items.map(function (i) { return i.id; })), tl = MB.toScreen(bb.x, bb.y);
      sv('rect', { x: tl.x, y: tl.y, width: bb.w * k, height: bb.h * k, 'class': 'mb-sel mb-sel--multi' });
      items.forEach(function (i) { var box = MB.aabb(i), s = MB.toScreen(box.x, box.y); sv('rect', { x: s.x, y: s.y, width: box.w * k, height: box.h * k, 'class': 'mb-sel mb-sel--each' }); });
    }

    if (drag && drag.guides) {
      var size = MB.canvasRect();
      drag.guides.forEach(function (g) {
        var at = g.v ? MB.toScreen(g.at, 0).x : MB.toScreen(0, g.at).y;
        sv('line', g.v ? { x1: at, y1: 0, x2: at, y2: size.height, 'class': 'mb-guide' } : { x1: 0, y1: at, x2: size.width, y2: at, 'class': 'mb-guide' });
      });
    }
    if (drag && drag.type === 'marquee') {
      var m = drag.rect;
      sv('rect', { x: m.x, y: m.y, width: m.w, height: m.h, 'class': 'mb-marquee' });
    }
    if (drag && drag.snap) {
      var target = S.items.get(drag.snap);
      if (target) { sv('polygon', { points: screenPts(MB.corners(target)), 'class': 'mb-snap' }); }
    }
    if (drag && drag.type === 'create') {
      var box = createRect(drag), p0 = MB.toScreen(box.x, box.y);
      sv('rect', { x: p0.x, y: p0.y, width: box.w * k, height: box.h * k, 'class': drag.kind === 'frame' ? 'mb-preview mb-preview--frame' : 'mb-preview' });
    }
    if (drag && drag.type === 'line' && drag.to) {
      var from = drag.fromItem ? MB.center(drag.fromItem) : drag.start, toPt = drag.toItem ? MB.center(drag.toItem) : drag.to;
      var pa = drag.fromItem ? anchorOf(drag.fromItem, toPt) : from, pb = drag.toItem ? anchorOf(drag.toItem, from) : drag.to;
      var sa = MB.toScreen(pa.x, pa.y), sb = MB.toScreen(pb.x, pb.y);
      sv('line', { x1: sa.x, y1: sa.y, x2: sb.x, y2: sb.y, 'class': 'mb-preview-line' });
    }
    if (drag && drag.type === 'pen' && drag.points.length > 1) {
      sv('polyline', { points: screenPts(drag.points), 'class': 'mb-preview-pen' });
    }
  }
  MB.on('loaded', drawOverlay);

  function anchorOf(item, toward) {
    // the same rule as a connector: where the line from the centre towards a point leaves the item
    var tmp = { id: 'tmp', k: 'line', x: 0, y: 0, w: 0, h: 0, r: 0, z: 0, d: { a: { id: item.id, x: 0, y: 0 }, b: { x: toward.x, y: toward.y } } };
    return MB.lineEnds(tmp).a;
  }

  // ---- gestures --------------------------------------------------------------------------------------------------------------------
  function worldOf(e) { return MB.toWorld(e.clientX, e.clientY); }
  function screenOf(e) { var r = MB.canvasRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  canvas.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) { return; }
    closePops();
    endEdit(true);
    canvas.focus({ preventScroll: true });
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* the pointer is gone */ }

    if (pointers.size === 2) { finishDrag(true); startPinch(); return; }
    if (pointers.size > 2) { return; }

    var p = worldOf(e);
    lastWorld = p;
    var panning = e.button === 1 || spaceDown || tool === 'hand';
    if (panning) { drag = { type: 'pan', sx: e.clientX, sy: e.clientY, view: Object.assign({}, S.view), moved: false }; canvas.classList.add('is-panning'); return; }

    var handle = e.target.closest && e.target.closest('[data-handle]');
    var node = e.target.closest && e.target.closest('g[data-id]');
    var item = node && node.parentNode === S.world ? S.items.get(node.getAttribute('data-id')) : null;

    if (tool === 'select') {
      if (!S.canEdit()) { drag = { type: 'pan', sx: e.clientX, sy: e.clientY, view: Object.assign({}, S.view), moved: false, click: item, clear: !item }; return; }
      if (handle) { startHandle(handle.getAttribute('data-handle'), p, e); return; }
      if (item) {
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          var next = new Set(S.sel);
          if (next.has(item.id)) { next.delete(item.id); } else { next.add(item.id); }
          MB.select(Array.from(next));
          if (!next.has(item.id)) { drag = null; return; }
        } else if (!S.sel.has(item.id)) { MB.select([item.id]); }
        startMove(p, item);
        return;
      }
      // nothing hit: a touch pans (a finger cannot draw a marquee and pan both), a mouse or pen selects by a rectangle
      if (e.pointerType === 'touch') { drag = { type: 'pan', sx: e.clientX, sy: e.clientY, view: Object.assign({}, S.view), moved: false, clear: true }; return; }
      var base = e.shiftKey ? Array.from(S.sel) : [];
      if (!e.shiftKey) { MB.select([]); }
      var s = screenOf(e);
      drag = { type: 'marquee', start: s, base: base, rect: { x: s.x, y: s.y, w: 0, h: 0 } };
      return;
    }

    if (!S.canEdit()) { return; }
    if (tool === 'comment') { setTool('select'); MB.emit('comment:new', p); return; }
    if (tool === 'stamp') {
      var stamp = MB.newItem('stamp', { x: r2(p.x - 32), y: r2(p.y - 32), d: { e: S.stamp || MB.STAMPS[0] } });
      MB.act([{ o: 'add', i: stamp }]);
      return;
    }
    if (tool === 'line') {
      var from = MB.itemAt(p.x, p.y, { connectable: true });
      drag = { type: 'line', start: p, fromItem: from, to: p, toItem: null, snap: from ? from.id : null };
      scheduleOverlay();
      return;
    }
    if (tool === 'pen') { drag = { type: 'pen', points: [p] }; return; }
    drag = { type: 'create', kind: tool, start: p, cur: p, sx: e.clientX, sy: e.clientY };
    scheduleOverlay();
  });

  canvas.addEventListener('pointermove', function (e) {
    if (pointers.has(e.pointerId)) { pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); }
    var p = worldOf(e);
    lastWorld = p;
    pointerSeen = true;
    if (e.pointerType === 'mouse' && MB.net) { MB.net.cursor(p.x, p.y); }
    if (drag && drag.type === 'pinch') { movePinch(); return; }
    if (!drag) { return; }
    switch (drag.type) {
      case 'pan': {
        var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; }
        MB.setView({ x: drag.view.x + dx, y: drag.view.y + dy, k: drag.view.k });
        break;
      }
      case 'marquee': moveMarquee(screenOf(e), e.shiftKey); break;
      case 'move': moveItems(p, e.altKey); break;
      case 'resize': resizeTo(p, e.shiftKey); break;
      case 'rotate': rotateTo(p, e.shiftKey); break;
      case 'end': moveEnd(p); break;
      case 'create': drag.cur = p; scheduleOverlay(); break;
      case 'line':
        drag.to = p;
        drag.toItem = MB.itemAt(p.x, p.y, { connectable: true, exclude: drag.fromItem ? null : null });
        if (drag.toItem && drag.fromItem && drag.toItem.id === drag.fromItem.id) { drag.toItem = null; }
        drag.snap = drag.toItem ? drag.toItem.id : null;
        scheduleOverlay();
        break;
      case 'pen': {
        var last = drag.points[drag.points.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) * S.view.k >= 2) { drag.points.push(p); scheduleOverlay(); }
        break;
      }
      default: break;
    }
  });

  function onUp(e) {
    pointers.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* released already */ }
    if (drag && drag.type === 'pinch') { if (pointers.size < 2) { drag = null; } return; }
    var wasClick = drag && !isMoved(drag);
    finishDrag(false, e);
    if (wasClick && e.type === 'pointerup') { tapped(e); }
  }
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  function isMoved(d) {
    if (d.type === 'pan' || d.type === 'move') { return d.moved; }
    if (d.type === 'marquee') { return d.rect.w + d.rect.h > 4; }
    return true;
  }

  /** Ends the gesture in progress: records it (for undo) and puts the preview away. */
  function finishDrag(cancel, e) {
    var d = drag;
    drag = null;
    canvas.classList.remove('is-panning');
    if (!d) { return; }
    switch (d.type) {
      case 'pan':
        if (!d.moved && !cancel) { if (d.click) { MB.select([d.click.id]); } else if (d.clear) { MB.select([]); } }
        break;
      case 'marquee': break;
      case 'move': endMove(d); break;
      case 'resize': case 'rotate': case 'end': endChange(d); break;
      case 'create': if (!cancel && e) { finishCreate(d); } break;
      case 'line': if (!cancel && e) { finishLine(d); } break;
      case 'pen': if (!cancel) { finishPen(d); } break;
      default: break;
    }
    scheduleOverlay();
  }

  // a tap: a second one close to the first is a double tap (edit what is there, or a new sticky note)
  function tapped(e) {
    if (tool !== 'select' || !S.canEdit()) { return; }
    var now = Date.now(), p = worldOf(e), s = { x: e.clientX, y: e.clientY };
    var second = now - lastTap.time < 380 && Math.hypot(s.x - lastTap.x, s.y - lastTap.y) < 14;
    lastTap = { time: second ? 0 : now, x: s.x, y: s.y };
    if (!second) { return; }
    var item = MB.itemAt(p.x, p.y);
    if (item) {
      if (MB.hasText(item.k)) { MB.select([item.id]); startEdit(item.id, 'text'); } else if (item.k === 'frame') { MB.select([item.id]); startEdit(item.id, 'title'); }
    } else {
      var made = MB.newItem('sticky', { x: p.x - 100, y: p.y - 100 });
      MB.act([{ o: 'add', i: made }]);
      MB.select([made.id]);
      startEdit(made.id, 'text');
    }
  }

  // ---- panning and zooming with two fingers --------------------------------------------------------------------------------
  function startPinch() {
    var pts = Array.from(pointers.values());
    var r = MB.canvasRect();
    var mid = { x: (pts[0].x + pts[1].x) / 2 - r.left, y: (pts[0].y + pts[1].y) / 2 - r.top };
    drag = { type: 'pinch', dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, view: Object.assign({}, S.view), mid: mid };
  }
  function movePinch() {
    var pts = Array.from(pointers.values());
    if (pts.length < 2) { return; }
    var r = MB.canvasRect(), d = drag;
    var mid = { x: (pts[0].x + pts[1].x) / 2 - r.left, y: (pts[0].y + pts[1].y) / 2 - r.top };
    var k = Math.max(0.05, Math.min(4, d.view.k * (Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) / d.dist)));
    var wx = (d.mid.x - d.view.x) / d.view.k, wy = (d.mid.y - d.view.y) / d.view.k;
    MB.setView({ x: mid.x - wx * k, y: mid.y - wy * k, k: k });
  }

  // ---- marquee ------------------------------------------------------------------------------------------------------------------
  function moveMarquee(s, additive) {
    var d = drag;
    d.rect = { x: Math.min(s.x, d.start.x), y: Math.min(s.y, d.start.y), w: Math.abs(s.x - d.start.x), h: Math.abs(s.y - d.start.y) };
    var a = MB.toWorld(d.rect.x + MB.canvasRect().left, d.rect.y + MB.canvasRect().top), k = S.view.k;
    var box = { x: a.x, y: a.y, w: d.rect.w / k, h: d.rect.h / k }, ids = additive ? d.base.slice() : [];
    S.items.forEach(function (it) {
      var b = MB.aabb(it);
      var hit = it.k === 'frame'
        ? b.x >= box.x && b.y >= box.y && b.x + b.w <= box.x + box.w && b.y + b.h <= box.y + box.h
        : b.x <= box.x + box.w && b.x + b.w >= box.x && b.y <= box.y + box.h && b.y + b.h >= box.y;
      if (hit && ids.indexOf(it.id) < 0) { ids.push(it.id); }
    });
    MB.select(ids);
  }

  // ---- moving ------------------------------------------------------------------------------------------------------------------
  function startMove(p, hit) {
    var ids = Array.from(S.sel).filter(function (id) { return !MB.isLocked(S.items.get(id)); }), all = new Set(ids);
    if (!ids.length) { drag = null; return; }
    // a frame takes what lies inside it along
    ids.forEach(function (id) {
      var it = S.items.get(id);
      if (!it || it.k !== 'frame') { return; }
      var f = MB.aabb(it);
      S.items.forEach(function (o) {
        if (o.id === id || o.k === 'frame' || all.has(o.id) || MB.isLocked(o)) { return; }
        var b = MB.aabb(o);
        if (b.x >= f.x && b.y >= f.y && b.x + b.w <= f.x + f.w && b.y + b.h <= f.y + f.h) { all.add(o.id); }
      });
    });
    var orig = {};
    all.forEach(function (id) { var it = S.items.get(id); orig[id] = { x: it.x, y: it.y, a: it.d.a ? MB.clone(it.d.a) : null, b: it.d.b ? MB.clone(it.d.b) : null, ends: it.k === 'line' ? MB.lineEnds(it) : null }; });
    drag = { type: 'move', start: p, ids: Array.from(all), all: all, orig: orig, moved: false, hit: hit };
    // what the moved things can line up with: the other things in view (edges and centres)
    var solid = drag.ids.filter(function (id) { var it = S.items.get(id); return it.k !== 'line' && it.k !== 'comment'; });
    drag.box = solid.length ? MB.bounds(solid) : null;
    var view = MB.canvasRect(), a = MB.toWorld(view.left, view.top), b = MB.toWorld(view.right, view.bottom);
    drag.targets = [];
    S.items.forEach(function (it) {
      if (all.has(it.id) || it.k === 'line' || it.k === 'pen' || it.k === 'comment') { return; }
      var box = MB.aabb(it);
      if (box.x > b.x || box.y > b.y || box.x + box.w < a.x || box.y + box.h < a.y || drag.targets.length > 400) { return; }
      drag.targets.push(box);
    });
    ctxBar.hidden = true;
  }

  /** Pulls a move onto the edges and centres of other things when it comes close (6 pixels on screen); the guides show it. Alt moves freely. */
  function snapMove(d, dx, dy, free) {
    d.guides = null;
    if (!d.box || free) { return { dx: dx, dy: dy }; }
    var th = 6 / S.view.k, b = { x: d.box.x + dx, y: d.box.y + dy, w: d.box.w, h: d.box.h };
    var xs = [b.x, b.x + b.w / 2, b.x + b.w], ys = [b.y, b.y + b.h / 2, b.y + b.h], bx = null, by = null;
    d.targets.forEach(function (o) {
      [o.x, o.x + o.w / 2, o.x + o.w].forEach(function (w) { xs.forEach(function (v) { var diff = w - v; if (Math.abs(diff) <= th && (!bx || Math.abs(diff) < Math.abs(bx.diff))) { bx = { diff: diff, at: w }; } }); });
      [o.y, o.y + o.h / 2, o.y + o.h].forEach(function (w) { ys.forEach(function (v) { var diff = w - v; if (Math.abs(diff) <= th && (!by || Math.abs(diff) < Math.abs(by.diff))) { by = { diff: diff, at: w }; } }); });
    });
    d.guides = [];
    if (bx) { dx += bx.diff; d.guides.push({ v: true, at: bx.at }); }
    if (by) { dy += by.diff; d.guides.push({ v: false, at: by.at }); }
    return { dx: dx, dy: dy };
  }

  function moveItems(p, free) {
    var d = drag, dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) * S.view.k < 3) { return; }
    d.moved = true;
    var snapped = snapMove(d, dx, dy, free);
    dx = snapped.dx; dy = snapped.dy;
    d.ops = [];
    d.ids.forEach(function (id) {
      var o = d.orig[id], it = S.items.get(id);
      if (!it) { return; }
      if (it.k === 'line') {
        var patch = {};
        ['a', 'b'].forEach(function (end) {
          var was = o[end], target = was && was.id;
          if (target && d.all.has(target)) { return; } // follows its item
          var at = o.ends[end];
          patch[end] = { x: r2(at.x + dx), y: r2(at.y + dy) };
        });
        if (Object.keys(patch).length) { d.ops.push({ o: 'upd', id: id, d: patch }); }
      } else {
        d.ops.push({ o: 'upd', id: id, x: r2(o.x + dx), y: r2(o.y + dy) });
      }
    });
    MB.live(d.ops);
    scheduleOverlay();
  }

  function endMove(d) {
    ctxBar.hidden = false;
    if (!d.moved || !d.ops || !d.ops.length) { return; }
    var back = d.ops.map(function (op) {
      var o = d.orig[op.id];
      if (op.d) {
        var undo = {};
        Object.keys(op.d).forEach(function (end) { undo[end] = o[end] ? MB.clone(o[end]) : { x: o.ends[end].x, y: o.ends[end].y }; });
        return { o: 'upd', id: op.id, d: undo };
      }
      return { o: 'upd', id: op.id, x: o.x, y: o.y };
    });
    MB.record(d.ops, back);
  }

  // ---- resizing, rotating and moving the end of a connector ---------------------------------------------------------------
  function startHandle(name, p, e) {
    var it = sel()[0];
    if (!it) { return; }
    if (name.indexOf('qc-') === 0) { quickConnect(it, name.slice(3)); return; }
    var orig = { x: it.x, y: it.y, w: it.w, h: it.h, r: it.r || 0, d: it.k === 'line' ? { a: it.d.a ? MB.clone(it.d.a) : null, b: it.d.b ? MB.clone(it.d.b) : null } : null };
    if (name === 'rotate') { drag = { type: 'rotate', id: it.id, orig: orig, start: p }; }
    else if (name === 'a' || name === 'b') {
      var ends = MB.lineEnds(it);
      drag = { type: 'end', id: it.id, end: name, orig: orig, ends: ends, start: p };
    } else { drag = { type: 'resize', id: it.id, handle: name, orig: orig, keepAspect: it.k === 'sticky' || it.k === 'image', start: p }; }
    ctxBar.hidden = true;
  }

  function resizeTo(p, shift) {
    var d = drag, it = S.items.get(d.id);
    if (!it) { return; }
    var o = d.orig, hx = HANDLES[d.handle][0], hy = HANDLES[d.handle][1], c0 = { x: o.x + o.w / 2, y: o.y + o.h / 2 };
    var q = MB.rotPt(p.x - c0.x, p.y - c0.y, -o.r), min = Math.max(14, 24 / S.view.k);
    var x0 = -o.w / 2, x1 = o.w / 2, y0 = -o.h / 2, y1 = o.h / 2;
    if (hx === 1) { x1 = Math.max(q.x, x0 + min); } else if (hx === -1) { x0 = Math.min(q.x, x1 - min); }
    if (hy === 1) { y1 = Math.max(q.y, y0 + min); } else if (hy === -1) { y0 = Math.min(q.y, y1 - min); }
    if ((d.keepAspect || shift) && hx !== 0 && hy !== 0 && o.w > 0 && o.h > 0) {
      var s = Math.max((x1 - x0) / o.w, (y1 - y0) / o.h), nw0 = o.w * s, nh0 = o.h * s;
      if (hx === 1) { x1 = x0 + nw0; } else { x0 = x1 - nw0; }
      if (hy === 1) { y1 = y0 + nh0; } else { y0 = y1 - nh0; }
    }
    var nw = x1 - x0, nh = y1 - y0, cl = MB.rotPt((x0 + x1) / 2, (y0 + y1) / 2, o.r);
    var cw = { x: c0.x + cl.x, y: c0.y + cl.y };
    var patch = { o: 'upd', id: d.id, x: r2(cw.x - nw / 2), y: r2(cw.y - nh / 2), w: r2(nw), h: r2(nh) };
    if (it.k === 'text') { patch.y = r2(o.y); patch.h = r2(MB.textHeight({ w: nw, d: it.d })); }
    d.patch = patch;
    MB.live([patch]);
    scheduleOverlay();
  }

  function rotateTo(p, snap) {
    var d = drag, o = d.orig, c = { x: o.x + o.w / 2, y: o.y + o.h / 2 };
    var angle = Math.atan2(p.y - c.y, p.x - c.x) * 180 / Math.PI + 90;
    if (snap) { angle = Math.round(angle / 15) * 15; }
    angle = ((angle + 540) % 360) - 180;
    d.patch = { o: 'upd', id: d.id, r: r2(angle) };
    MB.live([d.patch]);
    scheduleOverlay();
  }

  function moveEnd(p) {
    var d = drag, target = MB.itemAt(p.x, p.y, { connectable: true, exclude: d.id });
    var other = d.end === 'a' ? 'b' : 'a', otherId = d.orig.d[other] && d.orig.d[other].id;
    if (target && target.id === otherId) { target = null; }
    var value = target ? { id: target.id, x: r2(p.x), y: r2(p.y) } : { x: r2(p.x), y: r2(p.y) };
    var dd = {};
    dd[d.end] = value;
    // the other end, if it was attached, keeps its place on screen exactly as it is drawn
    d.patch = { o: 'upd', id: d.id, d: dd };
    d.snap = target ? target.id : null;
    MB.live([d.patch]);
    scheduleOverlay();
  }

  function endChange(d) {
    ctxBar.hidden = false;
    if (!d.patch) { return; }
    var back = { o: 'upd', id: d.id };
    if (d.type === 'resize') { ['x', 'y', 'w', 'h'].forEach(function (key) { back[key] = d.orig[key]; }); }
    else if (d.type === 'rotate') { back.r = d.orig.r; }
    else { back.d = {}; back.d[d.end] = d.orig.d[d.end] ? MB.clone(d.orig.d[d.end]) : { x: d.ends[d.end].x, y: d.ends[d.end].y }; }
    MB.record([d.patch], [back]);
  }

  /** Miro's blue dots: a new thing of the same kind next to this one (in a direction), connected to it, ready to be written on. */
  function quickConnect(it, dir) {
    var v = QUICK[dir], gap = 80;
    var data = MB.clone(it.d);
    delete data.text; delete data.lock;
    var copy = MB.newItem(it.k, { x: r2(it.x + v[0] * (it.w + gap)), y: r2(it.y + v[1] * (it.h + gap)), w: it.w, h: it.h, d: data });
    var a = MB.center(it), b = { x: copy.x + copy.w / 2, y: copy.y + copy.h / 2 };
    var line = MB.newItem('line', { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), d: { a: { id: it.id, x: r2(a.x), y: r2(a.y) }, b: { id: copy.id, x: r2(b.x), y: r2(b.y) } } });
    MB.act([{ o: 'add', i: copy }, { o: 'add', i: line }]);
    MB.select([copy.id]);
    var s = MB.toScreen(b.x, b.y), r = MB.canvasRect();
    if (s.x < 40 || s.y < 80 || s.x > r.width - 40 || s.y > r.height - 80) { MB.setView({ x: S.view.x - (s.x - r.width / 2), y: S.view.y - (s.y - r.height / 2), k: S.view.k }); }
    startEdit(copy.id, 'text');
  }

  // ---- creating --------------------------------------------------------------------------------------------------------------------
  function createRect(d) {
    var x = Math.min(d.start.x, d.cur.x), y = Math.min(d.start.y, d.cur.y);
    return { x: x, y: y, w: Math.abs(d.cur.x - d.start.x), h: Math.abs(d.cur.y - d.start.y) };
  }

  function finishCreate(d) {
    var kind = d.kind, box = createRect(d), small = box.w * S.view.k < 10 && box.h * S.view.k < 10, base = MB.defaults(kind);
    var item;
    if (small) {
      item = kind === 'text'
        ? MB.newItem(kind, { x: r2(d.start.x), y: r2(d.start.y - 14) })
        : MB.newItem(kind, { x: r2(d.start.x - base.w / 2), y: r2(d.start.y - base.h / 2) });
    } else if (kind === 'text') {
      item = MB.newItem(kind, { x: r2(box.x), y: r2(d.start.y - 14), w: r2(Math.max(60, box.w)) });
    } else {
      item = MB.newItem(kind, { x: r2(box.x), y: r2(box.y), w: r2(Math.max(24, box.w)), h: r2(Math.max(24, box.h)) });
    }
    if (kind === 'text') { item.h = MB.textHeight(item); }
    MB.act([{ o: 'add', i: item }]);
    setTool('select');
    MB.select([item.id]);
    if (MB.hasText(kind)) { startEdit(item.id, 'text'); } else if (kind === 'frame') { startEdit(item.id, 'title'); }
  }

  function finishLine(d) {
    var tooShort = Math.hypot((d.to.x - d.start.x) * S.view.k, (d.to.y - d.start.y) * S.view.k) < 14 && !d.toItem;
    if (tooShort) { return; }
    var a = d.fromItem ? { id: d.fromItem.id, x: r2(d.start.x), y: r2(d.start.y) } : { x: r2(d.start.x), y: r2(d.start.y) };
    var b = d.toItem ? { id: d.toItem.id, x: r2(d.to.x), y: r2(d.to.y) } : { x: r2(d.to.x), y: r2(d.to.y) };
    var item = MB.newItem('line', { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y), d: { a: a, b: b } });
    MB.act([{ o: 'add', i: item }]);
    setTool('select');
    MB.select([item.id]);
  }

  /** Douglas-Peucker: fewer points that keep the shape. */
  function simplify(points, eps) {
    if (points.length < 3) { return points; }
    var keep = new Array(points.length).fill(false);
    keep[0] = keep[points.length - 1] = true;
    (function walk(lo, hi) {
      var max = 0, at = -1, a = points[lo], b = points[hi], dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      for (var i = lo + 1; i < hi; i++) {
        var dist = Math.abs(dy * points[i].x - dx * points[i].y + b.x * a.y - b.y * a.x) / len;
        if (dist > max) { max = dist; at = i; }
      }
      if (max > eps && at > 0) { keep[at] = true; walk(lo, at); walk(at, hi); }
    })(0, points.length - 1);
    return points.filter(function (p, i) { return keep[i]; });
  }

  function finishPen(d) {
    var pts = d.points.length === 1 ? [d.points[0], { x: d.points[0].x + 0.01, y: d.points[0].y }] : simplify(d.points, 0.8 / S.view.k);
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach(function (p) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
    var flat = [];
    pts.forEach(function (p) { flat.push(r2(p.x - x0), r2(p.y - y0)); });
    var w = r2(x1 - x0), h = r2(y1 - y0);
    var item = MB.newItem('pen', { x: r2(x0), y: r2(y0), w: w, h: h, d: { pts: flat, bw: w, bh: h } });
    MB.act([{ o: 'add', i: item }]);
  }

  // ---- text editing ----------------------------------------------------------------------------------------------------------------
  function textBox(it) {
    var w = it.w, h = it.h;
    switch (it.k) {
      case 'sticky': return { x: 16, y: 16, w: w - 32, h: h - 32 };
      case 'text': return { x: 0, y: 2, w: w, h: Infinity };
      case 'ellipse': return { x: w * 0.14, y: h * 0.15, w: w * 0.72, h: h * 0.7 };
      case 'diamond': return { x: w * 0.25, y: h * 0.25, w: w * 0.5, h: h * 0.5 };
      case 'triangle': return { x: w * 0.27, y: h * 0.42, w: w * 0.46, h: h * 0.5 };
      default: return { x: 12, y: 12, w: w - 24, h: h - 24 };
    }
  }

  function startEdit(id, field) {
    var it = S.items.get(id);
    if (!it || !S.canEdit() || MB.isLocked(it)) { return; }
    endEdit(true);
    S.editing = { id: id, field: field, before: field === 'title' ? (it.d.title || '') : (it.d.text || '') };
    editor.value = S.editing.before;
    editor.hidden = false;
    MB.drawItem(id);
    placeEditor();
    editor.focus();
    editor.select();
    scheduleOverlay();
  }

  function placeEditor() {
    var ed = S.editing;
    if (!ed) { return; }
    var it = S.items.get(ed.id);
    if (!it) { return; }
    var k = S.view.k, box, fs, color, align, padTop = 0, bold = false;
    if (ed.field === 'title') {
      box = { x: 0, y: -34, w: Math.min(320, it.w), h: 34 };
      fs = 18; color = S.ink; align = 'left'; bold = true;
    } else {
      box = textBox(it);
      fs = it.d.fs || (it.k === 'sticky' ? 22 : it.k === 'text' ? 24 : 20);
      color = it.k === 'sticky' ? (it.d.color || '#1f1e1b') : (it.d.color && it.d.color !== 'auto' ? it.d.color : (MB.isShape(it.k) && it.d.fill !== 'none' ? '#1f1e1b' : S.ink));
      align = it.d.align || (it.k === 'text' ? 'left' : 'center');
      if (isFinite(box.h)) {
        var f = MB.fitText(editor.value || ' ', fs, box.w, box.h);
        fs = f.fs;
        padTop = Math.max(0, (box.h - f.lines.length * f.fs * 1.25) / 2);
      }
    }
    var c = MB.center(it), tl = { x: it.x + box.x, y: it.y + box.y };
    // the item may be rotated: the box is placed unrotated at the position it has before the rotation, then rotated around the centre of the item
    var rel = { x: tl.x - c.x, y: tl.y - c.y }, rot = MB.rotPt(rel.x, rel.y, 0);
    var s = MB.toScreen(c.x + rot.x, c.y + rot.y), sc = MB.toScreen(c.x, c.y), height = isFinite(box.h) ? box.h : Math.max(MB.textHeight({ w: box.w, d: Object.assign({}, it.d, { text: editor.value || ' ' }) }), 30);
    var st = editor.style;
    st.left = s.x + 'px'; st.top = s.y + 'px';
    st.width = box.w * k + 'px'; st.height = height * k + 'px';
    st.fontSize = fs * k + 'px'; st.lineHeight = '1.25'; st.color = color; st.textAlign = align; st.fontWeight = bold ? '600' : '400';
    st.paddingTop = padTop * k + 'px';
    st.transformOrigin = (sc.x - s.x) + 'px ' + (sc.y - s.y) + 'px';
    st.transform = it.r ? 'rotate(' + it.r + 'deg)' : 'none';
  }

  editor.addEventListener('input', placeEditor);
  editor.addEventListener('blur', function () { endEdit(true); });
  editor.addEventListener('keydown', function (e) {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) || (e.key === 'Enter' && S.editing && S.editing.field === 'title')) { e.preventDefault(); endEdit(true); canvas.focus({ preventScroll: true }); }
  });
  MB.on('editcancel', function () { endEdit(false); });

  function endEdit(commit) {
    var ed = S.editing;
    if (!ed) { return; }
    S.editing = null;
    editor.hidden = true;
    var it = S.items.get(ed.id), value = editor.value;
    if (it && commit) {
      if (ed.field === 'title') {
        value = value.trim().slice(0, 120);
        if (value !== ed.before) { MB.act([{ o: 'upd', id: it.id, d: { title: value === '' ? null : value } }]); }
      } else if (value !== ed.before) {
        var op = { o: 'upd', id: it.id, d: { text: value === '' ? null : value } };
        if (it.k === 'text') {
          if (value.trim() === '') { MB.act([{ o: 'del', id: it.id }]); it = null; }
          else { op.h = r2(MB.textHeight({ w: it.w, d: Object.assign({}, it.d, { text: value }) })); }
        }
        if (it) { MB.act([op]); }
      } else if (it.k === 'text' && !(it.d.text || '').trim()) { MB.act([{ o: 'del', id: it.id }]); it = null; }
    }
    if (it && S.items.has(it.id)) { MB.drawItem(it.id); }
    scheduleOverlay();
  }

  // ---- the bar over the selection ---------------------------------------------------------------------------------------------------
  function allOf(items, fn) { return items.length > 0 && items.every(fn); }
  function isFilled(it) { return it.k === 'sticky' || MB.isShape(it.k) || it.k === 'frame'; }
  function isStroked(it) { return MB.isShape(it.k) || it.k === 'line' || it.k === 'pen'; }

  function button(icon, label, onClick, active) {
    var b = MB.html('button', 'mb-ctx__btn' + (active ? ' is-active' : ''));
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.setAttribute('data-tip', label);
    b.appendChild(MB.icon(icon));
    b.addEventListener('click', function (e) { e.stopPropagation(); onClick(b); });
    return b;
  }
  function textButton(text, label, onClick) {
    var b = MB.html('button', 'mb-ctx__btn mb-ctx__btn--text');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.setAttribute('data-tip', label);
    b.textContent = text;
    b.addEventListener('click', function (e) { e.stopPropagation(); onClick(b); });
    return b;
  }

  function patchSelection(build) {
    var ops = [];
    sel().forEach(function (it) { var op = build(it); if (op) { ops.push(Object.assign({ o: 'upd', id: it.id }, op)); } });
    MB.act(ops);
  }

  function swatches(colors, current, withNone, onPick) {
    var pop = MB.html('div', 'mb-pop mb-pop--swatches');
    colors.concat(withNone ? ['none'] : []).forEach(function (color) {
      var b = MB.html('button', 'mb-swatch' + (color === current ? ' is-active' : '') + (color === 'none' ? ' mb-swatch--none' : ''), pop);
      b.type = 'button';
      b.setAttribute('aria-label', color === 'none' ? t('Js.Board.None') : color);
      if (color !== 'none') { b.style.background = color; }
      b.addEventListener('click', function (e) { e.stopPropagation(); ctxPop = null; onPick(color); });
    });
    return pop;
  }

  function nextIn(list, value, dir) {
    var i = list.indexOf(value);
    if (i < 0) { i = list.reduce(function (best, v, idx) { return Math.abs(v - value) < Math.abs(list[best] - value) ? idx : best; }, 0); }
    return list[Math.max(0, Math.min(list.length - 1, i + dir))];
  }

  function cycle(list, value) { var i = list.indexOf(value); return list[(i + 1) % list.length]; }

  function renderCtx() {
    ctxBar.textContent = '';
    var items = sel();
    if (!items.length || !S.canEdit() || S.editing || (drag && (drag.type === 'move' || drag.type === 'resize' || drag.type === 'rotate' || drag.type === 'end'))) { ctxBar.hidden = true; return; }
    ctxBar.hidden = false;

    var first = items[0], pop = null;
    var group = function () { var g = MB.html('span', 'mb-ctx__group', ctxBar); return g; };
    if (allOf(items, function (i) { return i.k === 'comment'; })) { ctxBar.hidden = true; return; }
    if (items.some(MB.isLocked)) {
      group().appendChild(button('unlock', t('Js.Board.Unlock'), function () { setLock(false); }));
      placeCtx();
      return;
    }
    if (allOf(items, function (i) { return i.k === 'stamp'; })) {
      var gs = group();
      MB.STAMPS.slice(0, 6).forEach(function (e) {
        var sb2 = textButton(e, e, function () { patchSelection(function () { return { d: { e: e } }; }); });
        if (first.d.e === e) { sb2.classList.add('is-active'); }
        gs.appendChild(sb2);
      });
    }

    if (allOf(items, isFilled)) {
      var g1 = group(), swatchBtn = button('palette', t('Js.Board.Fill'), function () { ctxPop = ctxPop === 'fill' ? null : 'fill'; renderCtx(); }, ctxPop === 'fill');
      swatchBtn.classList.add('mb-ctx__color');
      var dot = MB.html('span', 'mb-ctx__dot', swatchBtn);
      dot.style.background = first.d.fill && first.d.fill !== 'none' ? first.d.fill : 'transparent';
      g1.appendChild(swatchBtn);
      if (ctxPop === 'fill') {
        var allowNone = allOf(items, function (i) { return MB.isShape(i.k); });
        pop = swatches(MB.PALETTE, first.d.fill, allowNone, function (c) { patchSelection(function () { return { d: { fill: c === 'none' ? 'none' : c } }; }); });
        g1.appendChild(pop);
      }
    }
    if (allOf(items, isStroked)) {
      var g2 = group(), sb = button('edit', t('Js.Board.Stroke'), function () { ctxPop = ctxPop === 'stroke' ? null : 'stroke'; renderCtx(); }, ctxPop === 'stroke');
      sb.classList.add('mb-ctx__color');
      var d2 = MB.html('span', 'mb-ctx__dot mb-ctx__dot--ring', sb);
      d2.style.borderColor = first.d.stroke && first.d.stroke !== 'none' ? first.d.stroke : '#1e1e1e';
      g2.appendChild(sb);
      if (ctxPop === 'stroke') {
        g2.appendChild(swatches(MB.INKS, first.d.stroke, allOf(items, function (i) { return MB.isShape(i.k); }), function (c) { patchSelection(function () { return { d: { stroke: c } }; }); }));
      }
      g2.appendChild(textButton((first.d.sw || (first.k === 'pen' ? 4 : first.k === 'line' ? 3 : 2)) + 'px', t('Js.Board.Width'), function () {
        patchSelection(function (it) { return { d: { sw: cycle(WIDTHS, it.d.sw || (it.k === 'pen' ? 4 : it.k === 'line' ? 3 : 2)) } }; });
      }));
    }
    if (allOf(items, function (i) { return i.k === 'text'; })) {
      var g3 = group(), tb = button('type', t('Js.Board.TextColor'), function () { ctxPop = ctxPop === 'ink' ? null : 'ink'; renderCtx(); }, ctxPop === 'ink');
      tb.classList.add('mb-ctx__color');
      var d3 = MB.html('span', 'mb-ctx__dot', tb);
      d3.style.background = first.d.color && first.d.color !== 'auto' ? first.d.color : S.ink;
      g3.appendChild(tb);
      if (ctxPop === 'ink') { g3.appendChild(swatches(MB.INKS, first.d.color, false, function (c) { patchSelection(function () { return { d: { color: c } }; }); })); }
    }
    if (allOf(items, function (i) { return MB.hasText(i.k); })) {
      var g4 = group();
      var current = first.d.fs || (first.k === 'sticky' ? 22 : first.k === 'text' ? 24 : 20);
      g4.appendChild(textButton('A−', t('Js.Board.Smaller'), function () { fontStep(-1); }));
      g4.appendChild(textButton(String(current), t('Js.Board.FontSize'), function () { /* a label */ }));
      g4.appendChild(textButton('A+', t('Js.Board.Larger'), function () { fontStep(1); }));
    }
    if (allOf(items, function (i) { return i.k === 'line'; })) {
      var g5 = group();
      g5.appendChild(textButton({ straight: t('Js.Board.Straight'), curve: t('Js.Board.Curve'), elbow: t('Js.Board.Elbow') }[first.d.st || 'straight'], t('Js.Board.LineStyle'), function () {
        patchSelection(function (it) { return { d: { st: cycle(['straight', 'curve', 'elbow'], it.d.st || 'straight') } }; });
      }));
      g5.appendChild(textButton({ end: '→', both: '↔', none: '—', start: '←' }[first.d.ah || 'end'], t('Js.Board.Arrow'), function () {
        patchSelection(function (it) { return { d: { ah: cycle(['end', 'both', 'none', 'start'], it.d.ah || 'end') } }; });
      }));
      g5.appendChild(button('minus', t('Js.Board.Dashed'), function () { patchSelection(function (it) { return { d: { dash: it.d.dash ? null : true } }; }); }, !!first.d.dash));
    }
    var g6 = group();
    if (!allOf(items, function (i) { return i.k === 'frame'; })) {
      g6.appendChild(button('bring-front', t('Js.Board.Front'), function () { order(true); }));
      g6.appendChild(button('send-back', t('Js.Board.Back'), function () { order(false); }));
    }
    g6.appendChild(button('copy', t('Js.Board.Duplicate'), duplicate));
    g6.appendChild(button('lock', t('Js.Board.Lock'), function () { setLock(true); }));
    var del = button('trash', t('Js.Board.Delete'), deleteSelection);
    del.classList.add('mb-ctx__btn--danger');
    g6.appendChild(del);

    placeCtx();
  }

  function placeCtx() {
    var items = sel();
    if (!items.length || ctxBar.hidden) { return; }
    var b = MB.bounds(items.map(function (i) { return i.id; })), tl = MB.toScreen(b.x, b.y), k = S.view.k;
    var r = MB.canvasRect(), w = ctxBar.offsetWidth || 240, h = ctxBar.offsetHeight || 44;
    var x = tl.x + (b.w * k) / 2 - w / 2, y = tl.y - h - 46;
    if (y < 60) { y = tl.y + b.h * k + 22; }
    x = Math.max(8, Math.min(r.width - w - 8, x));
    y = Math.max(60, Math.min(r.height - h - 70, y));
    ctxBar.style.left = x + 'px';
    ctxBar.style.top = y + 'px';
  }
  window.addEventListener('resize', function () { scheduleOverlay(); placeEditor(); });

  function setLock(on) {
    patchSelection(function (it) { return MB.isLocked(it) === on ? null : { d: { lock: on ? true : null } }; });
    scheduleOverlay();
  }

  function fontStep(dir) {
    patchSelection(function (it) {
      var now = it.d.fs || (it.k === 'sticky' ? 22 : it.k === 'text' ? 24 : 20), next = nextIn(TEXT_SIZES, now, dir);
      var op = { d: { fs: next } };
      if (it.k === 'text') { op.h = r2(MB.textHeight({ w: it.w, d: Object.assign({}, it.d, { fs: next }) })); }
      return op;
    });
  }

  function order(front) {
    var list = sel().filter(function (i) { return i.k !== 'frame'; }).sort(function (a, b) { return a.z - b.z; });
    if (!list.length) { return; }
    var ops;
    if (front) {
      var z = S.maxZ;
      ops = list.map(function (it) { z += 1; return { o: 'upd', id: it.id, z: z }; });
    } else {
      var all = Array.from(S.items.values());
      var floor = Math.max.apply(null, all.filter(function (i) { return i.k === 'frame'; }).map(function (i) { return i.z; }).concat([0])) + 1;
      var lowest = Math.min.apply(null, all.filter(function (i) { return i.k !== 'frame'; }).map(function (i) { return i.z; }));
      ops = list.map(function (it, i) { return { o: 'upd', id: it.id, z: Math.max(floor, lowest - list.length + i) }; });
    }
    MB.act(ops);
  }

  // ---- delete, duplicate, copy and paste -----------------------------------------------------------------------------------------
  function deleteSelection() {
    var items = sel().filter(function (i) { return !MB.isLocked(i); });
    if (!items.length || !S.canEdit()) { return; }
    var gone = new Set(items.map(function (i) { return i.id; })), ops = [];
    // a connector that stays loses its end: it stays where it was, loose
    S.items.forEach(function (line) {
      if (line.k !== 'line' || gone.has(line.id) || MB.isLocked(line)) { return; }
      var patch = {}, e = MB.lineEnds(line);
      if (line.d.a && line.d.a.id && gone.has(line.d.a.id)) { patch.a = { x: r2(e.a.x), y: r2(e.a.y) }; }
      if (line.d.b && line.d.b.id && gone.has(line.d.b.id)) { patch.b = { x: r2(e.b.x), y: r2(e.b.y) }; }
      if (Object.keys(patch).length) { ops.push({ o: 'upd', id: line.id, d: patch }); }
    });
    // a connector between two things that go goes too
    items.forEach(function (it) { ops.push({ o: 'del', id: it.id }); });
    S.items.forEach(function (line) {
      if (line.k === 'line' && !gone.has(line.id)) {
        var a = line.d.a && line.d.a.id && gone.has(line.d.a.id), b = line.d.b && line.d.b.id && gone.has(line.d.b.id);
        if (a && b) { ops.push({ o: 'del', id: line.id }); }
      }
    });
    MB.select([]);
    MB.act(ops);
  }

  /** Copies of items, shifted; connectors between copied things connect the copies, other ends are left loose where they are. */
  function copiesOf(items, dx, dy) {
    var ids = {};
    items.forEach(function (it) { ids[it.id] = MB.uid(); });
    return items.map(function (it) {
      var c = MB.clone({ id: it.id, k: it.k, x: it.x, y: it.y, w: it.w, h: it.h, r: it.r, z: it.z, d: it.d });
      c.id = ids[it.id];
      c.x = r2(c.x + dx); c.y = r2(c.y + dy);
      c.z = c.k === 'frame' ? --S.minZ : ++S.maxZ;
      if (c.k === 'line') {
        var e = MB.lineEnds(it);
        ['a', 'b'].forEach(function (end) {
          var was = it.d[end], at = e[end];
          c.d[end] = was && was.id && ids[was.id] ? { id: ids[was.id], x: r2(at.x + dx), y: r2(at.y + dy) } : { x: r2(at.x + dx), y: r2(at.y + dy) };
        });
      }
      return c;
    });
  }

  function duplicate() {
    var items = sel();
    if (!items.length || !S.canEdit()) { return; }
    var made = copiesOf(items, 24, 24);
    MB.act(made.map(function (i) { return { o: 'add', i: i }; }));
    MB.select(made.map(function (i) { return i.id; }));
  }

  var CLIP = 'mb.clip';
  document.addEventListener('copy', function (e) { copyOrCut(e, false); });
  document.addEventListener('cut', function (e) { copyOrCut(e, true); });
  function copyOrCut(e, cut) {
    if (isTyping(e.target) || S.editing) { return; }
    var items = sel();
    if (!items.length) { return; }
    e.preventDefault();
    var plain = items.map(function (i) { return i.d.text || i.d.title || ''; }).filter(Boolean).join('\n') || 'MatBoard';
    var data = { at: Date.now(), plain: plain, items: items.map(function (i) { return { id: i.id, k: i.k, x: i.x, y: i.y, w: i.w, h: i.h, r: i.r, z: i.z, d: i.d }; }) };
    try { localStorage.setItem(CLIP, JSON.stringify(data)); } catch (err) { toast(t('Js.Board.CopyFailed'), 'warning'); }
    if (e.clipboardData) { e.clipboardData.setData('text/plain', plain); }
    if (cut) { deleteSelection(); }
  }

  document.addEventListener('paste', function (e) {
    if (isTyping(e.target) || S.editing || !S.canEdit()) { return; }
    var cd = e.clipboardData;
    if (!cd) { return; }
    var files = Array.from(cd.files || []).filter(function (f) { return f.type.indexOf('image/') === 0; });
    if (files.length) { e.preventDefault(); files.forEach(function (f) { addImageFile(f, pastePoint()); }); return; }
    var text = cd.getData('text/plain'), clip = null;
    try { clip = JSON.parse(localStorage.getItem(CLIP) || 'null'); } catch (err) { clip = null; }
    e.preventDefault();
    if (clip && clip.items && clip.items.length && (clip.plain === text || !text)) {
      var items = clip.items.map(function (i) { return Object.assign({}, i); });
      var b = items.reduce(function (acc, i) { return { x0: Math.min(acc.x0, i.x), y0: Math.min(acc.y0, i.y), x1: Math.max(acc.x1, i.x + i.w), y1: Math.max(acc.y1, i.y + i.h) }; }, { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
      var at = pastePoint();
      // the former items need not exist any more: lines are rebuilt from their stored places
      var shell = items.map(function (i) { return { id: i.id, k: i.k, x: i.x, y: i.y, w: i.w, h: i.h, r: i.r, z: i.z, d: i.d }; });
      var made = copiesOfStored(shell, at.x - (b.x0 + b.x1) / 2, at.y - (b.y0 + b.y1) / 2);
      MB.act(made.map(function (i) { return { o: 'add', i: i }; }));
      MB.select(made.map(function (i) { return i.id; }));
    } else if (text && text.trim()) {
      var p = pastePoint(), short = text.length <= 280 && text.indexOf('\n') < 0 && !/^https?:\/\//.test(text.trim());
      var item = short || text.length <= 600 ? MB.newItem('sticky', { x: p.x - 100, y: p.y - 100, d: { text: text.trim() } }) : MB.newItem('text', { x: p.x - 130, y: p.y - 20, d: { text: text.trim().slice(0, 5000) } });
      if (item.k === 'text') { item.h = MB.textHeight(item); }
      MB.act([{ o: 'add', i: item }]);
      MB.select([item.id]);
    }
  });

  function pastePoint() {
    var r = MB.canvasRect(), s = MB.toScreen(lastWorld.x, lastWorld.y);
    return pointerSeen && s.x > 0 && s.x < r.width && s.y > 0 && s.y < r.height ? lastWorld : MB.centerOnWorld();
  }

  /** Like copiesOf, for items that are not on the board (the clipboard): the ends of a connector come from their stored places. */
  function copiesOfStored(items, dx, dy) {
    var ids = {};
    items.forEach(function (it) { ids[it.id] = MB.uid(); });
    return items.map(function (it) {
      var c = MB.clone(it);
      c.id = ids[it.id];
      c.x = r2(c.x + dx); c.y = r2(c.y + dy);
      c.z = c.k === 'frame' ? --S.minZ : ++S.maxZ;
      if (c.k === 'line') {
        ['a', 'b'].forEach(function (end) {
          var was = it.d[end] || { x: it.x, y: it.y };
          c.d[end] = was.id && ids[was.id] ? { id: ids[was.id], x: r2(was.x + dx), y: r2(was.y + dy) } : { x: r2((was.x || 0) + dx), y: r2((was.y || 0) + dy) };
        });
      }
      return c;
    });
  }

  // ---- images (the picker, paste and drop): scaled down in the browser, kept in the item as a data address ---------------------------
  function addImageFile(file, at) {
    if (!S.canEdit() || !file || file.type.indexOf('image/') !== 0) { return; }
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var max = 1600, scale = Math.min(1, max / Math.max(img.width, img.height)), w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
        var src = '';
        for (var attempt = 0; attempt < 4; attempt++) {
          var c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          src = file.type === 'image/png' && attempt === 0 ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85 - attempt * 0.1);
          if (src.length < 2400000) { break; }
          w = Math.round(w * 0.7); h = Math.round(h * 0.7);
        }
        if (src.length >= 2900000) { toast(t('Js.Board.ImageTooBig'), 'warning'); return; }
        var show = Math.min(1, 480 / Math.max(w, h)), iw = Math.round(w * show), ih = Math.round(h * show);
        var item = MB.newItem('image', { x: r2(at.x - iw / 2), y: r2(at.y - ih / 2), w: iw, h: ih, d: { src: src } });
        MB.act([{ o: 'add', i: item }]);
        MB.select([item.id]);
      };
      img.onerror = function () { toast(t('Js.Board.ImageFailed'), 'warning'); };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  canvas.addEventListener('dragover', function (e) { if (S.canEdit() && e.dataTransfer && Array.from(e.dataTransfer.types).indexOf('Files') >= 0) { e.preventDefault(); } });
  canvas.addEventListener('drop', function (e) {
    if (!S.canEdit() || !e.dataTransfer || !e.dataTransfer.files.length) { return; }
    e.preventDefault();
    var p = worldOf(e);
    Array.from(e.dataTransfer.files).forEach(function (f, i) { addImageFile(f, { x: p.x + i * 30, y: p.y + i * 30 }); });
  });

  // ---- export --------------------------------------------------------------------------------------------------------------------------
  function fileName(ext) {
    var name = (S.root.getAttribute('data-name') || 'board').replace(/[^\w\-. ]+/g, '').trim().replace(/\s+/g, '-') || 'board';
    return name + '-' + new Date().toISOString().slice(0, 10) + '.' + ext;
  }
  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function buildSvg() {
    var b = MB.bounds();
    if (!b) { return null; }
    var pad = 40, x = b.x - pad, y = b.y - pad, w = Math.ceil(b.w + pad * 2), h = Math.ceil(b.h + pad * 2);
    var svg = MB.el('svg', { xmlns: 'http://www.w3.org/2000/svg', width: w, height: h, viewBox: [x, y, w, h].join(' ') });
    MB.el('rect', { x: x, y: y, width: w, height: h, fill: getComputedStyle(canvas).backgroundColor || '#ffffff' }, svg);
    var g = MB.el('g', {}, svg);
    Array.from(S.world.children).forEach(function (n) { if (n.getAttribute('data-kind') !== 'comment') { g.appendChild(n.cloneNode(true)); } });
    return { svg: svg, w: w, h: h };
  }
  function exportAs(kind) {
    if (kind === 'json') {
      var data = { app: 'MatBoard', board: S.root.getAttribute('data-name'), exportedAt: new Date().toISOString(), items: Array.from(S.items.values()).map(function (i) { return { id: i.id, k: i.k, x: i.x, y: i.y, w: i.w, h: i.h, r: i.r, z: i.z, d: i.d }; }) };
      download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), fileName('json'));
      return;
    }
    var built = buildSvg();
    if (!built) { toast(t('Js.Board.ExportEmpty'), 'info'); return; }
    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(built.svg);
    if (kind === 'svg') { download(new Blob([xml], { type: 'image/svg+xml' }), fileName('svg')); return; }
    var scale = Math.min(2, 8000 / Math.max(built.w, built.h)), img = new Image();
    img.onload = function () {
      var c = document.createElement('canvas');
      c.width = Math.round(built.w * scale); c.height = Math.round(built.h * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(function (blob) { if (blob) { download(blob, fileName('png')); } else { toast(t('Js.Board.ExportFailed'), 'warning'); } }, 'image/png');
    };
    img.onerror = function () { toast(t('Js.Board.ExportFailed'), 'warning'); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  }
  Array.from(document.querySelectorAll('[data-export]')).forEach(function (b) { b.addEventListener('click', function () { exportAs(b.getAttribute('data-export')); }); });

  // ---- keys ------------------------------------------------------------------------------------------------------------------------------
  function closePops() { shapesPop.hidden = true; shapesBtn.setAttribute('aria-expanded', 'false'); stampPop.hidden = true; stampBtn.setAttribute('aria-expanded', 'false'); if (ctxPop) { ctxPop = null; renderCtx(); } }
  document.addEventListener('pointerdown', function (e) {
    if ((!shapesPop.hidden || !stampPop.hidden) && !e.target.closest('.mb-tools__shapes')) { closePops(); }
  });

  var TOOL_KEYS = { v: 'select', h: 'hand', n: 'sticky', t: 'text', r: 'rect', o: 'ellipse', d: 'diamond', g: 'triangle', l: 'line', p: 'pen', f: 'frame', c: 'comment', s: 'stamp' };

  document.addEventListener('keydown', function (e) {
    if (isTyping(e.target) || document.querySelector('dialog[open]')) { return; }
    var key = e.key, mod = e.ctrlKey || e.metaKey;
    if (key === ' ' && !spaceDown) { spaceDown = true; canvas.classList.add('is-hand'); if (e.target === canvas || e.target === document.body) { e.preventDefault(); } return; }
    if (mod) {
      var lower = key.toLowerCase();
      if (lower === 'z') { e.preventDefault(); if (e.shiftKey) { MB.redo(); } else { MB.undo(); } }
      else if (lower === 'y') { e.preventDefault(); MB.redo(); }
      else if (lower === 'd') { e.preventDefault(); duplicate(); }
      else if (lower === 'a') { e.preventDefault(); MB.select(Array.from(S.items.keys())); }
      else if (lower === 'l' && e.shiftKey && S.sel.size && S.canEdit()) { e.preventDefault(); setLock(!sel().every(MB.isLocked)); }
      return;
    }
    if (e.altKey) { return; }
    if (key === 'Escape') { if (tool !== 'select') { setTool('select'); } else { MB.select([]); } closePops(); return; }
    if (key === 'Delete' || key === 'Backspace') { if (S.sel.size) { e.preventDefault(); deleteSelection(); } return; }
    if (key === 'Enter' || key === 'F2') {
      var one = sel();
      if (one.length === 1 && S.canEdit()) { e.preventDefault(); if (MB.hasText(one[0].k)) { startEdit(one[0].id, 'text'); } else if (one[0].k === 'frame') { startEdit(one[0].id, 'title'); } }
      return;
    }
    if (key.indexOf('Arrow') === 0 && S.sel.size && S.canEdit()) {
      e.preventDefault();
      var step = e.shiftKey ? 10 : 1, dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0, dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
      var ops = [];
      sel().filter(function (i) { return !MB.isLocked(i); }).forEach(function (it) {
        if (it.k === 'line') {
          var ends = MB.lineEnds(it), patch = {};
          ['a', 'b'].forEach(function (end) { if (!(it.d[end] && it.d[end].id)) { patch[end] = { x: r2(ends[end].x + dx), y: r2(ends[end].y + dy) }; } });
          if (Object.keys(patch).length) { ops.push({ o: 'upd', id: it.id, d: patch }); }
        } else { ops.push({ o: 'upd', id: it.id, x: r2(it.x + dx), y: r2(it.y + dy) }); }
      });
      MB.act(ops);
      return;
    }
    if (key === '+' || key === '=') { MB.zoomCenter(1.25); return; }
    if (key === '-' || key === '_') { MB.zoomCenter(0.8); return; }
    if (key === '0') { MB.fit(); return; }
    if (key === '1') { MB.zoomTo(1); return; }
    if (key === ']') { order(true); return; }
    if (key === '[') { order(false); return; }
    var name = TOOL_KEYS[key.toLowerCase()];
    if (name) { setTool(name); return; }
    if (key.toLowerCase() === 'i' && S.canEdit()) { fileInput.click(); }
  });
  document.addEventListener('keyup', function (e) { if (e.key === ' ') { spaceDown = false; canvas.classList.remove('is-hand'); } });
  window.addEventListener('blur', function () { spaceDown = false; canvas.classList.remove('is-hand'); });

  // ---- for board-extras.js (panels: templates, comments, frames, search, minimap, follow) ----
  MB.ui = { setTool: setTool, startEdit: startEdit, endEdit: endEdit, toast: toast, selected: sel, isTyping: isTyping, closePops: closePops };

  // ---- the first look -----------------------------------------------------------------------------------------------------------------
  zoomValue.textContent = '100%';
  setTool('select');
  applyRole();
  MB.net.boot();
})();
