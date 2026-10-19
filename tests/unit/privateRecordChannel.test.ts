import { describe, expect, it, vi } from 'vitest';
import { EngineChannelClient } from '../../src/services/EngineStateClient';

describe('private record intent uses the existing engine socket', () => {
  it('replays refcounted topic intent after reconnect and removes only the final subscriber', () => {
    const client = new EngineChannelClient({
      baseUrl: 'https://engine.invalid',
      getToken: async () => null,
    });
    const wire = vi.fn();
    (client as any).ws = { readyState: WebSocket.OPEN, send: wire };
    const topic = 'club-roster:11111111-1111-1111-1111-111111111111';
    const a = vi.fn();
    const b = vi.fn();
    const leaveA = client.onPrivateRecord(topic, a);
    const leaveB = client.onPrivateRecord(topic, b);
    (client as any).handleMessage({ type: 'PRIVATE_RECORD_STATUS', topic, ready: true });
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    leaveA();
    wire.mockClear();
    (client as any).replayDesiredState({ send: wire });
    expect(wire).toHaveBeenCalledWith(JSON.stringify({ type: 'JOIN_PRIVATE_RECORD', topic }));
    (client as any).handleMessage({ type: 'PRIVATE_RECORD_CHANGED', topic });
    expect(b).toHaveBeenLastCalledWith({ type: 'PRIVATE_RECORD_CHANGED', topic });
    leaveB();
    expect(wire).toHaveBeenLastCalledWith(JSON.stringify({ type: 'LEAVE_PRIVATE_RECORD', topic }));
    wire.mockClear();
    (client as any).replayDesiredState({ send: wire });
    expect(wire).not.toHaveBeenCalled();
  });
  it('clears old account intent and callbacks on session reset', () => {
    const client = new EngineChannelClient({
      baseUrl: 'https://engine.invalid',
      getToken: async () => null,
    });
    const wire = vi.fn();
    const close = vi.fn();
    (client as any).ws = { readyState: WebSocket.OPEN, send: wire, close };
    const topic = 'club-roster:11111111-1111-1111-1111-111111111111';
    const old = vi.fn();
    client.onPrivateRecord(topic, old);
    (client as any).setStatus('connected');
    client.resetSession(true);
    expect(close).toHaveBeenCalled();
    expect(old).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false }));
    old.mockClear();
    wire.mockClear();
    (client as any).replayDesiredState({ send: wire });
    (client as any).handleMessage({ type: 'PRIVATE_RECORD_CHANGED', topic });
    expect(wire).not.toHaveBeenCalled();
    expect(old).not.toHaveBeenCalled();
    (client as any).ws = { readyState: WebSocket.OPEN, send: wire, close };
    const next = vi.fn();
    client.onPrivateRecord(topic, next);
    (client as any).handleMessage({ type: 'PRIVATE_RECORD_CHANGED', topic });
    expect(next).toHaveBeenCalled();
    expect(old).not.toHaveBeenCalled();
  });

  it('marks engine delivery unavailable on socket loss before reconnect', () => {
    const client = new EngineChannelClient({
      baseUrl: 'https://engine.invalid',
      getToken: async () => null,
    });
    (client as any).ws = { readyState: WebSocket.OPEN, send: vi.fn() };
    const listener = vi.fn();
    client.onPrivateRecord('club-roster:11111111-1111-1111-1111-111111111111', listener);
    (client as any).setStatus('connected');
    (client as any).setStatus('reconnecting');
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'PRIVATE_RECORD_STATUS', ready: false })
    );
  });
});
