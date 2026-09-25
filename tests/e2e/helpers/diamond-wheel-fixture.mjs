import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

// Real components, CSS and local artwork. Only the already-settled server receipt
// and the destination page are fixtures; there is no API, account or wallet.
let bundled;
export function diamondWheelFixture() {
  bundled ??= (async () => {
    const records = JSON.parse(
      readFileSync('tests/fixtures/diamond-spins/wheel-v3-postgres-receipts.json', 'utf8')
    ).records;
    const wheel = records.filter((record) => record.kind === 'wheel').map((record) => record.value);
    const receipts = {
      prize: wheel.find((receipt) => receipt.outcome.kind === 'chips'),
      bonus: wheel.find((receipt) => receipt.outcome.kind === 'bonus'),
      upgrade: wheel.find((receipt) => receipt.secondary?.outcome.kind === 'bonus'),
      upgradechips: wheel.find(
        (receipt) =>
          receipt.secondary?.outcome.multiplier === 100 && receipt.entry_value_diamonds === 2500
      ),
    };
    if (Object.values(receipts).some((receipt) => !receipt))
      throw new Error('Wheel fixture receipts are incomplete');
    const result = await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
          import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
          import {MemoryRouter,useNavigate,useLocation} from 'react-router-dom';
          import {WheelExperience} from './src/components/wheel/WheelExperience';
          import {WheelCabinet,WheelPrizeGallery,WheelEntry} from './src/components/wheel/WheelCabinet';
          import {useMeasuredWidth} from './src/hooks/useMeasuredWidth';
          const receipts=${JSON.stringify(receipts)};
          const previews=${JSON.stringify(wheel.filter((r) => r.secondary))};
          window.wheelProof={finished:0,events:[],upgradeStates:[]};
          // Record short-lived rendered states in the browser. Serial driver
          // assertions can miss a complete secondary spin under CI tracing.
          const observeUpgrade=()=>{
            const upper=document.querySelector('[aria-label="Upgrade Wheel"]');
            const main=document.querySelector('[aria-label="Diamond Wheel"]');
            if(!upper||!main)return;
            const state={
              phase:upper.dataset.phase,
              expanded:document.querySelector('[data-wheel-assembly]').dataset.upgradeReveal,
              selectors:upper.querySelectorAll('[data-wheel-selector]').length,
              titles:upper.querySelectorAll('[data-card-design="title"]').length,
              cards:upper.querySelectorAll('[data-card-design="full"]').length,
              slots:upper.querySelectorAll('[data-slot]').length,
              visible:upper.getBoundingClientRect().height>0&&getComputedStyle(upper).visibility==='visible',
              scale:getComputedStyle(main.querySelector('[data-wheel-face]')).transform,
              finished:window.wheelProof.finished,
              destination:document.querySelector('[data-testid="destination"]').textContent,
            };
            const last=window.wheelProof.upgradeStates.at(-1);
            if(JSON.stringify(last)!==JSON.stringify(state))window.wheelProof.upgradeStates.push(state);
          };
          new MutationObserver(observeUpgrade).observe(document.getElementById('root'),{
            subtree:true,childList:true,attributes:true,
            attributeFilter:['data-phase','data-upgrade-reveal','style'],
          });
          document.addEventListener('transitionend',observeUpgrade,true);
          function Fixture(){
            const kind=new URLSearchParams(window.location.search).get('kind')||'prize';
            const receipt=receipts[kind];const [spinning,setSpinning]=useState(false);
            const [entry,setEntry]=useState(receipt.entry_value_diamonds);const navigate=useNavigate();const location=useLocation();
            const [stageRef,stageWidth]=useMeasuredWidth(300);
            const finish=()=>{
              window.wheelProof.finished++;window.wheelProof.events.push({event:'finished',time:performance.now()});
              setSpinning(false);
              if(receipt.bonus)navigate('/clubs/fixture/'+receipt.bonus.game+'?wheelAward='+receipt.bonus.id);
            };
            return <main style={{containerType:'inline-size',width:'100%'}}>
              <output data-testid="destination">{location.pathname+location.search}</output>
              {location.pathname.endsWith('/wheel')?<>
                <WheelCabinet title="Diamond Spins" titleId="wheel-heading" pill="Local Preview"
                  bays={[{label:'Entry',value:String(entry)},{label:'Balance',value:'10,000'}]}
                  setup={<WheelEntry value={entry} disabled={spinning} onChange={setEntry}/>}
                  primary={{label:'Preview Spin',disabled:spinning,onClick:()=>setSpinning(true)}}
                  secondary={{label:'Buy More',disabled:spinning,onClick:()=>{}}}>
                  <div ref={stageRef}><WheelExperience segments={receipt.segments} upgradeSegments={previews[0].secondary.segments} receipt={spinning?receipt:null} spinKey={1}
                    spinning={spinning} size={Math.max(240,stageWidth)} onFinished={finish}/></div>
                </WheelCabinet>
                <WheelPrizeGallery segments={receipt.segments}/>
              </>:<h1>Earned Game Entry</h1>}
            </main>;
          }
          createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/clubs/fixture/wheel']}><Fixture/></MemoryRouter>);
        `,
      },
      bundle: true,
      jsx: 'automatic',
      write: false,
      outdir: '/tmp/diamond-wheel-browser-fixture',
      format: 'iife',
      define: { 'import.meta.env': '{"DEV":false,"BASE_URL":"/","VITE_NATIVE":"0"}' },
      // The browser never enters the native-only vibration branch.
      external: ['/assets/*', '/fonts/*', '@capacitor/haptics'],
      logLevel: 'silent',
    });
    return {
      javascript: result.outputFiles.find((file) => file.path.endsWith('.js')).text,
      css: result.outputFiles.find((file) => file.path.endsWith('.css')).text,
      receipts,
    };
  })();
  return bundled;
}

export async function mountDiamondWheel(page, kind, width) {
  const bundle = await diamondWheelFixture();
  const assetRoot = resolve('public/assets');
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://diamond-wheel.test') return route.abort();
    if (url.pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--animation-speed:.25}*{box-sizing:border-box}body{margin:0;background:#000;color:#fff;font-family:Arial}output{position:absolute;left:0;top:0;font-size:1px}</style><div id="root"></div>',
      });
    if (!url.pathname.startsWith('/assets/')) return route.abort();
    const path = resolve('public', '.' + decodeURIComponent(url.pathname));
    if (!path.startsWith(assetRoot + sep)) return route.abort();
    return route.fulfill({ path });
  });
  await page.goto('https://diamond-wheel.test/?kind=' + kind);
  await page.addStyleTag({ content: bundle.css });
  await page.evaluate(() => {
    for (const type of ['animationstart', 'animationend'])
      document.addEventListener(
        type,
        (event) => {
          if (!event.animationName.includes('prize-pop-open')) return;
          const dialog = event.target.closest('[role="dialog"]');
          window.wheelProof.events.push({
            event: type,
            title: dialog?.getAttribute('aria-label'),
            time: performance.now(),
          });
        },
        true
      );
  });
  await page.addScriptTag({ content: bundle.javascript });
  return bundle.receipts[kind];
}
