import { build } from 'esbuild';
/**
 * Actual play controls and scenes; local-only sample outcomes, no API or wallet access.
 *
 * ONE SETTING PER GAME (2026-09-19). Nothing in here offers a choice the live
 * game does not: no drop value, no table, no risk ladder, no mine count. Every
 * one of those is read from the constant the server mirrors, so this preview
 * cannot drift from the page it stands in for. `diamondGameTitle` is the only
 * source of a game's name, and every scene is handed the same guarantee and
 * prize ladder its page hands it, so the surfaces that were added with the
 * recalibration (the colour-scaled bucket legend, the street strip, the Mines
 * profit readouts, the crash hero) all paint here too.
 *
 * Nothing in the bundled source below may use a JS template literal: this file
 * passes it to esbuild as one, so a `${...}` would be interpolated here.
 */
export async function diamondGamesFixture() {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';
 import {GameConsole} from './src/components/games/GameConsole';import BonusSetup from './src/components/games/BonusSetup';
 import ChoiceScene from './src/components/games/ChoiceScene';import CrashCurve from './src/components/crash/CrashCurve';
 import PlinkoBoard from './src/components/plinko/PlinkoBoard';import {useMeasuredWidth} from './src/hooks/useMeasuredWidth';
 import {diamondGameTitle,type DiamondBonusGame} from './src/utils/diamondGameTitles';
 import {bonusTotal,gameChips,plinkoBudget,plinkoDrops,validBonusBudget,type BonusBudget} from './src/utils/bonusGameBudget';
 import {PLINKO_TABLES,diamondBonusMinimum,plinkoTableVersion} from './src/utils/diamondBonusPayout';
 import {CHOICE_MODE,ROAD_LADDERS,minePrize} from './src/utils/diamondChoiceMath';
 import './src/styles/club-engine.css';import './src/pages/diamondGames.module.css';
 // club-engine.css is where the --realism-* design tokens are DEFINED, and the
 // console reads them for every surface it paints. A CSS fixture without it
 // measures a console whose colours all fall back to nothing, which is not a
 // console the app can ever render; main.tsx and src/diamond-test.tsx both load
 // it, so this preview loads it too.
 // The one setting per game, read from the same constants the server mirrors:
 // the live ordinary board (never a deactivated one, and never a chooser), the
 // one road, and the dealt number of mines on the sample reveal.
 const TABLE=PLINKO_TABLES[plinkoTableVersion(1)];
 const ROAD=ROAD_LADDERS[CHOICE_MODE.crossing];
 const MINES=Number(CHOICE_MODE.mines);
 const MINE_PICKS=25-MINES;
 const MINE_CELLS=Array.from({length:MINES},(_,i)=>i*4+1);
 const GAMES:DiamondBonusGame[]=['plinko','crash','crossing','mines'];
 // The crash hero is pinned at the table cap, the widest figure the glass can
 // ever print, because this fixture exists to catch one that does not fit.
 const CRASH_CAP_CENTS=100000;
 function Preview(){const [game,setGame]=useState<DiamondBonusGame>('mines'),[picked,setPicked]=useState<number[]>([]),[phase,setPhase]=useState<'idle'|'open'|'cashed'|'lost'>('open'),[budget,setBudget]=useState<BonusBudget>(()=>plinkoBudget({base:100,doubled:false,denomination:10}));const [ref,width]=useMeasuredWidth<HTMLDivElement>(600);
 // An entry the controls cannot quote has no guarantee to state, so nothing here
 // asks the payout maths about it.
 const chips=validBonusBudget(budget)?bonusTotal(budget)/100:0;
 const minimum=chips>0?diamondBonusMinimum(chips):0;
 const guaranteed=gameChips(minimum);
 const prizes=chips<=0?[]:game==='crossing'?ROAD.map(m=>(chips*m)/100):game==='mines'?Array.from({length:MINE_PICKS},(_,i)=>{const p=minePrize(chips,MINES,i+1,minimum);return Number(p.numerator)/Number(p.denominator)/100;}):[];
 return <><nav aria-label="Preview games">{GAMES.map(g=><button key={g} onClick={()=>{setGame(g);setPicked([]);setPhase('open');}}>{g}</button>)}</nav>
 <GameConsole title={diamondGameTitle(game)} pill="Preview"
 setup={<BonusSetup budget={budget} onChange={b=>setBudget(plinkoBudget(b))} diamonds={1000} disabled={false} game={game} clubId="preview"/>}
 bays={[{label:'Entry',value:'100'},
 {label:game==='plinko'?'Drops':'Choices',value:game==='plinko'?'0/'+(plinkoDrops(budget)??'?'):String(picked.length)},
 {label:'Guaranteed',value:guaranteed+' Chips'},
 {label:'Current Prize',value:phase==='lost'?guaranteed:'2.57',ink:'gold'},
 {label:'Next Prize',value:'3.15',ink:'blue'}]}
 primary={{label:game==='crossing'?'Preview Safe Crossing':'Preview Start',onClick:()=>{setPicked(p=>[...p,p.length]);setPhase('open');}}}
 secondary={{label:'Preview Collision',onClick:()=>{setPicked(p=>[...p,p.length]);setPhase('lost');}}}>
 <div ref={ref} style={{width:'100%'}}>
 {game==='mines'||game==='crossing'?<ChoiceScene game={game} picked={picked} phase={phase} mines={phase==='lost'?MINE_CELLS:null} roadEnd={null} busy={false} onPick={i=>setPicked(p=>[...p,i])} ladder={game==='crossing'?ROAD:undefined} prizes={prizes} betChips={chips} payoutChips={phase==='lost'?minimum:undefined}/>:
 game==='crash'?<CrashCurve phase="open" growthK={0.12} capCents={CRASH_CAP_CENTS} startedAtLocalMs={0} finalCents={null} cashoutCents={null} autoCashoutCents={null} tickerCents={CRASH_CAP_CENTS} minimumPayoutChips={minimum} betChips={chips} width={Math.max(240,width)} height={Math.max(310,Math.min(580,width*.64))} />:
 <PlinkoBoard width={Math.min(600,Math.max(240,width))} multipliersCents={TABLE.multipliersCents} path={null} dropKey={0} restingSlot={null}/>}
 </div></GameConsole></>}
 createRoot(document.getElementById('root')!).render(<MemoryRouter><Preview/></MemoryRouter>);
 `,
    },
    bundle: true,
    jsx: 'automatic',
    write: false,
    outdir: '/tmp/diamond-games-preview',
    format: 'iife',
    define: { 'import.meta.env.DEV': 'false', 'import.meta.env.BASE_URL': '"/"' },
    external: ['/assets/*'],
    logLevel: 'silent',
  });
  return {
    javascript: bundle.outputFiles.find((f) => f.path.endsWith('.js')).text,
    css: bundle.outputFiles.find((f) => f.path.endsWith('.css')).text,
  };
}
