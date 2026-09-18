import { build } from 'esbuild';
/** Actual play controls and scenes; local-only sample outcomes, no API or wallet access. */
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
 import './src/pages/diamondGames.module.css';
 function Preview(){const [game,setGame]=useState('mines'),[picked,setPicked]=useState([]),[phase,setPhase]=useState('open'),[budget,setBudget]=useState({base:100,doubled:false,denomination:1});const [ref,width]=useMeasuredWidth(600);
 return <><nav aria-label="Preview games">{['plinko','crash','crossing','mines'].map(g=><button key={g} onClick={()=>{setGame(g);setPicked([]);setPhase('open');}}>{g}</button>)}</nav>
 <GameConsole title={{plinko:'Diamond Plinko',crash:'Diamond Crash',crossing:'Donkey Crossing',mines:'Diamond Mines'}[game]} pill="Preview"
 setup={<BonusSetup budget={budget} onChange={setBudget} diamonds={1000} disabled={false} plinko={game==='plinko'} clubId="preview"/>}
 bays={[{label:'Entry',value:'100'},{label:'Street',value:String(picked.length)},{label:'Current Prize',value:phase==='lost'?'0.00':'2.57',ink:'gold'},{label:'Next Prize',value:'3.15',ink:'blue'}]}
 primary={{label:game==='crossing'?'Preview Safe Crossing':'Preview Start',onClick:()=>{setPicked(p=>[...p,p.length]);setPhase('open');}}}
 secondary={{label:'Preview Collision',onClick:()=>{setPicked(p=>[...p,p.length]);setPhase('lost');}}}>
 <div ref={ref} style={{width:'100%'}}>
 {game==='mines'||game==='crossing'?<ChoiceScene game={game} picked={picked} phase={phase} mines={phase==='lost'?[1,5,12,17,24]:null} roadEnd={null} busy={false} onPick={i=>setPicked(p=>[...p,i])}/>:
 game==='crash'?<CrashCurve phase="open" growthK={0.12} capCents={100000} startedAtLocalMs={0} finalCents={null} cashoutCents={null} autoCashoutCents={null} width={Math.max(240,width)} height={Math.max(310,Math.min(580,width*.64))} />:
 <PlinkoBoard width={Math.min(600,Math.max(240,width))} multipliersCents={[100000,2500,900,400,200,100,60,30,20,30,60,100,200,400,900,2500,100000]} path={null} dropKey={0} restingSlot={null}/>}
 </div></GameConsole></>}
 createRoot(document.getElementById('root')).render(<MemoryRouter><Preview/></MemoryRouter>);
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
