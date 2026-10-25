import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

export function registerLeaderboardLoadingLayoutCases() {
  test.describe('leaderboard loading layout', () => {
    let script: string, css: string;
    test.beforeAll(async () => {
      // Real page, styles, React and router; only external reads and unrelated dialogs are isolated.
      const stubs: Record<string, string> = {
        useAuthUser: `const user={id:'layout-viewer'};export const useAuthUser=()=>({user,isHydrating:false});`,
        useVisibilityRefresh: `export const useVisibilityRefresh=()=>({isRefreshing:false});`,
        ClubsService: `export const getUserMemberships=()=>new Promise(resolve=>{window.releaseMemberships=()=>resolve([1,2,3].map(i=>({club_id:'club-'+i,role:'player',club:{id:'club-'+i,name:'Club '+i,club_id:'10000'+i}})));});`,
        LeaderboardService: `const rows=[1,2,3].map(i=>({rank:i,userId:'viewer-'+i,username:'Player '+i,value:100-i,metric:'profit',change:null,totalRanked:100,baselineDate:'2026-10-19'}));export const LeaderboardService={getClubLeaderboard:async()=>rows,getGlobalLeaderboard:async()=>rows,getClubTournamentStats:async()=>[],getUserRank:async()=>({rank:1,total:100,value:100}),getGlobalUserRank:async()=>null,getPeriodWindow:async()=>({start_date:'2026-10-19',end_date:'2026-10-26'}),getLeaderboardSettlementStatus:async()=>({program:null}),getManageableRewardContexts:async()=>[],getLeaderboardRewardSetup:async()=>({club_id:'club-1',can_manage:true,setup_complete:false}),getRewardProgramHistory:async()=>[]};`,
        Toast: `const toast={error(){},success(){},info(){},warning(){}};export const useToast=()=>toast;`,
        MasterBus: `export const masterBus={subscribeDebounced:()=>()=>{}};`,
        errorReporter: `export const reportError=()=>{};`,
        LeaderboardPrizeWizard: `export const LeaderboardPrizeWizard=()=>null;`,
        LeaderboardSettlementCard: `export const LeaderboardSettlementCard=()=>null;`,
        PlayerAvatar: `export const PlayerAvatar=()=>null;`,
      };
      const result = await build({
        stdin: {
          contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';import Page from './src/pages/LeaderboardPage';createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,null,React.createElement(Page)));`,
          resolveDir: process.cwd(),
          loader: 'tsx',
        },
        bundle: true,
        write: false,
        outdir: 'fixture-output',
        format: 'iife',
        jsx: 'automatic',
        alias: { '@arena-display': resolve('src/lib/arenaDisplay') },
        define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
        plugins: [
          {
            name: 'owned-layout-reads',
            setup(builder) {
              builder.onResolve({ filter: /^\/assets\// }, (args) => ({
                path: args.path,
                external: true,
              }));
              builder.onResolve(
                {
                  filter:
                    /(?:useAuthUser|useVisibilityRefresh|ClubsService|LeaderboardService|Toast|MasterBus|errorReporter|LeaderboardPrizeWizard|LeaderboardSettlementCard|PlayerAvatar)$/,
                },
                (args) => {
                  const name = args.path.split('/').pop()!;
                  return stubs[name] ? { path: name, namespace: 'fixture' } : undefined;
                }
              );
              builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
                contents: stubs[args.path],
                loader: 'js',
              }));
            },
          },
        ],
      });
      script = result.outputFiles.find((f) => f.path.endsWith('.js'))!.text;
      css = result.outputFiles.find((f) => f.path.endsWith('.css'))!.text;
    });

    for (const width of [375, 393, 430, 1440]) {
      test(`delayed leaderboard membership does not move its controls at ${width}px`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await page.setContent(
          `<style>*{box-sizing:border-box}body{margin:0;background:#000}${css}</style><div id="root"></div>`
        );
        await page.addScriptTag({ content: script });
        await expect(page.getByText('Loading Your Clubs...', { exact: true })).toBeVisible();
        const positions = () =>
          page.evaluate(() =>
            Object.fromEntries(
              ['.lb-control-deck', '.lb-period-group', '#leaderboard-content-panel'].map(
                (selector) => {
                  const r = document.querySelector(selector)!.getBoundingClientRect();
                  return [selector, { top: r.top, height: r.height }];
                }
              )
            )
          );
        const before = await positions();
        await info.attach(`leaderboard-before-${width}.png`, {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
        await page.evaluate(() => (window as any).releaseMemberships());
        await expect(page.getByRole('combobox', { name: 'Club' })).toBeVisible();
        await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-busy', 'false');
        const after = await positions();
        await info.attach(`leaderboard-after-${width}.png`, {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
        await info.attach(`leaderboard-loading-${width}.json`, {
          body: JSON.stringify({ before, after }),
          contentType: 'application/json',
        });
        for (const selector of Object.keys(before))
          expect(
            Math.abs(after[selector].top - before[selector].top),
            selector
          ).toBeLessThanOrEqual(1);
      });
    }
  });
}
