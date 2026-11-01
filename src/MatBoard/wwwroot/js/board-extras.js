/* MatBoard – the canvas, part 4: what makes a whiteboard a workshop. The side panel (templates, comments, frames, search), presenting frame by frame,
   the minimap, following somebody and bringing everybody to one place. Everything here works through MB (core), MB.net and MB.ui; changes go through MB.act. */
(function () {
  'use strict';

  var MB = window.MB;
  if (!MB || !MB.S || !MB.ui) { return; }
  var S = MB.S, t = MB.t, ui = MB.ui;
  var root = S.root;

  function r2(n) { return Math.round(n * 100) / 100; }
  function byId(id) { return document.getElementById(id); }
  function me() {
    if (S.guest) { try { return localStorage.getItem('mb.guest') || t('Js.Board.Guest'); } catch (e) { return t('Js.Board.Guest'); } }
    return root.getAttribute('data-person') || '';
  }
  function itemText(it) { return String(it.d.text || it.d.title || (it.k === 'comment' ? (it.d.msgs || []).map(function (m) { return m.t; }).join(' ') : '') || ''); }

  /** Shows a rectangle of the board as large as fits (the view of somebody else, a frame). */
  function showRect(rect, padding) {
    var r = MB.canvasRect(), pad = padding === undefined ? 40 : padding;
    var k = Math.max(0.05, Math.min(4, (r.width - pad * 2) / Math.max(1, rect.w), (r.height - pad * 2) / Math.max(1, rect.h)));
    MB.setView({ x: r.width / 2 - (rect.x + rect.w / 2) * k, y: r.height / 2 - (rect.y + rect.h / 2) * k, k: k });
  }
  function visibleRect() {
    var r = MB.canvasRect(), a = MB.toWorld(r.left, r.top), b = MB.toWorld(r.right, r.bottom);
    return { x: r2(a.x), y: r2(a.y), w: r2(b.x - a.x), h: r2(b.y - a.y) };
  }

  // ---- the side panel: one content at a time -----------------------------------------------------------------------------------
  var panel = byId('mb-panel'), panelTitle = byId('mb-panel-title'), panelBody = byId('mb-panel-body'), panelKind = null, panelRefresh = null;

  function openPanel(kind, title, render) {
    panelKind = kind;
    panelTitle.textContent = title;
    panelRefresh = render;
    panel.hidden = false;
    root.classList.add('mb-has-panel');
    render();
  }
  function closePanel() {
    panel.hidden = true;
    panelKind = null;
    panelRefresh = null;
    root.classList.remove('mb-has-panel');
    panelBody.textContent = '';
  }
  byId('mb-panel-close').addEventListener('click', closePanel);
  function toggle(kind, open) { if (panelKind === kind) { closePanel(); } else { open(); } }

  function emptyNote(text) { var p = MB.html('p', 'mb-panel__empty', panelBody); p.textContent = text; }
  function listButton(parent, title, meta, onClick, swatch) {
    var b = MB.html('button', 'mb-list__item', parent);
    b.type = 'button';
    if (swatch) { var dot = MB.html('span', 'mb-list__swatch', b); dot.style.background = swatch; }
    var body = MB.html('span', 'mb-list__body', b);
    MB.html('span', 'mb-list__title', body).textContent = title;
    if (meta) { MB.html('span', 'mb-list__meta', body).textContent = meta; }
    b.addEventListener('click', onClick);
    return b;
  }

  // ---- templates ---------------------------------------------------------------------------------------------------------------------
  var GREEN = '#b2f2bb', RED = '#ffadad', BLUE = '#a5d8ff', YELLOW = '#fff2a8', ORANGE = '#ffd6a5', VIOLET = '#d0bfff';

  function frame(x, y, w, h, title, fill) { return MB.newItem('frame', { x: x, y: y, w: w, h: h, d: { title: title, fill: fill || null } }); }
  function note(x, y, text, fill, size) { return MB.newItem('sticky', { x: x, y: y, w: size || 180, h: size || 180, d: { text: text, fill: fill || YELLOW, fs: 20 } }); }
  function shape(kind, x, y, w, h, text, fill) { return MB.newItem(kind, { x: x, y: y, w: w, h: h, d: { text: text, fill: fill || '#ffffff' } }); }
  function title(x, y, w, text) { var it = MB.newItem('text', { x: x, y: y, w: w, d: { text: text, fs: 40, align: 'left' } }); it.h = MB.textHeight(it); return it; }
  function connect(a, b, style) {
    var ca = MB.center(a), cb = MB.center(b);
    return MB.newItem('line', { x: Math.min(ca.x, cb.x), y: Math.min(ca.y, cb.y), d: { a: { id: a.id, x: ca.x, y: ca.y }, b: { id: b.id, x: cb.x, y: cb.y }, st: style || 'straight' } });
  }
  function clean(items) { items.forEach(function (it) { Object.keys(it.d).forEach(function (k) { if (it.d[k] === null) { delete it.d[k]; } }); }); return items; }

  var TEMPLATES = [
    {
      key: 'kanban', icon: 'layout',
      build: function () {
        var cols = [t('Js.Tpl.Kanban.Todo'), t('Js.Tpl.Kanban.Doing'), t('Js.Tpl.Kanban.Done')], fills = [YELLOW, ORANGE, GREEN], out = [title(0, -110, 900, t('Js.Tpl.Kanban'))];
        cols.forEach(function (name, i) {
          out.push(frame(i * 440, 0, 400, 760, name));
          out.push(note(i * 440 + 30, 40, t('Js.Tpl.Kanban.Task'), fills[i], 160));
          out.push(note(i * 440 + 210, 40, t('Js.Tpl.Kanban.Task'), fills[i], 160));
        });
        return out;
      },
    },
    {
      key: 'retro', icon: 'refresh',
      build: function () {
        var cols = [[t('Js.Tpl.Retro.Good'), GREEN], [t('Js.Tpl.Retro.Better'), RED], [t('Js.Tpl.Retro.Actions'), BLUE]], out = [title(0, -110, 900, t('Js.Tpl.Retro'))];
        cols.forEach(function (c, i) {
          out.push(frame(i * 440, 0, 400, 640, c[0]));
          out.push(note(i * 440 + 30, 40, t('Js.Tpl.Retro.Idea'), c[1], 160));
        });
        return out;
      },
    },
    {
      key: 'mindmap', icon: 'network',
      build: function () {
        var centre = shape('ellipse', 0, 0, 300, 170, t('Js.Tpl.Mindmap.Topic'), '#ffc21f'), out = [centre];
        var fills = [YELLOW, ORANGE, RED, VIOLET, BLUE, GREEN];
        for (var i = 0; i < 6; i++) {
          var a = (i / 6) * Math.PI * 2 - Math.PI / 2, x = 150 + Math.cos(a) * 470 - 90, y = 85 + Math.sin(a) * 330 - 90;
          var idea = note(r2(x), r2(y), t('Js.Tpl.Mindmap.Idea', i + 1), fills[i]);
          out.push(idea, connect(centre, idea, 'curve'));
        }
        out.forEach(function (it) { if (it.k === 'line') { it.d.ah = 'none'; } });
        return out;
      },
    },
    {
      key: 'swot', icon: 'grid',
      build: function () {
        var cells = [[t('Js.Tpl.Swot.S'), GREEN], [t('Js.Tpl.Swot.W'), RED], [t('Js.Tpl.Swot.O'), BLUE], [t('Js.Tpl.Swot.T'), ORANGE]], out = [title(0, -110, 900, t('Js.Tpl.Swot'))];
        cells.forEach(function (c, i) {
          var x = (i % 2) * 560, y = Math.floor(i / 2) * 460;
          out.push(frame(x, y, 520, 420, c[0], c[1]));
          out.push(note(x + 30, y + 40, '', YELLOW, 150));
        });
        return out;
      },
    },
    {
      key: 'week', icon: 'calendar',
      build: function () {
        var out = [title(0, -110, 900, t('Js.Tpl.Week'))];
        [t('Js.Tpl.Week.Day1'), t('Js.Tpl.Week.Day2'), t('Js.Tpl.Week.Day3'), t('Js.Tpl.Week.Day4'), t('Js.Tpl.Week.Day5')].forEach(function (day, i) {
          out.push(frame(i * 300, 0, 280, 640, day));
          out.push(note(i * 300 + 40, 40, '', YELLOW, 200));
        });
        return out;
      },
    },
    {
      key: 'flow', icon: 'route',
      build: function () {
        var start = shape('ellipse', 0, 0, 220, 110, t('Js.Tpl.Flow.Start'), GREEN);
        var step = shape('rect', 0, 210, 220, 120, t('Js.Tpl.Flow.Step'));
        var ask = shape('diamond', -10, 430, 240, 170, t('Js.Tpl.Flow.Question'), YELLOW);
        var yes = shape('rect', 360, 455, 220, 120, t('Js.Tpl.Flow.Step'));
        var end = shape('ellipse', 0, 700, 220, 110, t('Js.Tpl.Flow.End'), RED);
        var out = [start, step, ask, yes, end, connect(start, step), connect(step, ask), connect(ask, end), connect(ask, yes)];
        var l1 = MB.newItem('text', { x: 250, y: 470, w: 80, d: { text: t('Js.Tpl.Flow.Yes'), fs: 18 } }), l2 = MB.newItem('text', { x: 125, y: 620, w: 80, d: { text: t('Js.Tpl.Flow.No'), fs: 18 } });
        l1.h = MB.textHeight(l1); l2.h = MB.textHeight(l2);
        return out.concat([l1, l2]);
      },
    },
    {
      key: 'journey', icon: 'user',
      build: function () {
        var phases = [t('Js.Tpl.Journey.Phase1'), t('Js.Tpl.Journey.Phase2'), t('Js.Tpl.Journey.Phase3'), t('Js.Tpl.Journey.Phase4'), t('Js.Tpl.Journey.Phase5')], rows = [t('Js.Tpl.Journey.Does'), t('Js.Tpl.Journey.Thinks'), t('Js.Tpl.Journey.Feels'), t('Js.Tpl.Journey.Chances')];
        var out = [title(0, -110, 1200, t('Js.Tpl.Journey'))];
        phases.forEach(function (p, i) { out.push(shape('rect', 220 + i * 240, 0, 220, 70, p, '#ffc21f')); });
        rows.forEach(function (r, j) {
          var row = MB.newItem('text', { x: 0, y: 110 + j * 220 + 70, w: 200, d: { text: r, fs: 22 } });
          row.h = MB.textHeight(row);
          out.push(row);
          phases.forEach(function (p, i) { out.push(note(220 + i * 240 + 20, 110 + j * 220, '', [BLUE, VIOLET, ORANGE, GREEN][j], 180)); });
        });
        return out;
      },
    },
  ];

  function insertTemplate(tpl) {
    var items = clean(tpl.build());
    // frames go behind, the rest in front, all centred where the person looks
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    items.forEach(function (it) { if (it.k === 'line') { return; } x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y); x1 = Math.max(x1, it.x + it.w); y1 = Math.max(y1, it.y + it.h); });
    var c = MB.centerOnWorld(), dx = r2(c.x - (x0 + x1) / 2), dy = r2(c.y - (y0 + y1) / 2);
    // where the person looks is taken already: the template goes to the right of everything on the board
    var target = { x: x0 + dx, y: y0 + dy, w: x1 - x0, h: y1 - y0 }, taken = false;
    S.items.forEach(function (it) {
      var b = MB.aabb(it);
      if (b.x < target.x + target.w && b.x + b.w > target.x && b.y < target.y + target.h && b.y + b.h > target.y) { taken = true; }
    });
    var all = taken ? MB.bounds() : null;
    if (all) { dx = r2(all.x + all.w + 200 - x0); dy = r2(all.y - y0); }
    items.forEach(function (it) {
      it.x = r2(it.x + dx); it.y = r2(it.y + dy);
      if (it.k === 'line') { ['a', 'b'].forEach(function (end) { it.d[end].x = r2(it.d[end].x + dx); it.d[end].y = r2(it.d[end].y + dy); }); }
    });
    MB.act(items.map(function (it) { return { o: 'add', i: it }; }));
    var ids = items.map(function (it) { return it.id; });
    MB.fit(ids);
    MB.select(ids);
    closePanel();
    ui.toast(t('Js.Tpl.Added', t('Js.Tpl.' + tpl.key.charAt(0).toUpperCase() + tpl.key.slice(1))), 'success');
  }

  function renderTemplates() {
    panelBody.textContent = '';
    MB.html('p', 'mb-panel__intro', panelBody).textContent = t('Js.Tpl.Intro');
    var grid = MB.html('div', 'mb-tpl', panelBody);
    TEMPLATES.forEach(function (tpl) {
      var name = 'Js.Tpl.' + tpl.key.charAt(0).toUpperCase() + tpl.key.slice(1);
      var b = MB.html('button', 'mb-tpl__item', grid);
      b.type = 'button';
      b.appendChild(MB.icon(tpl.icon));
      MB.html('span', 'mb-tpl__name', b).textContent = t(name);
      MB.html('span', 'mb-tpl__text', b).textContent = t(name + '.Text');
      b.addEventListener('click', function () { insertTemplate(tpl); });
    });
  }
  byId('mb-templates-btn').addEventListener('click', function () { ui.closePops(); toggle('templates', function () { openPanel('templates', t('Js.Tpl.Title'), renderTemplates); }); });

  // ---- comments: a pin on the board with a thread ------------------------------------------------------------------------------------
  var thread = null; // { id } of an existing comment, or { at: {x, y} } for a new one

  function when(iso) {
    if (!iso) { return ''; }
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return ''; }
    var zone = root.getAttribute('data-zone') || undefined;
    try { return d.toLocaleString(document.documentElement.lang || undefined, { dateStyle: 'short', timeStyle: 'short', timeZone: zone }); } catch (e) { return d.toLocaleString(); }
  }

  function renderThread() {
    panelBody.textContent = '';
    var it = thread && thread.id ? S.items.get(thread.id) : null;
    if (thread && thread.id && !it) { closePanel(); return; }
    var msgs = it ? it.d.msgs || [] : [];
    var list = MB.html('div', 'mb-thread', panelBody);
    msgs.forEach(function (m, i) {
      var row = MB.html('div', 'mb-thread__msg', list);
      var head = MB.html('div', 'mb-thread__head', row);
      MB.html('strong', null, head).textContent = m.a || t('Js.Board.Guest');
      MB.html('span', 'mb-thread__when', head).textContent = when(m.at);
      MB.html('p', 'mb-thread__text', row).textContent = m.t;
      if (i === 0 && it && it.d.done) { MB.html('span', 'mb-thread__done', row).textContent = t('Js.Comment.Resolved'); }
    });
    if (!S.canEdit()) { if (!msgs.length) { emptyNote(t('Js.Comment.ViewOnly')); } return; }

    var form = MB.html('form', 'mb-thread__form', panelBody);
    var box = MB.html('textarea', 'mat-input mb-thread__input', form);
    box.rows = 3;
    box.maxLength = 2000;
    box.placeholder = t(it ? 'Js.Comment.Reply' : 'Js.Comment.Write');
    box.setAttribute('aria-label', box.placeholder);
    var row2 = MB.html('div', 'mb-thread__actions', form);
    var send = MB.html('button', 'mat-btn mat-btn--primary mat-btn--sm', row2);
    send.type = 'submit';
    send.appendChild(MB.icon('check'));
    MB.html('span', null, send).textContent = t(it ? 'Js.Comment.Send' : 'Js.Comment.Add');
    if (it) {
      var done = MB.html('button', 'mat-btn mat-btn--sm', row2);
      done.type = 'button';
      done.appendChild(MB.icon(it.d.done ? 'refresh' : 'check-circle'));
      MB.html('span', null, done).textContent = t(it.d.done ? 'Js.Comment.Reopen' : 'Js.Comment.Resolve');
      done.addEventListener('click', function () { MB.act([{ o: 'upd', id: it.id, d: { done: it.d.done ? null : true } }]); });
      MB.html('span', 'mb-thread__space', row2);
      var del = MB.html('button', 'mat-btn mat-btn--danger mat-btn--sm mat-btn--icon', row2);
      del.type = 'button';
      del.setAttribute('aria-label', t('Js.Board.Delete'));
      del.setAttribute('data-tip', t('Js.Board.Delete'));
      del.appendChild(MB.icon('trash'));
      del.addEventListener('click', function () { MB.select([]); MB.act([{ o: 'del', id: it.id }]); closePanel(); });
    }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = box.value.trim();
      if (!text) { box.focus(); return; }
      var message = { a: me().slice(0, 60), t: text.slice(0, 2000), at: new Date().toISOString() };
      var current = thread.id ? S.items.get(thread.id) : null;
      if (current) {
        MB.act([{ o: 'upd', id: current.id, d: { msgs: (current.d.msgs || []).concat([message]).slice(-200), done: null } }]);
      } else {
        var pin = MB.newItem('comment', { x: r2(thread.at.x), y: r2(thread.at.y - 36), d: { msgs: [message] } });
        MB.act([{ o: 'add', i: pin }]);
        thread = { id: pin.id };
        MB.select([pin.id]);
      }
      renderThread();
    });
    box.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); } if (e.key === 'Escape') { closePanel(); } });
    setTimeout(function () { box.focus(); }, 30);
  }

  function openThread(spec) { thread = spec; openPanel('thread', t('Js.Comment.Title'), renderThread); }
  MB.on('comment:new', function (p) { openThread({ at: p }); });
  MB.on('selection', function () {
    var one = S.sel.size === 1 ? S.items.get(Array.from(S.sel)[0]) : null;
    if (one && one.k === 'comment' && !(panelKind === 'thread' && thread && thread.id === one.id)) { openThread({ id: one.id }); }
  });

  function renderComments() {
    panelBody.textContent = '';
    var pins = Array.from(S.items.values()).filter(function (it) { return it.k === 'comment'; });
    if (!pins.length) { emptyNote(t(S.canEdit() ? 'Js.Comment.None' : 'Js.Comment.NoneView')); return; }
    pins.sort(function (a, b) { return (a.d.done ? 1 : 0) - (b.d.done ? 1 : 0) || a.y - b.y || a.x - b.x; });
    var list = MB.html('div', 'mb-list', panelBody);
    pins.forEach(function (pin) {
      var msgs = pin.d.msgs || [], first = msgs[0] || { a: '', t: '' };
      var meta = (first.a || '') + ' · ' + t('Js.Comment.Count', msgs.length) + (pin.d.done ? ' · ' + t('Js.Comment.Resolved') : '');
      var b = listButton(list, first.t, meta, function () { MB.fit([pin.id]); MB.zoomTo(Math.min(1, S.view.k)); MB.select([pin.id]); }, pin.d.done ? '#adb5bd' : '#ffc21f');
      if (pin.d.done) { b.classList.add('is-done'); }
    });
  }
  byId('mb-comments-btn').addEventListener('click', function () { toggle('comments', function () { openPanel('comments', t('Js.Comment.All'), renderComments); }); });

  // the panel follows what happens on the board (somebody answers, a frame is renamed ...)
  var refreshFrame = 0;
  MB.on('items', function () {
    if (!panelRefresh || panelKind === 'templates' || panelKind === 'search') { return; }
    if (panelKind === 'thread' && document.activeElement && document.activeElement.classList.contains('mb-thread__input') && document.activeElement.value) { return; }
    if (refreshFrame) { return; }
    refreshFrame = requestAnimationFrame(function () { refreshFrame = 0; if (panelRefresh) { panelRefresh(); } });
  });

  // ---- frames: a list, and presenting them one after the other -------------------------------------------------------------------------
  function frames() {
    return Array.from(S.items.values()).filter(function (it) { return it.k === 'frame'; })
      .sort(function (a, b) { return Math.abs(a.y - b.y) > 120 ? a.y - b.y : a.x - b.x; });
  }

  function renderFrames() {
    panelBody.textContent = '';
    var list = frames();
    if (!list.length) { emptyNote(t('Js.Frames.None')); return; }
    var start = MB.html('button', 'mat-btn mat-btn--primary mb-panel__wide', panelBody);
    start.type = 'button';
    start.appendChild(MB.icon('present'));
    MB.html('span', null, start).textContent = t('Js.Frames.Present');
    start.addEventListener('click', function () { present(0); });
    var ul = MB.html('div', 'mb-list', panelBody);
    list.forEach(function (f, i) {
      listButton(ul, (i + 1) + '. ' + (f.d.title || t('Js.Board.Frame')), null, function () { showRect(f, 60); MB.select([f.id]); }, f.d.fill || null);
    });
  }
  byId('mb-frames-btn').addEventListener('click', function () { toggle('frames', function () { openPanel('frames', t('Js.Frames.Title'), renderFrames); }); });

  var show = null, presentBar = byId('mb-present'), presentCount = byId('mb-present-count');
  function present(index) {
    var list = frames();
    if (!list.length) { return; }
    closePanel();
    MB.select([]);
    ui.setTool('select');
    show = { index: Math.max(0, Math.min(list.length - 1, index)) };
    root.classList.add('mb-presenting');
    presentBar.hidden = false;
    var f = list[show.index];
    showRect(f, 24);
    presentCount.textContent = (show.index + 1) + ' / ' + list.length + ' · ' + (f.d.title || t('Js.Board.Frame'));
    if (document.documentElement.requestFullscreen && !document.fullscreenElement && show.index === index && index === 0) { document.documentElement.requestFullscreen().catch(function () { /* not allowed: the window will do */ }); }
  }
  function endPresent() {
    if (!show) { return; }
    show = null;
    root.classList.remove('mb-presenting');
    presentBar.hidden = true;
    if (document.fullscreenElement && document.exitFullscreen) { document.exitFullscreen().catch(function () { /* left already */ }); }
  }
  byId('mb-present-prev').addEventListener('click', function () { if (show) { present(show.index - 1); } });
  byId('mb-present-next').addEventListener('click', function () { if (show) { present(show.index + 1); } });
  byId('mb-present-exit').addEventListener('click', endPresent);
  document.addEventListener('fullscreenchange', function () { if (!document.fullscreenElement && show) { endPresent(); } });

  // ---- search ----------------------------------------------------------------------------------------------------------------------------
  var searchQuery = '', hits = [], hitIndex = -1;
  function renderSearch() {
    panelBody.textContent = '';
    var input = MB.html('input', 'mat-input mb-search__input', panelBody);
    input.type = 'search';
    input.placeholder = t('Js.Search.Placeholder');
    input.setAttribute('aria-label', input.placeholder);
    input.value = searchQuery;
    var list = MB.html('div', 'mb-list', panelBody);
    function run() {
      searchQuery = input.value;
      var q = searchQuery.trim().toLowerCase();
      list.textContent = '';
      hits = q ? Array.from(S.items.values()).filter(function (it) { return itemText(it).toLowerCase().indexOf(q) >= 0; }) : [];
      hits.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
      hitIndex = -1;
      if (q && !hits.length) { MB.html('p', 'mb-panel__empty', list).textContent = t('Js.Search.None'); return; }
      if (hits.length) { MB.html('p', 'mb-panel__intro', list).textContent = t('Js.Search.Count', hits.length); }
      hits.slice(0, 100).forEach(function (it, i) {
        var text = itemText(it).replace(/\s+/g, ' ');
        listButton(list, text.length > 90 ? text.slice(0, 88) + '…' : text, t('Js.Kind.' + it.k), function () { goTo(i); }, it.d.fill && it.d.fill !== 'none' ? it.d.fill : null);
      });
    }
    input.addEventListener('input', run);
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); if (hits.length) { goTo((hitIndex + (e.shiftKey ? -1 + hits.length : 1)) % hits.length); } }
      if (e.key === 'Escape') { closePanel(); }
    });
    run();
    setTimeout(function () { input.focus(); input.select(); }, 30);
  }
  function goTo(i) {
    var it = hits[i];
    if (!it || !S.items.has(it.id)) { return; }
    hitIndex = i;
    var box = MB.aabb(it);
    showRect({ x: box.x - box.w, y: box.y - box.h, w: box.w * 3, h: box.h * 3 }, 40);
    MB.select([it.id]);
  }
  function openSearch() { if (panelKind !== 'search') { openPanel('search', t('Js.Search.Title'), renderSearch); } else { var input = panelBody.querySelector('input'); if (input) { input.focus(); input.select(); } } }
  byId('mb-search-btn').addEventListener('click', function () { if (panelKind === 'search') { closePanel(); } else { openSearch(); } });

  // ---- the minimap ----------------------------------------------------------------------------------------------------------------------
  var map = byId('mb-minimap'), mapBtn = byId('mb-minimap-btn'), mapCtx = map.getContext('2d'), mapFrame = 0, mapOn = false, mapScale = null;
  try { mapOn = localStorage.getItem('mb.minimap') === '1'; } catch (e) { mapOn = false; }

  function setMap(on) {
    mapOn = on;
    map.hidden = !on;
    mapBtn.classList.toggle('is-active', on);
    mapBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    try { localStorage.setItem('mb.minimap', on ? '1' : '0'); } catch (e) { /* private mode */ }
    scheduleMap();
  }
  function scheduleMap() { if (mapOn && !mapFrame) { mapFrame = requestAnimationFrame(function () { mapFrame = 0; drawMap(); }); } }

  function drawMap() {
    var dpr = window.devicePixelRatio || 1, cw = map.clientWidth || 220, ch = map.clientHeight || 150;
    if (map.width !== Math.round(cw * dpr)) { map.width = Math.round(cw * dpr); map.height = Math.round(ch * dpr); }
    var c = mapCtx, view = visibleRect(), b = MB.bounds() || view;
    var x0 = Math.min(b.x, view.x), y0 = Math.min(b.y, view.y), x1 = Math.max(b.x + b.w, view.x + view.w), y1 = Math.max(b.y + b.h, view.y + view.h);
    var pad = 8, k = Math.min((cw - pad * 2) / Math.max(1, x1 - x0), (ch - pad * 2) / Math.max(1, y1 - y0));
    var ox = pad + ((cw - pad * 2) - (x1 - x0) * k) / 2 - x0 * k, oy = pad + ((ch - pad * 2) - (y1 - y0) * k) / 2 - y0 * k;
    mapScale = { k: k, ox: ox, oy: oy };
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, cw, ch);
    var muted = getComputedStyle(root).getPropertyValue('--mat-text-muted').trim() || '#868e96';
    Array.from(S.items.values()).sort(function (a, b2) { return a.z - b2.z; }).forEach(function (it) {
      var box = MB.aabb(it), x = ox + box.x * k, y = oy + box.y * k, w = Math.max(1.5, box.w * k), h = Math.max(1.5, box.h * k);
      if (it.k === 'frame') { c.strokeStyle = muted; c.lineWidth = 1; c.strokeRect(x, y, w, h); return; }
      if (it.k === 'line' || it.k === 'pen') { c.fillStyle = muted; c.globalAlpha = 0.5; c.fillRect(x, y, w, h); c.globalAlpha = 1; return; }
      c.fillStyle = it.k === 'comment' ? '#ffc21f' : it.d.fill && it.d.fill !== 'none' ? it.d.fill : muted;
      c.fillRect(x, y, w, h);
    });
    c.strokeStyle = '#e8a600';
    c.lineWidth = 2;
    c.strokeRect(ox + view.x * k, oy + view.y * k, view.w * k, view.h * k);
  }

  function mapJump(e) {
    if (!mapScale) { return; }
    var r = map.getBoundingClientRect(), wx = (e.clientX - r.left - mapScale.ox) / mapScale.k, wy = (e.clientY - r.top - mapScale.oy) / mapScale.k;
    var cr = MB.canvasRect();
    MB.setView({ x: cr.width / 2 - wx * S.view.k, y: cr.height / 2 - wy * S.view.k, k: S.view.k });
  }
  var mapDrag = false;
  map.addEventListener('pointerdown', function (e) { mapDrag = true; try { map.setPointerCapture(e.pointerId); } catch (err) { /* gone */ } mapJump(e); });
  map.addEventListener('pointermove', function (e) { if (mapDrag) { mapJump(e); } });
  map.addEventListener('pointerup', function () { mapDrag = false; });
  map.addEventListener('pointercancel', function () { mapDrag = false; });
  mapBtn.addEventListener('click', function () { setMap(!mapOn); });
  MB.on('items', scheduleMap);
  MB.on('view', scheduleMap);
  MB.on('loaded', function () { setMap(mapOn); });

  // ---- following somebody, and bringing everybody here --------------------------------------------------------------------------------
  var followBar = byId('mb-followbar'), followText = byId('mb-followbar-text'), summonBtn = byId('mb-summon-btn');
  var applyingRemote = false, lastSent = 0, sendTimer = 0;

  function peerName(id) { var p = MB.net.peers().filter(function (x) { return x.id === id; })[0]; return p ? p.name : t('Js.Board.Guest'); }
  function peerColor(id) { var p = MB.net.peers().filter(function (x) { return x.id === id; })[0]; return p ? p.color : '#ffc21f'; }

  MB.on('follow', function (id) {
    S.following = id || null;
    followBar.hidden = !S.following;
    root.classList.toggle('mb-following', !!S.following);
    if (S.following) {
      followText.textContent = t('Js.Board.Following', peerName(S.following));
      root.style.setProperty('--mb-follow', peerColor(S.following));
    }
    MB.net.renderPresence();
  });
  byId('mb-followbar-stop').addEventListener('click', function () { MB.emit('follow', null); });

  function applyRemoteView(m) {
    applyingRemote = true;
    showRect({ x: m.x, y: m.y, w: m.w, h: m.h }, 0);
    applyingRemote = false;
  }
  MB.on('peer:view', function (m) { if (S.following === m.id) { applyRemoteView(m); } });
  MB.on('summon', function (m) {
    endPresent();
    applyRemoteView(m);
    ui.toast(t('Js.Board.Summoned', peerName(m.id)), 'info');
  });

  // what this person sees goes to the others (at most every 300 ms, only while somebody is there); a person who moves the view stops following
  MB.on('view', function () {
    if (S.following && !applyingRemote) { MB.emit('follow', null); }
    if (!MB.net.peerCount()) { return; }
    clearTimeout(sendTimer);
    var wait = Math.max(0, 300 - (Date.now() - lastSent));
    sendTimer = setTimeout(function () { lastSent = Date.now(); MB.net.view(visibleRect(), false); }, wait);
  });

  summonBtn.addEventListener('click', function () {
    if (MB.net.view(visibleRect(), true)) { ui.toast(t('Js.Board.SummonDone'), 'success'); }
  });
  function updateSummon() { summonBtn.hidden = !S.canEdit() || !MB.net.peerCount(); }
  var presence = byId('mb-presence');
  new MutationObserver(updateSummon).observe(presence, { childList: true });
  MB.on('role', updateSummon);

  // ---- tooltips: one floating tip, beside the control (data-tip-place="right|below|above"; at the top of the window below, else above), always inside the window ----
  var tip = document.createElement('div');
  tip.className = 'mb-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  root.appendChild(tip);
  var tipFor = null, tipTimer = 0;
  function tipText(el) { return el.getAttribute('data-tip') || (el.hasAttribute('data-theme-toggle') ? el.getAttribute('aria-label') : '') || ''; }
  function placeTip(el) {
    var text = tipText(el);
    if (!text || !el.isConnected || el.offsetParent === null) { hideTip(); return; }
    // matui gives the theme button a title as well: the browser's own tip would show over this one
    if (el.hasAttribute('title')) { el.removeAttribute('title'); }
    tip.textContent = text;
    tip.hidden = false;
    var r = el.getBoundingClientRect(), W = window.innerWidth, H = window.innerHeight, gap = 8, edge = 6;
    var w = tip.offsetWidth, h = tip.offsetHeight, x, y;
    var place = el.getAttribute('data-tip-place') || (r.top < 90 ? 'below' : 'above');
    // the tool column turns into a row at the bottom on a phone: there is no room beside it
    if (place === 'right' && r.right + gap + w > W - edge) { place = 'above'; }
    if (place === 'right' && el.closest('.mb-tools') && getComputedStyle(el.closest('.mb-tools')).flexDirection === 'row') { place = 'above'; }
    if (place === 'right') { x = r.right + gap; y = r.top + r.height / 2 - h / 2; }
    else {
      x = r.left + r.width / 2 - w / 2;
      y = place === 'below' ? r.bottom + gap : r.top - gap - h;
      if (y < edge) { y = r.bottom + gap; } else if (y + h > H - edge) { y = r.top - gap - h; }
    }
    x = Math.max(edge, Math.min(W - w - edge, x));
    y = Math.max(edge, Math.min(H - h - edge, y));
    tip.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
  }
  function showTip(el, delay) {
    clearTimeout(tipTimer);
    tipFor = el;
    tipTimer = setTimeout(function () { if (tipFor === el) { placeTip(el); } }, delay);
  }
  function hideTip() { clearTimeout(tipTimer); tipFor = null; tip.hidden = true; }
  function tipTarget(node) { var el = node && node.closest ? node.closest('[data-tip], [data-theme-toggle]') : null; return el && root.contains(el) ? el : null; }
  root.addEventListener('pointerover', function (e) {
    if (e.pointerType !== 'mouse') { return; }
    var el = tipTarget(e.target);
    if (el && el !== tipFor) { showTip(el, tip.hidden ? 350 : 0); } else if (!el) { hideTip(); }
  });
  root.addEventListener('pointerout', function (e) { if (tipFor && !(e.relatedTarget && tipFor.contains(e.relatedTarget))) { hideTip(); } });
  root.addEventListener('focusin', function (e) { var el = tipTarget(e.target); if (el && el.matches(':focus-visible')) { showTip(el, 0); } });
  root.addEventListener('focusout', hideTip);
  root.addEventListener('pointerdown', hideTip, true);
  root.addEventListener('wheel', hideTip, { passive: true });
  // a tip that changes while it is shown (the theme after a click, following somebody) is read again
  new MutationObserver(function () { if (tipFor && !tip.hidden) { placeTip(tipFor); } })
    .observe(root, { subtree: true, attributes: true, attributeFilter: ['data-tip', 'aria-label'] });

  // ---- keys --------------------------------------------------------------------------------------------------------------------------------
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !tip.hidden) { hideTip(); }
    if (show) {
      if (e.key === 'Escape') { e.preventDefault(); endPresent(); return; }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); e.stopImmediatePropagation(); present(show.index + 1); return; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); e.stopImmediatePropagation(); present(show.index - 1); return; }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch(); return; }
    if (ui.isTyping(e.target) || document.querySelector('dialog[open]') || e.ctrlKey || e.metaKey || e.altKey) { return; }
    if (e.key === 'Escape' && panelKind) { closePanel(); return; }
    if (e.key === 'Escape' && S.following) { MB.emit('follow', null); return; }
    if (e.key.toLowerCase() === 'm') { setMap(!mapOn); }
  }, true);
})();
