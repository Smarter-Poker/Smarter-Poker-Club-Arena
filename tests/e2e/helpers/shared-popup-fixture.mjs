/** The real shared popup (src/components/common/Modal) and the real popup
 *  stylesheets, mounted on demand so a case can decide when the entrance
 *  starts. No account, no server, no art: the entrance under test is a
 *  transform, and a transform needs no pixels. */
import { build } from 'esbuild';

let bundled;
export function sharedPopupFixture() {
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
          function Fixture(){
            const [open, setOpen] = React.useState(true);
            return (
              <Modal isOpen={open} onClose={() => setOpen(false)} ariaLabel="Fixture Popup"
                     showCloseButton={false} size="small">
                <button id="dismiss" type="button" onClick={() => setOpen(false)}>Not Now</button>
              </Modal>
            );
          }
          window.mountPopup = () => createRoot(document.getElementById('root')).render(<Fixture/>);
        `,
      },
      bundle: true,
      jsx: 'automatic',
      write: false,
      outdir: '/tmp/shared-popup-fixture',
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
