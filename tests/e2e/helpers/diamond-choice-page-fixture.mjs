import { build } from 'esbuild';

/**
 * THE REAL DiamondChoicePage, IN ITS REAL SHELL, WITH NO SERVER BEHIND IT.
 *
 * diamond-test-fixture.mjs mounts DiamondTestPage, which is a different page:
 * it has no back link, no daily line and no rules panels, so it cannot answer
 * the question this fixture exists for - whether the two money plates are on
 * the glass of a 375 x 667 phone while a round is open. Only the shipping page
 * stacks the shell, the back link, the console header, the daily line, the
 * scene and the controls the way a player gets them, so the fit is measured on
 * that page inside AppLayout, exactly as App.tsx routes it.
 *
 * Every wallet and server boundary is a local module, built the same way
 * diamond-wheel-page-fixture.mjs builds the wheel's: a layout check can read
 * an open round but can never place a wager. Built once per worker; the bundle
 * is a pair of immutable strings.
 */
let bundled;
export function diamondChoicePageFixture() {
  return (bundled ??= (async () => {
    const stubs = {
      // ── The shell around the page ──────────────────────────────────────
      ClubArenaWelcomeModal: `export default()=>null;export const useClubArenaWelcome=()=>({isReady:false,showWelcome:false,acceptWelcome:()=>{}});`,
      CompleteProfileModal: `export default()=>null;export const useCompleteProfile=()=>({isReady:false,showProfileModal:false,profileStatus:'complete',finishProfile:()=>{}});`,
      DailyBonusEntry: `export default()=>null;`,
      ClubWorkspaceContext: `export const ClubWorkspaceProvider=({children})=>children;export const useClubWorkspace=()=>({routeClubId:'fixture'});`,
      NavigationTelemetry: `export default()=>null;`,
      ClubAnnouncementBanner: `export default()=>null;`,
      ArenaSectionRail: `export default()=>null;`,
      ClubOperationsRail: `export default()=>null;`,
      HamburgerMenu: `export default()=>null;`,
      FloorFeed: `export default()=>null;`,
      useWalletStore: `const state={loadBalances:()=>{},loadDiamonds:()=>{}};export const useWalletStore=()=>state;useWalletStore.setState=()=>{};`,
      useHeaderDataStore: `const state={avatarUrl:null,isVipActive:false,notificationCount:0,unreadMessages:0,loadOnce:()=>{},clearUnreadNotifications:()=>{},clearUnreadMessages:()=>{}};export const useHeaderDataStore=()=>state;`,
      useMasterBusSubscription: `export const useMasterBusSubscription=()=>{};`,
      MasterBus: `export const masterBus={emit:()=>{},on:()=>()=>{}};`,
      avatarGenerator: `export const sizedStorageUrl=(url)=>url;`,
      Toast: `const t={success:()=>{},error:()=>{},info:()=>{},warning:()=>{}};export const useToast=()=>t;`,
      // ── Player, club and the noisy edges ───────────────────────────────
      useAuthUser: `export const useAuthUser=()=>({user:{id:'local-layout-player'}});`,
      clubIdResolver: `export const resolveClubUUID=async()=> 'club-fixture-0000-4000-8000-000000000001';`,
      errorReporter: `export const reportError=console.error;`,
      HapticService: `export const triggerHaptic=()=>{};`,
      SoundService: `export const soundService={playWin:()=>{},playBigWin:()=>{},playSpinTick:()=>{},playSpinStart:()=>{},playSpinTicking:()=>{},playSpinPeg:()=>{},playSpinResult:()=>{},playSpinMultiplierResult:()=>{}};`,
      supabase: `export const supabase={rpc:async()=>({data:{ok:true,commit_id:'commit-fixture-0001',server_seed_hash:'a'.repeat(64)},error:null}),from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:null,error:null})})})}),channel:()=>({on:()=>({subscribe:()=>({})}),subscribe:()=>({})}),removeChannel:()=>{}};`,
      diamondBonusRecovery: `export class PriorBonusPending extends Error{};export const pendingBonus=()=>null;export const rememberBonus=()=>{};export const forgetBonus=()=>{};`,
      // ── The money boundary. A layout fixture may read a round, never bet. ──
      DiamondBonusService: `export class BonusRefusal extends Error{};export class BonusUnreadable extends Error{};export const BONUS_SAVED='Your Wager Is Saved. It Finishes By Itself.';
        export const DiamondBonusService={start:async()=>{throw new Error('This Layout Fixture Cannot Wager')}};`,
      DiamondChoiceService: `
        import {CHOICE_MODE,ROAD_LADDERS,minePrize} from './src/utils/diamondChoiceMath';
        import {diamondBonusMinimum} from './src/utils/diamondBonusPayout';
        const game=new URLSearchParams(location.search).get('game')==='mines'?'mines':'crossing';
        const ROAD=ROAD_LADDERS[CHOICE_MODE.crossing];
        const MINES=Number(CHOICE_MODE.mines);
        const MINE_PICKS=25-MINES;
        /** One chip in, the live guarantee on it, and the ladder the server deals. */
        const chips=1, minimum=diamondBonusMinimum(chips);
        const prizes=game==='mines'
          ? Array.from({length:MINE_PICKS},(_,i)=>{const p=minePrize(chips,MINES,i+1,minimum);return Number(p.numerator)/Number(p.denominator)/100;})
          : ROAD.map((m)=>(chips*m)/100);
        /** A round the player is already two moves into: the state item 6 is about. */
        const openRound={ok:true,id:'round-fixture-0000-4000-8000-000000000001',game,
          club_id:'club-fixture-0000-4000-8000-000000000001',status:'open',
          mode:String(CHOICE_MODE[game]),bet_diamonds:100,bet_chips:chips,diamonds_per_chip:100,
          picked:game==='mines'?[7,8]:[0,1],max_steps:game==='mines'?MINE_PICKS:ROAD.length,
          prizes,payout_chips:0,minimum_payout_chips:minimum,payout_version:2,
          server_seed_hash:'a'.repeat(64),client_seed:'c'.repeat(32),nonce:1,
          commit_id:'commit-fixture-0001',proof:null};
        const state={ok:true,available:true,frozen:false,reason:null,diamonds:10000,
          member_chips:5000,is_member:true,diamonds_per_chip:100,bets:[100],
          max_steps:openRound.max_steps,prizes,open_round:openRound,history:[],
          rounds_today:3,daily_limit:200,diamonds_today:300,seconds_until_next:0};
        export const parseChoiceRound=(value)=>value;
        export const parseChoiceState=(value)=>value;
        export const DiamondChoiceService={
          state:async()=>state,
          act:async()=>{throw new Error('This Layout Fixture Cannot Wager')}};`,
      useEarnedBonus: `
        const budget={base:100,doubled:false,denomination:1};
        const award={id:'award-fixture-0001',boostMultiplier:1};
        export const useEarnedBonus=()=>({budget,award,required:false,ready:true,
          refresh:()=>{},consume:()=>{},gameState:null,
          quote:{guarantee:'standard',minimumPayoutChips:0.1,mode:null,plinkoTable:5},
          recoveredResult:null,error:null,loading:false});`,
      WheelBonusEntryService: `export const WheelBonusEntryService={entryState:async()=>null};export const bonusEntryKey=()=>'fixture';`,
    };
    const result = await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
      import './src/styles/club-engine.css';import './src/styles/animations.css';import './src/styles/metallic-popups.css';import './src/styles/reducedMotion.css';
      import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter,Routes,Route} from 'react-router-dom';
      import DiamondChoicePage from './src/pages/DiamondChoicePage';
      import AppLayout from './src/components/layouts/AppLayout';
      const game = new URLSearchParams(location.search).get('game') === 'mines' ? 'mines' : 'crossing';
      createRoot(document.getElementById('root')).render(
        <MemoryRouter initialEntries={['/clubs/fixture/' + game]}>
          <Routes><Route element={<AppLayout/>}>
            <Route path="/clubs/:clubId/crossing" element={<DiamondChoicePage game="crossing"/>}/>
            <Route path="/clubs/:clubId/mines" element={<DiamondChoicePage game="mines"/>}/>
          </Route></Routes>
        </MemoryRouter>);
    `,
      },
      bundle: true,
      jsx: 'automatic',
      write: false,
      outdir: '/tmp/diamond-choice-page-fixture',
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
              resolveDir: process.cwd(),
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
