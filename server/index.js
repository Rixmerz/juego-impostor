'use strict';

const path = require('path');
const http = require('http');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');
const qrcode = require('qrcode-terminal');

const { CATEGORY_INDEX } = require('./words');
const {
  RoomStore,
  PHASES,
  MIN_PLAYERS,
  MAX_PLAYERS_CAP,
  maxImpostorsFor,
  normalizeConfig,
  sanitizeName
} = require('./game');

const PORT = process.env.PORT !== undefined && process.env.PORT !== ''
  ? Number(process.env.PORT)
  : 3000;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 30000
});

const store = new RoomStore();

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', extensions: ['html'] }));

app.get('/api/categories', (_req, res) => res.json({ categories: CATEGORY_INDEX }));
app.get('/api/health', (_req, res) => res.json({ ok: true, rooms: store.rooms.size, uptime: process.uptime() }));

// SPA fallback: cualquier ruta desconocida devuelve el juego.
app.use((_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

/* ------------------------------------------------------------------ */
/* Socket.IO                                                           */
/* ------------------------------------------------------------------ */

// socket.data = { roomCode, playerId }

function broadcastRoom(room) {
  const state = room.publicState();
  io.to(room.code).emit('room:state', state);
  // Cada jugador recibe además su carta privada.
  for (const player of room.players.values()) {
    if (!player.socketId) continue;
    io.to(player.socketId).emit('you:state', {
      playerId: player.id,
      isHost: player.id === room.hostId,
      private: room.privateState(player.id)
    });
  }
}

function fail(cb, message) {
  if (typeof cb === 'function') cb({ ok: false, error: message });
}

function attach(socket, room, player) {
  // Si el jugador tenía otro socket abierto, lo desconectamos.
  if (player.socketId && player.socketId !== socket.id) {
    const old = io.sockets.sockets.get(player.socketId);
    if (old) {
      old.emit('session:replaced');
      old.leave(room.code);
      old.data = {};
    }
  }
  player.socketId = socket.id;
  player.connected = true;
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);
}

io.on('connection', (socket) => {
  socket.data = {};

  socket.on('room:create', (payload, cb) => {
    const name = sanitizeName(payload?.name);
    const room = store.create(payload?.config);
    const player = room.addPlayer(name);
    attach(socket, room, player);
    if (typeof cb === 'function') {
      cb({ ok: true, code: room.code, playerId: player.id, token: player.token });
    }
    broadcastRoom(room);
  });

  socket.on('room:join', (payload, cb) => {
    const room = store.get(payload?.code);
    if (!room) return fail(cb, 'No existe una sala con ese código');
    if (room.phase !== PHASES.LOBBY) return fail(cb, 'La partida ya empezó. Espera a que termine la ronda');
    if (room.playerList.length >= room.config.maxPlayers) return fail(cb, 'La sala está llena');

    const player = room.addPlayer(room.uniqueName(payload?.name));
    attach(socket, room, player);
    if (typeof cb === 'function') {
      cb({ ok: true, code: room.code, playerId: player.id, token: player.token });
    }
    broadcastRoom(room);
  });

  socket.on('room:resume', (payload, cb) => {
    const room = store.get(payload?.code);
    if (!room) return fail(cb, 'La sala ya no existe');
    const player = room.players.get(payload?.playerId);
    if (!player || player.token !== payload?.token) return fail(cb, 'Sesión inválida');

    attach(socket, room, player);
    room.touch();
    if (typeof cb === 'function') cb({ ok: true, code: room.code, playerId: player.id, token: player.token });
    broadcastRoom(room);
  });

  socket.on('room:config', (payload, cb) => {
    const room = store.get(socket.data.roomCode);
    if (!room) return fail(cb, 'Sala no encontrada');
    if (socket.data.playerId !== room.hostId) return fail(cb, 'Solo el anfitrión puede cambiar la configuración');
    if (room.phase !== PHASES.LOBBY) return fail(cb, 'No puedes cambiar la configuración en plena partida');

    room.config = normalizeConfig(payload, room.config);
    room.touch();
    if (typeof cb === 'function') cb({ ok: true, config: room.config });
    broadcastRoom(room);
  });

  socket.on('room:kick', (payload, cb) => {
    const room = store.get(socket.data.roomCode);
    if (!room) return fail(cb, 'Sala no encontrada');
    if (socket.data.playerId !== room.hostId) return fail(cb, 'Solo el anfitrión puede expulsar');
    const target = room.players.get(payload?.playerId);
    if (!target || target.id === room.hostId) return fail(cb, 'No puedes expulsar a ese jugador');

    const targetSocket = target.socketId ? io.sockets.sockets.get(target.socketId) : null;
    room.removePlayer(target.id);
    if (targetSocket) {
      targetSocket.emit('room:kicked');
      targetSocket.leave(room.code);
      targetSocket.data = {};
    }
    if (typeof cb === 'function') cb({ ok: true });
    broadcastRoom(room);
  });

  socket.on('game:start', (_payload, cb) => {
    const room = store.get(socket.data.roomCode);
    if (!room) return fail(cb, 'Sala no encontrada');
    if (socket.data.playerId !== room.hostId) return fail(cb, 'Solo el anfitrión puede iniciar');

    const result = room.startRound();
    if (!result.ok) return fail(cb, result.reason);
    if (typeof cb === 'function') cb({ ok: true });
    broadcastRoom(room);
  });

  socket.on('game:revealed', (_payload, cb) => {
    const room = store.get(socket.data.roomCode);
    if (!room) return fail(cb, 'Sala no encontrada');
    room.markRevealed(socket.data.playerId);
    if (typeof cb === 'function') cb({ ok: true });
    broadcastRoom(room);
  });

  socket.on('game:discussion', (_payload, cb) => {
    const room = store.get(socket.data.roomCode);
    if (!room) return fail(cb, 'Sala no encontrada');
    if (socket.data.playerId !== room.hostId) return fail(cb, 'Solo el anfitrión puede avanzar');
    room.beginDiscussion();
    if (typeof cb === 'function') cb({ ok: true });
    broadcastRoom(room);
  });

  socket.on('game:voting', (_payload, cb) => {
    const room = store.get(socket.data.roomCode);
    if (!room) return fail(cb, 'Sala no encontrada');
    if (socket.data.playerId !== room.hostId) return fail(cb, 'Solo el anfitrión puede abrir la votación');
    const result = room.beginVoting();
    if (!result.ok) return fail(cb, result.reason);
    if (typeof cb === 'function') cb({ ok: true });
    broadcastRoom(room);
  });

  socket.on('game:vote', (payload, cb) => {
    const room = store.get(socket.data.roomCode);
    if (!room) return fail(cb, 'Sala no encontrada');
    const result = room.castVote(socket.data.playerId, payload?.targetId);
    if (!result.ok) return fail(cb, result.reason);
    if (typeof cb === 'function') cb({ ok: true });
    broadcastRoom(room);
  });

  socket.on('game:forceResults', (_payload, cb) => {
    const room = store.get(socket.data.roomCode);
    if (!room) return fail(cb, 'Sala no encontrada');
    if (socket.data.playerId !== room.hostId) return fail(cb, 'Solo el anfitrión puede cerrar la votación');
    if (room.phase !== PHASES.VOTING) return fail(cb, 'No hay votación abierta');
    room.resolveVotes();
    if (typeof cb === 'function') cb({ ok: true });
    broadcastRoom(room);
  });

  socket.on('game:next', (_payload, cb) => {
    const room = store.get(socket.data.roomCode);
    if (!room) return fail(cb, 'Sala no encontrada');
    if (socket.data.playerId !== room.hostId) return fail(cb, 'Solo el anfitrión puede seguir');

    const result = room.startRound();
    if (!result.ok) {
      room.backToLobby();
      broadcastRoom(room);
      return fail(cb, result.reason);
    }
    if (typeof cb === 'function') cb({ ok: true });
    broadcastRoom(room);
  });

  socket.on('game:lobby', (_payload, cb) => {
    const room = store.get(socket.data.roomCode);
    if (!room) return fail(cb, 'Sala no encontrada');
    if (socket.data.playerId !== room.hostId) return fail(cb, 'Solo el anfitrión puede volver a la sala');
    room.backToLobby();
    if (typeof cb === 'function') cb({ ok: true });
    broadcastRoom(room);
  });

  socket.on('game:resetScores', (_payload, cb) => {
    const room = store.get(socket.data.roomCode);
    if (!room) return fail(cb, 'Sala no encontrada');
    if (socket.data.playerId !== room.hostId) return fail(cb, 'Solo el anfitrión puede reiniciar el marcador');
    room.resetScores();
    if (typeof cb === 'function') cb({ ok: true });
    broadcastRoom(room);
  });

  socket.on('room:leave', (_payload, cb) => {
    const room = store.get(socket.data.roomCode);
    if (room && socket.data.playerId) {
      room.removePlayer(socket.data.playerId);
      socket.leave(room.code);
      if (room.playerList.length === 0) store.destroy(room.code);
      else broadcastRoom(room);
    }
    socket.data = {};
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('disconnect', () => {
    const room = store.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players.get(socket.data.playerId);
    if (!player || player.socketId !== socket.id) return;

    player.connected = false;
    player.socketId = null;
    room.touch();

    // En el lobby no tiene sentido guardar sillas vacías.
    if (room.phase === PHASES.LOBBY) {
      room.removePlayer(player.id);
      if (room.playerList.length === 0) {
        store.destroy(room.code);
        return;
      }
    }
    broadcastRoom(room);
  });
});

/* ------------------------------------------------------------------ */
/* Arranque + descubrimiento de IP en la red local                     */
/* ------------------------------------------------------------------ */

function localAddresses() {
  const nets = os.networkInterfaces();
  const found = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) found.push({ name, address: addr.address });
    }
  }
  // Las redes domésticas típicas primero.
  return found.sort((a, b) => {
    const score = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
    return score(a.address) - score(b.address);
  });
}

server.listen(PORT, HOST, () => {
  const port = server.address().port; // PORT puede ser 0 (puerto efímero)
  const addresses = localAddresses();
  const lan = addresses[0];
  const lanUrl = lan ? `http://${lan.address}:${port}` : null;

  console.log('');
  console.log('  🕵️  JUEGO DEL IMPOSTOR');
  console.log('  ─────────────────────────────────────────');
  console.log(`  Local:   http://localhost:${port}`);
  if (addresses.length) {
    addresses.forEach((a, i) => {
      const label = i === 0 ? 'WiFi:  ' : '       ';
      console.log(`  ${label} http://${a.address}:${port}   (${a.name})`);
    });
  } else {
    console.log('  WiFi:    no se detectó una interfaz de red local');
  }
  console.log('  ─────────────────────────────────────────');

  if (lanUrl && process.env.NO_QR !== '1') {
    console.log('  Escanea este QR desde el celular:');
    console.log('');
    qrcode.generate(lanUrl, { small: true }, (qr) => {
      console.log(qr.split('\n').map((line) => '  ' + line).join('\n'));
      console.log(`  ${lanUrl}`);
      console.log('');
    });
  }
});

function shutdown() {
  console.log('\n  Cerrando servidor...');
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, server, io, store, MIN_PLAYERS, MAX_PLAYERS_CAP, maxImpostorsFor };
