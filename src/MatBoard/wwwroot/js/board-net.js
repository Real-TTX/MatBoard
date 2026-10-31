/* MatBoard – the canvas, part 2: the connection. Loads the board, keeps a WebSocket to the server, sends what this person changes (in batches, kept on this device until
   the server confirms: the board can be worked on offline and catches up), applies what the others change and shows who is there.
   Without a network the last copy of the board that was loaded is shown (kept in the browser cache) and changes wait in localStorage (mb.q.<board>). */
(function () {
  'use strict';

  var MB = window.MB;
  if (!MB || !MB.S) { return; }
  var S = MB.S, t = MB.t;
  var net = MB.net = {};

  var CACHE = 'mb-boards';
  var QUEUE_KEY = 'mb.q.' + S.id;
  var snapshotUrl = '/live/boards/' + S.id + (S.link ? '?t=' + encodeURIComponent(S.link) : '');

  var ws = null, opened = false, attempt = 0, retryTimer = 0, flushTimer = 0, ackTimer = 0, pingTimer = 0, connectingTimer = 0;
  var pending = [], inflight = null, cid = 0, you = 0, lastCursor = 0, gone = false;
  var peers = new Map();

  var conn = document.getElementById('mb-conn'), connText = document.getElementById('mb-conn-text');

  // ---- the state of the connection (shown top right) ------------------------------------------------------------------------
  function setConn(kind) {
    clearTimeout(connectingTimer);
    if (kind === 'online') { conn.hidden = true; conn.className = 'mb-conn'; return; }
    var show = function () {
      conn.hidden = false;
      conn.className = 'mb-conn mb-conn--' + kind;
      connText.textContent = kind === 'offline' ? t('Js.Board.Offline') : kind === 'readonly' ? t('Js.Board.OfflineCopy') : t('Js.Board.Connecting');
    };
    if (kind === 'connecting') { connectingTimer = setTimeout(show, 1500); } else { show(); }
  }
  net.state = function () { return opened ? 'online' : 'offline'; };

  function toast(message, tone) { if (window.MatUi && MatUi.toast) { MatUi.toast(message, { tone: tone || 'info' }); } }

  // ---- the queue of changes that the server has not confirmed -----------------------------------------------------------------
  function persist() {
    var all = (inflight ? inflight.ops : []).concat(pending);
    try {
      if (all.length) { localStorage.setItem(QUEUE_KEY, JSON.stringify(all)); } else { localStorage.removeItem(QUEUE_KEY); }
    } catch (e) { /* full or private mode: the changes then live only as long as this page */ }
  }
  function loadQueue() {
    try { pending = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (e) { pending = []; }
    if (!Array.isArray(pending)) { pending = []; }
  }

  // two changes of the same thing that are both still waiting become one (a drag makes hundreds)
  function mergeUpd(into, op) {
    ['x', 'y', 'w', 'h', 'r', 'z'].forEach(function (key) { if (op[key] !== undefined) { into[key] = op[key]; } });
    if (op.d) { into.d = into.d || {}; Object.keys(op.d).forEach(function (key) { into.d[key] = op.d[key]; }); }
  }

  /** Called with changes the person made. They are queued, sent as soon as the connection allows and kept until the server confirms them. */
  net.send = function (ops) {
    MB.clone(ops).forEach(function (op) {
      if (op.o === 'upd') {
        for (var i = pending.length - 1; i >= 0; i--) {
          var other = pending[i];
          if ((other.o === 'upd' && other.id === op.id)) { mergeUpd(other, op); op = null; break; }
          if ((other.o === 'add' && other.i.id === op.id) || (other.o === 'del' && other.id === op.id)) { break; }
        }
      }
      if (op) { pending.push(op); }
    });
    schedule();
  };

  function schedule() {
    if (flushTimer) { return; }
    flushTimer = setTimeout(function () { flushTimer = 0; flush(); }, 60);
  }

  function flush() {
    persist();
    if (!ws || ws.readyState !== 1 || inflight || !pending.length || !S.ready) { return; }
    var batch = [], size = 0;
    while (pending.length && batch.length < 200) {
      var length = JSON.stringify(pending[0]).length;
      if (batch.length && size + length > 1500000) { break; }
      size += length;
      batch.push(pending.shift());
    }
    inflight = { cid: ++cid, ops: batch };
    ws.send(JSON.stringify({ t: 'ops', cid: String(inflight.cid), ops: batch }));
    clearTimeout(ackTimer);
    ackTimer = setTimeout(function () { if (ws) { ws.close(); } }, 20000);
  }

  function unsent() { return (inflight ? inflight.ops : []).concat(pending); }

  // ---- loading the board ----------------------------------------------------------------------------------------------------------
  function fetchSnapshot() {
    return fetch(snapshotUrl, { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' }).then(function (res) {
      if (res.status === 404 || res.status === 401 || res.status === 403) { var err = new Error('gone'); err.gone = true; throw err; }
      if (!res.ok) { throw new Error(String(res.status)); }
      var copy = res.clone();
      return res.json().then(function (data) {
        if (window.caches) { caches.open(CACHE).then(function (cache) { return cache.put(snapshotUrl, copy); }).catch(function () { /* no cache: no offline copy */ }); }
        return { data: data, offline: false };
      });
    }).catch(function (error) {
      if (error && error.gone) { throw error; }
      if (!window.caches) { throw error; }
      return caches.open(CACHE).then(function (cache) { return cache.match(snapshotUrl); }).then(function (hit) {
        if (!hit) { throw error; }
        return hit.json().then(function (data) { return { data: data, offline: true }; });
      });
    });
  }

  function showFail(kind) {
    var fail = document.getElementById('mb-fail');
    document.getElementById('mb-loading').hidden = true;
    document.getElementById('mb-fail-title').textContent = t(kind === 'gone' ? 'Js.Board.Gone.Title' : 'Js.Board.Fail.Title');
    document.getElementById('mb-fail-text').textContent = t(kind === 'gone' ? 'Js.Board.Gone.Text' : 'Js.Board.Fail.Text');
    document.getElementById('mb-fail-retry').hidden = kind === 'gone';
    fail.hidden = false;
  }

  function adopt(result, first) {
    var data = result.data;
    MB.setRole(data.role);
    MB.load(data);
    // what was not confirmed yet (also from an earlier visit) is laid over what the server has
    var waiting = unsent();
    if (waiting.length) { MB.applyRemote(MB.clone(waiting)); }
    if (first) {
      S.ready = true;
      MB.restoreView();
      document.getElementById('mb-loading').hidden = true;
      document.getElementById('mb-fail').hidden = true;
    }
    if (result.offline) { setConn('readonly'); }
    MB.emit('loaded');
  }

  function start() {
    loadQueue();
    document.getElementById('mb-loading').hidden = false;
    document.getElementById('mb-fail').hidden = true;
    fetchSnapshot().then(function (result) {
      adopt(result, true);
      if (result.offline) { setConn('readonly'); }
      connect();
    }).catch(function (error) { showFail(error && error.gone ? 'gone' : 'fail'); });
  }
  net.start = start;

  function resync() {
    return fetchSnapshot().then(function (result) {
      if (inflight) { pending = inflight.ops.concat(pending); inflight = null; }
      adopt(result, false);
      if (!result.offline) { setConn('online'); }
      schedule();
    }).catch(function (error) { if (error && error.gone) { gone = true; showFail('gone'); } });
  }

  // ---- the WebSocket ---------------------------------------------------------------------------------------------------------------
  function guestName() {
    if (!S.guest) { return ''; }
    try { return localStorage.getItem('mb.guest') || ''; } catch (e) { return ''; }
  }

  function connect() {
    if (gone || (ws && (ws.readyState === 0 || ws.readyState === 1))) { return; }
    clearTimeout(retryTimer);
    setConn('connecting');
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/live/boards/' + S.id + '/ws';
    var query = [];
    if (S.link) { query.push('t=' + encodeURIComponent(S.link)); }
    if (S.guest) { query.push('n=' + encodeURIComponent(guestName())); }
    var socket = new WebSocket(url + (query.length ? '?' + query.join('&') : ''));
    ws = socket;

    socket.onopen = function () {
      opened = true;
      attempt = 0;
      clearInterval(pingTimer);
      pingTimer = setInterval(function () { if (socket.readyState === 1) { socket.send('{"t":"ping"}'); } }, 25000);
    };
    socket.onmessage = function (event) {
      var m;
      try { m = JSON.parse(event.data); } catch (e) { return; }
      handle(m);
    };
    socket.onclose = function () {
      clearInterval(pingTimer);
      clearTimeout(ackTimer);
      if (ws === socket) { ws = null; }
      var was = opened;
      opened = false;
      peers.clear();
      renderPresence();
      if (inflight) { pending = inflight.ops.concat(pending); inflight = null; persist(); }
      if (gone) { return; }
      if (was || attempt === 0) { setConn('offline'); }
      var delay = Math.min(15000, 1000 * Math.pow(2, attempt++)) + Math.random() * 500;
      retryTimer = setTimeout(function () { if (navigator.onLine !== false) { reconnect(); } }, delay);
    };
    socket.onerror = function () { /* onclose follows */ };
  }

  function reconnect() {
    // a board that was loaded from the copy of the browser is replaced by the real one first
    resync().then(function () { connect(); });
  }

  function handle(m) {
    switch (m.t) {
      case 'hello':
        you = m.you;
        if (m.role && m.role !== S.role) { MB.setRole(m.role); }
        peers.clear();
        (m.peers || []).forEach(function (p) { peers.set(p.id, p); });
        renderPresence();
        setConn('online');
        if (typeof m.rev === 'number' && m.rev > S.rev) { resync(); } else { schedule(); }
        break;
      case 'peer+': peers.set(m.peer.id, m.peer); renderPresence(); break;
      case 'peer-': peers.delete(m.id); renderPresence(); break;
      case 'cur': {
        var p = peers.get(m.id);
        if (p) { p.x = m.x; p.y = m.y; placeCursor(p); }
        break;
      }
      case 'ops':
        MB.applyRemote(m.ops);
        if (typeof m.rev === 'number') { S.rev = Math.max(S.rev, m.rev); }
        break;
      case 'ack':
        clearTimeout(ackTimer);
        if (inflight && String(inflight.cid) === String(m.cid)) { inflight = null; }
        if (typeof m.rev === 'number') { S.rev = Math.max(S.rev, m.rev); }
        if (m.rejected && m.rejected.length && window.console) { console.warn('MatBoard: changes refused', m.rejected); }
        persist();
        schedule();
        break;
      case 'err':
        clearTimeout(ackTimer);
        if (m.code === 'forbidden') {
          inflight = null; pending = []; persist();
          toast(t('Js.Board.NoRight'), 'warning');
          resync();
        } else if (inflight) {
          // not stored: the batch is tried again a little later
          pending = inflight.ops.concat(pending); inflight = null;
          setTimeout(schedule, 3000);
        }
        break;
      case 'gone': gone = true; showFail('gone'); break;
      case 'role': MB.setRole(m.role); if (m.role === 'viewer') { toast(t('Js.Board.NowViewer'), 'info'); } break;
      case 'board':
        if (m.name) { document.getElementById('mb-title').textContent = m.name; document.title = m.name + ' · MatBoard'; }
        if (m.background) { MB.setBackground(m.background); }
        break;
      default: break;
    }
  }

  // ---- who is there --------------------------------------------------------------------------------------------------------------
  var presence = document.getElementById('mb-presence'), cursors = document.getElementById('mb-cursors');

  function initials(name) {
    var parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
    return parts.map(function (p) { return p.charAt(0).toUpperCase(); }).join('') || '?';
  }

  function renderPresence() {
    presence.textContent = '';
    var list = Array.from(peers.values()).filter(function (p) { return p.id !== you; });
    list.slice(0, 4).forEach(function (p) {
      var chip = MB.html('span', 'mb-avatar', presence);
      chip.textContent = initials(p.name);
      chip.title = p.name;
      chip.style.background = p.color;
    });
    if (list.length > 4) {
      var more = MB.html('span', 'mb-avatar mb-avatar--more', presence);
      more.textContent = '+' + (list.length - 4);
      more.title = list.slice(4).map(function (p) { return p.name; }).join(', ');
    }
    presence.hidden = list.length === 0;
    // cursors of people who left go
    Array.from(cursors.children).forEach(function (c) { if (!peers.has(parseInt(c.getAttribute('data-peer'), 10)) || parseInt(c.getAttribute('data-peer'), 10) === you) { c.remove(); } });
    list.forEach(placeCursor);
  }

  function placeCursor(p) {
    if (p.id === you || typeof p.x !== 'number') { return; }
    var node = cursors.querySelector('[data-peer="' + p.id + '"]');
    if (!node) {
      node = MB.html('div', 'mb-cursor', cursors);
      node.setAttribute('data-peer', p.id);
      var arrow = MB.el('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'class': 'mb-cursor__arrow' }, node);
      MB.el('path', { d: 'M4.5 3.5 20 10l-7.2 2.3L10 19.5z', fill: p.color, stroke: '#fff', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }, arrow);
      var label = MB.html('span', 'mb-cursor__label', node);
      label.textContent = p.name;
      label.style.background = p.color;
    }
    var s = MB.toScreen(p.x, p.y);
    node.style.transform = 'translate(' + Math.round(s.x) + 'px,' + Math.round(s.y) + 'px)';
    node.hidden = false;
    clearTimeout(node._hide);
    node._hide = setTimeout(function () { node.hidden = true; }, 15000);
  }

  var placeAll = 0;
  MB.on('view', function () {
    if (placeAll) { return; }
    placeAll = requestAnimationFrame(function () { placeAll = 0; peers.forEach(placeCursor); });
  });

  /** Tells the others where this person's pointer is (in board coordinates), at most every 50 ms and only when somebody is there. */
  net.cursor = function (x, y) {
    var now = Date.now();
    if (!opened || now - lastCursor < 50 || peers.size < 1) { return; }
    lastCursor = now;
    ws.send(JSON.stringify({ t: 'cur', x: x, y: y }));
  };

  net.peerCount = function () { return peers.size; };

  // ---- the world around ---------------------------------------------------------------------------------------------------------
  window.addEventListener('online', function () { attempt = 0; clearTimeout(retryTimer); if (!opened && S.ready) { reconnect(); } });
  window.addEventListener('offline', function () { if (S.ready) { setConn('offline'); } });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { persist(); } else if (!opened && S.ready && navigator.onLine !== false) { attempt = 0; clearTimeout(retryTimer); reconnect(); }
  });
  window.addEventListener('pagehide', persist);
  document.getElementById('mb-fail-retry').addEventListener('click', start);

  /** Starts the board (board-ui.js calls it when everything is in place). A guest says who they are first (the others see the name at the cursor). */
  net.boot = function () {
  var dialog = document.getElementById('mb-guest');
  if (S.guest && dialog) {
    var input = document.getElementById('mb-guest-name');
    var saved = guestName();
    if (saved) { start(); } else {
      input.value = '';
      dialog.showModal();
      dialog.addEventListener('close', function () {
        var name = (input.value || '').trim().slice(0, 30) || t('Js.Board.Guest');
        try { localStorage.setItem('mb.guest', name); } catch (e) { /* private mode */ }
        start();
      }, { once: true });
      dialog.addEventListener('cancel', function (e) { e.preventDefault(); });
    }
  } else {
    start();
  }
  };
})();
