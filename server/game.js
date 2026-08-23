'use strict';

const crypto = require('crypto');
const { CATEGORY_BY_ID, CATEGORY_INDEX, HINT_LEVEL_IDS } = require('./words');

const MIN_PLAYERS = 3;
const MAX_PLAYERS_CAP = 20;
const ROOM_TTL_MS = 1000 * 60 * 60 * 6; // 6 horas sin actividad

const PHASES = {
  LOBBY: 'lobby',
  REVEAL: 'reveal',
  DISCUSSION: 'discussion',
  VOTING: 'voting',
  RESULTS: 'results'
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin I,O,0,1

function randomInt(max) {
  return crypto.randomInt(max);
}

function pick(arr) {
  return arr[randomInt(arr.length)];
}

function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function sanitizeName(raw) {
  const name = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return name || 'Jugador';
}

function maxImpostorsFor(playerCount) {
  return Math.max(1, Math.floor((playerCount - 1) / 2));
}

function defaultConfig() {
  return {
    maxPlayers: 8,
    impostors: 1,
    hintEnabled: true,
    hintLevel: 'facil',
    showCategory: true,
    categories: CATEGORY_INDEX.map((c) => c.id),
    discussionSeconds: 180
  };
}

function normalizeConfig(input, current) {
  const base = current || defaultConfig();
  const next = { ...base };

  if (input && typeof input === 'object') {
    if (input.maxPlayers !== undefined) {
      const n = Number(input.maxPlayers);
      if (Number.isFinite(n)) next.maxPlayers = Math.min(MAX_PLAYERS_CAP, Math.max(MIN_PLAYERS, Math.round(n)));
    }
    if (input.impostors !== undefined) {
      const n = Number(input.impostors);
      if (Number.isFinite(n)) next.impostors = Math.max(1, Math.round(n));
    }
    if (input.hintEnabled !== undefined) next.hintEnabled = Boolean(input.hintEnabled);
    if (input.hintLevel !== undefined && HINT_LEVEL_IDS.indexOf(input.hintLevel) >= 0) {
      next.hintLevel = input.hintLevel;
    }
    if (input.showCategory !== undefined) next.showCategory = Boolean(input.showCategory);
    if (input.discussionSeconds !== undefined) {
      const n = Number(input.discussionSeconds);
      if (Number.isFinite(n)) next.discussionSeconds = Math.min(900, Math.max(0, Math.round(n / 15) * 15));
    }
    if (Array.isArray(input.categories)) {
      const valid = input.categories.filter((id) => CATEGORY_BY_ID.has(id));
      if (valid.length > 0) next.categories = Array.from(new Set(valid));
    }
  }

  // El número de impostores nunca puede romper la partida.
  next.impostors = Math.min(next.impostors, maxImpostorsFor(next.maxPlayers));
  return next;
}

class Room {
  constructor(code, config) {
    this.code = code;
    this.config = normalizeConfig(config, defaultConfig());
    this.phase = PHASES.LOBBY;
    this.players = new Map(); // playerId -> player
    this.order = []; // orden estable de llegada
    this.hostId = null;
    this.round = null;
    this.roundNumber = 0;
    this.lastActivity = Date.now();
    this.discussionEndsAt = null;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  get playerList() {
    return this.order.map((id) => this.players.get(id)).filter(Boolean);
  }

  get activePlayers() {
    return this.playerList.filter((p) => p.connected && !p.pending);
  }

  /** Jugadores conectados que participan de la ronda en curso. */
  get roundPlayers() {
    if (!this.round) return this.activePlayers;
    return this.playerList.filter((p) => p.connected && this.round.participants.has(p.id));
  }

  isParticipant(playerId) {
    return !this.round || this.round.participants.has(playerId);
  }

  addPlayer(name) {
    const player = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(16).toString('hex'),
      name: sanitizeName(name),
      socketId: null,
      connected: true,
      score: 0,
      ready: false,
      // Quien llega con una ronda en curso espera a la siguiente: no recibe
      // carta, no vota, y no bloquea el avance de los que sí están jugando.
      pending: this.phase !== PHASES.LOBBY,
      joinedAt: Date.now()
    };
    this.players.set(player.id, player);
    this.order.push(player.id);
    if (!this.hostId) this.hostId = player.id;
    this.touch();
    return player;
  }

  removePlayer(playerId) {
    if (!this.players.has(playerId)) return;
    const wasParticipant = this.round && this.round.participants.has(playerId);
    this.players.delete(playerId);
    this.order = this.order.filter((id) => id !== playerId);
    if (this.round) {
      this.round.impostorIds.delete(playerId);
      this.round.participants.delete(playerId);
      this.round.revealed.delete(playerId);
      this.round.votes.delete(playerId);
      for (const [voter, target] of Array.from(this.round.votes.entries())) {
        if (target === playerId) this.round.votes.delete(voter);
      }
      this.round.order = this.round.order.filter((id) => id !== playerId);
    }
    if (this.hostId === playerId) {
      this.hostId = this.order[0] || null;
    }
    // Si el que se fue era el último que faltaba, la ronda no puede quedar colgada.
    if (wasParticipant) this.unblockPhase();
    this.touch();
  }

  /** Reevalúa si la fase actual ya se puede cerrar (alguien se fue o se desconectó). */
  unblockPhase() {
    if (!this.round) return;
    const esperando = this.roundPlayers;
    if (esperando.length === 0) return;
    if (this.phase === PHASES.REVEAL && esperando.every((p) => this.round.revealed.has(p.id))) {
      this.beginDiscussion();
    } else if (this.phase === PHASES.VOTING && esperando.every((p) => this.round.votes.has(p.id))) {
      this.resolveVotes();
    }
  }

  isNameTaken(name) {
    const clean = sanitizeName(name).toLowerCase();
    return this.playerList.some((p) => p.name.toLowerCase() === clean);
  }

  uniqueName(name) {
    let candidate = sanitizeName(name);
    let n = 2;
    while (this.isNameTaken(candidate)) {
      candidate = `${sanitizeName(name).slice(0, 13)} ${n}`;
      n++;
    }
    return candidate;
  }

  canStart() {
    const count = this.activePlayers.length;
    if (count < MIN_PLAYERS) return { ok: false, reason: `Se necesitan al menos ${MIN_PLAYERS} jugadores` };
    if (this.config.impostors > maxImpostorsFor(count)) {
      return { ok: false, reason: `Con ${count} jugadores el máximo es ${maxImpostorsFor(count)} impostor(es)` };
    }
    if (!this.config.categories.length) return { ok: false, reason: 'Elige al menos una categoría' };
    return { ok: true };
  }

  startRound() {
    // Los que estaban esperando entran a esta ronda: hay que sumarlos antes de
    // validar y antes de repartir, o quedarían fuera una ronda de más.
    for (const p of this.players.values()) p.pending = false;

    const check = this.canStart();
    if (!check.ok) return check;

    const players = this.activePlayers;
    const categoryId = pick(this.config.categories);
    const category = CATEGORY_BY_ID.get(categoryId);
    const entry = pick(category.words);

    const impostorIds = new Set(shuffle(players.map((p) => p.id)).slice(0, this.config.impostors));

    this.roundNumber += 1;
    this.round = {
      number: this.roundNumber,
      categoryId: category.id,
      categoryName: category.name,
      categoryEmoji: category.emoji,
      word: entry.word,
      hints: entry.hints,
      hint: entry.hints[this.config.hintLevel] || entry.hints.facil,
      impostorIds,
      participants: new Set(players.map((p) => p.id)),
      revealed: new Set(),
      votes: new Map(),
      order: shuffle(players.map((p) => p.id)),
      result: null
    };

    for (const p of this.players.values()) p.ready = false;
    this.phase = PHASES.REVEAL;
    this.discussionEndsAt = null;
    this.touch();
    return { ok: true };
  }

  markRevealed(playerId) {
    if (this.phase !== PHASES.REVEAL || !this.round) return false;
    if (!this.players.has(playerId)) return false;
    if (!this.isParticipant(playerId)) return false;
    this.round.revealed.add(playerId);
    const player = this.players.get(playerId);
    player.ready = true;
    this.touch();

    const pending = this.roundPlayers.filter((p) => !this.round.revealed.has(p.id));
    if (pending.length === 0) {
      this.beginDiscussion();
      return true;
    }
    return false;
  }

  beginDiscussion() {
    if (!this.round) return;
    this.phase = PHASES.DISCUSSION;
    this.discussionEndsAt = this.config.discussionSeconds > 0
      ? Date.now() + this.config.discussionSeconds * 1000
      : null;
    this.touch();
  }

  beginVoting() {
    if (!this.round) return { ok: false, reason: 'No hay ronda activa' };
    if (this.phase !== PHASES.DISCUSSION && this.phase !== PHASES.REVEAL) {
      return { ok: false, reason: 'No es momento de votar' };
    }
    this.phase = PHASES.VOTING;
    this.round.votes = new Map();
    this.discussionEndsAt = null;
    this.touch();
    return { ok: true };
  }

  castVote(voterId, targetId) {
    if (this.phase !== PHASES.VOTING || !this.round) return { ok: false, reason: 'No es momento de votar' };
    if (!this.players.has(voterId)) return { ok: false, reason: 'No estás en la sala' };
    if (!this.isParticipant(voterId)) return { ok: false, reason: 'Entras en la siguiente ronda' };
    if (voterId === targetId) return { ok: false, reason: 'No puedes votarte a ti mismo' };
    if (targetId !== 'skip' && !this.players.has(targetId)) return { ok: false, reason: 'Ese jugador ya no está' };

    this.round.votes.set(voterId, targetId);
    this.touch();

    const pending = this.roundPlayers.filter((p) => !this.round.votes.has(p.id));
    if (pending.length === 0) this.resolveVotes();
    return { ok: true, resolved: this.phase === PHASES.RESULTS };
  }

  resolveVotes() {
    if (!this.round) return;
    const tally = new Map();
    for (const target of this.round.votes.values()) {
      if (target === 'skip') continue;
      tally.set(target, (tally.get(target) || 0) + 1);
    }

    let ejectedId = null;
    let top = 0;
    let tie = false;
    for (const [id, count] of tally.entries()) {
      if (count > top) {
        top = count;
        ejectedId = id;
        tie = false;
      } else if (count === top) {
        tie = true;
      }
    }
    if (tie || top === 0) ejectedId = null;

    const impostorIds = Array.from(this.round.impostorIds);
    const crewWins = Boolean(ejectedId) && this.round.impostorIds.has(ejectedId);

    for (const player of this.players.values()) {
      const isImpostor = this.round.impostorIds.has(player.id);
      if (crewWins && !isImpostor) player.score += 1;
      if (!crewWins && isImpostor) player.score += 2;
    }

    this.round.result = {
      ejectedId,
      ejectedName: ejectedId ? this.players.get(ejectedId)?.name || '???' : null,
      tie: tie || top === 0,
      crewWins,
      word: this.round.word,
      hint: this.round.hint,
      categoryName: this.round.categoryName,
      categoryEmoji: this.round.categoryEmoji,
      impostors: impostorIds.map((id) => ({ id, name: this.players.get(id)?.name || 'Se fue' })),
      tally: Array.from(tally.entries()).map(([id, count]) => ({
        id,
        name: this.players.get(id)?.name || '???',
        count
      })).sort((a, b) => b.count - a.count),
      votes: Array.from(this.round.votes.entries()).map(([voterId, targetId]) => ({
        voterId,
        voterName: this.players.get(voterId)?.name || '???',
        targetId,
        targetName: targetId === 'skip' ? 'Nadie' : this.players.get(targetId)?.name || '???'
      }))
    };

    this.phase = PHASES.RESULTS;
    this.touch();
  }

  backToLobby() {
    this.phase = PHASES.LOBBY;
    this.round = null;
    this.discussionEndsAt = null;
    for (const p of this.players.values()) p.ready = false;
    this.touch();
  }

  resetScores() {
    for (const p of this.players.values()) p.score = 0;
    this.roundNumber = 0;
    this.touch();
  }

  /** Estado público: nunca incluye la palabra secreta ni quién es impostor (salvo en resultados). */
  publicState() {
    const revealed = this.round ? this.round.revealed : new Set();
    const votes = this.round ? this.round.votes : new Map();

    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      config: this.config,
      roundNumber: this.roundNumber,
      minPlayers: MIN_PLAYERS,
      maxImpostors: maxImpostorsFor(Math.max(this.activePlayers.length, MIN_PLAYERS)),
      discussionEndsAt: this.discussionEndsAt,
      players: this.playerList.map((p) => ({
        id: p.id,
        name: p.name,
        isHost: p.id === this.hostId,
        connected: p.connected,
        score: p.score,
        pending: Boolean(p.pending) || (this.round ? !this.round.participants.has(p.id) : false),
        ready: revealed.has(p.id),
        hasVoted: votes.has(p.id)
      })),
      round: this.round
        ? {
            number: this.round.number,
            categoryName: this.config.showCategory ? this.round.categoryName : null,
            categoryEmoji: this.config.showCategory ? this.round.categoryEmoji : null,
            order: this.round.order.map((id) => this.players.get(id)?.name).filter(Boolean),
            revealedCount: this.round.revealed.size,
            voteCount: this.round.votes.size,
            totalPlayers: this.roundPlayers.length,
            result: this.phase === PHASES.RESULTS ? this.round.result : null
          }
        : null
    };
  }

  /** Estado privado por jugador: su rol y su carta. */
  privateState(playerId) {
    if (!this.round || this.phase === PHASES.LOBBY) return null;
    if (!this.players.has(playerId)) return null;
    if (!this.isParticipant(playerId)) return { pending: true, round: this.round.number };

    const isImpostor = this.round.impostorIds.has(playerId);
    const showCategory = this.config.showCategory;

    return {
      round: this.round.number,
      role: isImpostor ? 'impostor' : 'crew',
      word: isImpostor ? null : this.round.word,
      hint: isImpostor && this.config.hintEnabled ? this.round.hint : null,
      hintEnabled: this.config.hintEnabled,
      hintLevel: this.config.hintLevel,
      categoryName: showCategory ? this.round.categoryName : null,
      categoryEmoji: showCategory ? this.round.categoryEmoji : null,
      impostorCount: this.config.impostors,
      revealed: this.round.revealed.has(playerId)
    };
  }
}

class RoomStore {
  constructor() {
    this.rooms = new Map();
    this.cleanupTimer = setInterval(() => this.cleanup(), 1000 * 60 * 10);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  generateCode() {
    let code;
    let attempts = 0;
    do {
      code = Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      attempts++;
    } while (this.rooms.has(code) && attempts < 50);
    return code;
  }

  create(config) {
    const code = this.generateCode();
    const room = new Room(code, config);
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    if (!code) return null;
    return this.rooms.get(String(code).toUpperCase().trim()) || null;
  }

  destroy(code) {
    this.rooms.delete(code);
  }

  cleanup() {
    const now = Date.now();
    for (const [code, room] of this.rooms.entries()) {
      const empty = room.playerList.every((p) => !p.connected);
      if (now - room.lastActivity > ROOM_TTL_MS || (empty && now - room.lastActivity > 1000 * 60 * 30)) {
        this.rooms.delete(code);
      }
    }
  }
}

module.exports = {
  Room,
  RoomStore,
  PHASES,
  MIN_PLAYERS,
  MAX_PLAYERS_CAP,
  maxImpostorsFor,
  defaultConfig,
  normalizeConfig,
  sanitizeName
};
