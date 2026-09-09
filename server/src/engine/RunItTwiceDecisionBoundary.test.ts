import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({ supabase: {}, maintenanceSupabase: {} }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../http/auth.js', () => ({
  authenticateRequest: vi.fn(async () => ({ userId: 'spectator' })),
}));
vi.mock('../http/body.js', () => ({ readBody: vi.fn(async (req: any) => req.body) }));
import { RunItTwiceEngine } from './RunItTwiceEngine.js';
import { ServerTableEngine } from './ServerTableEngine.js';
import { handleRit } from '../handlers/rit.js';
import { mockReq, mockRes, parseJson } from '../handlers/_testHelpers.js';
import type { DeadlineScheduler } from './DeadlineScheduler.js';

const engines: any[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.preciseTimer.dispose();
});

function fixture() {
  const tableId = 'rit-boundary';
  const rit = new RunItTwiceEngine(undefined, {
    start() {},
    schedule() {},
    cancel() {},
  } as unknown as DeadlineScheduler);
  rit.configure(tableId, { enabled: true, autoDeclineTimeout: 10, maxRuns: 2 });
  rit.offer(tableId, 'hand-1', 'a', ['a', 'b'], 200);
  const engine = new ServerTableEngine(tableId) as any;
  engines.push(engine);
  engine.runItTwiceEngine = rit;
  engine.hub = { emitEvent: vi.fn() };
  return { engine, rit, tableId };
}

it('a nonparticipant cannot decline at the consent source', () => {
  const { rit, tableId } = fixture();
  rit.decline(tableId, 'spectator');
  expect(rit.getState(tableId)?.status).toBe('offered');
});

it.each(['accept', 'decline'] as const)(
  'rejects a spectator %s without state or broadcast changes',
  (response) => {
    const { engine, rit, tableId } = fixture();
    expect(engine.respondToRIT('spectator', response)).toMatchObject({ success: false });
    expect(rit.getState(tableId)?.status).toBe('offered');
    expect([...rit.getState(tableId)!.acceptedBy]).toEqual(['a']);
    expect(engine.hub.emitEvent).not.toHaveBeenCalled();
  }
);

it('the authenticated HTTP identity cannot impersonate a participant to decline', async () => {
  const { engine, rit, tableId } = fixture();
  const req = Object.assign(mockReq(), {
    body: JSON.stringify({ tableId, response: 'decline', userId: 'a' }),
  });
  const { res, captured } = mockRes();
  await handleRit(req, res, { gameServer: { getTableEngine: () => engine } });
  expect(captured.statusCode).toBe(400);
  expect(parseJson(captured)).toMatchObject({ success: false });
  expect(rit.getState(tableId)?.status).toBe('offered');
});

it('a late chooser cannot announce a different run count after consent is final', () => {
  const { engine, rit, tableId } = fixture();
  engine.respondToRIT('a', undefined, 2);
  expect(engine.respondToRIT('b', 'accept')).toMatchObject({ success: true, status: 'accepted' });
  engine.hub.emitEvent.mockClear();
  expect(engine.respondToRIT('a', undefined, 3)).toMatchObject({ success: false });
  expect(rit.getChosenRuns(tableId)).toBe(2);
  expect(engine.hub.emitEvent).not.toHaveBeenCalled();
});

it('announces the allowed count when a chooser requests above the table maximum', () => {
  const { engine, rit, tableId } = fixture();
  expect(engine.respondToRIT('a', undefined, 3)).toMatchObject({ success: true });
  expect(rit.getState(tableId)?.chosenRuns).toBe(2);
  const event = engine.hub.emitEvent.mock.calls.find(
    (c: any[]) => c[1].type === 'rit_chooser_decided'
  )[1];
  expect(event.chosenRuns).toBe(2);
});

it('still allows every participant to finish or refuse the offer', () => {
  const { engine, rit, tableId } = fixture();
  expect(engine.respondToRIT('a', undefined, 2)).toMatchObject({ success: true });
  expect(engine.respondToRIT('b', 'decline')).toMatchObject({ success: true });
  expect(rit.getState(tableId)?.status).toBe('declined');
  expect(rit.getChosenRuns(tableId)).toBe(1);
});
