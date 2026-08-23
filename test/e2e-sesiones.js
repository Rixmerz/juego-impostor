const { chromium, devices } = require('playwright');
const URL = process.env.URL || 'http://localhost:3000';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const fallos = [];
  const ok = (m) => console.log('  ✓ ' + m);
  const check = (cond, m) => cond ? ok(m) : (fallos.push(m), console.log('  ✗ ' + m));

  async function nuevo(opts) {
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await ctx.newPage();
    if (opts && opts.sinWs) {
      await page.addInitScript(() => { window.WebSocket = function () { throw new Error('bloqueado'); }; });
    }
    return page;
  }

  console.log('\n1. Fallback de transporte');
  for (const [label, sinWs] of [['red normal', false], ['red que bloquea WebSocket', true]]) {
    const p = await nuevo({ sinWs });
    await p.goto(URL, { waitUntil: 'domcontentloaded' });
    const r = await p.evaluate(() => new Promise((res) => {
      const t = setTimeout(() => res({ ok: false }), 15000);
      const probe = io({ transports: ['polling', 'websocket'], tryAllTransports: true });
      probe.on('connect', () => { clearTimeout(t); setTimeout(() => res({ ok: true, tr: probe.io.engine.transport.name }), 1500); });
      probe.on('connect_error', () => { clearTimeout(t); res({ ok: false }); });
    }));
    check(r.ok, label + ' → conecta' + (r.tr ? ' (' + r.tr + ')' : ''));
    await p.context().close();
  }

  console.log('\n2. Sala con 3 jugadores y link directo');
  const host = await nuevo();
  await host.goto(URL, { waitUntil: 'networkidle' });
  await host.fill('#input-name', 'Ana');
  await host.click('#btn-go-create');
  await host.waitForSelector('#screen-create.is-active');
  await host.waitForFunction(() => document.querySelectorAll('.chip').length > 0);
  await host.click('#btn-create');
  await host.waitForSelector('#screen-lobby.is-active');
  const code = (await host.textContent('#room-code')).trim();
  ok('sala ' + code);

  const inv = await nuevo();
  await inv.goto(URL + '/?sala=' + code, { waitUntil: 'networkidle' });
  await inv.waitForSelector('#screen-invite.is-active', { timeout: 5000 });
  check((await inv.textContent('#invite-code')).trim() === code, 'link directo muestra "Te invitaron a la sala ' + code + '"');
  await inv.fill('#input-invite-name', 'Beto');
  await inv.click('#btn-invite-join');
  await inv.waitForSelector('#screen-lobby.is-active', { timeout: 5000 });
  ok('entra desde el link poniendo solo el nombre');

  const auto = await nuevo();
  await auto.goto(URL, { waitUntil: 'networkidle' });
  await auto.evaluate(() => localStorage.setItem('impostor:name', 'Caro'));
  await auto.goto(URL + '/?sala=' + code, { waitUntil: 'networkidle' });
  await auto.waitForSelector('#screen-lobby.is-active', { timeout: 8000 });
  ok('con el nombre ya guardado, el link entra solo');

  await host.waitForFunction(() => document.querySelectorAll('#players .player').length === 3);
  ok('los 3 se ven entre sí en el lobby');

  console.log('\n3. Entrar con la partida en curso');
  await host.click('#btn-start');
  await host.waitForSelector('#screen-reveal.is-active');

  const tarde = await nuevo();
  await tarde.goto(URL + '/?sala=' + code, { waitUntil: 'networkidle' });
  await tarde.waitForSelector('#screen-invite.is-active', { timeout: 5000 });
  await tarde.fill('#input-invite-name', 'Dani');
  await tarde.click('#btn-invite-join');
  await tarde.waitForSelector('#screen-waiting.is-active', { timeout: 6000 });
  ok('entra a mitad de partida: "' + (await tarde.textContent('#waiting-text')).trim() + '"');
  check(!(await tarde.isVisible('#role-word')), 'no ve ninguna carta de esta ronda');

  for (const p of [host, inv, auto]) {
    await p.$eval('#reveal-card', (el) => el.classList.remove('is-open'));
    await p.click('#btn-ready');
  }
  await host.waitForSelector('#screen-discussion.is-active', { timeout: 6000 });
  ok('el que espera no bloquea el avance de la ronda');

  await host.click('#btn-to-voting');
  await host.waitForSelector('#screen-voting.is-active');
  const botones = await host.$$eval('.vote-btn:not(.is-skip)', (els) => els.length);
  check(botones === 3, 'la votación lista solo a los 3 que juegan (vio ' + botones + ')');

  await host.click('#btn-force-results');
  await host.waitForSelector('#screen-results.is-active', { timeout: 6000 });
  await host.click('#btn-next-round');
  await tarde.waitForSelector('#screen-reveal.is-active', { timeout: 8000 });
  ok('en la ronda 2 el que esperaba ya recibe carta');

  console.log('\n4. Sesión: perder conexión y volver');
  await inv.context().setOffline(true);
  await inv.waitForTimeout(1500);
  await inv.context().setOffline(false);
  await inv.waitForFunction(() => document.querySelector('#connection').hidden, { timeout: 25000 });
  const sigueDentro = await inv.evaluate(() => !document.querySelector('#screen-home').classList.contains('is-active'));
  check(sigueDentro, 'tras cortar y volver la conexión, sigue en la partida');

  console.log('');
  await browser.close();
  if (fallos.length) { console.log('  FALLARON: ' + fallos.length + '\n'); process.exit(1); }
  console.log('  todo ok\n');
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
