/** Compact row and chrome CSS, with measured header/footer stand-ins.
 * Art requests are blocked; rows use the production compact stylesheet.
 * No application server, account, force-click or changed stacking order.
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export async function createLobbyScrollFixture() {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import './src/components/lobby/CompactLobbyRows.css';
      import {observeLobbyScrollClearance} from './src/components/lobby/lobbyScrollClearance';
      import header from './src/components/navigation/GlobalHeader.module.css';
      import footer from './src/components/club/ClubBottomNav.module.css';
      import './src/pages/ClubHomePage.css';
      import './src/pages/ClubHomeMobilePremium.css';
      import './src/components/lobby/ClubLobbyCommandTop.css';
      import './src/components/lobby/LobbyTable.css';
      import './src/components/lobby/LobbySortBar.css';
      function Fixture(){return <><header id="global-header" className={header.header}>
        <div className={header.desktopArtwork}/></header>
        <main className="club-home club-home--unified-mobile"><section className="club-lobby-machine"><div id="deck" style={{height:240,position:'relative'}}>Selectors</div>
        <div className="club-home__games club-home__games--v2">
        <div className="arena-lobby-card-list"><table className="compact-lobby"><thead><tr><th>Game</th><th>Stakes</th><th>Players</th><th>Status</th></tr></thead><tbody>{Array.from({length:40},(_,i)=><tr key={i}><td><button className="compact-lobby__open" onClick={()=>window.clicked.push(i)}>Details {i}</button></td><td>1/2</td><td>4/6</td><td>Running</td></tr>)}</tbody></table></div>
        </div></section></main>
        <nav aria-label="Poker Arena" className={footer.bottomNav}><div className={footer.viewport}><div className={footer.artwork}/></div></nav></>}
      window.clicked=[];
      createRoot(document.getElementById('root')).render(<Fixture/>);
      window.publishChrome=()=>{
        document.documentElement.style.setProperty('--ca-global-header-height',document.getElementById('global-header').getBoundingClientRect().height+'px');
        document.documentElement.style.setProperty('--ca-lobby-controls-h',document.getElementById('deck').getBoundingClientRect().height+'px');
      };
      window.attach=()=>{
        window.dispose=observeLobbyScrollClearance(document.querySelector('.compact-lobby thead'),document.querySelector('.arena-lobby-card-list'));
      };
    `,
    },
    bundle: true,
    define: { 'import.meta.env.BASE_URL': JSON.stringify('/'), 'import.meta.env.DEV': 'false' },
    jsx: 'automatic',
    write: false,
    outdir: '/tmp/lobby-clearance-bundle',
    format: 'iife',
    external: ['/assets/*', '/images/*', '/hub/*'],
    logLevel: 'silent',
  });
  const javascript = result.outputFiles.find((f) => f.path.endsWith('.js')).text;
  const css =
    readFileSync(resolve('src/styles/globals.css'), 'utf8') +
    result.outputFiles.find((f) => f.path.endsWith('.css')).text;
  return { javascript, css };
}

export async function verifyLobbyScrollClearance(page, width, onProof) {
  page.setDefaultTimeout(5000);
  page.on('pageerror', (e) => console.error(e));
  const { css, javascript } = await createLobbyScrollFixture();
  await page.setViewportSize({ width, height: 812 });
  await page.route('**/*', (route) => route.abort());
  await page.setContent(
    '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0}</style><div id="root"></div>'
  );
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: javascript });
  await page
    .getByRole('button', { name: /^Details / })
    .first()
    .waitFor();
  await page.evaluate(() => window.publishChrome());
  const target = page.getByRole('button', { name: /^Details / }).nth(20);
  await target.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  assert.equal(
    await target.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2));
    }),
    false,
    'without scrollport clearance the detail hitbox is covered'
  );
  await page.evaluate(() => {
    window.attach();
    window.scrollTo(0, 0);
  });
  await target.click({ timeout: 1500 });
  for (const alignment of ['start', 'end', 'center']) {
    await target.evaluate((el, block) => el.scrollIntoView({ block }), alignment);
    const proof = await target.evaluate((el) => {
      const b = el.getBoundingClientRect();
      const bar = document.querySelector('.compact-lobby thead').getBoundingClientRect();
      const nav = document.querySelector('nav').getBoundingClientRect();
      return {
        top: b.top,
        bottom: b.bottom,
        barBottom: bar.bottom,
        navTop: nav.top,
        port: document.querySelector('[data-lobby-scrollport]')?.tagName,
        padding: getComputedStyle(document.documentElement).scrollPaddingTop,
        hit: el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)),
      };
    });
    onProof?.({ width, alignment, ...proof });
    assert.ok(proof.top >= 0, JSON.stringify(proof));
    assert.ok(proof.bottom <= proof.navTop, JSON.stringify(proof));
    assert.equal(proof.hit, true, JSON.stringify(proof));
    await target.click({ timeout: 1500 });
  }
  assert.deepEqual(await page.evaluate(() => window.clicked), [20, 20, 20, 20]);
  const last = page.getByRole('button', { name: /^Details / }).last();
  await last.evaluate((el) => el.scrollIntoView({ block: 'end' }));
  await last.click({ timeout: 1500 });
  assert.equal(
    await last.evaluate(
      (el) =>
        el.getBoundingClientRect().bottom <=
        document.querySelector('nav').getBoundingClientRect().top
    ),
    true
  );
  await page.evaluate(() => window.dispose());
  assert.equal(
    await page.evaluate(() => document.documentElement.hasAttribute('data-lobby-scrollport')),
    false
  );
}
