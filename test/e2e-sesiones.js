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

  // Sin un solo voto no se puede cerrar la votación.
  check(await host.isDisabled('#btn-force-results'), 'no deja cerrar una votación en la que nadie votó');
  await host.evaluate(() => {
    const b = [...document.querySelectorAll('.vote-btn')].find((x) => x.classList.contains('is-skip'));
    b.click();
  });
  await host.waitForTimeout(400);
  check(!(await host.isDisabled('#btn-force-results')), 'con al menos un voto ya se puede cerrar');

  await host.click('#btn-force-results');
  await host.waitForSelector('#screen-results.is-active', { timeout: 6000 });
  await host.click('#btn-next-round');
  await tarde.waitForSelector('#screen-reveal.is-active', { timeout: 8000 });
  ok('en la ronda 2 el que esperaba ya recibe carta');

  console.log('\n4. Volver a ver tu carta si te caes');
  for (const p of [host, inv, auto, tarde]) {
    await p.$eval('#reveal-card', (el) => el.classList.remove('is-open'));
    await p.click('#btn-ready');
  }
  await host.waitForSelector('#screen-discussion.is-active', { timeout: 8000 });
  const suPalabra = await host.evaluate(() => document.querySelector('#role-word').textContent.trim());
  const btnPeek = '#screen-discussion [data-peek]';
  check(await host.isVisible(btnPeek), 'en el debate hay un botón para reconsultar la carta');

  // La carta va sobre toda la pantalla: antes se desplegaba debajo del botón
  // y quedaba cortada fuera del área visible.
  const geo = await host.evaluate(() => {
    document.querySelector('#screen-discussion [data-peek]')
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const ov = document.getElementById('peek-overlay');
    const r = document.getElementById('peek-card').getBoundingClientRect();
    return {
      abierta: !ov.hidden,
      fija: getComputedStyle(ov).position === 'fixed',
      cabeEntera: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
      alto: Math.round(r.height),
      vh: window.innerHeight,
      palabra: document.getElementById('peek-word').textContent.trim()
    };
  });
  check(geo.abierta && geo.fija, 'se abre sobre toda la pantalla');
  check(geo.cabeEntera, 'la carta cabe entera sin scroll (' + geo.alto + 'px en ' + geo.vh + 'px)');
  check(geo.palabra === suPalabra, 'muestra la misma carta de esta ronda (vio "' + geo.palabra + '")');
  await host.evaluate(() => document.getElementById('peek-overlay')
    .dispatchEvent(new PointerEvent('pointerup', { bubbles: true })));
  await host.waitForTimeout(200);
  check(await host.isHidden('#peek-overlay'), 'al soltar, la carta se vuelve a ocultar');

  console.log('\n5. Dificultad de la pista');
  {
    const p = await nuevo();
    await p.goto(URL, { waitUntil: 'networkidle' });
    await p.fill('#input-name', 'Eva');
    await p.click('#btn-go-create');
    await p.waitForSelector('#screen-create.is-active');
    await p.waitForFunction(() => document.querySelectorAll('.chip').length > 0);
    check(await p.isVisible('#hint-level'), 'hay selector de dificultad');
    for (const [nivel, esperado] of [['facil', 'se pelea sin armas'], ['media', 'Oriental y sin armas'], ['dificil', 'Disciplina»']]) {
      await p.click('#hint-level button[data-level="' + nivel + '"]');
      const muestra = (await p.textContent('#hint-sample')).trim();
      check(muestra.includes(esperado), nivel + ' → ' + muestra.replace('Por ejemplo, para Karate: ', ''));
    }
    await p.click('.switch[data-toggle="hintEnabled"]');
    check(await p.isHidden('#hint-level'), 'sin pista, el selector se oculta');
    await p.context().close();
  }

  console.log('\n6. Reconectar con el link estando la sala llena');
  {
    const a = await nuevo();
    await a.goto(URL, { waitUntil: 'networkidle' });
    await a.fill('#input-name', 'Ana');
    await a.click('#btn-go-create');
    await a.waitForSelector('#screen-create.is-active');
    await a.waitForFunction(() => document.querySelectorAll('.chip').length > 0);
    for (let i = 0; i < 5; i++) await a.click('.step-btn[data-step="maxPlayers"][data-delta="-1"]');
    await a.click('#btn-create');
    await a.waitForSelector('#screen-lobby.is-active');
    const sala = (await a.textContent('#room-code')).trim();
    check((await a.textContent('#player-count')).trim() === '1/3', 'sala con 3 cupos');

    const b2 = await nuevo(); const c2 = await nuevo();
    for (const [p, n] of [[b2, 'Beto'], [c2, 'Caro']]) {
      await p.goto(URL, { waitUntil: 'networkidle' });
      await p.fill('#input-name', n);
      await p.click('#btn-go-join');
      await p.fill('#input-code', sala);
      await p.click('#btn-join');
      await p.waitForSelector('#screen-lobby.is-active');
    }
    await a.waitForFunction(() => document.querySelectorAll('#players .player').length === 3);
    await a.click('#btn-start');
    await b2.waitForSelector('#screen-reveal.is-active');

    // Beto pierde la conexión y reabre el link de invitación con la sala llena.
    await b2.context().setOffline(true);
    await b2.waitForTimeout(1000);
    await b2.context().setOffline(false);
    await b2.goto(URL + '/?sala=' + sala, { waitUntil: 'networkidle' });
    let volvio = false;
    try {
      await b2.waitForFunction(() => {
        const act = document.querySelector('.screen.is-active');
        return act && ['screen-reveal', 'screen-discussion', 'screen-lobby', 'screen-voting', 'screen-results'].includes(act.id);
      }, { timeout: 15000 });
      volvio = true;
    } catch (e) { /* se quedó afuera */ }
    check(volvio, 'vuelve con el link aunque la sala esté llena');
    const aviso = await b2.textContent('#toast');
    check(!/llena/i.test(aviso), 'no dice "la sala está llena" (dijo: "' + aviso.trim() + '")');

    // Y el inicio ofrece volver.
    await b2.goto(URL, { waitUntil: 'networkidle' });
    await b2.waitForTimeout(700);
    const volver = (await b2.textContent('#btn-resume')).trim();
    check(/Volver a la sala/.test(volver), 'el inicio ofrece "' + volver + '"');
  }

  console.log('\n7. Un navegador con la versión vieja en caché');
  {
    // Reproduce el fallo real: el celular ya tenía el CSS y el JS cacheados y,
    // tras desplegar, seguía usándolos — la página cargaba sin estilos ni conducta.
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const p = await ctx.newPage();
    const irAConfigurar = async () => {
      await p.fill('#input-name', 'Zoe');
      await p.click('#btn-go-create');
      await p.waitForSelector('#screen-create.is-active');
      await p.waitForFunction(() => document.querySelectorAll('.chip').length > 0);
    };

    await p.goto(URL, { waitUntil: 'networkidle' });
    await irAConfigurar();
    check(await p.isVisible('#hint-level'), 'primera carga: el selector de dificultad está');

    // Segunda visita: el CSS y el JS ya están en caché del navegador.
    await p.reload({ waitUntil: 'networkidle' });
    await irAConfigurar();

    const estilado = await p.evaluate(() => {
      const seg = document.querySelector('#hint-level');
      if (!seg) return { existe: false };
      const cs = getComputedStyle(seg);
      const btn = seg.querySelector('button');
      return {
        existe: true,
        conEstilo: cs.display === 'grid',
        botones: seg.querySelectorAll('button').length,
        alto: Math.round(btn.getBoundingClientRect().height)
      };
    });
    check(estilado.existe, 'tras recargar, el componente sigue en el DOM');
    check(estilado.conEstilo, 'y con su CSS aplicado (display: ' + (estilado.conEstilo ? 'grid' : 'sin estilo') + ')');
    check(estilado.botones === 3 && estilado.alto >= 40, 'sus 3 botones miden bien (' + estilado.alto + 'px)');

    // Y la conducta: seleccionar debe cambiar el ejemplo.
    await p.tap('#hint-level button[data-level="dificil"]');
    await p.waitForTimeout(200);
    const tras = await p.evaluate(() => ({
      marcado: document.querySelector('#hint-level button[data-level="dificil"]').classList.contains('is-on'),
      ejemplo: document.getElementById('hint-sample').textContent.trim()
    }));
    check(tras.marcado, 'al tocar "Difícil" queda marcado');
    check(/Disciplina»/.test(tras.ejemplo), 'y el ejemplo cambia: ' + tras.ejemplo.replace('Por ejemplo, para Karate: ', ''));
    await ctx.close();
  }

  console.log('\n8. Sesión: perder conexión y volver');
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
