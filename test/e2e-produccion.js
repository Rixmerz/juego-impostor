/**
 * Prueba una instancia YA DESPLEGADA con clientes Socket.IO reales.
 * No necesita navegador: juega una partida entera contra el servidor remoto.
 *
 *   node test/e2e-produccion.js https://tu-app.onrender.com
 *
 * Requiere `npm i -D socket.io-client` (ya está en devDependencies).
 * Detrás de un proxy corporativo: HTTPS_PROXY=... PROXY_CA=/ruta/ca.crt
 */
const assert = require('assert');
const fs = require('fs');
const { io } = require('socket.io-client');
const URL = process.argv[2] || process.env.URL;
if (!URL) {
  console.error('Uso: node test/e2e-produccion.js https://tu-app.onrender.com');
  process.exit(1);
}

// Solo si se corre detrás de un proxy con su propia CA (entornos corporativos).
let agent;
if (process.env.HTTPS_PROXY) {
  const { HttpsProxyAgent } = require('https-proxy-agent');
  const ca = process.env.PROXY_CA && fs.existsSync(process.env.PROXY_CA)
    ? fs.readFileSync(process.env.PROXY_CA)
    : undefined;
  agent = new HttpsProxyAgent(process.env.HTTPS_PROXY, ca ? { ca } : {});
}

const fallos = [];
const ok = (m) => console.log('  ✓ ' + m);
const check = (cond, m) => (cond ? ok(m) : (fallos.push(m), console.log('  ✗ ' + m)));

const clientes = [];
function conectar(transports) {
  const c = io(URL, {
    transports: transports || ['polling', 'websocket'],
    tryAllTransports: true,
    agent,
    rejectUnauthorized: true,
    timeout: 25000,
    reconnection: true
  });
  c.lastRoom = null;
  c.lastYou = null;
  c.on('room:state', (s) => { c.lastRoom = s; });
  c.on('you:state', (s) => { c.lastYou = s; });
  clientes.push(c);
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('no conectó en 25s')), 25000);
    c.on('connect', () => { clearTimeout(t); res(c); });
    c.on('connect_error', (e) => { clearTimeout(t); rej(new Error(e.message)); });
  });
}

function pedir(c, ev, payload) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout en ' + ev)), 15000);
    c.emit(ev, payload, (r) => { clearTimeout(t); r && r.ok ? res(r) : rej(new Error((r && r.error) || 'sin respuesta')); });
  });
}

function esperar(c, ev, pred) {
  const cache = ev === 'room:state' ? c.lastRoom : c.lastYou;
  if (cache && (!pred || pred(cache))) return Promise.resolve(cache);
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout esperando ' + ev)), 15000);
    const h = (d) => { if (!pred || pred(d)) { clearTimeout(t); c.off(ev, h); res(d); } };
    c.on(ev, h);
  });
}

(async () => {
  console.log('\n  Servidor: ' + URL + '\n');

  console.log('1. Versión desplegada');
  const appjs = await fetch(URL + '/js/app.js', { dispatcher: undefined }).then((r) => r.text()).catch(() => '');
  check(appjs.includes('tryAllTransports'), 'el cliente desplegado tiene el arreglo de transporte');
  const html = await fetch(URL + '/').then((r) => r.text()).catch(() => '');
  check(html.includes('screen-invite'), 'tiene la pantalla de invitación por link');
  check(html.includes('screen-waiting'), 'tiene la pantalla de espera para quien llega tarde');

  console.log('\n2. Transporte contra Render');
  const soloPolling = await conectar(['polling']);
  check(soloPolling.io.engine.transport.name === 'polling', 'conecta por polling (redes que bloquean WebSocket)');
  soloPolling.close();

  const auto = await conectar();
  await new Promise((r) => setTimeout(r, 3000));
  const tr = auto.io.engine.transport.name;
  check(tr === 'websocket', 'sube solo a WebSocket cuando la red lo permite (quedó en ' + tr + ')');

  console.log('\n3. Partida real con 4 jugadores');
  const anfitrion = auto;
  const creada = await pedir(anfitrion, 'room:create', {
    name: 'Ana',
    config: { maxPlayers: 8, impostors: 1, hintEnabled: true, showCategory: true, categories: ['animales'], discussionSeconds: 0 }
  });
  ok('sala creada: ' + creada.code);

  const b = await conectar();
  const c = await conectar();
  const jb = await pedir(b, 'room:join', { name: 'Beto', code: creada.code });
  await pedir(c, 'room:join', { name: 'Caro', code: creada.code.toLowerCase() });
  const lobby = await esperar(anfitrion, 'room:state', (s) => s.players.length === 3);
  check(lobby.players.length === 3, 'los 3 se ven en el lobby');

  await pedir(anfitrion, 'game:start', {});
  await esperar(anfitrion, 'room:state', (s) => s.phase === 'reveal');
  const cartas = await Promise.all([anfitrion, b, c].map((x) => esperar(x, 'you:state', (d) => d.private && d.private.round === 1)));
  const roles = cartas.map((x) => x.private.role);
  check(roles.filter((r) => r === 'impostor').length === 1, 'se reparte exactamente 1 impostor');
  const palabras = new Set(cartas.map((x) => x.private.word).filter(Boolean));
  check(palabras.size === 1, 'los tripulantes comparten la palabra ("' + [...palabras][0] + '")');
  const imp = cartas.find((x) => x.private.role === 'impostor').private;
  check(Boolean(imp.hint), 'el impostor recibe pista ("' + imp.hint + '")');
  check(imp.categoryName === 'Animales', 'se respeta el tópico elegido');

  console.log('\n4. Entrar con la partida en curso');
  const tarde = await conectar();
  const rt = await pedir(tarde, 'room:join', { name: 'Dani', code: creada.code });
  check(rt.pending === true, 'quien llega tarde entra y queda a la espera (antes era rechazado)');
  const cartaTarde = await esperar(tarde, 'you:state', (d) => d.private);
  check(cartaTarde.private.pending === true && !cartaTarde.private.word, 'no recibe carta de la ronda en curso');

  await pedir(anfitrion, 'game:revealed', {});
  await pedir(b, 'game:revealed', {});
  await pedir(c, 'game:revealed', {});
  const debate = await esperar(anfitrion, 'room:state', (s) => s.phase === 'discussion');
  check(debate.round.totalPlayers === 3, 'el que espera no bloquea el avance de la ronda');

  await pedir(anfitrion, 'game:voting', {});
  await esperar(anfitrion, 'room:state', (s) => s.phase === 'voting');
  let rechazado = false;
  try { await pedir(tarde, 'game:vote', { targetId: 'skip' }); } catch (e) { rechazado = /siguiente ronda/.test(e.message); }
  check(rechazado, 'el que espera no puede votar en una ronda que no juega');

  console.log('\n5. Sesión: caerse y volver a mitad de partida');
  const antes = b.lastYou.private;
  b.io.engine.close(); // corta el transporte, como al perder la red
  await new Promise((r) => setTimeout(r, 2500));
  await esperar(b, 'room:state', () => true).catch(() => {});
  check(b.connected, 'reconecta solo tras perder la red');

  const vuelve = await conectar();
  await pedir(vuelve, 'room:resume', { code: creada.code, playerId: jb.playerId, token: jb.token });
  const restaurado = await esperar(vuelve, 'you:state', (d) => d.private);
  check(restaurado.private.role === antes.role && restaurado.private.word === antes.word,
    'al volver recupera su mismo rol y su misma palabra');

  console.log('\n6. Cierre de ronda y la siguiente');
  await pedir(anfitrion, 'game:forceResults', {});
  const res = await esperar(anfitrion, 'room:state', (s) => s.phase === 'results');
  check(Boolean(res.round.result.word), 'los resultados revelan la palabra');
  await pedir(anfitrion, 'game:next', {});
  const r2 = await esperar(anfitrion, 'room:state', (s) => s.phase === 'reveal' && s.round.number === 2);
  check(r2.round.totalPlayers === 4, 'en la ronda 2 juegan los 4, incluido el que llegó tarde');
  const cartaR2 = await esperar(tarde, 'you:state', (d) => d.private && d.private.round === 2);
  check(!cartaR2.private.pending && Boolean(cartaR2.private.role), 'el que llegó tarde ya recibe carta');

  clientes.forEach((x) => x.close());
  console.log('');
  if (fallos.length) { console.log('  ✗ FALLARON ' + fallos.length + ':\n   - ' + fallos.join('\n   - ') + '\n'); process.exit(1); }
  console.log('  ✓ todo confirmado en producción\n');
  process.exit(0);
})().catch((e) => { console.error('\n  ERROR: ' + e.message + '\n'); clientes.forEach((x) => x.close()); process.exit(1); });
