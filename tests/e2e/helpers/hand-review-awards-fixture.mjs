/** Real review component, model, cards and CSS. Only external account/I/O is stubbed. */
import { build } from 'esbuild';
let bundled;
export function handReviewAwardsFixture() {
  return (bundled ??= build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {HandDetailModal} from './src/components/table/HandDetailModal';
      import {adaptServiceHandToPanel} from './src/lib/handHistoryAdapter';
      import './src/styles/metallic-popups.css';
      const hand = adaptServiceHandToPanel({
        id:'recorded-fold-win', hand_number:45462869, serial_number:'45462869',
        table_id:'fixture-table', table_name:'Recorded Hand', played_at:'2026-10-23T12:00:00Z',
        game_type:'NLH', stakes:'1/2', main_pot:96, side_pots:[], rake:2.5, bbj_fee:.25,
        bomb_pot:{board_count:2,ante_amount:4},
        community_cards:['7clubs','2clubs','9hearts','Kdiamonds','Tclubs'],
        community_cards2:['7clubs','2clubs','9hearts','6diamonds','5hearts'],
        players:[{seat:1,user_id:'hero',username:'KingFish',position:'BTN',hole_cards:[],
          private_hole_cards:[{rank:'Q',suit:'hearts'},{rank:'6',suit:'hearts'}],result:47.25,is_winner:true},
          {seat:2,user_id:'villain',username:'Other Player',position:'BB',hole_cards:[],result:-50,is_winner:false}],
        actions:[{player_id:'villain',action:'fold',street:'river',timestamp:1}],
        winners:[{user_id:'hero',amount:93.25,pot_index:0}],
        winners_by_board:[{board:1,user_id:'hero',amount:46.62,pots:[{index:0,amount:46.62}]},
          {board:2,user_id:'hero',amount:46.63,pots:[{index:0,amount:46.63}]}]
      } as any,'hero');
      createRoot(document.getElementById('root')).render(<HandDetailModal isOpen onClose={()=>{}} hands={[hand]} heroId="hero"/>);
    `,
    },
    bundle: true,
    jsx: 'automatic',
    write: false,
    outdir: process.env.TMPDIR || process.cwd(),
    format: 'iife',
    define: {
      'import.meta.env':
        '{"DEV":false,"BASE_URL":"/","VITE_NATIVE":"0","VITE_SUPABASE_URL":"https://fixture.invalid","VITE_SUPABASE_ANON_KEY":"fixture"}',
    },
    external: ['/assets/*', '/fonts/*', 'https://*', '@capacitor/haptics'],
    plugins: [
      {
        name: 'no-account-io',
        setup(b) {
          b.onResolve({ filter: /useAuthUser$/ }, () => ({ path: 'auth', namespace: 'fixture' }));
          b.onResolve({ filter: /SoundService$/ }, () => ({ path: 'sound', namespace: 'fixture' }));
          b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
            contents:
              path === 'auth'
                ? 'export const useAuthUser=()=>({user:null});'
                : 'export const soundService=new Proxy({},{get:()=>()=>{}});export const haptic=new Proxy({},{get:()=>()=>{}});',
          }));
        },
      },
    ],
    logLevel: 'silent',
  }).then((result) => ({
    javascript: result.outputFiles.find((f) => f.path.endsWith('.js')).text,
    css: result.outputFiles.find((f) => f.path.endsWith('.css')).text,
  })));
}
