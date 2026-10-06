import { describe, expect, it } from 'vitest';
import jsonPatch from 'fast-json-patch';
import { TableStateHub, type HubSubscriber } from './TableStateHub.js';

function wireClient(id: string) {
  let state: Record<string, unknown> = {};
  let seq = 0;
  const failures: unknown[] = [];
  const frames: any[] = [];
  const sub: HubSubscriber = {
    id,
    readyState: 1,
    send(raw) {
      const frame = JSON.parse(raw);
      frames.push(frame);
      try {
        if (frame.type === 'SNAPSHOT') state = frame.state;
        else if (frame.type === 'DELTA') {
          expect(frame.prev).toBe(seq);
          // Validate against the actual serialized snapshot, as a strict
          // consumer must. Missing replace/remove paths are invalid RFC 6902.
          state = jsonPatch.applyPatch(state, frame.patch, true, false).newDocument;
        } else return;
        seq = frame.seq;
      } catch (error) {
        failures.push(error);
      }
    },
  };
  return { sub, frames, failures, state: () => state, seq: () => seq };
}

describe('TableStateHub wire baseline', () => {
  it('applies optional-field transitions to live, late-joining and resynced clients', () => {
    const hub = new TableStateHub();
    const live = wireClient('live');
    hub.subscribe('table', live.sub);
    const states = [
      { seats: [{ lastAction: undefined, stack: 200 }], turn: undefined },
      { seats: [{ lastAction: 'call', stack: 198 }], turn: { seat: 1 } },
      { seats: [{ lastAction: undefined, stack: 198 }], turn: undefined },
      { seats: [{ stack: 198 }] },
      { seats: [{ lastAction: 'check', stack: 198 }], turn: { seat: 2 } },
    ];
    hub.publish('table', states[0]);
    const late = wireClient('late');
    hub.subscribe('table', late.sub);
    for (const state of states.slice(1)) {
      hub.publish('table', state);
      for (const client of [live, late]) {
        expect(client.failures).toEqual([]);
        expect(client.state()).toEqual(JSON.parse(JSON.stringify(state)));
        expect(client.seq()).toBe(hub.lastSeq('table'));
      }
      hub.resync('table', late.sub);
    }
    expect(live.frames[1].patch).toContainEqual({ op: 'add', path: '/turn', value: { seat: 1 } });
    // Omitting a field already absent on the wire is a no-op, not a remove.
    expect(live.frames).toHaveLength(4);
  });

  it('retains JSON array/null semantics and owns its baseline independently of the producer', () => {
    const hub = new TableStateHub();
    const client = wireClient('live');
    hub.subscribe('table', client.sub);
    const source = { values: [undefined, null, 3], optional: undefined, nested: { value: 1 } };
    hub.publish('table', source);
    source.nested.value = 2;
    source.values[0] = 7;
    hub.publish('table', source);
    expect(client.failures).toEqual([]);
    expect(client.state()).toEqual({ values: [7, null, 3], nested: { value: 2 } });
    expect(hub.publish('table', { values: [7, null, 3], nested: { value: 2 } })).toBe(2);
    expect(client.frames).toHaveLength(2);
  });
});
