/** Real footer direction hook + real tournament styles. No API, account or
 * timers supply correctness: the browser itself resizes and clamps the panel. */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

let bundled;
export function tournamentScrollFeedbackFixture() {
  return (bundled ??= (async () => {
    const result = await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
          import React, {useLayoutEffect, useRef} from 'react';
          import {createRoot} from 'react-dom/client';
          import {useHideFooterOnScroll} from './src/components/club/useHideFooterOnScroll';
          function Fixture() {
            const {hidden} = useHideFooterOnScroll('/tournaments/fixture');
            const footer = useRef(null);
            useLayoutEffect(() => {
              document.documentElement.style.setProperty('--ca-bottom-chrome-h',
                hidden ? '0px' : footer.current.offsetHeight + 'px');
              window.footerFlips.push(hidden);
            }, [hidden]);
            return <>
              <section className="tournament-details" data-embedded="false"
                style={{'--details-h': '100dvh'}}>
                <header className="details-header" style={{height:160}}>Tournament</header>
                <nav className="details-tabs"><button>Details</button></nav>
                <div className="details-content"><div className="dov">
                  <div style={{height:180}}>Live Stats</div>
                  <div className="tl-panel dov-info dov-info--band">
                    {Array.from({length:12}, (_,i) =>
                      <p key={i} style={{height:24}}>Tournament Detail {i + 1}</p>)}
                  </div>
                </div></div>
                <footer className="details-footer"><button>Share</button><button>Late Register</button></footer>
              </section>
              <nav ref={footer} aria-label="Global Footer" data-footer-hidden={hidden}
                style={{position:'fixed',height:60,bottom:0,transform:hidden?'translateY(100%)':'none'}}>
                Global Footer
              </nav>
            </>;
          }
          window.footerFlips = [];
          createRoot(document.getElementById('root')).render(<Fixture/>);
        `,
      },
      bundle: true,
      jsx: 'automatic',
      write: false,
      format: 'iife',
      logLevel: 'silent',
    });
    return {
      javascript: result.outputFiles[0].text,
      css: [
        'src/pages/tournament/TournamentDetails.css',
        'src/components/tournament/details/DetailOverviewTab.css',
      ]
        .map((path) => readFileSync(path, 'utf8'))
        .join('\n'),
    };
  })());
}
