import { expect, it } from 'vitest';
import { EngineChannelClient } from '../../src/services/EngineStateClient';
it('retires primary identity intent before a dependent reset failure is exposed', () => {
  const client = new EngineChannelClient();
  const state = client as any;
  state.sendQueue = [{ type: 'old-account-action' }];
  state.privateRecordListeners.set('old-account', new Set());
  const remove = client.onSessionReset(() => {
    throw new Error('dependent reset refused');
  });
  expect(() => client.resetSession(false)).toThrow('dependent reset refused');
  expect(client.getStatus()).toBe('idle');
  expect(state.sessionBlocked).toBe(true);
  expect(state.sendQueue).toEqual([]);
  expect(state.privateRecordListeners.size).toBe(0);
  remove();
  expect(() => client.resetSession(true)).not.toThrow();
});
