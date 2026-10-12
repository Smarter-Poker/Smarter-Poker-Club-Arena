import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  club: vi.fn(),
  status: vi.fn(),
  unClub: vi.fn(),
  unStatus: vi.fn(),
  event: (_event: any) => undefined as void,
  connection: (_status: string) => undefined as void,
}));
vi.mock('../../src/services/RealtimeChannelService', () => ({
  realtimeChannelService: { subscribeToClub: state.club },
}));
vi.mock('../../src/services/EngineStateClient', () => ({
  engineChannelClient: { onStatusChange: state.status },
}));
import { watchLightningOperator } from '../../src/lightning/lightningOperatorEvents';
it('uses the retained club scope, wakes only the chosen cluster and reconnects, then releases both listeners', () => {
  state.club.mockImplementation((_club, _user, _info, callbacks) => {
    state.event = callbacks.onEvent;
    return state.unClub;
  });
  state.status.mockImplementation((callback) => {
    state.connection = callback;
    return state.unStatus;
  });
  const changed = vi.fn();
  const stop = watchLightningOperator('club-a', 'cluster-a', changed);
  expect(state.club.mock.calls[0][0]).toBe('club-a');
  state.event({ type: 'lightning_operator_changed', clusterId: 'cluster-b' });
  state.event({ type: 'other', clusterId: 'cluster-a' });
  state.connection('disconnected');
  expect(changed).not.toHaveBeenCalled();
  state.event({ type: 'lightning_operator_changed', clusterId: 'cluster-a' });
  state.event({ type: 'lightning_operator_resync' });
  state.connection('connected');
  expect(changed).toHaveBeenCalledTimes(3);
  stop();
  expect(state.unClub).toHaveBeenCalledOnce();
  expect(state.unStatus).toHaveBeenCalledOnce();
});
