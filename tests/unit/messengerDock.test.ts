import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// Portable implementation is byte-identical to the Hub's source, recorded in
// the delivery checkpoint. These tests exercise the native Arena consumer.
import {
  dockCapacity,
  dockLayout,
  updateDock,
  restoreDock,
} from '../../src/components/messenger/dock/messengerDock.mjs';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
describe('native Messenger dock', () => {
  it('opens one window per conversation and preserves explicit minimization', () => {
    const conversation = { id: id(1), title: 'Player' };
    let rows = updateDock([], { type: 'open', conversation, incoming: true });
    rows = updateDock(rows, { type: 'minimize', id: id(1) });
    rows = updateDock(rows, { type: 'open', conversation, incoming: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].minimized).toBe(true);
    expect(rows[0].unread).toBe(true);
  });
  it('uses one phone conversation and bounded desktop windows', () => {
    expect(dockCapacity(375)).toBe(1);
    expect(dockCapacity(1440)).toBe(3);
    const chats = [1, 2, 3].reduce(
      (rows, n) => updateDock(rows, { type: 'open', conversation: { id: id(n) } }),
      []
    );
    for (const width of [320, 375, 390, 768, 1440]) {
      const layout = dockLayout(chats, { width, height: 844 });
      expect(layout.width).toBeLessThanOrEqual(width - 16);
      expect(layout.expanded.length).toBeLessThanOrEqual(dockCapacity(width));
    }
  });
  it('restores only UUID window identities without conversation content', () => {
    expect(restoreDock('broken')).toEqual([]);
    expect(restoreDock(JSON.stringify([{ id: id(1), secret: 'content' }]))).toEqual([
      { id: id(1), minimized: false },
    ]);
  });
  it('mounts once with no iframe bridge and uses the established authenticated APIs', () => {
    const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
    const root = read('src/components/messenger/dock/MessengerDock.jsx'),
      panel = read('src/components/messenger/dock/MessengerChat.jsx');
    expect(root + panel).not.toMatch(/<iframe|postMessage|setInterval|autoFocus/);
    expect(panel).toContain('performMessengerSend');
    expect(panel).toContain('visibleMessageBoundary');
    expect(read('src/App.tsx')).toContain('<MessengerDockHost />');
    expect(read('src/components/messenger/MessengerDockHost.tsx')).toContain('OPEN_HUB_TAB');
  });
});
