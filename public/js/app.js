/* ============================================================
   Impostor — cliente
   ============================================================ */
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  var STORAGE_SESSION = 'impostor:session';
  var STORAGE_NAME = 'impostor:name';
  var MIN_PLAYERS = 3;
  var MAX_PLAYERS = 20;

  var socket = io({ transports: ['websocket', 'polling'] });

  var state = {
    playerId: null,
    token: null,
    code: null,
    isHost: false,
    room: null,
    priv: null,
    categories: [],
    draft: {
      maxPlayers: 8,
      impostors: 1,
      hintEnabled: true,
      showCategory: true,
      discussionSeconds: 180,
      categories: []
    },
    editingConfig: false,
    myVote: null,
    lastPhase: null
  };

  /* ---------------- utilidades ---------------- */

  function toast(msg, isError) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('is-error', !!isError);
    el.classList.add('is-on');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove('is-on'); }, 2600);
  }

  function buzz(pattern) {
    if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) { /* da igual */ } }
  }

  function show(screenId) {
    $$('.screen').forEach(function (s) { s.classList.toggle('is-active', s.id === 'screen-' + screenId); });
    var body = $('#screen-' + screenId + ' .screen-body');
    if (body) body.scrollTop = 0;
  }

  function activeScreen() {
    var el = $('.screen.is-active');
    return el ? el.id.replace('screen-', '') : null;
  }

  function initials(name) {
    var parts = String(name || '?').trim().split(/\s+/);
    if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
    return String(name || '?').slice(0, 2).toUpperCase();
  }

  function fmtTime(seconds) {
    var s = Math.max(0, Math.round(seconds));
    var m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  function maxImpostorsFor(n) { return Math.max(1, Math.floor((n - 1) / 2)); }

  function saveSession() {
    try {
      if (state.playerId && state.token && state.code) {
        localStorage.setItem(STORAGE_SESSION, JSON.stringify({
          playerId: state.playerId, token: state.token, code: state.code
        }));
      } else {
        localStorage.removeItem(STORAGE_SESSION);
      }
    } catch (e) { /* modo privado */ }
  }

  function readSession() {
    try { return JSON.parse(localStorage.getItem(STORAGE_SESSION) || 'null'); }
    catch (e) { return null; }
  }

  function clearSession() {
    state.playerId = state.token = state.code = null;
    state.room = state.priv = null;
    state.isHost = false;
    state.myVote = null;
    state.lastPhase = null;
    saveSession();
  }

  function myName() {
    var v = $('#input-name').value.trim();
    if (v) { try { localStorage.setItem(STORAGE_NAME, v); } catch (e) {} }
    return v;
  }

  function emit(event, payload, onOk) {
    socket.emit(event, payload, function (res) {
      if (!res || res.ok === false) {
        toast((res && res.error) || 'Algo salió mal', true);
        return;
      }
      if (onOk) onOk(res);
    });
  }

  /* ---------------- categorías ---------------- */

  function loadCategories() {
    return fetch('/api/categories')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        state.categories = data.categories || [];
        if (!state.draft.categories.length) {
          state.draft.categories = state.categories.map(function (c) { return c.id; });
        }
        renderCategories();
      })
      .catch(function () { toast('No se pudieron cargar los tópicos', true); });
  }

  function renderCategories() {
    var wrap = $('#categories');
    wrap.innerHTML = '';
    state.categories.forEach(function (cat) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip' + (state.draft.categories.indexOf(cat.id) >= 0 ? ' is-on' : '');
      btn.textContent = cat.emoji + ' ' + cat.name;
      btn.setAttribute('aria-pressed', state.draft.categories.indexOf(cat.id) >= 0 ? 'true' : 'false');
      btn.addEventListener('click', function () {
        var i = state.draft.categories.indexOf(cat.id);
        if (i >= 0) {
          if (state.draft.categories.length === 1) { toast('Deja al menos una categoría', true); return; }
          state.draft.categories.splice(i, 1);
        } else {
          state.draft.categories.push(cat.id);
        }
        buzz(8);
        renderCategories();
        pushConfigIfEditing();
      });
      wrap.appendChild(btn);
    });
    $('#cat-count').textContent = state.draft.categories.length === state.categories.length
      ? 'Todos los tópicos activados'
      : state.draft.categories.length + ' de ' + state.categories.length + ' tópicos seleccionados';
  }

  /* ---------------- panel de configuración ---------------- */

  function renderConfigPanel() {
    var d = state.draft;
    $('#val-maxPlayers').textContent = d.maxPlayers;
    $('#val-impostors').textContent = d.impostors;
    $('#val-timer').textContent = d.discussionSeconds === 0 ? 'Sin' : fmtTime(d.discussionSeconds);
    $('#desc-timer').textContent = d.discussionSeconds === 0
      ? 'Sin cronómetro, avanzan cuando quieran'
      : 'El debate dura ' + fmtTime(d.discussionSeconds);
    $('#desc-impostors').textContent = 'Máximo ' + maxImpostorsFor(d.maxPlayers) + ' con ' + d.maxPlayers + ' jugadores';

    $$('.switch[data-toggle]').forEach(function (sw) {
      sw.setAttribute('aria-checked', d[sw.dataset.toggle] ? 'true' : 'false');
    });

    $$('.step-btn').forEach(function (btn) {
      var key = btn.dataset.step;
      var delta = Number(btn.dataset.delta);
      btn.disabled = !canStep(key, delta);
    });
  }

  function canStep(key, delta) {
    var d = state.draft;
    if (key === 'maxPlayers') return d.maxPlayers + delta >= MIN_PLAYERS && d.maxPlayers + delta <= MAX_PLAYERS;
    if (key === 'impostors') return d.impostors + delta >= 1 && d.impostors + delta <= maxImpostorsFor(d.maxPlayers);
    if (key === 'discussionSeconds') return d.discussionSeconds + delta >= 0 && d.discussionSeconds + delta <= 900;
    return false;
  }

  function pushConfigIfEditing() {
    if (state.editingConfig && state.isHost) {
      emit('room:config', {
        maxPlayers: state.draft.maxPlayers,
        impostors: state.draft.impostors,
        hintEnabled: state.draft.hintEnabled,
        showCategory: state.draft.showCategory,
        discussionSeconds: state.draft.discussionSeconds,
        categories: state.draft.categories
      });
    }
  }

  $$('.step-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var key = btn.dataset.step;
      var delta = Number(btn.dataset.delta);
      if (!canStep(key, delta)) return;
      state.draft[key] += delta;
      if (key === 'maxPlayers') {
        state.draft.impostors = Math.min(state.draft.impostors, maxImpostorsFor(state.draft.maxPlayers));
      }
      buzz(8);
      renderConfigPanel();
      pushConfigIfEditing();
    });
  });

  $$('.switch[data-toggle]').forEach(function (sw) {
    sw.addEventListener('click', function () {
      state.draft[sw.dataset.toggle] = !state.draft[sw.dataset.toggle];
      buzz(8);
      renderConfigPanel();
      pushConfigIfEditing();
    });
  });

  $('#btn-cat-all').addEventListener('click', function () {
    state.draft.categories = state.categories.map(function (c) { return c.id; });
    renderCategories();
    pushConfigIfEditing();
  });

  $('#btn-cat-none').addEventListener('click', function () {
    state.draft.categories = state.categories.length ? [state.categories[0].id] : [];
    renderCategories();
    pushConfigIfEditing();
    toast('Siempre debe quedar al menos un tópico');
  });

  /* ---------------- navegación inicial ---------------- */

  $$('[data-back]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.editingConfig = false;
      $('#btn-create').textContent = 'Crear sala';
      show(btn.dataset.back);
    });
  });

  function requireName() {
    var name = myName();
    if (!name) {
      toast('Escribe tu nombre primero', true);
      show('home');
      $('#input-name').focus();
      return null;
    }
    return name;
  }

  $('#btn-go-create').addEventListener('click', function () {
    if (!requireName()) return;
    state.editingConfig = false;
    $('#btn-create').textContent = 'Crear sala';
    renderConfigPanel();
    show('create');
  });

  $('#btn-go-join').addEventListener('click', function () {
    if (!requireName()) return;
    show('join');
    setTimeout(function () { $('#input-code').focus(); }, 250);
  });

  $('#input-code').addEventListener('input', function (e) {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  });

  $('#input-code').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('#btn-join').click();
  });

  $('#input-name').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.target.blur(); }
  });

  $('#btn-create').addEventListener('click', function () {
    if (state.editingConfig) {
      state.editingConfig = false;
      $('#btn-create').textContent = 'Crear sala';
      show('lobby');
      return;
    }
    var name = requireName();
    if (!name) return;
    emit('room:create', { name: name, config: state.draft }, function (res) {
      state.playerId = res.playerId;
      state.token = res.token;
      state.code = res.code;
      saveSession();
      show('lobby');
    });
  });

  $('#btn-join').addEventListener('click', function () {
    var name = requireName();
    if (!name) return;
    var code = $('#input-code').value.trim().toUpperCase();
    if (code.length !== 4) { toast('El código tiene 4 caracteres', true); return; }
    emit('room:join', { name: name, code: code }, function (res) {
      state.playerId = res.playerId;
      state.token = res.token;
      state.code = res.code;
      saveSession();
      show('lobby');
    });
  });

  /* ---------------- lobby ---------------- */

  $('#room-code-box').addEventListener('click', function () {
    var url = location.origin + '/?sala=' + state.code;
    var text = '¡Juguemos al Impostor! Código: ' + state.code + ' → ' + url;
    if (navigator.share) {
      navigator.share({ title: 'Impostor', text: text, url: url }).catch(function () {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () { toast('Link copiado'); },
        function () { toast(url); });
    } else {
      toast(url);
    }
  });

  $('#btn-leave').addEventListener('click', function () {
    if (!confirm('¿Salir de la sala?')) return;
    socket.emit('room:leave', {}, function () {});
    clearSession();
    show('home');
  });

  $('#btn-edit-config').addEventListener('click', function () {
    state.editingConfig = true;
    $('#btn-create').textContent = 'Listo';
    renderConfigPanel();
    renderCategories();
    show('create');
  });

  $('#btn-start').addEventListener('click', function () {
    emit('game:start', {});
  });

  /* ---------------- revelar carta ---------------- */

  var card = $('#reveal-card');
  var holdOpen = false;

  function openCard() {
    if (!state.priv) return;
    holdOpen = true;
    card.classList.add('is-open');
    buzz(12);
  }
  function closeCard() {
    holdOpen = false;
    card.classList.remove('is-open');
  }

  ['pointerdown', 'touchstart'].forEach(function (ev) {
    card.addEventListener(ev, function (e) { e.preventDefault(); openCard(); }, { passive: false });
  });
  ['pointerup', 'pointercancel', 'pointerleave', 'touchend', 'touchcancel'].forEach(function (ev) {
    card.addEventListener(ev, function () { if (holdOpen) closeCard(); });
  });
  window.addEventListener('blur', function () { if (holdOpen) closeCard(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden && holdOpen) closeCard(); });

  $('#btn-ready').addEventListener('click', function () {
    closeCard();
    emit('game:revealed', {});
    $('#btn-ready').disabled = true;
    $('#btn-ready').textContent = 'Esperando al resto…';
  });

  /* ---------------- debate / votación ---------------- */

  $('#btn-to-voting').addEventListener('click', function () { emit('game:voting', {}); });
  $('#btn-force-results').addEventListener('click', function () { emit('game:forceResults', {}); });
  $('#btn-next-round').addEventListener('click', function () { emit('game:next', {}); });
  $('#btn-back-lobby').addEventListener('click', function () { emit('game:lobby', {}); });

  /* ---------------- render principal ---------------- */

  function render() {
    var room = state.room;
    if (!room) return;

    var me = room.players.filter(function (p) { return p.id === state.playerId; })[0];
    state.isHost = !!me && me.isHost;

    renderLobby(room, me);

    var phase = room.phase;
    if (phase !== state.lastPhase) {
      state.lastPhase = phase;
      state.myVote = null;
      if (phase === 'reveal') {
        closeCard();
        $('#btn-ready').disabled = false;
        $('#btn-ready').textContent = 'Ya la vi';
        buzz([20, 60, 20]);
      }
      if (phase === 'voting') buzz([30, 50, 30]);
      if (phase === 'results') buzz([40, 60, 40, 60, 80]);
    }

    if (phase === 'lobby') {
      if (['reveal', 'discussion', 'voting', 'results'].indexOf(activeScreen()) >= 0) show('lobby');
      else if (activeScreen() !== 'create') show('lobby');
    } else if (phase === 'reveal') {
      renderReveal(room);
      if (activeScreen() !== 'reveal') show('reveal');
    } else if (phase === 'discussion') {
      renderDiscussion(room);
      if (activeScreen() !== 'discussion') show('discussion');
    } else if (phase === 'voting') {
      renderVoting(room);
      if (activeScreen() !== 'voting') show('voting');
    } else if (phase === 'results') {
      renderResults(room);
      if (activeScreen() !== 'results') show('results');
    }
  }

  function renderLobby(room, me) {
    $('#room-code').textContent = room.code;
    $('#room-url').textContent = location.host + '/?sala=' + room.code;
    $('#player-count').textContent = room.players.length + '/' + room.config.maxPlayers;

    var scoreBadge = $('#scoreboard-toggle');
    scoreBadge.hidden = room.roundNumber === 0;
    scoreBadge.textContent = 'Ronda ' + room.roundNumber;

    var list = $('#players');
    list.innerHTML = '';
    room.players.forEach(function (p) {
      list.appendChild(playerRow(p, {
        showScore: room.roundNumber > 0,
        kickable: state.isHost && p.id !== state.playerId && room.phase === 'lobby'
      }));
    });

    var cfg = room.config;
    var catNames = cfg.categories.map(function (id) {
      var c = state.categories.filter(function (x) { return x.id === id; })[0];
      return c ? c.emoji + ' ' + c.name : id;
    });
    $('#config-summary').innerHTML = [
      row('Jugadores', 'hasta ' + cfg.maxPlayers),
      row('Impostores', String(cfg.impostors)),
      row('Pista al impostor', cfg.hintEnabled ? 'Sí' : 'No'),
      row('Mostrar tópico', cfg.showCategory ? 'Sí' : 'No'),
      row('Debate', cfg.discussionSeconds === 0 ? 'Libre' : fmtTime(cfg.discussionSeconds)),
      row('Tópicos', catNames.length === state.categories.length && state.categories.length
        ? 'Todos (' + catNames.length + ')'
        : catNames.join(', '))
    ].join('');

    $('#btn-edit-config').hidden = !state.isHost || room.phase !== 'lobby';

    var start = $('#btn-start');
    var note = $('#lobby-note');
    var connected = room.players.filter(function (p) { return p.connected; }).length;

    if (!state.isHost) {
      start.hidden = true;
      note.textContent = 'Esperando a que el anfitrión inicie la partida…';
    } else {
      start.hidden = false;
      if (connected < room.minPlayers) {
        start.disabled = true;
        note.textContent = 'Faltan ' + (room.minPlayers - connected) + ' jugador(es) para empezar';
      } else if (cfg.impostors > maxImpostorsFor(connected)) {
        start.disabled = true;
        note.textContent = 'Con ' + connected + ' jugadores el máximo es ' + maxImpostorsFor(connected) + ' impostor(es)';
      } else {
        start.disabled = false;
        note.textContent = connected + ' jugadores · ' + cfg.impostors + ' impostor(es)';
      }
    }
  }

  function row(label, value) {
    return '<li><span>' + esc(label) + '</span><b>' + esc(value) + '</b></li>';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function playerRow(p, opts) {
    opts = opts || {};
    var li = document.createElement('li');
    li.className = 'player' + (p.connected === false ? ' is-off' : '');

    var av = document.createElement('span');
    av.className = 'player-avatar';
    av.textContent = initials(p.name);
    li.appendChild(av);

    var name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = p.name + (p.id === state.playerId ? ' (tú)' : '');
    li.appendChild(name);

    if (opts.showScore && typeof p.score === 'number') {
      var sc = document.createElement('span');
      sc.className = 'player-score';
      sc.textContent = p.score + ' pt';
      li.appendChild(sc);
    }

    (opts.tags || []).forEach(function (t) {
      var tag = document.createElement('span');
      tag.className = 'player-tag ' + (t.kind || '');
      tag.textContent = t.text;
      li.appendChild(tag);
    });

    if (p.isHost) li.appendChild(tagEl('Anfitrión', 'host'));
    if (p.connected === false) li.appendChild(tagEl('Offline', 'off'));

    if (opts.kickable) {
      var kick = document.createElement('button');
      kick.className = 'player-kick';
      kick.type = 'button';
      kick.textContent = '✕';
      kick.setAttribute('aria-label', 'Expulsar a ' + p.name);
      kick.addEventListener('click', function () {
        if (confirm('¿Expulsar a ' + p.name + '?')) emit('room:kick', { playerId: p.id });
      });
      li.appendChild(kick);
    }
    return li;
  }

  function tagEl(text, kind) {
    var el = document.createElement('span');
    el.className = 'player-tag ' + (kind || '');
    el.textContent = text;
    return el;
  }

  function renderReveal(room) {
    $('#reveal-round').textContent = 'Ronda ' + room.round.number;
    $('#reveal-progress').textContent = room.round.revealedCount + ' de ' + room.round.totalPlayers + ' listos';

    var priv = state.priv;
    if (!priv) return;

    card.classList.toggle('is-impostor', priv.role === 'impostor');

    if (priv.role === 'impostor') {
      $('#role-label').textContent = 'Eres el';
      $('#role-word').textContent = 'IMPOSTOR';
      var extra = [];
      if (priv.categoryName) extra.push('Tópico: <b>' + esc(priv.categoryEmoji + ' ' + priv.categoryName) + '</b>');
      if (priv.hint) extra.push('Pista: <b>' + esc(priv.hint) + '</b>');
      if (!priv.hint && priv.hintEnabled === false) extra.push('Sin pista. Suerte 😬');
      if (priv.impostorCount > 1) extra.push('Hay <b>' + priv.impostorCount + '</b> impostores en total');
      $('#role-extra').innerHTML = extra.join('<br>');
    } else {
      $('#role-label').textContent = 'Tu palabra';
      $('#role-word').textContent = priv.word || '—';
      var ex = [];
      if (priv.categoryName) ex.push('Tópico: <b>' + esc(priv.categoryEmoji + ' ' + priv.categoryName) + '</b>');
      ex.push(priv.impostorCount > 1
        ? 'Hay <b>' + priv.impostorCount + '</b> impostores'
        : 'Hay <b>1</b> impostor');
      $('#role-extra').innerHTML = ex.join('<br>');
    }

    if (priv.revealed) {
      $('#btn-ready').disabled = true;
      $('#btn-ready').textContent = 'Esperando al resto…';
    }
  }

  function renderDiscussion(room) {
    var banner = $('#topic-banner');
    if (room.round.categoryName) {
      banner.hidden = false;
      $('#topic-value').textContent = (room.round.categoryEmoji || '') + ' ' + room.round.categoryName;
    } else {
      banner.hidden = true;
    }

    var ol = $('#order-list');
    ol.innerHTML = '';
    room.round.order.forEach(function (name) {
      var li = document.createElement('li');
      li.textContent = name;
      ol.appendChild(li);
    });

    $('#btn-to-voting').hidden = !state.isHost;
    $('#discussion-note').textContent = state.isHost
      ? 'Cuando todos hayan hablado, abre la votación'
      : 'El anfitrión abrirá la votación';

    startTimer(room.discussionEndsAt);
  }

  var timerRaf = null;
  function startTimer(endsAt) {
    var box = $('#timer');
    if (timerRaf) { clearInterval(timerRaf); timerRaf = null; }
    if (!endsAt) { box.hidden = true; return; }
    box.hidden = false;

    var tick = function () {
      var left = (endsAt - Date.now()) / 1000;
      $('#timer-value').textContent = fmtTime(left);
      box.classList.toggle('is-low', left <= 20);
      if (left <= 0) {
        clearInterval(timerRaf);
        timerRaf = null;
        $('#timer-value').textContent = '0:00';
        buzz([100, 60, 100]);
      }
    };
    tick();
    timerRaf = setInterval(tick, 250);
  }

  function renderVoting(room) {
    $('#vote-progress').textContent = room.round.voteCount + ' de ' + room.round.totalPlayers + ' votaron';
    $('#btn-force-results').hidden = !state.isHost;

    var grid = $('#vote-grid');
    grid.innerHTML = '';

    var me = room.players.filter(function (p) { return p.id === state.playerId; })[0];
    var alreadyVoted = me && me.hasVoted;

    room.players.forEach(function (p) {
      if (!p.connected) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vote-btn' + (state.myVote === p.id ? ' is-picked' : '');
      btn.disabled = p.id === state.playerId;

      var av = document.createElement('span');
      av.className = 'player-avatar';
      av.textContent = initials(p.name);
      btn.appendChild(av);

      var nm = document.createElement('span');
      nm.textContent = p.name + (p.id === state.playerId ? ' (tú)' : '');
      btn.appendChild(nm);

      if (p.hasVoted) {
        var s = document.createElement('small');
        s.textContent = '✓ ya votó';
        btn.appendChild(s);
      }

      btn.addEventListener('click', function () {
        state.myVote = p.id;
        buzz(15);
        emit('game:vote', { targetId: p.id });
        renderVoting(state.room);
      });
      grid.appendChild(btn);
    });

    var skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'vote-btn is-skip' + (state.myVote === 'skip' ? ' is-picked' : '');
    skip.textContent = '🤷 Saltar voto';
    skip.addEventListener('click', function () {
      state.myVote = 'skip';
      buzz(15);
      emit('game:vote', { targetId: 'skip' });
      renderVoting(state.room);
    });
    grid.appendChild(skip);

    if (alreadyVoted && !state.myVote) {
      $('#vote-progress').textContent = 'Ya votaste · ' + room.round.voteCount + ' de ' + room.round.totalPlayers;
    }
  }

  function renderResults(room) {
    var r = room.round.result;
    if (!r) return;

    var title = $('#result-title');
    title.classList.remove('crew', 'impostor');

    if (r.crewWins) {
      $('#result-emoji').textContent = '🎉';
      title.textContent = '¡Atraparon al impostor!';
      title.classList.add('crew');
      $('#result-sub').textContent = r.ejectedName + ' era impostor.';
    } else if (r.tie) {
      $('#result-emoji').textContent = '🤝';
      title.textContent = 'Empate en la votación';
      title.classList.add('impostor');
      $('#result-sub').textContent = 'Nadie fue eliminado. Los impostores se salvan.';
    } else {
      $('#result-emoji').textContent = '🕵️';
      title.textContent = '¡Ganan los impostores!';
      title.classList.add('impostor');
      $('#result-sub').textContent = r.ejectedName + ' era inocente.';
    }

    $('#result-word').textContent = r.word;
    $('#result-category').textContent = (r.categoryEmoji || '') + ' ' + r.categoryName +
      (r.hint ? ' · pista: ' + r.hint : '');

    var imp = $('#result-impostors');
    imp.innerHTML = '';
    r.impostors.forEach(function (p) {
      imp.appendChild(playerRow({ id: p.id, name: p.name, connected: true },
        { tags: [{ text: 'Impostor', kind: 'impostor' }] }));
    });

    var votes = $('#result-votes');
    votes.innerHTML = r.votes.length
      ? r.votes.map(function (v) { return row(v.voterName, '→ ' + v.targetName); }).join('')
      : '<li><span>Nadie votó</span></li>';

    var scores = $('#result-scores');
    scores.innerHTML = '';
    room.players.slice().sort(function (a, b) { return b.score - a.score; }).forEach(function (p) {
      scores.appendChild(playerRow(p, { showScore: true }));
    });

    $('#btn-next-round').hidden = !state.isHost;
    $('#btn-back-lobby').hidden = !state.isHost;
    $('#results-note').textContent = state.isHost ? '' : 'Esperando a que el anfitrión reparta la siguiente ronda…';
  }

  /* ---------------- socket ---------------- */

  socket.on('connect', function () {
    $('#connection').hidden = true;
    var sess = readSession();
    if (sess && sess.playerId && sess.token && sess.code) {
      socket.emit('room:resume', sess, function (res) {
        if (res && res.ok) {
          state.playerId = res.playerId;
          state.token = res.token;
          state.code = res.code;
          saveSession();
        } else {
          clearSession();
          if (['lobby', 'reveal', 'discussion', 'voting', 'results'].indexOf(activeScreen()) >= 0) {
            show('home');
          }
        }
      });
    }
  });

  socket.on('disconnect', function () {
    $('#connection').hidden = false;
    $('#connection').textContent = 'Reconectando…';
  });

  socket.on('connect_error', function () {
    $('#connection').hidden = false;
    $('#connection').textContent = 'Sin conexión con el servidor';
  });

  socket.on('room:state', function (roomState) {
    state.room = roomState;
    render();
  });

  socket.on('you:state', function (payload) {
    state.playerId = payload.playerId;
    state.isHost = payload.isHost;
    state.priv = payload.private;
    if (state.room) render();
  });

  socket.on('room:kicked', function () {
    clearSession();
    show('home');
    toast('El anfitrión te sacó de la sala', true);
  });

  socket.on('session:replaced', function () {
    toast('Abriste el juego en otra pestaña');
  });

  /* ---------------- arranque ---------------- */

  function boot() {
    try {
      var saved = localStorage.getItem(STORAGE_NAME);
      if (saved) $('#input-name').value = saved;
    } catch (e) {}

    var params = new URLSearchParams(location.search);
    var sala = params.get('sala') || params.get('room');
    if (sala) {
      $('#input-code').value = sala.toUpperCase().slice(0, 4);
      if ($('#input-name').value.trim()) show('join');
      else { show('home'); toast('Escribe tu nombre para entrar a la sala ' + sala.toUpperCase()); }
      history.replaceState(null, '', location.pathname);
    }

    renderConfigPanel();
    loadCategories();
  }

  boot();
})();
