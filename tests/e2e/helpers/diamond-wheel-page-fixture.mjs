import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

// The actual page, animation, console and global styles. Server and wallet
// boundaries are local fixtures, so layout/recovery checks cannot place a wager.
let bundled;
export function diamondWheelPageFixture() {
  return (bundled ??= (async () => {
    const records = JSON.parse(
      readFileSync('tests/fixtures/diamond-spins/wheel-v3-postgres-receipts.json', 'utf8')
    ).records;
    const receipts = records.filter((r) => r.kind === 'wheel').map((r) => r.value);
    const receipt = receipts.find((r) => r.outcome.kind === 'chips');
    const state = {
      ok: true,
      contract_version: 3,
      available: true,
      frozen: false,
      segments: receipt.segments,
      upgrade_segments: receipts.find((r) => r.secondary).secondary.segments,
      pending_awards: [],
      config: { spin_price_diamonds: 100, max_spins_per_player_per_day: 200 },
      player: {
        diamonds: 10000,
        member_chips: 12345,
        spendable: 10000,
        is_member: true,
        spins_today: 8,
        diamonds_today: 2000,
        seconds_until_next: 0,
      },
    };
    const stubs = {
      DiamondReplayService: `export const DiamondReplayService={list:async()=>[]}; export const bonusReplayTitle=()=> 'Diamond Plinko';`,
      ClubArenaWelcomeModal: `export default()=>null;export const useClubArenaWelcome=()=>({isReady:false,showWelcome:false,acceptWelcome:()=>{}});`,
      CompleteProfileModal: `export default()=>null;export const useCompleteProfile=()=>({isReady:false,showProfileModal:false,profileStatus:'complete',finishProfile:()=>{}});`,
      DailyBonusEntry: `export default()=>null;`,
      ClubWorkspaceContext: `export const ClubWorkspaceProvider=({children})=>children;export const useClubWorkspace=()=>({routeClubId:'fixture'});`,
      NavigationTelemetry: `export default()=>null;`,
      ClubAnnouncementBanner: `export default()=>null;`,
      ArenaSectionRail: `export default()=>null;`,
      ClubOperationsRail: `export default()=>null;`,
      HamburgerMenu: `export default()=>null;`,
      useWalletStore: `const state={loadBalances:()=>{},loadDiamonds:()=>{}};export const useWalletStore=()=>state;useWalletStore.setState=()=>{};`,
      useHeaderDataStore: `const state={avatarUrl:null,isVipActive:false,notificationCount:0,unreadMessages:0,loadOnce:()=>{},clearUnreadNotifications:()=>{},clearUnreadMessages:()=>{}};export const useHeaderDataStore=()=>state;`,
      useMasterBusSubscription: `export const useMasterBusSubscription=()=>{};`,
      MasterBus: `export const masterBus={emit:()=>{},on:()=>()=>{}};`,
      avatarGenerator: `export const sizedStorageUrl=(url)=>url;`,
      DiamondWheelService: `const state=${JSON.stringify(state)};export default {
        getStateV2:async()=>({...state,available:!location.search.includes('paused'),reason:'Local Connection Is Paused'}),
        welcomeState:async()=>({available:true,enabled:true,price:100}),
        dailyBonusState:async()=>({available:true,ticket_count:2}), history:async()=>[],
        commit:async()=>({ok:true,commit_id:'d1000000-0000-4000-8000-000000000001',server_seed_hash:'a'.repeat(64)}),
        spinV2:async()=>{throw Error('This Layout Fixture Cannot Wager')}};`,
      useAuthUser: `export const useAuthUser=()=>({user:{id:'local-layout-player'}});`,
      useGameFloor: `const refresh=()=>{};export const useGameFloor=()=>({floor:null,refresh});`,
      clubIdResolver: `export const resolveClubUUID=async()=> '${receipt.club_id}';`,
      FloorFeed: `export default()=>null`,
      Toast: `const t={success:()=>{},error:()=>{},info:()=>{},warning:()=>{}};export const useToast=()=>t;`,
      errorReporter: `export const reportError=console.error`,
      SoundService: `export const soundService={playWin:()=>{},playBigWin:()=>{},playSpinStart:()=>{},playSpinTicking:()=>{},playSpinPeg:()=>{},playSpinResult:()=>{}};`,
      HapticService: `export const triggerHaptic=()=>{};`,
    };
    const result = await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
      import './src/styles/club-engine.css';import './src/styles/animations.css';import './src/styles/metallic-popups.css';import './src/styles/reducedMotion.css';
      import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter,Routes,Route} from 'react-router-dom';
      import DiamondWheelPage from './src/pages/DiamondWheelPage';
      import AppLayout from './src/components/layouts/AppLayout';
      createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/clubs/fixture/wheel']}><Routes><Route element={<AppLayout/>}><Route path="/clubs/:clubId/wheel" element={<DiamondWheelPage/>}/></Route></Routes></MemoryRouter>);
    `,
      },
      bundle: true,
      jsx: 'automatic',
      write: false,
      outdir: '/tmp/diamond-wheel-page-fixture',
      format: 'iife',
      define: { 'import.meta.env': '{"DEV":false,"BASE_URL":"/","VITE_NATIVE":"0"}' },
      external: ['/assets/*', '/fonts/*', 'https://*', '@capacitor/haptics'],
      plugins: [
        {
          name: 'local-wallet-boundaries',
          setup(b) {
            b.onResolve({ filter: /.*/ }, (args) => {
              const name = args.path.split('/').pop();
              if (stubs[name]) return { path: name, namespace: 'fixture' };
            });
            b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
              contents: stubs[args.path],
              loader: 'js',
            }));
          },
        },
      ],
      logLevel: 'silent',
    });
    return {
      javascript: result.outputFiles.find((f) => f.path.endsWith('.js')).text,
      css: result.outputFiles.find((f) => f.path.endsWith('.css')).text,
    };
  })());
}
