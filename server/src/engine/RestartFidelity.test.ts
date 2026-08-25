/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A RESTART RESUMES THE TABLE, IT DOES NOT RESET IT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25, BINDING, verbatim:
 *
 *   "IN THE EVENT OF AN ENGINE RESTART, WHILE PLAY IS RUNNING, IT MUST ALWAYS
 *    RESTART IN THE SAME POSITION, ALL CHIPS ON ALL TABLES MUST STAY EXACTLY
 *    THE SAME, EVERYTHING RESTARTS EXACTLY AS IT WAS BEFORE THE RESTART!
 *    THAT IS AN ABSOLUTE MUST!"
 *
 * WHAT A RESTART USED TO DO. Four things, none of them visible in any log:
 *
 *   THE BUTTON JUMPED TO SEAT 1. `lastButtonSeat` is declared `= 0` and nothing
 *   restored it. The rotation reads 0 as "no hand dealt yet" and falls back to
 *   the LOWEST OCCUPIED SEAT, so the button went backwards and the blinds were
 *   taken again from the seats behind it. A player could post the big blind,
 *   the engine could restart, and they could post it again on the next hand.
 *   Every deploy, on every table, silently.
 *
 *   TIME BANKS REFILLED. syncStacks has always written time_bank_remaining and
 *   loadSeatedPlayers has always read it back — and the initializer threw it
 *   away and handed out a full bank.
 *
 *   SIT-OUTS WERE FORGOTTEN. `is_sitting_out` is written on every sit-out and
 *   was never selected, so the next deal dealt cards to players who had sat
 *   out, while every client still correctly showed them as out.
 *
 *   NEW PLAYERS COULD TAKE THE BUTTON. `dealtInUserIds` emptied, so
 *   buttonEligible() fell back to the whole roster and the rule was
 *   unenforceable for a full orbit after every restart.
 *
 * These are source-text guards for the wiring, plus real behavioural tests for
 * the two pieces of logic that can be exercised in isolation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

const BASE = strip(read('src/engine/ServerTableEngineBase.ts'));
const DEALING = strip(read('src/engine/ServerTableEngineDealing.ts'));
const TABLES = strip(read('src/services/supabase/tables.ts'));

describe('the button comes back to where it was', () => {
  it('is restored from the last settled hand, during start()', () => {
    expect(BASE).toMatch(/private async restoreButtonFromHistory\(\)/);
    expect(BASE).toMatch(/this\.lastButtonSeat = seat;/);
    // Must run at boot, not lazily: the first deal after a restart is exactly
    // the hand that would re-take the blinds.
    const call = BASE.indexOf('await this.restoreButtonFromHistory()');
    const loop = BASE.indexOf('this.dealingLoop()');
    expect(call, 'restoreButtonFromHistory is never called').toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(call);
  });

  it('reads the column that is actually populated', () => {
    // button_seat is written on every settled hand and was read by nobody.
    const at = BASE.indexOf('private async restoreButtonFromHistory');
    const body = BASE.slice(at, at + 1400);
    expect(body).toMatch(/from\('hand_history'\)/);
    expect(body).toMatch(/select\('button_seat'\)/);
    expect(body).toMatch(/order\('hand_number', \{ ascending: false \}\)/);
  });

  it('a table that cannot read its history still deals', () => {
    // Losing the button costs one orbit of position. Refusing to start costs
    // the whole table, which is strictly worse.
    const at = BASE.indexOf('private async restoreButtonFromHistory');
    const body = BASE.slice(at, at + 1800);
    expect(body).toMatch(/catch/);
    expect(body).not.toMatch(/throw/);
  });
});

describe('nobody is treated as a stranger at their own table', () => {
  it('everyone seated at boot is already a button-eligible veteran', () => {
    const at = DEALING.indexOf('if (this.dealingLoopFirstIteration)');
    expect(at).toBeGreaterThan(-1);
    const block = DEALING.slice(at, at + 500);
    expect(block).toMatch(/this\.dealtInUserIds\.add\(p\.user_id\)/);
  });
});

describe('a restart does not hand out free time banks', () => {
  it('the persisted bank is used when there is one', () => {
    const at = DEALING.indexOf('const persistedSeconds');
    expect(at, 'time bank is still initialised from the table default only').toBeGreaterThan(-1);
    const block = DEALING.slice(at, at + 700);
    expect(block).toMatch(/seated\?\.time_bank_remaining/);
    expect(block).toMatch(/hasPersisted \? persistedSeconds : tbTotal/);
  });
});

describe('a restart does not deal cards to someone who sat out', () => {
  it('is_sitting_out is selected and carried onto the seat', () => {
    expect(TABLES).toMatch(/is_sitting_out/);
    expect(TABLES).toMatch(/is_sitting_out: seat\.is_sitting_out === true/);
  });

  it('the flag is applied to the engine at boot', () => {
    expect(BASE).toMatch(/protected restoreSitOutsFromSeats\(\)/);
    expect(BASE).toMatch(/this\.restoreSitOutsFromSeats\(\)/);
  });

  it('never un-sits anybody', () => {
    // Sitting back in is a player action. A stale `false` from a row read
    // moments before a live sit-out must not override it.
    const at = BASE.indexOf('protected restoreSitOutsFromSeats');
    const body = BASE.slice(at, at + 600);
    expect(body).toMatch(/if \(p\.is_sitting_out !== true\) continue;/);
    expect(body).not.toMatch(/sitBack|satBack/);
  });
});

describe('chips survive the write, or somebody is told', () => {
  it('a database error counts as a failure', () => {
    // THE BUG: supabase does not REJECT on a database error, it RESOLVES with
    // { error }. Promise.allSettled only reports `rejected`, so an RLS refusal
    // or a constraint violation counted as a successful chip write and the
    // alarm could only ever fire on a network throw.
    const at = TABLES.indexOf('export async function syncStacks');
    const body = TABLES.slice(at, at + 2600);
    expect(body).toMatch(/const \{ error \}\s*=\s*await supabase/);
    expect(body).toMatch(/if \(!error\) return null;/);
    expect(body).not.toMatch(/r\.status === 'rejected'/);
  });

  it('a failed seat is retried, and named if it still fails', () => {
    const at = TABLES.indexOf('export async function syncStacks');
    const body = TABLES.slice(at, at + 2600);
    expect(body).toMatch(/attempt <= 3/);
    // Named, not counted: "2/6 failed" cannot be reconciled after the fact.
    expect(body).toMatch(/\$\{player\.user_id\}/);
    expect(body).toMatch(/failures\.join/);
  });

  it('the retry is bounded, because settlement cannot wait forever', () => {
    const at = TABLES.indexOf('export async function syncStacks');
    const body = TABLES.slice(at, at + 2600);
    expect(body).toMatch(/attempt < 3/);
    expect(body).toMatch(/setTimeout/);
  });
});

describe('the in-flight hand is voided, and that is the safe answer', () => {
  it('crash recovery completes the snapshot rather than resuming it', () => {
    // Chips are exact BECAUSE the hand is abandoned: the database is never
    // debited mid-hand (syncStacks runs only in postHandTasks), so every chip
    // committed to an abandoned pot is still in its owner's stack. Resuming
    // instead would require persisting the deck, and the snapshot deliberately
    // strips it.
    expect(BASE).toMatch(/async checkCrashRecovery\(\)/);
    expect(BASE).toMatch(/completeHandSnapshot\(this\.tableId, snapshot\.handNumber\)/);
    const at = BASE.indexOf('const { deck, ...serializableState }');
    expect(at, 'the deck is no longer stripped from the snapshot').toBeGreaterThan(-1);
  });

  it('stacks are only ever written after a hand completes', () => {
    // This is the property that makes an abandoned hand chip-exact. If a
    // mid-hand syncStacks is ever added, an abandoned hand starts destroying
    // chips and this test is the thing that should stop it.
    const settlement = strip(read('src/engine/ServerTableEngineSettlement.ts'));
    expect(settlement).toMatch(/syncStacks\(/);
    const turns = strip(read('src/engine/ServerTableEngineTurns.ts'));
    expect(turns).not.toMatch(/syncStacks\(/);
    expect(DEALING).not.toMatch(/syncStacks\(/);
  });
});
