'use strict';

/**
 * Partida completa en navegadores reales (5 "celulares" simultáneos).
 *
 * Requiere Playwright y un servidor corriendo:
 *   npm start                 # en otra terminal
 *   npm run test:e2e
 *
 * Variables: URL (por defecto http://localhost:3000), SMALL=1 (viewport chico),
 * SHOTS=<dir> para guardar capturas.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const URL = process.env.URL || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || null;

let playwright;
try {
  playwright = require('playwright');
} catch (e) {
  console.error('Falta Playwright. Instálalo con:  npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}
const { chromium, devices } = playwright;

const NAMES = ['Ana', 'Beto', 'Caro', 'Dani', 'Eva'];

(async () => {
  const launchOpts = fs.existsSync('/opt/pw-browsers/chromium')
    ? { executablePath: '/opt/pw-browsers/chromium' }
    : {};
  const browser = await chromium.launch(launchOpts);
  const phone = process.env.SMALL ? devices['iPhone SE'] : devices['iPhone 13'];
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  const errors = [];
  async function snap(page, name) {
    if (!SHOTS) return;
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  }

  const pages = [];
  for (const name of NAMES) {
    const ctx = await browser.newContext({ ...phone });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(name + ': ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(name + ' [console]: ' + m.text()); });
    await page.goto(URL, { waitUntil: 'networkidle' });
    pages.push(page);
  }

  const host = pages[0];
  const step = (msg) => console.log('  · ' + msg);

  try {
    /* ---- inicio y configuración ---- */
    await host.fill('#input-name', NAMES[0]);
    await snap(host, '01-inicio');
    await host.click('#btn-go-create');
    await host.waitForSelector('#screen-create.is-active');
    await host.waitForFunction(() => document.querySelectorAll('.chip').length > 0);

    await host.click('.step-btn[data-step="impostors"][data-delta="1"]');
    assert.strictEqual((await host.textContent('#val-impostors')).trim(), '2', 'debería poder subir a 2 impostores');

    await host.click('#btn-cat-none');
    await host.click('.chip:nth-child(2)');
    await host.click('.chip:nth-child(3)');
    assert.match(await host.textContent('#cat-count'), /3 de \d+/, 'debería haber 3 tópicos elegidos');
    await snap(host, '02-configurar');
    step('configuración: 2 impostores, 3 tópicos, pista y tópico visibles');

    await host.click('#btn-create');
    await host.waitForSelector('#screen-lobby.is-active');
    const code = (await host.textContent('#room-code')).trim();
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}$/, 'código de sala inválido: ' + code);
    step('sala creada: ' + code);

    /* ---- se unen los demás ---- */
    for (let i = 1; i < pages.length; i++) {
      const p = pages[i];
      await p.fill('#input-name', NAMES[i]);
      await p.click('#btn-go-join');
      await p.fill('#input-code', code.toLowerCase()); // minúsculas: debe funcionar igual
      await p.click('#btn-join');
      await p.waitForSelector('#screen-lobby.is-active');
    }
    await host.waitForFunction(() => document.querySelectorAll('#players .player').length === 5);
    await snap(host, '03-lobby-anfitrion');
    await snap(pages[1], '04-lobby-jugador');

    assert.strictEqual(await pages[1].isVisible('#btn-start'), false, 'un jugador normal no debe ver "Comenzar"');
    assert.strictEqual(await host.isVisible('#btn-start'), true, 'el anfitrión sí debe verlo');
    assert.strictEqual(await pages[1].isVisible('#btn-edit-config'), false, 'solo el anfitrión edita la configuración');
    step('5 jugadores en la sala, controles restringidos al anfitrión');

    /* ---- repartir cartas ---- */
    await host.click('#btn-start');
    for (const p of pages) await p.waitForSelector('#screen-reveal.is-active');

    const cards = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      await (await p.$('#reveal-card')).dispatchEvent('pointerdown');
      await p.waitForTimeout(450);
      cards.push({
        name: NAMES[i],
        word: (await p.textContent('#role-word')).trim(),
        extra: (await p.textContent('#role-extra')).trim().replace(/\s+/g, ' ')
      });
    }
    const impostores = cards.filter((c) => c.word === 'IMPOSTOR');
    const tripulantes = cards.filter((c) => c.word !== 'IMPOSTOR');
    assert.strictEqual(impostores.length, 2, 'deberían repartirse exactamente 2 impostores');
    assert.strictEqual(new Set(tripulantes.map((c) => c.word)).size, 1, 'los tripulantes deben compartir la palabra');
    impostores.forEach((c) => {
      assert.match(c.extra, /Pista:/, 'el impostor debe recibir pista');
      assert.match(c.extra, /Tópico:/, 'el impostor debe ver el tópico');
    });
    tripulantes.forEach((c) => assert.ok(!/Pista:/.test(c.extra), 'los tripulantes no reciben pista'));
    await snap(pages[NAMES.indexOf(impostores[0].name)], '05-carta-impostor');
    await snap(pages[NAMES.indexOf(tripulantes[0].name)], '06-carta-tripulante');
    step('2 impostores con pista; 3 tripulantes con la palabra "' + tripulantes[0].word + '"');

    /* ---- debate ---- */
    for (const p of pages) {
      await p.$eval('#reveal-card', (el) => el.classList.remove('is-open'));
      await p.click('#btn-ready');
    }
    for (const p of pages) await p.waitForSelector('#screen-discussion.is-active');
    const topic = (await host.textContent('#topic-value')).trim();
    assert.ok(topic.length > 2, 'debe mostrarse el tópico al empezar la partida');
    const order = await host.$$eval('#order-list li', (els) => els.map((e) => e.textContent));
    assert.strictEqual(order.length, 5, 'el orden debe incluir a todos');
    assert.match(await host.textContent('#timer-value'), /^\d:\d\d$/, 'el cronómetro debe correr');
    await snap(host, '07-debate');
    step('debate: tópico "' + topic + '", orden y cronómetro');

    /* ---- votación ---- */
    await host.click('#btn-to-voting');
    for (const p of pages) await p.waitForSelector('#screen-voting.is-active');
    await snap(host, '08-votacion');

    const objetivo = impostores[0].name;
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const target = NAMES[i] === objetivo ? NAMES[(i + 1) % NAMES.length] : objetivo;
      const ok = await p.evaluate((want) => {
        for (const b of document.querySelectorAll('.vote-btn:not(.is-skip)')) {
          const label = b.querySelector('span:not(.player-avatar)');
          if (label && label.textContent.replace(' (tú)', '').trim() === want && !b.disabled) {
            b.click();
            return true;
          }
        }
        return false;
      }, target);
      assert.ok(ok, 'no se pudo votar a ' + target);
      await p.waitForTimeout(120);
    }

    /* ---- resultados ---- */
    for (const p of pages) await p.waitForSelector('#screen-results.is-active', { timeout: 8000 });
    assert.match(await host.textContent('#result-title'), /Atraparon/, 'votando al impostor deberían ganar los tripulantes');
    assert.strictEqual((await host.textContent('#result-word')).trim(), tripulantes[0].word, 'la palabra revelada debe coincidir');
    const revelados = await host.$$eval('#result-impostors .player-name', (els) => els.map((e) => e.textContent.replace(' (tú)', '').trim()));
    assert.deepStrictEqual(revelados.slice().sort(), impostores.map((c) => c.name).sort(), 'deben revelarse los 2 impostores');
    await snap(host, '09-resultados');

    // El contenido largo scrollea dentro del body y el footer nunca lo tapa.
    const layout = await host.evaluate(() => {
      const body = document.querySelector('#screen-results .screen-body');
      const footer = document.querySelector('#screen-results .screen-footer');
      body.scrollTop = body.scrollHeight;
      const first = document.querySelector('#result-scores .player');
      const r = first.getBoundingClientRect();
      const f = footer.getBoundingClientRect();
      return {
        scrollea: body.scrollHeight > body.clientHeight + 4,
        sinTapar: r.bottom <= f.top + 1 && r.top >= 0,
        overflowX: document.documentElement.scrollWidth > window.innerWidth
      };
    });
    assert.ok(layout.scrollea, 'los resultados deben scrollear dentro del body');
    assert.ok(layout.sinTapar, 'el footer no debe tapar los puntajes');
    assert.ok(!layout.overflowX, 'no debe haber scroll horizontal');
    assert.strictEqual(await pages[1].isVisible('#btn-next-round'), false, 'solo el anfitrión pasa de ronda');
    step('resultados correctos y layout sin desbordes');

    /* ---- siguiente ronda ---- */
    await host.click('#btn-next-round');
    for (const p of pages) await p.waitForSelector('#screen-reveal.is-active', { timeout: 8000 });
    assert.match(await host.textContent('#reveal-round'), /Ronda 2/, 'debería arrancar la ronda 2');
    step('ronda 2 repartida');

    assert.deepStrictEqual(errors, [], 'hubo errores de JavaScript en el navegador');
    console.log('\n  ✓ partida completa verificada en ' + phone.viewport.width + '×' + phone.viewport.height + '\n');
  } catch (err) {
    console.error('\n  ✗ ' + err.message + '\n');
    if (errors.length) console.error('  errores del navegador:\n   - ' + errors.join('\n   - '));
    await browser.close();
    process.exit(1);
  }

  await browser.close();
})();
