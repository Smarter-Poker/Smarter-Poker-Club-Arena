import { build } from 'esbuild';

/**
 * THE FOUR SHIPPING BONUS GAME PAGES, IN THEIR REAL SHELL, WITH NO SERVER.
 *
 * Dan, 2026-10-12: "THE Start game BUTTON for any of the bonus games INSIDE OF
 * DIAMOND SPINS needs to be clickable on the opening screen. Not scroll down to
 * just click start." and, for Crash, the Stop (Book The Win) plate "NEEDS TO BE
 * VISUALLY ON THE SAME PAGE AS THE START BUTTON".
 *
 * Whether a plate is on the glass of a phone is a property of the WHOLE page:
 * the back link, the console header, the day's line, the scene the page sizes
 * from the viewport, the setup panel and the bays all stack above it. So this
 * mounts DiamondCrashPage, DiamondPlinkoPage and DiamondChoicePage (Donkey
 * Cross and Diamond Mines) exactly as App.tsx routes them, inside AppLayout,
 * and serves each one the state a player meets on arrival from the wheel: a
 * pending award, the game open, a ticket in hand, nothing started.
 *
 * `?live=1` on Crash serves a round already climbing instead, so the plate that
 * books the win can be measured while it is the plate that matters.
 *
 * Every wallet and server boundary is a local module, built the way
 * diamond-choice-page-fixture.mjs builds its own: a layout check can read a
 * round, but every start and every cash-out throws before anything is sent.
 * Built once per worker; the bundle is a pair of immutable strings.
 *
 * Nothing in the stub sources below may use a JS template literal: this file
 * passes them to esbuild inside one, so a `${...}` would be interpolated here.
 */
let bundled;
export function diamondGamePagesFixture() {
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
      avatarGenerator: `export const sizedStorageUrl=(url)=>url;export const getAvatarWithFallback=(url)=>url;`,
      Toast: `const t={success:()=>{},error:()=>{},info:()=>{},warning:()=>{}};export const useToast=()=>t;`,
      // ── Player, club and the noisy edges ───────────────────────────────
      useAuthUser: `export const useAuthUser=()=>({user:{id:'local-layout-player'}});`,
      clubIdResolver: `export const resolveClubUUID=async()=> 'club-fixture-0000-4000-8000-000000000001';`,
      errorReporter: `export const reportError=()=>{};`,
      HapticService: `export const triggerHaptic=()=>{};`,
      DiamondSceneRecorder: `export const installDiamondSceneRecorder=()=>{};`,
      // Every cue is a no-op, whatever its name (see diamond-choice-page-fixture.mjs).
      SoundService: `export const soundService=new Proxy({},{get:()=>()=>{}});export const haptic=new Proxy({},{get:()=>()=>{}});export const PLINKO_PEG_GAP_MS=30;`,
      // The commit every game deals before Start, and nothing else: the
      // lifetime averages read is answered with a refusal, which that panel
      // already handles by itself.
      supabase: `export const supabase={rpc:async(name)=>name==='fn_diamond_game_commit'?({data:{ok:true,commit_id:'c0ffee00-0000-4000-8000-000000000001',server_seed_hash:'a'.repeat(64)},error:null}):({data:null,error:{message:'fixture'}}),from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:null,error:null})})})}),channel:()=>({on:()=>({subscribe:()=>({})}),subscribe:()=>({})}),removeChannel:()=>{}};`,
      diamondBonusRecovery: `export class PriorBonusPending extends Error{};export const pendingBonus=()=>null;export const rememberBonus=()=>{};export const clearPendingBonus=()=>{};`,
      // ── The money boundary. A layout fixture may read a round, never bet. ──
      DiamondBonusService: `export class BonusRefusal extends Error{};export class BonusUnreadable extends Error{};export const BONUS_SAVED='Your Round Is Saved';
        export const parsePlinkoBonus=(value)=>value;
        export const DiamondBonusService={start:async()=>{throw new Error('This Layout Fixture Cannot Wager')}};`,
      DiamondGamesService: `
        import {PLINKO_TABLES} from './src/utils/diamondBonusPayout';
        const params=new URLSearchParams(location.search);
        const game=params.get('game')==='plinko'?'plinko':'crash';
        const live=params.get('live')==='1';
        const club='club-fixture-0000-4000-8000-000000000001';
        /** A round four seconds into its climb: past the 1.11x the cash-out opens at. */
        const openRound=()=>({ok:true,replayed:false,resumed:true,round_id:'round-fixture-0000-4000-8000-000000000001',
          club_id:club,host_id:club,status:'open',bet_diamonds:100,bet_chips:1,minimum_payout_chips:0.5,
          payout_version:4,cashout_floor_cents:111,crash_floor_cents:110,diamonds_per_chip:100,cap_cents:2500,
          growth_k:0.1,auto_cashout_cents:null,started_at:new Date(Date.now()-4000).toISOString(),
          server_now:new Date().toISOString(),elapsed_ms:4000,multiplier_now_cents:149,outcome:null,
          fairness:{commit_id:'c0ffee00-0000-4000-8000-000000000001',server_seed_hash:'a'.repeat(64),client_seed:'c'.repeat(32),nonce:1},
          balances:{diamonds:9900,member_chips:5000},pool:{chips_paid:null},created_at:new Date().toISOString()});
        const round=live?openRound():null;
        const table=PLINKO_TABLES[4];
        const state={ok:true,available:true,game,host_id:club,host_kind:'club',club_id:club,
          config:{diamonds_per_chip:100,min_bet_diamonds:25,max_bet_diamonds:2500,exposure_allowance_chips:0,
            cap_fraction:1,max_multiplier_cents:2500,growth_k:0.1,purchased_only:false,
            max_rounds_per_player_per_day:200,min_seconds_between_rounds:0,spec_rtp:0.96,house_share:0},
          bets:[{bet_diamonds:100,bet_chips:1,cap_cents:2500,playable:true}],
          tables:[{version:4,name:table.name,rows:16,multipliers_cents:table.multipliersCents,
            max_multiplier_cents:2000,spec_rtp:0.96,sd_chips:1,hit_rate:1,note:''}],
          open_round:round,
          player:{diamonds:10000,purchased_available:10000,spendable:10000,rounds_today:3,
            diamonds_today:300,seconds_until_next:0,is_member:true,member_chips:5000},
          frozen:false};
        export const normaliseCrash=(value)=>value;
        export const fixtureGameState=state;
        const DiamondGamesService={
          getState:async()=>state,
          commit:async()=>({ok:true,commit_id:'c0ffee00-0000-4000-8000-000000000001',server_seed_hash:'a'.repeat(64),expires_at:''}),
          crashSettle:async(roundId,cashout)=>{if(cashout)throw new Error('This Layout Fixture Cannot Cash Out');return {...round,server_now:new Date().toISOString()};},
          crashHistory:async()=>[],
          plinkoHistory:async()=>[],
          floor:async()=>({ok:true,wins:[],crash_points:[],top_week:[]}),
        };
        export default DiamondGamesService;`,
      DiamondChoiceService: `
        import {CHOICE_MODE,ROAD_LADDERS,minePrize} from './src/utils/diamondChoiceMath';
        import {diamondBonusMinimum} from './src/utils/diamondBonusPayout';
        const game=new URLSearchParams(location.search).get('game')==='mines'?'mines':'crossing';
        const ROAD=ROAD_LADDERS[CHOICE_MODE.crossing];
        const MINES=Number(CHOICE_MODE.mines);
        const MINE_PICKS=25-MINES;
        const chips=1, minimum=diamondBonusMinimum(chips);
        const prizes=game==='mines'
          ? Array.from({length:MINE_PICKS},(_,i)=>{const p=minePrize(chips,MINES,i+1,minimum);return Number(p.numerator)/Number(p.denominator)/100;})
          : ROAD.map((m)=>(chips*m)/100);
        /** Nothing started: the screen a player meets on arrival. */
        const state={ok:true,available:true,frozen:false,reason:null,diamonds:10000,
          member_chips:5000,is_member:true,diamonds_per_chip:100,bets:[100],
          max_steps:prizes.length,prizes,open_round:null,history:[],
          rounds_today:3,daily_limit:200,diamonds_today:300,seconds_until_next:0};
        export const parseChoiceRound=(value)=>value;
        export const parseChoiceState=(value)=>value;
        export const fixtureChoiceState=state;
        export const MOVE_NOT_TAKEN='The Game Could Not Take That Move';
        export class ChoiceMoveRefused extends Error{};
        export const moveRefusedByDatabase=()=>false;
        export const DiamondChoiceService={
          state:async()=>state,
          act:async()=>{throw new Error('This Layout Fixture Cannot Wager')}};`,
      // A pending wheel award for this game, quoted by the server, which
      // returns the game's own state with it (WheelBonusEntryService.state).
      // The Double Your Diamonds answer is the player's, from useBonusBudget,
      // exactly as awardBudget reads it: an answer for another award answers
      // nothing.
      useEarnedBonus: `
        import {plinkoBudget} from './src/utils/bonusGameBudget';
        import {fixtureGameState} from 'DiamondGamesService';
        import {fixtureChoiceState} from 'DiamondChoiceService';
        const award={id:'a0a0a0a0-0000-4000-8000-000000000001',entryDiamonds:100,boostMultiplier:1};
        const quote={guarantee:'standard',minimumPayoutChips:0.5,mode:null,plinkoTable:4,payoutVersion:4,paidDiamonds:100,cashoutFloorCents:111};
        export const useEarnedBonus=(club,game,preference)=>{
          const own=preference.award&&preference.award.id===award.id;
          const budget=plinkoBudget({base:100,doubled:own?preference.doubled:false,denomination:own?preference.denomination:null,award});
          const gameState=game==='mines'||game==='crossing'?fixtureChoiceState:fixtureGameState;
          return {budget,award,required:true,ready:true,refresh:async()=>{},consume:()=>{},
            gameState,quote,recoveredResult:null,error:null,loading:false};
        };`,
      WheelBonusEntryService: `export const WheelBonusEntryService={state:async()=>null};export const bonusEntryKey=()=>'fixture';`,
    };
    const result = await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
      import './src/styles/club-engine.css';import './src/styles/animations.css';import './src/styles/metallic-popups.css';import './src/styles/reducedMotion.css';
      import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter,Routes,Route} from 'react-router-dom';
      import DiamondCrashPage from './src/pages/DiamondCrashPage';
      import DiamondPlinkoPage from './src/pages/DiamondPlinkoPage';
      import DiamondChoicePage from './src/pages/DiamondChoicePage';
      import AppLayout from './src/components/layouts/AppLayout';
      const wanted = new URLSearchParams(location.search).get('game');
      const game = ['crash','plinko','crossing','mines'].includes(wanted) ? wanted : 'crash';
      createRoot(document.getElementById('root')).render(
        <MemoryRouter initialEntries={['/clubs/fixture/' + game]}>
          <Routes><Route element={<AppLayout/>}>
            <Route path="/clubs/:clubId/crash" element={<DiamondCrashPage/>}/>
            <Route path="/clubs/:clubId/plinko" element={<DiamondPlinkoPage/>}/>
            <Route path="/clubs/:clubId/crossing" element={<DiamondChoicePage game="crossing"/>}/>
            <Route path="/clubs/:clubId/mines" element={<DiamondChoicePage game="mines"/>}/>
          </Route></Routes>
        </MemoryRouter>);
    `,
      },
      bundle: true,
      jsx: 'automatic',
      write: false,
      outdir: '/tmp/diamond-game-pages-fixture',
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
