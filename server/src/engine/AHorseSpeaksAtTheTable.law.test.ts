/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW - A HORSE SPEAKS AT THE TABLE, THE SAME WAY A PLAYER DOES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Measured 2026-09-08: `table_chat` held 6 messages in its whole history, all
 * from one human. Across 1,000 horses and 1,271 occupied seats, a horse had
 * NEVER sent one - not rarely, never. Chat is a feature every human seat has
 * and no horse seat had, which is the exclusion Dan ruled on for the rebuy
 * pause: "IF YOU DIDN'T GIVE THEM THE SAME EXACT FEATURES AND FUNCTIONALITY,
 * PEOPLE WOULD NOTICE!"
 *
 * The pins below are the properties that make a horse's message
 * indistinguishable from a person's, and each is a way this could go wrong:
 *
 *   - it writes the SAME ROW a human writes (`message_type: 'player'`, no flag)
 *   - it is refused by the SAME rule (`fn_table_chat_is_silenced`) - the engine
 *     holds the service role, so RLS does not stop it and a silenced horse that
 *     kept talking would itself be the tell
 *   - an unreadable silence check is NOT permission (10.86)
 *   - it never lands on the same tick as the pot, and never at a fixed delay
 *   - the fleet is not uniform: chattiness comes from the horse's own id
 *   - it never repeats itself, or anyone else
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* A real-shaped profile id. The first draft used 'chatty-horse' and the
   "nothing in this row says horse" pin failed on the FIXTURE's own name - which
   is the pin working, but on the wrong string. */
const SPEAKER = '3ec4fbbc-2e0d-4004-8b34-245e8984e8a3';

const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
let silenced: { data: unknown; error: unknown } = { data: false, error: null };
let ledgerRows: Array<{ phrase_norm: string }> = [];
let ledgerFails = false;

vi.mock('../services/supabase.js', () => {
  const select = () => {
    const chain: Record<string, unknown> = {};
    const result = ledgerFails
      ? { data: null, error: { message: 'boom' } }
      : { data: ledgerRows, error: null };
    for (const k of ['gte', 'eq', 'limit']) {
      chain[k] = () => chain;
    }
    // Awaiting the builder resolves it, exactly as postgrest-js does.
    (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve(result);
    return chain;
  };
  return {
    supabase: {
      rpc: async () => silenced,
      from: (table: string) => ({
        insert: async (row: Record<string, unknown>) => {
          inserted.push({ table, row });
          return { error: null };
        },
        select,
      }),
    },
  };
});

const talk = await import('./HorseTableTalk.js');

/** Runs every scheduled message immediately, so the test sees the insert. */
const immediate = (fn: () => void) => fn();

beforeEach(() => {
  inserted.length = 0;
  ledgerRows = [];
  ledgerFails = false;
  silenced = { data: false, error: null };
  talk.__resetTableTalk();
});

describe('LAW: a horse speaks at the table, the same way a player does', () => {
  it('writes the same row a human writes, through the same table', async () => {
    const spoke = await talk.maybeSpeak({
      tableId: 't1',
      userId: SPEAKER,
      moment: 'lost_big',
      rand: () => 0, // certain: past every probabilistic gate
      schedule: immediate,
    });
    expect(spoke).toBe(true);
    const chat = inserted.find((i) => i.table === 'table_chat');
    expect(chat).toBeTruthy();
    expect(chat!.row.message_type).toBe('player');
    expect(chat!.row.table_id).toBe('t1');
    expect(chat!.row.user_id).toBe(SPEAKER);
    expect(String(chat!.row.message).length).toBeGreaterThan(0);
    // Nothing in the row says what kind of player wrote it.
    expect(JSON.stringify(chat!.row)).not.toMatch(/horse|is_bot|\bai\b/i);
  });

  it('is silenced by exactly what silences a human', async () => {
    silenced = { data: true, error: null }; // ban_chat, or a table_chat_mutes row
    const spoke = await talk.maybeSpeak({
      tableId: 't1',
      userId: SPEAKER,
      moment: 'lost_big',
      rand: () => 0,
      schedule: immediate,
    });
    expect(spoke).toBe(false);
    expect(inserted.filter((i) => i.table === 'table_chat')).toHaveLength(0);
    expect(talk.talkStats.silenced).toBe(1);
  });

  it('treats an unreadable silence check as silence, not as permission', async () => {
    silenced = { data: null, error: { message: 'PGRST002' } };
    const spoke = await talk.maybeSpeak({
      tableId: 't1',
      userId: SPEAKER,
      moment: 'lost_big',
      rand: () => 0,
      schedule: immediate,
    });
    expect(spoke).toBe(false);
    expect(inserted.filter((i) => i.table === 'table_chat')).toHaveLength(0);
    // Counted, not swallowed: a leak that is only ever silent is invisible.
    expect(talk.talkStats.unknown).toBe(1);
  });

  it('never lands on the same tick as the pot, and never at a fixed delay', () => {
    const delays = new Set<number>();
    let min = Infinity;
    for (let i = 0; i < 500; i++) {
      const ms = talk.typingDelayMs(() => (i + 0.5) / 500);
      delays.add(ms);
      min = Math.min(min, ms);
    }
    // A message that appears the instant the pot is pushed is a tell.
    expect(min).toBeGreaterThan(1000);
    // A constant delay is measurable, and measurable is a tell (V35's lesson).
    expect(delays.size).toBeGreaterThan(100);
  });

  it('does not repeat itself, or anyone else', async () => {
    const pool = talk.TALK_PHRASES.joined;
    ledgerRows = pool.map((p) => ({ phrase_norm: p })); // everything taken
    expect(await talk.pickPhrase('h', 'joined')).toBeNull();

    ledgerRows = pool.slice(1).map((p) => ({ phrase_norm: p })); // one left
    expect(await talk.pickPhrase('h', 'joined')).toBe(pool[0]);
  });

  it('stays quiet rather than repeating when the ledger cannot be read', async () => {
    ledgerFails = true;
    expect(await talk.pickPhrase('h', 'joined')).toBeNull();
  });

  it('gives the fleet a spread of chattiness, so the rate is not a signature', () => {
    const values = Array.from({ length: 400 }, (_, i) => talk.chattiness(`horse-${i}`));
    const silent = values.filter((v) => v === 0).length;
    // Some people never talk; a fleet where everyone talks at one rate is a
    // signature in itself.
    expect(silent).toBeGreaterThan(80);
    expect(silent).toBeLessThan(220);
    expect(Math.max(...values)).toBeLessThan(0.35);
    // Stable for the life of the horse - not a property of the hand.
    expect(talk.chattiness('horse-7')).toBe(talk.chattiness('horse-7'));
  });

  it('one horse does not answer its own pot twice, and a table does not chorus', async () => {
    const args = { rand: () => 0, schedule: immediate } as const;
    await talk.maybeSpeak({ tableId: 't1', userId: 'a', moment: 'lost_big', ...args });
    const first = inserted.filter((i) => i.table === 'table_chat').length;
    await talk.maybeSpeak({ tableId: 't1', userId: 'a', moment: 'won_big', ...args });
    await talk.maybeSpeak({ tableId: 't1', userId: 'b', moment: 'lost_big', ...args });
    expect(inserted.filter((i) => i.table === 'table_chat')).toHaveLength(first);
  });

  it('the phrases read like a person, not like a generator', () => {
    for (const [moment, pool] of Object.entries(talk.TALK_PHRASES)) {
      expect(pool.length, `${moment} has no phrases`).toBeGreaterThan(3);
      for (const phrase of pool) {
        expect(phrase, `${phrase} is not lower case`).toBe(phrase.toLowerCase());
        expect(phrase.split(/\s+/).length, `${phrase} is a sentence`).toBeLessThanOrEqual(5);
        // Repo rules: no emoji in source, no em dashes in player-facing copy.
        expect(phrase).not.toMatch(/[—\u{1F300}-\u{1FAFF}☀-➿]/u);
      }
    }
  });

  it('settlement asks it after a hand, and never waits on it', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/engine/ServerTableEngineSettlement.ts'),
      'utf8'
    );
    expect(src).toContain("import { maybeSpeak } from './HorseTableTalk.js'");
    // `void`, not `await`: chat must never hold up a pot.
    expect(src).toMatch(
      /void maybeSpeak\(\{ tableId: this\.tableId, userId: p\.user_id, moment \}\)/
    );
    expect(src).toMatch(
      /catch \(err\) \{\s*reportError\(err, 'ServerTableEngine\.horse_table_talk'\)/
    );
  });
});
