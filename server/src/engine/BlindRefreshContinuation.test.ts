import { test, expect, vi, afterEach } from 'vitest';
const io = vi.hoisted(() => ({ loadTable: vi.fn() }));
vi.mock('../services/supabase.js', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  loadTable: io.loadTable,
}));
import { ServerTableEngine } from './ServerTableEngine.js';
class Engine extends ServerTableEngine {
  constructor(id: string) {
    super(id);
    this.engineTelemetry.dispose();
  }
  activate() {
    expect((this as any).claimProcessOwnership()).toBe(true);
    this.running = true;
    this.tableInfo = {
      id: this.tableId,
      tournament_id: 'original',
      lifecycle: 'live',
      small_blind: 10,
      big_blind: 20,
      ante: 0,
    } as any;
    this.hub = { emitEvent: vi.fn() } as any;
  }
  refresh() {
    return this.refreshBlinds();
  }
  bounded(ms: number) {
    return this.withStepBudget('refresh_blinds', ms, this.refreshBlinds());
  }
  meta() {
    return this.tableInfo;
  }
  events() {
    return (this.hub as any).emitEvent;
  }
  replaceMetadata() {
    this.tableInfo = { ...this.tableInfo!, lifecycle: 'breaking' };
  }
  changeLifecycle() {
    this.tableInfo!.lifecycle = 'breaking';
  }
  dropOwnerForReplacement() {
    (this.constructor as any).liveEngines.delete(this.tableId);
  }
}
const engines: Engine[] = [];
function create() {
  const e = new Engine('blind-refresh-' + engines.length);
  engines.push(e);
  e.activate();
  return e;
}
afterEach(async () => {
  vi.useRealTimers();
  for (const e of engines.splice(0)) await e.stop();
  io.loadTable.mockReset();
});
const fresh = { small_blind: 20, big_blind: 40, ante: 5 };
test('successful actual blind refresh applies metadata and emits only when changed', async () => {
  const e = create();
  io.loadTable.mockResolvedValue(fresh);
  await e.refresh();
  expect(e.meta()).toMatchObject(fresh);
  expect(e.events()).toHaveBeenCalledTimes(1);
  await e.refresh();
  expect(e.events()).toHaveBeenCalledTimes(1);
});
test('budget timeout does not release actual continuation; stop waits for delayed read and discards its result', async () => {
  vi.useFakeTimers();
  const e = create();
  let resolve!: (v: any) => void;
  io.loadTable.mockImplementation(() => new Promise((r) => (resolve = r)));
  const timed = e.bounded(20);
  const rejected = expect(timed).rejects.toThrow('deal_step_timeout');
  await vi.advanceTimersByTimeAsync(21);
  await rejected;
  let stopped = false;
  const stop = e.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  resolve(fresh);
  await stop;
  expect(e.meta()).toMatchObject({ small_blind: 10, big_blind: 20, ante: 0 });
  expect(e.events()).not.toHaveBeenCalled();
  await e.refresh();
  expect(io.loadTable).toHaveBeenCalledTimes(1);
});
test('delayed reply after metadata lifecycle replacement cannot alter replacement metadata', async () => {
  const e = create();
  let resolve!: (v: any) => void;
  io.loadTable.mockImplementation(() => new Promise((r) => (resolve = r)));
  const pending = e.refresh();
  e.replaceMetadata();
  resolve(fresh);
  await pending;
  expect(e.meta()).toMatchObject({ lifecycle: 'breaking', big_blind: 20 });
  expect(e.events()).not.toHaveBeenCalled();
});
test('delayed original reply cannot emit or update after actual process-slot replacement', async () => {
  const e = create();
  let resolve!: (v: any) => void;
  io.loadTable.mockImplementation(() => new Promise((r) => (resolve = r)));
  const pending = e.refresh();
  e.dropOwnerForReplacement();
  const replacement = new Engine((e as any).tableId);
  engines.push(replacement);
  replacement.activate();
  resolve(fresh);
  await pending;
  expect(e.meta()).toMatchObject({ big_blind: 20 });
  expect(e.events()).not.toHaveBeenCalled();
  expect(replacement.meta()).toMatchObject({ big_blind: 20 });
  expect(replacement.events()).not.toHaveBeenCalled();
});
test('stop during retry backoff retains continuation and prevents another read', async () => {
  vi.useFakeTimers();
  const e = create();
  io.loadTable.mockRejectedValue(Error('fetch failed'));
  const pending = e.refresh();
  await vi.advanceTimersByTimeAsync(1);
  let stopped = false;
  const stop = e.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  await vi.advanceTimersByTimeAsync(500);
  await pending;
  await stop;
  expect(io.loadTable).toHaveBeenCalledTimes(1);
  expect(e.events()).not.toHaveBeenCalled();
});

test('same metadata object with changed lifecycle discards a delayed reply', async () => {
  const e = create();
  let resolve!: (v: any) => void;
  io.loadTable.mockImplementation(() => new Promise((r) => (resolve = r)));
  const pending = e.refresh();
  e.changeLifecycle();
  resolve(fresh);
  await pending;
  expect(e.meta()).toMatchObject({ lifecycle: 'breaking', big_blind: 20 });
  expect(e.events()).not.toHaveBeenCalled();
});
test('current owner preserves the existing transient retry and successful update', async () => {
  vi.useFakeTimers();
  const e = create();
  io.loadTable.mockRejectedValueOnce(Error('fetch failed')).mockResolvedValueOnce(fresh);
  const pending = e.refresh();
  await vi.advanceTimersByTimeAsync(501);
  await pending;
  expect(io.loadTable).toHaveBeenCalledTimes(2);
  expect(e.meta()).toMatchObject(fresh);
  expect(e.events()).toHaveBeenCalledTimes(1);
});
