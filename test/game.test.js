'use strict';

/**
 * Pruebas del núcleo del juego + una partida completa por sockets.
 * Ejecutar con: npm test
 */

const assert = require('assert');
const { Room, RoomStore, PHASES, maxImpostorsFor, normalizeConfig } = require('../server/game');
const { CATEGORY_INDEX } = require('../server/words');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  ✗ ' + name + '\n      ' + err.message);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  ✗ ' + name + '\n      ' + err.message);
  }
}

function roomWith(n, config) {
  const room = new Room('TEST', config);
  const players = [];
  for (let i = 0; i < n; i++) players.push(room.addPlayer('Jugador' + (i + 1)));
  return { room, players };
}

console.log('\nConfiguración');

test('la configuración por defecto es válida', () => {
  const cfg = normalizeConfig({}, undefined);
  assert.strictEqual(cfg.maxPlayers, 8);
  assert.strictEqual(cfg.impostors, 1);
  assert.strictEqual(cfg.hintEnabled, true);
  assert.strictEqual(cfg.showCategory, true);
  assert.strictEqual(cfg.categories.length, CATEGORY_INDEX.length);
});

test('maxPlayers queda dentro de los límites', () => {
  assert.strictEqual(normalizeConfig({ maxPlayers: 1 }).maxPlayers, 3);
  assert.strictEqual(normalizeConfig({ maxPlayers: 999 }).maxPlayers, 20);
});

test('los impostores nunca superan la mitad menos uno', () => {
  assert.strictEqual(normalizeConfig({ maxPlayers: 4, impostors: 9 }).impostors, 1);
  assert.strictEqual(normalizeConfig({ maxPlayers: 8, impostors: 9 }).impostors, 3);
  assert.strictEqual(maxImpostorsFor(3), 1);
  assert.strictEqual(maxImpostorsFor(10), 4);
});

test('se ignoran categorías inexistentes y nunca queda vacío', () => {
  const cfg = normalizeConfig({ categories: ['no-existe'] });
  assert.ok(cfg.categories.length > 0);
  const cfg2 = normalizeConfig({ categories: ['animales', 'anime', 'nope'] });
  assert.deepStrictEqual(cfg2.categories, ['animales', 'anime']);
});

test('los toggles de pista y tópico se guardan', () => {
  const cfg = normalizeConfig({ hintEnabled: false, showCategory: false });
  assert.strictEqual(cfg.hintEnabled, false);
  assert.strictEqual(cfg.showCategory, false);
});

console.log('\nSala y jugadores');

test('el primero en entrar es el anfitrión', () => {
  const { room, players } = roomWith(3);
  assert.strictEqual(room.hostId, players[0].id);
});

test('los nombres repetidos se hacen únicos', () => {
  const room = new Room('TEST');
  room.addPlayer('Ana');
  const second = room.addPlayer(room.uniqueName('Ana'));
  assert.notStrictEqual(second.name, 'Ana');
});

test('si el anfitrión se va, otro toma su lugar', () => {
  const { room, players } = roomWith(3);
  room.removePlayer(players[0].id);
  assert.strictEqual(room.hostId, players[1].id);
});

test('no se puede empezar con menos de 3 jugadores', () => {
  const { room } = roomWith(2);
  assert.strictEqual(room.canStart().ok, false);
});

console.log('\nRonda');

test('la ronda reparte exactamente los impostores configurados', () => {
  const { room } = roomWith(7, { maxPlayers: 8, impostors: 3 });
  assert.strictEqual(room.startRound().ok, true);
  assert.strictEqual(room.round.impostorIds.size, 3);
});

test('los tripulantes ven la palabra y el impostor no', () => {
  const { room, players } = roomWith(5, { impostors: 1 });
  room.startRound();
  const impostorId = Array.from(room.round.impostorIds)[0];
  for (const p of players) {
    const view = room.privateState(p.id);
    if (p.id === impostorId) {
      assert.strictEqual(view.role, 'impostor');
      assert.strictEqual(view.word, null);
    } else {
      assert.strictEqual(view.role, 'crew');
      assert.strictEqual(view.word, room.round.word);
    }
  }
});

test('con pista activada el impostor recibe una pista', () => {
  const { room } = roomWith(4, { hintEnabled: true });
  room.startRound();
  const impostorId = Array.from(room.round.impostorIds)[0];
  const view = room.privateState(impostorId);
  assert.ok(view.hint && view.hint.length > 0, 'debería haber pista');
});

test('con pista desactivada el impostor no recibe nada', () => {
  const { room } = roomWith(4, { hintEnabled: false });
  room.startRound();
  const impostorId = Array.from(room.round.impostorIds)[0];
  assert.strictEqual(room.privateState(impostorId).hint, null);
});

test('mostrar tópico controla la categoría en el estado público y privado', () => {
  const on = roomWith(4, { showCategory: true });
  on.room.startRound();
  assert.ok(on.room.publicState().round.categoryName);
  assert.ok(on.room.privateState(on.players[0].id).categoryName);

  const off = roomWith(4, { showCategory: false });
  off.room.startRound();
  assert.strictEqual(off.room.publicState().round.categoryName, null);
  assert.strictEqual(off.room.privateState(off.players[0].id).categoryName, null);
});

test('la palabra sale de una de las categorías elegidas', () => {
  const { room } = roomWith(4, { categories: ['animales'] });
  for (let i = 0; i < 25; i++) {
    room.startRound();
    assert.strictEqual(room.round.categoryId, 'animales');
  }
});

test('el estado público jamás filtra la palabra ni quién es impostor', () => {
  const { room } = roomWith(5);
  room.startRound();
  const state = room.publicState();
  const json = JSON.stringify(state);
  assert.ok(!json.includes(room.round.word), 'la palabra se filtró');
  assert.ok(!json.includes(room.round.hint), 'la pista se filtró');
  // Ningún jugador viene marcado con su rol antes de los resultados.
  state.players.forEach((p) => {
    assert.ok(!('role' in p) && !('isImpostor' in p), 'el rol se filtró');
  });
  assert.strictEqual(state.round.result, null);
  assert.ok(!('impostorIds' in state.round) && !('word' in state.round));
});

test('cuando todos ven su carta se pasa al debate', () => {
  const { room, players } = roomWith(4);
  room.startRound();
  players.slice(0, 3).forEach((p) => room.markRevealed(p.id));
  assert.strictEqual(room.phase, PHASES.REVEAL);
  room.markRevealed(players[3].id);
  assert.strictEqual(room.phase, PHASES.DISCUSSION);
});

console.log('\nVotación');

test('nadie puede votarse a sí mismo', () => {
  const { room, players } = roomWith(4);
  room.startRound();
  room.beginVoting();
  const res = room.castVote(players[0].id, players[0].id);
  assert.strictEqual(res.ok, false);
});

test('si el más votado es impostor ganan los tripulantes', () => {
  const { room, players } = roomWith(4, { impostors: 1 });
  room.startRound();
  const impostorId = Array.from(room.round.impostorIds)[0];
  room.beginVoting();
  players.filter((p) => p.id !== impostorId).forEach((p) => room.castVote(p.id, impostorId));
  room.castVote(impostorId, players.find((p) => p.id !== impostorId).id);
  assert.strictEqual(room.phase, PHASES.RESULTS);
  assert.strictEqual(room.round.result.crewWins, true);
  players.filter((p) => p.id !== impostorId).forEach((p) => assert.strictEqual(p.score, 1));
});

test('si el más votado es inocente ganan los impostores', () => {
  const { room, players } = roomWith(4, { impostors: 1 });
  room.startRound();
  const impostorId = Array.from(room.round.impostorIds)[0];
  const inocentes = players.filter((p) => p.id !== impostorId);
  room.beginVoting();
  room.castVote(impostorId, inocentes[0].id);
  room.castVote(inocentes[1].id, inocentes[0].id);
  room.castVote(inocentes[2].id, inocentes[0].id);
  room.castVote(inocentes[0].id, inocentes[1].id);
  assert.strictEqual(room.round.result.crewWins, false);
  assert.strictEqual(room.players.get(impostorId).score, 2);
});

test('el empate no elimina a nadie', () => {
  const { room, players } = roomWith(4);
  room.startRound();
  room.beginVoting();
  room.castVote(players[0].id, players[1].id);
  room.castVote(players[1].id, players[0].id);
  room.castVote(players[2].id, players[3].id);
  room.castVote(players[3].id, players[2].id);
  assert.strictEqual(room.round.result.tie, true);
  assert.strictEqual(room.round.result.ejectedId, null);
});

test('los resultados revelan palabra e impostores', () => {
  const { room, players } = roomWith(4);
  room.startRound();
  const word = room.round.word;
  room.beginVoting();
  players.forEach((p) => room.castVote(p.id, players[(players.indexOf(p) + 1) % players.length].id));
  const result = room.round.result;
  assert.strictEqual(result.word, word);
  assert.strictEqual(result.impostors.length, 1);
});

test('las rondas siguientes reparten roles nuevos', () => {
  const { room, players } = roomWith(5);
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    room.startRound();
    Array.from(room.round.impostorIds).forEach((id) => seen.add(id));
  }
  assert.ok(seen.size >= 3, 'el impostor debería rotar entre jugadores');
  assert.strictEqual(room.roundNumber, 40);
  assert.strictEqual(players.length, 5);
});

console.log('\nAlmacén de salas');

test('los códigos de sala son de 4 caracteres y únicos', () => {
  const store = new RoomStore();
  const codes = new Set();
  for (let i = 0; i < 300; i++) {
    const room = store.create();
    assert.match(room.code, /^[A-HJ-NP-Z2-9]{4}$/);
    codes.add(room.code);
  }
  assert.strictEqual(codes.size, 300);
  clearInterval(store.cleanupTimer);
});

test('buscar sala no distingue mayúsculas', () => {
  const store = new RoomStore();
  const room = store.create();
  assert.strictEqual(store.get(room.code.toLowerCase()), room);
  clearInterval(store.cleanupTimer);
});

/* ------------------------------------------------------------------ */
/* Partida completa por sockets                                        */
/* ------------------------------------------------------------------ */

(async function integration() {
  console.log('\nPartida completa (sockets)');

  process.env.NO_QR = '1';
  process.env.PORT = '0'; // puerto efímero
  const { server, io: ioServer, store } = require('../server/index.js');
  const { io: ioClient } = require('socket.io-client');

  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  const port = server.address().port;
  const url = 'http://127.0.0.1:' + port;

  const clients = [];
  function connect() {
    const c = ioClient(url, { transports: ['websocket'], forceNew: true });
    clients.push(c);
    // Cacheamos el último estado recibido: los eventos pueden llegar antes de que
    // el test empiece a escuchar, y esperar a ciegas provoca timeouts falsos.
    c.lastRoom = null;
    c.lastYou = null;
    c.on('room:state', (s) => { c.lastRoom = s; });
    c.on('you:state', (s) => { c.lastYou = s; });
    return new Promise((resolve) => c.on('connect', () => resolve(c)));
  }
  function ask(c, event, payload) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout en ' + event)), 4000);
      c.emit(event, payload, (res) => { clearTimeout(t); res && res.ok ? resolve(res) : reject(new Error(res && res.error)); });
    });
  }
  function waitFor(c, event, predicate) {
    const cached = event === 'room:state' ? c.lastRoom : event === 'you:state' ? c.lastYou : null;
    if (cached && (!predicate || predicate(cached))) return Promise.resolve(cached);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout esperando ' + event)), 4000);
      const handler = (data) => {
        if (!predicate || predicate(data)) {
          clearTimeout(t);
          c.off(event, handler);
          resolve(data);
        }
      };
      c.on(event, handler);
    });
  }

  try {
    await testAsync('crear sala, unirse, jugar una ronda entera y ver resultados', async () => {
      const host = await connect();
      const created = await ask(host, 'room:create', {
        name: 'Ana',
        config: { maxPlayers: 6, impostors: 1, hintEnabled: true, showCategory: true, categories: ['animales'], discussionSeconds: 0 }
      });
      const code = created.code;
      assert.match(code, /^[A-HJ-NP-Z2-9]{4}$/);

      const p2 = await connect();
      const p3 = await connect();
      await ask(p2, 'room:join', { name: 'Beto', code: code });
      const joined3 = await ask(p3, 'room:join', { name: 'Caro', code: code.toLowerCase() });
      assert.ok(joined3.playerId);

      const lobby = await waitFor(host, 'room:state', (s) => s.players.length === 3);
      assert.strictEqual(lobby.config.categories.length, 1);
      assert.strictEqual(lobby.phase, 'lobby');

      // Un jugador que no es anfitrión no puede iniciar.
      await assert.rejects(() => ask(p2, 'game:start', {}));

      await ask(host, 'game:start', {});
      await waitFor(host, 'room:state', (s) => s.phase === 'reveal');
      const cards = await Promise.all([host, p2, p3].map((c) =>
        waitFor(c, 'you:state', (d) => d.private && d.private.round === 1)));
      const privates = new Map(cards.map((d, i) => [i, d]));

      const roles = [0, 1, 2].map((i) => privates.get(i).private.role);
      assert.strictEqual(roles.filter((r) => r === 'impostor').length, 1);
      const crewWords = [0, 1, 2].map((i) => privates.get(i).private.word).filter(Boolean);
      assert.strictEqual(new Set(crewWords).size, 1, 'los tripulantes comparten la palabra');
      const impostorView = [0, 1, 2].map((i) => privates.get(i).private).find((v) => v.role === 'impostor');
      assert.ok(impostorView.hint, 'el impostor recibe pista');
      assert.strictEqual(impostorView.categoryName, 'Animales');

      await ask(host, 'game:revealed', {});
      await ask(p2, 'game:revealed', {});
      await ask(p3, 'game:revealed', {});
      const disc = await waitFor(host, 'room:state', (s) => s.phase === 'discussion');
      assert.strictEqual(disc.round.order.length, 3);

      await ask(host, 'game:voting', {});
      await waitFor(host, 'room:state', (s) => s.phase === 'voting');

      const ids = lobby.players.map((p) => p.id);
      await ask(host, 'game:vote', { targetId: ids[1] });
      await ask(p2, 'game:vote', { targetId: ids[0] });
      await ask(p3, 'game:vote', { targetId: ids[1] });

      const results = await waitFor(host, 'room:state', (s) => s.phase === 'results');
      assert.ok(results.round.result.word);
      assert.strictEqual(results.round.result.ejectedName, 'Beto');
      assert.strictEqual(results.round.result.impostors.length, 1);
    });

    await testAsync('reconectar recupera la sesión y el rol', async () => {
      const host = await connect();
      const created = await ask(host, 'room:create', { name: 'Ana', config: { impostors: 1, discussionSeconds: 0 } });
      const p2 = await connect();
      const p3 = await connect();
      const j2 = await ask(p2, 'room:join', { name: 'Beto', code: created.code });
      await ask(p3, 'room:join', { name: 'Caro', code: created.code });
      await ask(host, 'game:start', {});

      const beforeState = await waitFor(p2, 'you:state', (d) => d.private && d.private.round === 1);
      const before = beforeState.private;
      assert.ok(before, 'debería haber llegado la carta');

      p2.disconnect();
      await new Promise((r) => setTimeout(r, 120));

      const again = await connect();
      await ask(again, 'room:resume', { code: created.code, playerId: j2.playerId, token: j2.token });
      const restored = await waitFor(again, 'you:state', (d) => d.private);
      assert.strictEqual(restored.private.role, before.role);
      assert.strictEqual(restored.private.word, before.word);
    });

    await testAsync('no se puede entrar a una sala llena', async () => {
      const host = await connect();
      const created = await ask(host, 'room:create', { name: 'Ana', config: { maxPlayers: 3 } });
      const p2 = await connect();
      const p3 = await connect();
      await ask(p2, 'room:join', { name: 'Beto', code: created.code });
      await ask(p3, 'room:join', { name: 'Caro', code: created.code });

      const p4 = await connect();
      await assert.rejects(() => ask(p4, 'room:join', { name: 'Dani', code: created.code }), /llena/);
    });

    await testAsync('quien entra con la ronda en curso espera y juega la siguiente', async () => {
      const host = await connect();
      const created = await ask(host, 'room:create', { name: 'Ana', config: { maxPlayers: 6, discussionSeconds: 0 } });
      const p2 = await connect();
      const p3 = await connect();
      await ask(p2, 'room:join', { name: 'Beto', code: created.code });
      await ask(p3, 'room:join', { name: 'Caro', code: created.code });
      await ask(host, 'game:start', {});
      await waitFor(host, 'room:state', (s) => s.phase === 'reveal');

      // Entra con la partida ya empezada: no se le rechaza, queda a la espera.
      const tarde = await connect();
      const res = await ask(tarde, 'room:join', { name: 'Dani', code: created.code });
      assert.strictEqual(res.pending, true, 'debería quedar pendiente');

      const suCarta = await waitFor(tarde, 'you:state', (d) => d.private);
      assert.strictEqual(suCarta.private.pending, true, 'no debe recibir carta de esta ronda');
      assert.strictEqual(suCarta.private.word, undefined, 'no debe ver la palabra');

      const estado = await waitFor(host, 'room:state', (s) => s.players.length === 4);
      assert.strictEqual(estado.round.totalPlayers, 3, 'el que espera no cuenta para la ronda');
      assert.strictEqual(estado.players.find((p) => p.name === 'Dani').pending, true);

      // Los 3 originales avanzan sin que el pendiente los bloquee.
      await ask(host, 'game:revealed', {});
      await ask(p2, 'game:revealed', {});
      await ask(p3, 'game:revealed', {});
      await waitFor(host, 'room:state', (s) => s.phase === 'discussion');

      // Y no puede votar en una ronda que no juega.
      await ask(host, 'game:voting', {});
      await waitFor(host, 'room:state', (s) => s.phase === 'voting');
      await assert.rejects(() => ask(tarde, 'game:vote', { targetId: 'skip' }), /siguiente ronda/);

      // En la ronda siguiente ya es uno más.
      await ask(host, 'game:forceResults', {});
      await waitFor(host, 'room:state', (s) => s.phase === 'results');
      await ask(host, 'game:next', {});
      const ronda2 = await waitFor(host, 'room:state', (s) => s.phase === 'reveal' && s.round.number === 2);
      assert.strictEqual(ronda2.round.totalPlayers, 4, 'ahora juegan los 4');
      const carta2 = await waitFor(tarde, 'you:state', (d) => d.private && d.private.round === 2);
      assert.ok(!carta2.private.pending, 'ya no debería estar pendiente');
      assert.ok(carta2.private.role, 'debería recibir rol');
    });

    await testAsync('una desconexión no deja la ronda colgada', async () => {
      const host = await connect();
      const created = await ask(host, 'room:create', { name: 'Ana', config: { discussionSeconds: 0 } });
      const p2 = await connect();
      const p3 = await connect();
      await ask(p2, 'room:join', { name: 'Beto', code: created.code });
      await ask(p3, 'room:join', { name: 'Caro', code: created.code });
      await ask(host, 'game:start', {});
      await waitFor(host, 'room:state', (s) => s.phase === 'reveal');

      // Dos revelan; el tercero se cae sin revelar. La ronda debe avanzar igual.
      await ask(host, 'game:revealed', {});
      await ask(p2, 'game:revealed', {});
      p3.disconnect();
      await waitFor(host, 'room:state', (s) => s.phase === 'discussion');

      // Lo mismo en la votación.
      await ask(host, 'game:voting', {});
      await waitFor(host, 'room:state', (s) => s.phase === 'voting');
      await ask(host, 'game:vote', { targetId: 'skip' });
      await ask(p2, 'game:vote', { targetId: 'skip' });
      const fin = await waitFor(host, 'room:state', (s) => s.phase === 'results');
      assert.ok(fin.round.result, 'debería haber resultado');
    });

    await testAsync('caerse un momento en el lobby no te expulsa', async () => {
      const host = await connect();
      const created = await ask(host, 'room:create', { name: 'Ana' });
      const p2 = await connect();
      const j2 = await ask(p2, 'room:join', { name: 'Beto', code: created.code });

      p2.disconnect();
      await new Promise((r) => setTimeout(r, 150));
      const durante = await waitFor(host, 'room:state', (s) => s.players.some((p) => p.name === 'Beto' && !p.connected));
      assert.strictEqual(durante.players.length, 2, 'sigue en la sala mientras dura la gracia');

      const vuelve = await connect();
      await ask(vuelve, 'room:resume', { code: created.code, playerId: j2.playerId, token: j2.token });
      const despues = await waitFor(host, 'room:state', (s) => s.players.every((p) => p.connected));
      assert.strictEqual(despues.players.length, 2, 'recupera su lugar al volver');
    });

    await testAsync('el anfitrión puede cambiar la configuración y los demás no', async () => {
      const host = await connect();
      const created = await ask(host, 'room:create', { name: 'Ana' });
      const p2 = await connect();
      await ask(p2, 'room:join', { name: 'Beto', code: created.code });

      const res = await ask(host, 'room:config', { impostors: 2, maxPlayers: 10, hintEnabled: false, showCategory: false, categories: ['anime', 'peliculas'] });
      assert.strictEqual(res.config.impostors, 2);
      assert.strictEqual(res.config.hintEnabled, false);
      assert.deepStrictEqual(res.config.categories, ['anime', 'peliculas']);

      await assert.rejects(() => ask(p2, 'room:config', { impostors: 4 }), /anfitrión/);
    });

    await testAsync('el endpoint de categorías responde sin filtrar palabras', async () => {
      const res = await fetch(url + '/api/categories');
      const data = await res.json();
      assert.strictEqual(data.categories.length, CATEGORY_INDEX.length);
      assert.ok(!JSON.stringify(data).includes('|'));
      assert.ok(data.categories.every((c) => c.name && c.emoji && c.count > 0));
    });

    await testAsync('la app se sirve en la raíz', async () => {
      const res = await fetch(url + '/');
      const html = await res.text();
      assert.strictEqual(res.status, 200);
      assert.ok(html.includes('IMPOSTOR'));
      assert.ok(html.includes('/js/app.js'));
    });
  } finally {
    clients.forEach((c) => c.close());
    ioServer.close();
    server.close();
    clearInterval(store.cleanupTimer);
  }

  console.log('\n' + '─'.repeat(45));
  if (failures.length) {
    console.log(`  ${passed} pasaron · ${failures.length} fallaron\n`);
    failures.forEach((f) => console.log('  ✗ ' + f.name + '\n' + f.err.stack + '\n'));
    process.exit(1);
  }
  console.log(`  ✓ ${passed} pruebas pasaron\n`);
  process.exit(0);
})();
