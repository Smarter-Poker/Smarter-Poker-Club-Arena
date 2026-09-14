/** Actual card and chrome CSS, with measured selector-deck/header stand-ins.
 * Art requests are blocked: percentage hitboxes use the production aspect ratio.
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
      import ArenaGameCard from './src/components/lobby/game-cards/ArenaGameCard';
      import {observeLobbyScrollClearance} from './src/components/lobby/lobbyScrollClearance';
      import header from './src/components/navigation/GlobalHeader.module.css';
      import footer from './src/components/club/ClubBottomNav.module.css';
      import './src/pages/ClubHomePage.css';
      import './src/pages/ClubHomeMobilePremium.css';
      import './src/components/lobby/ClubLobbyCommandTop.css';
      import './src/components/lobby/LobbyTable.css';
      import './src/components/lobby/LobbySortBar.css';
      const data={id:'cash',family:'nlh',gameType:'NLH',title:'No Limit Holdem',status:'running',statusLabel:'Running',
        stakes:'1 / 2',buyIn:'80 - 400',players:'4 / 6',rules:[],badges:[],dataState:'loaded'};
      function Fixture(){return <><header id="global-header" className={header.header}>
        <div className={header.desktopArtwork}/></header>
        <main className="club-home club-home--unified-mobile"><section className="club-lobby-machine"><div id="deck" style={{height:240,position:'sticky',top:'var(--ca-global-header-height)',zIndex:30}}>Selectors</div>
        <div className="club-home__games club-home__games--v2"><div className="lobby-sortbar" role="toolbar"><span className="lobby-sortbar__eyebrow">Sort</span>
        <div className="lobby-sortbar__chips"><button className="lobby-sortbar__chip">Game</button><button className="lobby-sortbar__chip">Players</button></div></div>
        <div className="arena-lobby-card-list">{[0,1,2,3,4].map(i=><div key={i}><ArenaGameCard
          data={{...data,id:'cash-'+i}} presentation="mobile" actions={{primaryLabel:'Join Game',secondaryLabel:'View Game',onSecondary:()=>window.clicked.push(i)}}/></div>)}</div>
        </div></section></main>
        <nav aria-label="Poker Arena" className={footer.bottomNav}><div className={footer.viewport}><div className={footer.artwork}/></div></nav></>}
      window.clicked=[];
      createRoot(document.getElementById('root')).render(<Fixture/>);
      window.publishChrome=()=>{
        document.documentElement.style.setProperty('--ca-global-header-height',document.getElementById('global-header').getBoundingClientRect().height+'px');
        document.documentElement.style.setProperty('--ca-lobby-controls-h',document.getElementById('deck').getBoundingClientRect().height+'px');
      };
      window.attach=()=>{
        window.dispose=observeLobbyScrollClearance(document.querySelector('.lobby-sortbar'),document.querySelector('.arena-lobby-card-list'));
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
  await page.getByRole('button', { name: 'View Game', exact: true }).first().waitFor();
  await page.evaluate(() => window.publishChrome());
  const target = page.getByRole('button', { name: 'View Game', exact: true }).nth(2);
  await target.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  assert.equal(
    await target.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2));
    }),
    false,
    'without scrollport clearance the View hitbox is covered'
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
      const bar = document.querySelector('.lobby-sortbar').getBoundingClientRect();
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
    assert.ok(proof.top >= proof.barBottom, JSON.stringify(proof));
    assert.ok(proof.bottom <= proof.navTop, JSON.stringify(proof));
    assert.equal(proof.hit, true, JSON.stringify(proof));
    await target.click({ timeout: 1500 });
  }
  assert.deepEqual(await page.evaluate(() => window.clicked), [2, 2, 2, 2]);
  await page.evaluate(() => {
    document.querySelector('.lobby-sortbar').setAttribute('style', 'height:100px');
  });
  await page.waitForFunction(
    () => parseFloat(document.documentElement.style.getPropertyValue('--ca-lobby-sortbar-h')) >= 100
  );
  await target.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  assert.equal(
    await target.evaluate(
      (el) =>
        el.getBoundingClientRect().top >=
        document.querySelector('.lobby-sortbar').getBoundingClientRect().bottom
    ),
    true
  );
  const last = page.getByRole('button', { name: 'View Game', exact: true }).last();
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
