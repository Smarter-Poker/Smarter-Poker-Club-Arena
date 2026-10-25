/**
 * One dropped Realtime socket is one report, not one per channel (2026-10-24).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sink = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: sink.report }));

import {
  TRANSPORT_LOSS_REPORT_CEILING_MS,
  __resetRealtimeTransportLossForTests,
  isRealtimeTopicRefusal,
  isRealtimeTransportLoss,
  noteRealtimeTransportLoss,
  noteRealtimeTransportRecovered,
} from '../../src/lib/realtimeTransportLoss';

beforeEach(() => {
  vi.clearAllMocks();
  __resetRealtimeTransportLossForTests();
});

describe('isRealtimeTransportLoss', () => {
  it('is a CHANNEL_ERROR with no server reason (the SDK socket fan-out)', () => {
    expect(isRealtimeTransportLoss('CHANNEL_ERROR')).toBe(true);
    expect(isRealtimeTransportLoss('CHANNEL_ERROR', undefined)).toBe(true);
  });

  it('is an admission failure of the shared socket', () => {
    expect(
      isRealtimeTransportLoss(
        'CHANNEL_ERROR',
        new Error('Realtime transport closed before admission')
      )
    ).toBe(true);
    expect(
      isRealtimeTransportLoss(
        'CHANNEL_ERROR',
        new DOMException('Realtime transport/auth admission timed out', 'TimeoutError')
      )
    ).toBe(true);
  });

  it('is not a channel the server refused or a join that timed out', () => {
    const refused = new Error(
      '"Unauthorized: You do not have permissions to read from this Channel topic: x"'
    );
    expect(isRealtimeTransportLoss('CHANNEL_ERROR', refused)).toBe(false);
    expect(
      isRealtimeTransportLoss(
        'CHANNEL_ERROR',
        new Error('mismatch between server and client bindings for postgres changes')
      )
    ).toBe(false);
    expect(isRealtimeTransportLoss('TIMED_OUT')).toBe(false);
    expect(isRealtimeTransportLoss('CLOSED')).toBe(false);
  });
});

describe('noteRealtimeTransportLoss', () => {
  it('files one report for every channel the drop fanned out to', () => {
    for (const name of ['profile-account:u', 'profile-appearance:u', 'daily-mission-completion:u'])
      noteRealtimeTransportLoss(name, 'useMasterBusBroadcastChannel.x', undefined, 1_000);
    expect(sink.report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'Realtime transport lost (socket closed)' }),
      'Realtime.transport_lost',
      { firstChannel: 'profile-account:u', via: 'useMasterBusBroadcastChannel.x' }
    );
  });

  it('stays quiet through recovery retries of the same outage', () => {
    noteRealtimeTransportLoss('a', 's', undefined, 0);
    noteRealtimeTransportLoss('a', 's', undefined, 30_000);
    noteRealtimeTransportLoss('a', 's', undefined, 60_000);
    expect(sink.report).toHaveBeenCalledOnce();
  });

  it('counts the next drop once a channel has joined again', () => {
    noteRealtimeTransportLoss('a', 's', undefined, 0);
    noteRealtimeTransportRecovered();
    noteRealtimeTransportLoss('a', 's', undefined, 1);
    expect(sink.report).toHaveBeenCalledTimes(2);
  });

  it('reports a socket that never comes back once per ceiling', () => {
    noteRealtimeTransportLoss('a', 's', undefined, 0);
    noteRealtimeTransportLoss('a', 's', undefined, TRANSPORT_LOSS_REPORT_CEILING_MS - 1);
    noteRealtimeTransportLoss('a', 's', undefined, TRANSPORT_LOSS_REPORT_CEILING_MS);
    expect(sink.report).toHaveBeenCalledTimes(2);
  });
});

describe('isRealtimeTopicRefusal', () => {
  it('recognises the server RLS refusal, quoted or not', () => {
    expect(
      isRealtimeTopicRefusal(
        new Error(
          '"Unauthorized: You do not have permissions to read from this Channel topic: table-appearance:x"'
        )
      )
    ).toBe(true);
    expect(isRealtimeTopicRefusal(undefined)).toBe(false);
    expect(isRealtimeTopicRefusal(new Error('Realtime transport closed before admission'))).toBe(
      false
    );
  });
});
