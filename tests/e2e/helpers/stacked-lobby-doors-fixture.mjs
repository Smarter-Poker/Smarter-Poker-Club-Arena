/** The two optional lobby doors on the real shared popup: the club entry
 *  message (full screen, "Club Message From ...") and the Diamond Spins
 *  invitation (small). Both are src/components/common/Modal, so both portal a
 *  `.ca-modal-portal` at the same z-index onto document.body and the door that
 *  opens SECOND is the top layer, exactly as in the live lobby, where the order
 *  is whichever of their two reads answered last. No account, no server, no
 *  art: the stack under test is DOM order and hit-testing, not pixels. */
import { build } from 'esbuild';

let bundled;
export function stackedLobbyDoorsFixture() {
  return (bundled ??= (async () => {
    const result = await build({
      stdin: {
        resolveDir: process.cwd(),
        loader: 'tsx',
        contents: `
          import './src/styles/metallic-popups.css';
          import React from 'react';
          import {createRoot} from 'react-dom/client';
          import {Modal} from './src/components/common/Modal';
          const counts = { declines: 0, dismissals: 0 };
          window.lobbyDoorCounts = counts;
          function Fixture({ first, invitationCloses, notNowDelayMs }) {
            const [greeting, setGreeting] = React.useState(first === 'greeting');
            const [invitation, setInvitation] = React.useState(first === 'invitation');
            const [notNowReady, setNotNowReady] = React.useState(notNowDelayMs === 0);
            React.useEffect(() => {
              if (notNowDelayMs === 0) return undefined;
              const ready = setTimeout(() => setNotNowReady(true), notNowDelayMs);
              return () => clearTimeout(ready);
            }, []);
            React.useEffect(() => {
              const later = setTimeout(() => {
                if (first === 'greeting') setInvitation(true);
                else setGreeting(true);
              }, 150);
              return () => clearTimeout(later);
            }, []);
            return (
              <>
                <button role="tab" aria-selected="false" type="button"
                  onClick={(e) => e.currentTarget.setAttribute('aria-selected', 'true')}>NLH</button>
                <Modal isOpen={greeting} onClose={() => setGreeting(false)} size="fullscreen"
                       showCloseButton={false} closeOnOverlay={false}
                       ariaLabel="Club Message From Fixture Club">
                  <button type="button" aria-label="Close Club Message"
                          onClick={() => setGreeting(false)}>X</button>
                  <p>Welcome To The Fixture Club</p>
                  <button type="button" onClick={() => {
                    fetch('https://fixture.invalid/rest/v1/rpc/fn_dismiss_club_message', { method: 'POST' })
                      .then((r) => r.json())
                      .then((body) => { if (body.ok) { counts.dismissals += 1; setGreeting(false); } });
                  }}>Do Not Show Me This Message Again</button>
                </Modal>
                <Modal isOpen={invitation} onClose={() => setInvitation(false)} size="small"
                       showCloseButton={false} ariaLabel="Diamond Spins">
                  <p>You Have Diamonds Ready To Play</p>
                  <button type="button" disabled={!notNowReady} onClick={() => {
                    counts.declines += 1;
                    if (invitationCloses) setInvitation(false);
                  }}>Not Now</button>
                </Modal>
              </>
            );
          }
          window.mountLobbyDoors = (first, invitationCloses = true, notNowDelayMs = 0) =>
            createRoot(document.getElementById('root')).render(
              <Fixture first={first} invitationCloses={invitationCloses}
                       notNowDelayMs={notNowDelayMs} />
            );
        `,
      },
      bundle: true,
      jsx: 'automatic',
      write: false,
      outdir: '/tmp/stacked-lobby-doors-fixture',
      format: 'iife',
      define: { 'import.meta.env': '{"DEV":false,"BASE_URL":"/","VITE_NATIVE":"0"}' },
      external: ['/assets/*', '/fonts/*', 'https://*', '@capacitor/haptics'],
      logLevel: 'silent',
    });
    return {
      javascript: result.outputFiles.find((f) => f.path.endsWith('.js')).text,
      css: result.outputFiles.find((f) => f.path.endsWith('.css')).text,
    };
  })());
}
