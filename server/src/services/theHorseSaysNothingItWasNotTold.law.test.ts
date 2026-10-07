/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LAW: THE HORSE SAYS NOTHING IT WAS NOT TOLD (Phase 10, 2026-10-06)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A horse's chat line is an ordinary table_chat row that every client renders
 * as a player's line. That is only safe while four things stay true, and each
 * of them is a thing a future edit could quietly break:
 *
 *   1. The pool is owner-approved static text. Every line passes the same
 *      sanitizer production runs (no banned dash, no emoji, no at sign, at
 *      most 120 characters), carries no placeholder but the four the engine
 *      can fill, and reads the client's own profanity list clean.
 *   2. Nothing in the path rolls dice: Math.random is banned in the engine
 *      and a replayed hand must answer the same way twice.
 *   3. The gate is a 30 second cache that fails closed: the literal TTL is
 *      pinned, and no catch block ever answers `allowed: true`.
 *   4. The chat insert names exactly the browser's four columns, so the row
 *      can never carry a horse marker to a browser (tests/a-horse-is-never-
 *      named.law.test.ts is the client half of this).
 *
 * Source-reading style after ThePersonaSurvivesTheTuner.law.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LINES, TALK_EVENTS, TALK_PLACEHOLDERS, TALK_VOICES } from './horseTableTalkLines.js';
import { TALK_LINE_MAX_CHARS, fillLine, sanitizeLine } from './HorseTableTalk.js';
import { TABLE_TALK_GATE_TTL_MS } from './HorseTableTalkGate.js';

const SRC = join(process.cwd(), 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
/** The code without its comments, so a decision record cannot trip a rule about code. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const TALK = read('services/HorseTableTalk.ts');
const LINES_SRC = read('services/horseTableTalkLines.ts');
const GATE = read('services/HorseTableTalkGate.ts');
/** The client's own filter, read from the client's own file (server/ is the cwd). */
const CLIENT_CHAT = readFileSync(
  join(process.cwd(), '..', 'src', 'hooks', 'useTableChat.ts'),
  'utf8'
);

/** Every line in the pool, with where it lives. */
function everyLine(): Array<{ event: string; voice: string; line: string }> {
  const out: Array<{ event: string; voice: string; line: string }> = [];
  for (const event of TALK_EVENTS) {
    for (const voice of TALK_VOICES) {
      for (const line of LINES[event][voice].lines) out.push({ event, voice, line });
    }
  }
  return out;
}

/** A filled line, with every placeholder given a realistic fact. */
const FILL = { potBB: 52, street: 'river' as const, hand: 'full house', seat: 7 };

/** Usernames a line must not be able to carry even by accident. */
const SEATED = ['danny', 'Plate4', 'gg_master', 'seat7'];

describe('LAW: the horse says nothing it was not told', () => {
  it('the pool is four events by three voices, keyed lines, with at least one line per cell', () => {
    expect(TALK_EVENTS).toEqual(['big_pot_won', 'showdown_loss', 'big_hand_shown', 'arrival']);
    expect(TALK_VOICES).toEqual(['quiet', 'needler', 'friendly']);
    for (const event of TALK_EVENTS) {
      for (const voice of TALK_VOICES) {
        expect(LINES[event][voice].lines.length, `${event}/${voice} has no line`).toBeGreaterThan(
          0
        );
      }
    }
    expect(everyLine().length).toBeGreaterThanOrEqual(12);
    // the Title Case gate inspects these keys; the pool must never grow one
    expect(LINES_SRC).not.toMatch(
      /\b(label|title|description|caption|placeholder|hint|tooltip|subtitle)\s*:/
    );
  });

  it('every line, filled, passes the one door production runs', () => {
    for (const { event, voice, line } of everyLine()) {
      const filled = fillLine(line, FILL);
      expect(
        filled,
        `${event}/${voice}: "${line}" cannot be filled from engine facts`
      ).not.toBeNull();
      const verdict = sanitizeLine(filled!, SEATED);
      expect(verdict, `${event}/${voice}: "${line}" refused`).toEqual({ ok: true, line: filled });
      expect(filled!.length).toBeLessThanOrEqual(TALK_LINE_MAX_CHARS);
    }
  });

  it('no line carries a placeholder other than potBB, street, hand and seat', () => {
    expect(TALK_PLACEHOLDERS).toEqual(['potBB', 'street', 'hand', 'seat']);
    for (const { line } of everyLine()) {
      for (const m of line.matchAll(/\{([^}]*)\}/g)) {
        expect(TALK_PLACEHOLDERS, `"${line}" carries {${m[1]}}`).toContain(m[1]);
      }
      // nothing that could be a username, a handle or markup
      expect(line).not.toMatch(/[@<>#]/);
    }
  });

  it('no line in the pool holds a banned dash or an emoji, before any filling', () => {
    const dash = new RegExp(
      '[' + [0x2012, 0x2013, 0x2014, 0x2015].map((c) => String.fromCodePoint(c)).join('') + ']'
    );
    for (const { line } of everyLine()) {
      expect(dash.test(line), `"${line}" holds a banned dash`).toBe(false);
      expect(sanitizeLine(line.replace(/\{[^}]*\}/g, 'x'), []).ok, `"${line}" refused`).toBe(true);
    }
    expect(dash.test(LINES_SRC)).toBe(false);
  });

  it("every line reads the client's own profanity list clean", () => {
    const m = /const PROFANITY_LIST = \[([\s\S]*?)\];/.exec(CLIENT_CHAT);
    expect(m, 'useTableChat.ts still declares PROFANITY_LIST').not.toBeNull();
    const words = [...m![1].matchAll(/'([^']+)'/g)].map((w) => w[1]);
    expect(words.length).toBeGreaterThanOrEqual(10);
    const regex = new RegExp(`\\b(${words.join('|')})\\b`, 'i');
    for (const { line } of everyLine()) {
      expect(regex.test(fillLine(line, FILL)!), `"${line}" trips the client filter`).toBe(false);
    }
  });

  it('nothing in the path rolls dice', () => {
    for (const [name, src] of [
      ['HorseTableTalk.ts', TALK],
      ['horseTableTalkLines.ts', LINES_SRC],
      ['HorseTableTalkGate.ts', GATE],
    ]) {
      // code only: a comment may say the word while explaining the ban
      expect(code(src), `${name} uses Math.random`).not.toContain('Math.random');
      expect(code(src), `${name} uses crypto randomness`).not.toMatch(
        /randomInt|randomUUID|getRandomValues/
      );
    }
    expect(TALK).toContain(
      'personaHash(`${horseId}|${Math.max(0, Math.floor(handNumber))}|${event}`)'
    );
    expect(LINES_SRC).not.toMatch(/^\s*import\s/m);
  });

  it('the gate is a 30 second cache that fails closed', () => {
    expect(TABLE_TALK_GATE_TTL_MS).toBe(30_000);
    expect(GATE).toContain('export const TABLE_TALK_GATE_TTL_MS = 30_000;');
    // every catch block: find its braces and read what it returns
    const catches = [...GATE.matchAll(/catch\s*(?:\([^)]*\))?\s*\{/g)];
    expect(catches.length, 'the gate has a catch').toBeGreaterThan(0);
    for (const c of catches) {
      let depth = 1;
      let i = c.index! + c[0].length;
      while (i < GATE.length && depth > 0) {
        if (GATE[i] === '{') depth++;
        else if (GATE[i] === '}') depth--;
        i++;
      }
      const block = GATE.slice(c.index!, i);
      expect(block, 'a catch block answers yes').not.toContain('allowed: true');
      expect(block, 'a catch block answers yes through remember()').not.toContain('remember(');
      expect(block).toContain('unreadable(');
    }
    // a failed read is refused through a function that does not touch the cache
    const fn = GATE.slice(
      GATE.indexOf('function unreadable('),
      GATE.indexOf('\n}', GATE.indexOf('function unreadable('))
    );
    expect(fn).not.toContain('cached =');
    expect(fn).toContain("reason: 'unreadable'");
    // and the switches are read from the two switch tables, service client only
    expect(GATE).toContain("from('content_settings')");
    expect(GATE).toContain("from('horse_post_modes')");
    expect(GATE).toContain("import { supabase } from './supabase/client.js';");
  });

  it('the chat insert names exactly the four columns the browser writes, and no horse marker', () => {
    const at = TALK.indexOf(".from('table_chat')");
    expect(at).toBeGreaterThan(0);
    const insert = TALK.slice(TALK.indexOf('.insert({', at), TALK.indexOf('});', at));
    const keys = [...insert.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]).sort();
    expect(keys).toEqual(['message', 'message_type', 'table_id', 'user_id']);
    expect(insert).toContain("message_type: 'player'");
    // only one chat write door, and nothing a browser could read as a marker
    expect(code(TALK).match(/from\('table_chat'\)/g)).toHaveLength(1);
    const door = code(TALK).slice(
      code(TALK).indexOf('export async function writeChatRow('),
      code(TALK).indexOf('\n}', code(TALK).indexOf('export async function writeChatRow('))
    );
    for (const marker of ['display_name', 'avatar_url', 'is_horse', 'isHorse', 'horse_profile']) {
      expect(door, `the chat door mentions ${marker}`).not.toContain(marker);
    }
    // the browser's own insert, so the two never drift apart
    expect(CLIENT_CHAT).toMatch(/message_type:\s*'player'/);
  });

  it('the claim precedes the chat row, and is one insert with no retry', () => {
    const claim = TALK.indexOf("from('horse_table_talk_ledger').insert(");
    const chat = TALK.indexOf("from('table_chat').insert(");
    expect(claim).toBeGreaterThan(0);
    expect(chat).toBeGreaterThan(claim);
    expect(TALK).toContain(
      "if (error.code === '23505') return { ok: false, reason: 'hand_taken' };"
    );
    expect(code(TALK)).not.toMatch(/setInterval|setTimeout|retry|attempt/i);
    expect(code(GATE)).not.toMatch(/setInterval|setTimeout|retry|attempt/i);
  });

  it('the engine hands over the hand and never waits for the network', () => {
    const settlement = read('engine/ServerTableEngineSettlement.ts');
    const dealing = read('engine/ServerTableEngineDealing.ts');
    expect(settlement).toContain("await runStep('horse_table_talk', false, async () => {");
    expect(settlement).toContain(
      'void speakAtTheFelt(buildTableTalkInput(snap, players, this.tableInfo));'
    );
    expect(settlement).toMatch(/horse_table_talk: 'seats'/);
    expect(dealing).toContain('void greetArrival(');
    // no horse is ever excluded from anything on either path
    expect(TALK).not.toMatch(/!\s*[\w.?]*\bis_?[Hh]orse\b|is_?[Hh]orse\s*={2,3}\s*false/);
  });
});
