/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW - THE ENGINE NEVER SAYS "HORSE" ON THE WIRE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-02, binding: "NOBODY SHOULD EVER EVER EVER BE ABLE TO LOOK AT
 * OUR CODE OR USE A DEVELOPER TOOL AND FIND THIS OUT."
 *
 * Found 2026-09-08, after the client, the column grants, the RPC masks, the
 * Realtime publication, the report table and the avatar paths had all been
 * closed: every seat in all three client payloads - the resync
 * (getTableState), the hand broadcast and the between-hands roster - carried
 * `is_horse: p.is_horse ?? false`. The WebSocket frame in any player's
 * Network tab labelled every horse at the table, on every state change,
 * under a comment citing "Bible V8 section 2.3". A closed database and an open
 * socket is an open socket.
 *
 * The flag stays on the engine's own Player record - HorseLogic and
 * autoRebuyHorse are the horse's input device (CLAUDE.md 10.5) and they read
 * it there. It is never serialised into anything a client receives.
 *
 * Two pins: the source of ServerTableEngine (every seat literal the three
 * payload builders emit) and the client's declared snapshot shape, which is
 * what a reader of the bundle would use to know what to look for.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blankNonCode } from '../testHelpers/sourceWindow.js';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('LAW: the engine never says horse on the wire', () => {
  it('no seat literal in a client payload carries is_horse', () => {
    const src = blankNonCode(read('src/engine/ServerTableEngine.ts'));
    // The three payload builders are the only places `hub.publish` is fed
    // from; the resync path returns the same shape over HTTP.
    expect(src).toMatch(/hub\.publish\(this\.tableId, payload\)/);
    expect(src).not.toMatch(/\bis_horse\s*:/);
    expect(src).not.toMatch(/\bisHorse\s*:/);
  });

  it('the client snapshot shape does not declare it either', () => {
    // The client repo file, read relative to the server package.
    const client = blankNonCode(read('../src/utils/mapEngineSnapshot.ts'));
    expect(client).not.toMatch(/\bis_horse\b/);
    expect(client).not.toMatch(/\bisHorse\b/);
  });
});
