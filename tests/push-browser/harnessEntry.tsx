/**
 * Browser harness for the push opt-in flow. Mounts the REAL prompt host
 * (src/components/notifications/FirstRunPushPrompt.tsx), the REAL push client
 * (src/lib/pushClient.ts) and the REAL nudge policy. Only the auth hook is
 * replaced (harnessAuth.ts) and the hub API is served by harnessServer.mjs.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import FirstRunPushPrompt from '../../src/components/notifications/FirstRunPushPrompt';
import { requestPushNudge } from '../../src/lib/pushNudgePolicy';
import { hasLocalSubscription } from '../../src/lib/pushClient';

function Harness() {
  const [taps, setTaps] = useState(0);
  const [status, setStatus] = useState('unknown');
  return (
    <MemoryRouter initialEntries={['/clubs/harness-club']}>
      <main style={{ padding: 16, fontFamily: 'sans-serif' }}>
        <button type="button" onClick={() => requestPushNudge('club_joined')}>
          Harness Join Club
        </button>
        <button type="button" onClick={() => requestPushNudge('rakeback_receipt')}>
          Harness Rakeback Receipt
        </button>
        <button type="button" onClick={() => setTaps((n) => n + 1)}>
          Harness Page Control
        </button>
        <button
          type="button"
          onClick={async () => setStatus((await hasLocalSubscription()) ? 'on' : 'off')}
        >
          Harness Read Status
        </button>
        <output data-testid="taps">{taps}</output>
        <output data-testid="status">{status}</output>
      </main>
      <FirstRunPushPrompt />
    </MemoryRouter>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
