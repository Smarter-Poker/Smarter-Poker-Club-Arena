import React, { useEffect } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useEngineTableState } from '../src/hooks/useEngineTableState';

const clients = vi.hoisted(
  () =>
    [] as Array<{
      onEvent: (event: Record<string, unknown>) => void;
      onUserEvent: (event: Record<string, unknown>) => void;
    }>
);
vi.mock('../src/lib/authToken', () => ({ getFreshAccessToken: vi.fn() }));
vi.mock('../src/services/EngineStateClient', () => ({
  default: class {
    constructor(options: (typeof clients)[number]) {
      clients.push(options);
    }
    connect() {
      return Promise.resolve();
    }
    disconnect() {}
    noteScheduledRestart() {}
    requestSnapshot() {}
  },
}));
afterEach(() => {
  cleanup();
  clients.length = 0;
});

it('commits each discrete public and private event before the next can replace it', () => {
  const seen: string[] = [];
  function Consumer() {
    const { lastEvent, lastUserEvent } = useEngineTableState('table-a');
    useEffect(() => {
      if (lastEvent) seen.push(String(lastEvent.type));
    }, [lastEvent]);
    useEffect(() => {
      if (lastUserEvent) seen.push(String(lastUserEvent.type));
    }, [lastUserEvent]);
    return null;
  }
  render(<Consumer />);
  act(() => {
    clients[0].onEvent({ type: 'HAND_STARTED' });
    clients[0].onEvent({ type: 'PLAYER_ACTION' });
    clients[0].onUserEvent({ type: 'HOLE_CARDS' });
    clients[0].onUserEvent({ type: 'PRE_ACTION' });
  });
  expect(seen).toEqual(['HAND_STARTED', 'PLAYER_ACTION', 'HOLE_CARDS', 'PRE_ACTION']);
});

it('rejects events from the prior table and from an unmounted owner', () => {
  const seen: string[] = [];
  function Consumer({ tableId }: { tableId: string }) {
    const { lastEvent, lastUserEvent } = useEngineTableState(tableId);
    useEffect(() => {
      if (lastEvent) seen.push(String(lastEvent.type));
    }, [lastEvent]);
    useEffect(() => {
      if (lastUserEvent) seen.push(String(lastUserEvent.type));
    }, [lastUserEvent]);
    return null;
  }
  const view = render(<Consumer tableId="table-a" />);
  const prior = clients[0];
  view.rerender(<Consumer tableId="table-b" />);
  act(() => {
    prior.onEvent({ type: 'OLD_HAND' });
    prior.onUserEvent({ type: 'OLD_CARDS' });
  });
  expect(seen).toEqual([]);
  act(() => clients[1].onEvent({ type: 'CURRENT_HAND' }));
  expect(seen).toEqual(['CURRENT_HAND']);
  view.unmount();
  act(() => clients[1].onEvent({ type: 'AFTER_UNMOUNT' }));
  expect(seen).toEqual(['CURRENT_HAND']);
});
