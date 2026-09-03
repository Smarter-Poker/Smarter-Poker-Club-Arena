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
 * THESE ARE SOURCE-TEXT GUARDS ONLY, AND THAT IS A KNOWN LIMITATION. Two of the
 * fixes above shipped GREEN through this file while being completely broken:
 * the sit-out restore was a no-op (sitOut() refuses an unregistered player), and
 * the time-bank restore's fallback branch was unreachable (the column defaults
 * to 30 and is coerced `|| 0`, so "is there a persisted value" was always true).
 * A regex can only see that certain words are present, and they were.
 *
 * The behaviour is driven for real in RestartFidelity.behaviour.test.ts. What
 * lives here is the WIRING — that the calls exist, in the right order, in the
 * right place — which is the half a behavioural test of an isolated method
 * cannot see.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  sliceEnclosingBlock,
  sliceBlockAfter,
  sliceMethod,
  sliceStatement,
} from '../testHelpers/sourceWindow.js';

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
    // 2026-08-31 (Phase 2.2): `players` joins it in the same read so the seat
    // that posted the BIG BLIND can be derived on restart too -- without it a
    // restart between two heads-up hands drops the dead-button rule for one
    // hand and somebody posts the big blind twice. Same row, same query, no
    // extra round trip; the pin stays exact so a silent widening is still a
    // visible change here.
    const at = BASE.indexOf('private async restoreButtonFromHistory');
    const body = sliceMethod(BASE, 'private async restoreButtonFromHistory');
    expect(body).toMatch(/from\('hand_history'\)/);
    expect(body).toMatch(/select\('button_seat, players'\)/);
    expect(body).toMatch(/order\('hand_number', \{ ascending: false \}\)/);
  });

  it('a table that cannot read its history still deals', () => {
    // Losing the button costs one orbit of position. Refusing to start costs
    // the whole table, which is strictly worse.
    const at = BASE.indexOf('private async restoreButtonFromHistory');
    const body = sliceMethod(BASE, 'private async restoreButtonFromHistory');
    expect(body).toMatch(/catch/);
    expect(body).not.toMatch(/throw/);
  });
});

describe('nobody is treated as a stranger at their own table', () => {
  it('everyone seated at boot is already a button-eligible veteran', () => {
    const at = DEALING.indexOf('if (this.dealingLoopFirstIteration)');
    expect(at).toBeGreaterThan(-1);
    const block = sliceBlockAfter(DEALING, 'if (this.dealingLoopFirstIteration)');
    expect(block).toMatch(/this\.dealtInUserIds\.add\(p\.user_id\)/);
  });
});

describe('the time bank restore stays REVERTED until the schema can support it', () => {
  it('does not read the persisted columns to seed the bank', () => {
    // This assertion used to be the inverse, and it CERTIFIED A REGRESSION.
    // `time_bank_remaining INTEGER DEFAULT 30` is never null and
    // loadSeatedPlayers coerces `|| 0`, so the "no persisted value" branch was
    // unreachable: every seat got 30s instead of the table base plus VIP and
    // purchased extras, fetchTimeBankExtras became dead code, and VIP quota was
    // pre-debited by the difference on sit-down.
    //
    // A correct restore needs a nullable marker that distinguishes "never
    // seeded" from "has 30 seconds left". Until that exists, seeding from the
    // full allowance is the safe behaviour — a free refill after a restart
    // costs seconds of clock; the broken version overcharged real VIP quota.
    const at = DEALING.indexOf('const tbTotal = this.timeBankBaseSeconds');
    expect(at, 'time bank initialisation not found').toBeGreaterThan(-1);
    const block = sliceEnclosingBlock(DEALING, 'const tbTotal = this.timeBankBaseSeconds');
    expect(block).not.toMatch(/hasPersisted/);
    expect(block).toMatch(/remainingSeconds: tbTotal/);
    expect(block).toMatch(/dbConsumedSeconds: 0/);
  });
});

describe('a restart does not deal cards to someone who sat out', () => {
  it('is_sitting_out is selected and carried onto the seat', () => {
    expect(TABLES).toMatch(/is_sitting_out/);
    expect(TABLES).toMatch(/is_sitting_out: seat\.is_sitting_out === true/);
  });

  it('the flag is applied to the engine at boot AND on every seat sweep', () => {
    expect(BASE).toMatch(/protected restoreSitOutsFromSeats\(\)/);
    expect(BASE).toMatch(/this\.restoreSitOutsFromSeats\(\)/);
    // The start-up loop breaks once enough players are seated and never runs
    // again, so a seat that appears later would be dealt in despite the row
    // saying otherwise. The dealing loop's own sweep covers that.
    expect(DEALING).toMatch(/this\.restoreSitOutsFromSeats\(\)/);
  });

  it('REGISTERS the player before sitting them out', () => {
    // The defect that made the whole method a no-op: DisconnectEngine.sitOut()
    // returns immediately when the player has no playerStates entry, and that
    // Map is only populated by registerPlayer inside dealHand. At boot it is
    // empty. See RestartFidelity.behaviour.test.ts, which drives this for real.
    const at = BASE.indexOf('protected restoreSitOutsFromSeats');
    const body = sliceMethod(BASE, 'protected restoreSitOutsFromSeats');
    const reg = body.indexOf('registerPlayer');
    const sit = body.indexOf('sitOut(');
    expect(reg, 'registerPlayer is not called before sitOut').toBeGreaterThan(-1);
    expect(sit).toBeGreaterThan(reg);
  });

  it('reports the OUTCOME, so a silent no-op cannot masquerade as a restore', () => {
    // The original logged "Restored sit-out for X" unconditionally — including
    // on every sweep where it had restored nothing at all.
    const at = BASE.indexOf('protected restoreSitOutsFromSeats');
    const body = sliceMethod(BASE, 'protected restoreSitOutsFromSeats');
    expect(body).toMatch(/sit_out_restore_no_effect/);
  });

  it('never un-sits anybody', () => {
    // Sitting back in is a player action. A stale `false` from a row read
    // moments before a live sit-out must not override it.
    const at = BASE.indexOf('protected restoreSitOutsFromSeats');
    const body = sliceMethod(BASE, 'protected restoreSitOutsFromSeats');
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
    const body = sliceMethod(TABLES, 'export async function syncStacks');
    expect(body).toMatch(/const \{ error \}\s*=\s*await supabase/);
    expect(body).toMatch(/if \(!error\) return null;/);
    expect(body).not.toMatch(/r\.status === 'rejected'/);
  });

  it('a failed seat is retried, and named if it still fails', () => {
    const at = TABLES.indexOf('export async function syncStacks');
    const body = sliceMethod(TABLES, 'export async function syncStacks');
    expect(body).toMatch(/attempt <= 3/);
    // Named, not counted: "2/6 failed" cannot be reconciled after the fact.
    expect(body).toMatch(/\$\{player\.user_id\}/);
    expect(body).toMatch(/failures\.join/);
  });

  it('the retry is bounded, because settlement cannot wait forever', () => {
    const at = TABLES.indexOf('export async function syncStacks');
    const body = sliceMethod(TABLES, 'export async function syncStacks');
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
