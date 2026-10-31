import { build } from 'esbuild';
import { expect, test } from '@playwright/test';
import { mountStatsPaneBeforeDebounce } from '../e2e/support/statsClock';

// No account, network, production route or app override. Use the real React,
// Framer tab transition, swipe hook and ledger. Service, preferences and haptic
// side effects are isolated; pointer event behavior stays real.
test.use({ hasTouch: true });
let script: string;
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React, {useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {AnimatePresence, motion} from 'framer-motion';
        import {tabTransition} from './src/components/stats/statsMotion';
        import {useSwipeTabs} from './src/hooks/useSwipeTabs';
        import Downline from './src/components/agent/DownlineRakePanel';
        const roles=[{club_id:'fixture',club_name:'Fixture',role:'agent',agent_id:'fixture',is_overseer:false}];
        function App(){const[tab,setTab]=useState('overview');const swipe=useSwipeTabs({tabs:['overview','rake'],activeTab:tab,onTabChange:setTab});return <>
          <button onClick={()=>setTab('rake')}>Rake</button><button onClick={()=>setTab('overview')}>Overview</button>
          <AnimatePresence mode="wait" initial={false}><motion.div key={tab} id={'stats-panel-'+tab}
            variants={tabTransition} initial="initial" animate="animate" exit="exit"
            transition={{duration:0.22,ease:[0.22,1,0.36,1]}} {...swipe}>
            {tab==='rake'?<Downline roles={roles}/>:<p>Overview</p>}
          </motion.div></AnimatePresence></>}
        createRoot(document.getElementById('root')).render(<App/>);
      `,
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    bundle: true,
    jsx: 'automatic',
    write: false,
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'empty' },
    plugins: [
      {
        name: 'isolated-ledger-service',
        setup(builder) {
          builder.onResolve({ filter: /services\/AgentRakeService$/ }, () => ({
            path: 'service',
            namespace: 'fixture',
          }));
          builder.onResolve({ filter: /hooks\/usePlayerPreference$/ }, () => ({
            path: 'preferences',
            namespace: 'fixture',
          }));
          builder.onResolve({ filter: /utils\/vibrationGate$/ }, () => ({
            path: 'haptics',
            namespace: 'fixture',
          }));
          builder.onResolve({ filter: /utils\/errorReporter$/ }, () => ({
            path: 'reporter',
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
            resolveDir: process.cwd(),
            contents:
              path === 'preferences'
                ? "import {useState} from 'react'; export const usePlayerPreference=(_name,value)=>useState(value);"
                : path === 'haptics'
                  ? 'export const fireVibration=()=>{};'
                  : path === 'reporter'
                    ? 'export const reportError=()=>{};'
                    : `export const RAKE_WINDOWS=[{key:'week',label:'This Week'}];
             export const windowToRange=()=>({since:null,until:null});
             export const describeRakeError=()=> 'Fixture Error';
             export const AgentRakeService={
               getDownlineRake:async({limit})=>Array.from({length:limit===501?501:620},(_,i)=>({player_id:'p'+i,username:'Player '+i,club_id:'fixture',club_name:'Fixture',role:'player',depth:1,rake_generated:i+1,hands:i+2,downline_players:0,downline_rake:0})),
               getDownlineRakeSummary:async()=>({members:620,active:620,direct:620,sub_agents:0,hands:1000,rake_generated:620,commission_rate:.2,estimated_commission:124}),
               subscribeToRake:()=>()=>{}
             };`,
          }));
        },
      },
    ],
  });
  script = result.outputFiles[0].text;
});

test.afterEach(async ({ page }) => {
  await page.clock.resume();
});

for (const protocol of [
  'late-clock-eager',
  'installed-before-import-frames',
  'installed-before-import-touch',
] as const) {
  test(`${protocol} preserves the fresh ledger mount and debounce`, async ({ page }, testInfo) => {
    if (protocol !== 'late-clock-eager') await page.clock.install();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    const panel = page.getByRole('region', { name: 'Downline Rake Ledger' });
    await page.getByRole('button', { name: 'Rake', exact: true }).click();
    await expect(panel.getByRole('row')).toHaveCount(501);
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(panel).toHaveCount(0);
    if (protocol === 'late-clock-eager') await page.clock.install();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await page.getByRole('button', { name: 'Rake', exact: true }).click();
    const pane = page.locator('#stats-panel-rake');
    if (protocol === 'late-clock-eager') {
      await page.clock.runFor(299);
      // Retain the known failed protocol as a passing negative control.
      await expect(pane).toHaveCount(0);
      return;
    }
    const spent = await mountStatsPaneBeforeDebounce(page, pane);
    expect(spent).toBeLessThan(300);
    await testInfo.attach('frame-budget', {
      body: JSON.stringify({ advancedMs: spent, maximumMs: 299, actualReactFramerAndLedger: true }),
      contentType: 'application/json',
    });
    await expect
      .poll(async () => {
        await page.clock.runFor(0);
        return panel.getByRole('row').count();
      })
      .toBe(501);
    const more = panel.getByRole('button', { name: 'Show 500 More Members' });
    if (protocol === 'installed-before-import-touch') await more.tap();
    else await more.click();
    await expect
      .poll(async () => {
        await page.clock.runFor(0);
        return panel.getByRole('row').count();
      })
      .toBe(621);
    await page.clock.runFor(300);
    await expect(panel.getByRole('row')).toHaveCount(621);
    await panel.getByRole('textbox', { name: 'Search Downline Players' }).fill('river');
    await page.clock.runFor(299);
    await expect(panel.getByRole('row')).toHaveCount(621);
    await page.clock.runFor(1);
    await expect
      .poll(async () => {
        await page.clock.runFor(0);
        return panel.getByRole('row').count();
      })
      .toBe(501);
  });
}
