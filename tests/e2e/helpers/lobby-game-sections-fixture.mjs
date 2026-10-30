import { build } from 'esbuild';

export async function lobbyGameSectionsFixture() {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import LobbyGameSections from './src/components/lobby/LobbyGameSections';
        function Fixture() {
          const [selected, setSelected] = React.useState(null);
          return <div className="club-home club-home--unified-mobile"><div className="club-lobby-command-top"><section className="lobby-controls">
            <div className="lobby-controls__heading"><strong className="lobby-controls__title">Find Your Game</strong></div>
            <LobbyGameSections selected={selected} onToggle={s => setSelected(p => p === s ? null : s)} />
            {selected && <div id="lobby-game-section-controls" className="game-bar"><div className="game-bar__types" role="tablist" aria-label="Game Type">
              {(selected === 'cash' ? ['ALL','NLH','PLO','LIMIT'] : ['MTT','SPINS',"SIT N GO'S",'SATELLITES']).map(t => <button role="tab" className="game-bar__type" key={t}>{t}</button>)}
            </div></div>}
          </section></div></div>;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
      `,
    },
    // The test loads these exact sheets in cascade order itself.
    plugins: [
      {
        name: 'styles-loaded-by-fixture',
        setup(b) {
          b.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
        },
      },
    ],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
  });
  return result.outputFiles[0].text;
}
