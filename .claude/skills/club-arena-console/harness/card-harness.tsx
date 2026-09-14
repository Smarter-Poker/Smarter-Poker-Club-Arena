/**
 * #ClubArenaConsole render harness. Copy to the REPO ROOT, render, delete.
 * Never commit it: it imports pages directly and would bloat the bundle.
 *
 * Add a surface to the switch below, then:
 *   bash .claude/skills/club-arena-console/harness/run-shots.sh /tmp/after "?surface=<key>"
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { supabase } from './src/lib/supabase';
import { useUserStore } from './src/stores/useUserStore';
import { masterBus } from './src/core/MasterBus';
import { ToastProvider } from './src/components/common/Toast';
// The globals a real page gets. metallic-popups.css especially: without it a
// dialog looks right in the harness and wrong in the app.
import './src/styles/club-engine.css';
import './src/styles/animations.css';
import './src/styles/metallic-popups.css';
import './src/styles/reducedMotion.css';

const CLUB = '11111111-1111-4111-8111-111111111111';
const now = Date.now();

/** Rows the page will read. One entry per table name it queries. */
const canned: Record<string, unknown> = {
  clubs: { name: 'Shark Club', settings: {}, owner_id: 'u1' },
  club_members: { role: 'owner' },
  profiles: [{ id: 'u1', username: 'KingFish' }],
};

function chain(table: string): any {
  const p: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (res: any) => res({ data: canned[table] ?? null, error: null });
      if (prop === 'maybeSingle')
        return () => Promise.resolve({ data: canned[table] ?? null, error: null });
      return () => p;
    },
    apply() {
      return p;
    },
  });
  return p;
}
(supabase as any).from = (t: string) => chain(t);
(supabase as any).channel = () => ({
  on() {
    return this;
  },
  subscribe() {
    return this;
  },
  unsubscribe() {},
});
(masterBus as any).getOrCreateChannel = () => ({
  on() {
    return this;
  },
  subscribe() {
    return this;
  },
});
(masterBus as any).removeRegisteredChannel = () => {};
useUserStore.getState().setUser({ id: 'u1', alias: 'KingFish', username: 'kingfish' } as any);

const q = new URLSearchParams(location.search);
const key = q.get('surface') || '';
/** `?surface=foo-empty` renders the `foo` branch with an empty-state tweak. */
const surface = key.replace(
  /-(compose|leave|poor|member|empty|out|error|missing|short|staff|busy)$/,
  ''
);

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div data-card={key} style={{ width: 393, minHeight: 700, background: '#000' }}>
      {children}
    </div>
  );
}

async function main() {
  let node: React.ReactNode = null;

  if (surface === 'confirm') {
    const { default: ConfirmModal } = await import('./src/components/common/ConfirmModal');
    node = (
      <ConfirmModal
        isOpen
        title="Close Table"
        message={'Close table "NLH 1/2 Main"? It can only close after every player has left.'}
        variant="danger"
        confirmText="Close Table"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
  }
  // ── add your surface here ───────────────────────────────────────────────
  // else if (surface === 'my-page') {
  //   const { default: Page } = await import('./src/pages/MyPage');
  //   node = <Routes><Route path="/clubs/:clubId/thing" element={<Page />} /></Routes>;
  // }

  const click = q.get('click');
  if (click)
    setTimeout(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent?.trim() === click)
        ?.click();
    }, 900);

  createRoot(document.getElementById('root')!).render(
    <MemoryRouter initialEntries={[`/clubs/${CLUB}/thing`]}>
      <ToastProvider>
        <Shell>{node}</Shell>
      </ToastProvider>
    </MemoryRouter>
  );
}
main();
