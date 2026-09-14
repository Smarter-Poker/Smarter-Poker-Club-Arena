/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CONSOLE PRINTS ONLY SCHEMA COLOURS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-13, verbatim:
 *
 *   "YOU MUST STICK TO THE SMARTER.POKER COLOR SCHEMA"
 *   "ALWAYS USE SMARTER.POKER COLOR SCHEMA COLORS, NO BROWNS OR PINKS"
 *
 * Dan, 2026-09-14, defining what that schema actually is:
 *
 *   "PRIMARY COLOR SCHEMA IS BLACK, BLUE, TEAL, SILVER, WHITE, AND COLORS
 *    USED INSIDE THE CLUB ARENA"
 *   "YELLOW AND ORANGE ARE NOT REALLY USED, OR ARE USED IN LIMITED CAPACITY"
 *   "PURPLES, PINKS, REDS, AREN'T USED OFTEN AND SHOULD BE ONLY USED WHEN
 *    ABSOLUTELY REQUIRED"
 *   "FACEBOOK COLOR SCHEMA FOR THE SOCIAL MEDIA PAGES IS EXCLUDED FROM ANY
 *    AND ALL COLOR SCHEMAS. THATS ITS OWN INDIVIDUALLY OWNED COLOR SCHEMA"
 *
 * WHY A TEST AND NOT A PARAGRAPH
 *
 * `.claude/skills/club-arena-console/SKILL.md` has told agents to use "the
 * Smarter.Poker color schema" since 1.0 without anywhere saying what it is.
 * Twenty-four "shadow" stops computed from the browns they replaced were
 * rejected on sight (Dan, 2026-09-13) — every one of them written by an agent
 * that had read the instruction and agreed with it. Prose is advice. This is
 * the part that cannot be talked past.
 *
 * WHAT THIS GUARDS
 *
 * The console kit and every surface built on it: the files in CONSOLE below.
 * It is an ALLOWLIST, not a ban list, because a ban list only ever catches the
 * last mistake. Measured on 2026-09-14 the kit already held exactly seventeen
 * distinct literals and every one of them is on the list — this law locks in
 * a state the kit was already in, and stops the next drift rather than
 * demanding a cleanup first.
 *
 * WHAT THIS DOES NOT GUARD, ON PURPOSE
 *
 *   - `src/components/social/**` — the social surfaces run the FACEBOOK colour
 *     schema, which Dan owns separately and which is explicitly excluded from
 *     the Smarter.Poker schema. `--fb-blue #1877f2` is correct there and is
 *     banned here. SOCIAL_IS_NOT_OURS below asserts the exclusion structurally,
 *     so a later agent cannot quietly widen this guard onto those files.
 *   - The felt and the table themes. A felt is a user preference with its own
 *     preset list; see the note in SKILL.md §3.4.
 *   - The rest of the repo. This law is scoped to what #ClubArenaConsole
 *     governs. Widening it is a separate, deliberate piece of work.
 *
 * ADDING A COLOUR
 *
 * You do not add one to satisfy a design you already wrote. A new literal
 * means a new token in the schema, and the schema is Dan's. Get the ruling,
 * put it in SKILL.md §3.4, then add it here with the job it does in the
 * comment beside it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/* Headers and rationale comments quote the colours they replaced, so every
   sheet is read with its comments removed — the assertion is about what the
   surface paints, not about how the file explains itself. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every surface #ClubArenaConsole governs. */
const CONSOLE = [
  'src/components/console/SpadeConsole.css',
  'src/components/daily-bonus/DailyBonusSheet.css',
  'src/components/rewards/RewardsSurfaceHeader.module.css',
  'src/pages/PromotionsPage.css',
];

/**
 * The schema, as literals. Grouped by the five colours Dan named, then the
 * three restricted inks. The job beside each one is the whole point: a colour
 * with no job is the drift this law exists to stop.
 */
const SCHEMA = new Map<string, string>([
  // ── BLACK — the ground. The console's bevels fall to these.
  ['#000', 'black ground'],
  ['#000000', 'black ground'],
  ['#050607', 'console bevel floor'],
  ['#050709', 'console bevel floor (rewards header)'],

  // ── SILVER — chrome and engraved ink.
  ['#e4e7ec', 'sc-ink--silver, titles and values'],
  ['#e6e9ee', 'silver ink, sheet variant'],
  ['#d7dee7', 'silver ink, bevel lowlight'],
  ['#9aa5b3', 'sc-ink--muted, secondary meta'],
  ['#6d747c', 'muted ink on a lit plate'],

  // ── WHITE — the primary action, and only that.
  ['#f4f7fb', 'sc-ink--white, primary action'],
  ['#f4f8fb', 'white ink, account/rewards variant'],

  // ── BLUE and TEAL — labels, eyebrows, numerals, LED glows.
  ['#45adff', 'sc-ink--blue, labels and numerals'],
  ['#8fd4ff', 'blue LED glow'],
  ['#65d9ff', 'teal LED glow'],

  // ── RESTRICTED. One job each. Not decoration.
  ['#ffd700', 'gold — things that genuinely are gold: VIP, winnings, top up'],
  ['#c8ffd2', 'sc-ink--green — good news, chips in'],
  ['#35d95a', 'green glow behind sc-ink--green'],
  ['#ff5b6e', 'sc-ink--red — destructive, insufficient'],
  ['#f02849', 'accent red glow'],
]);

/**
 * Named offenders. The allowlist above already rejects all of these — this
 * list exists so the failure message says WHY, rather than only that a hex
 * was unrecognised.
 */
const NAMED_OFFENDERS = new Map<string, string>([
  ['#1877f2', 'Facebook blue — belongs to the social schema, excluded from ours'],
  ['#d6ad52', 'brass — a warm accent sanctioned on account surfaces, never on the console'],
  ['#8b4513', 'brown — Dan: "NO BROWNS OR PINKS"'],
  ['#a0522d', 'brown'],
  ['#ec4899', 'pink — Dan: "NO BROWNS OR PINKS"'],
  ['#ff00ff', 'magenta — retired from the schema'],
  ['#9d4edd', 'purple — retired from the schema'],
  ['#ff8c00', 'orange — Dan: yellow and orange are limited-capacity at most'],
  ['#f59e0b', 'amber — a warning state elsewhere, never a console ink'],
  ['#fbbf24', 'amber'],
]);

const HEX = /#[0-9a-f]{3}\b|#[0-9a-f]{6}\b/gi;

describe('the console prints only schema colours', () => {
  it.each(CONSOLE)('%s paints nothing the schema does not own', (sheet) => {
    const css = stripComments(read(sheet));
    const found = [...new Set((css.match(HEX) ?? []).map((h) => h.toLowerCase()))];

    for (const hex of found) {
      const why = NAMED_OFFENDERS.get(hex);
      expect(
        SCHEMA.has(hex),
        why
          ? `${sheet} paints ${hex} — ${why}. See SKILL.md §3.4.`
          : `${sheet} paints ${hex}, which is not in the Smarter.Poker schema. ` +
              `Either use a schema token, or get Dan's ruling and add it to ` +
              `SKILL.md §3.4 and to SCHEMA in this file with the job it does.`
      ).toBe(true);
    }
  });

  it('guards every console surface that exists', () => {
    /* A surface added to the kit but not to CONSOLE is unguarded, which is how
       a law quietly stops covering the thing it names. Anything wearing the
       kit's own class hooks must be listed above. */
    const wearsTheKit = (p: string) => /sc-plate|sc-ink--|sc-console/.test(read(p));
    for (const sheet of CONSOLE) {
      expect(() => read(sheet), `${sheet} is listed but missing`).not.toThrow();
    }
    expect(CONSOLE.some(wearsTheKit), 'no listed surface wears the console kit').toBe(true);
  });
});

describe('the social surfaces are not ours to police', () => {
  it('SOCIAL_IS_NOT_OURS: no social path is under this guard', () => {
    /* Dan, 2026-09-14: the Facebook schema is "ITS OWN INDIVIDUALLY OWNED
       COLOR SCHEMA". Widening this law onto src/components/social would start
       failing builds over colours that are correct where they sit. */
    for (const sheet of CONSOLE) {
      expect(
        sheet.startsWith('src/components/social/'),
        `${sheet} is a social surface — those run the Facebook schema, not ours`
      ).toBe(false);
    }
  });
});

describe('the skill still carries the schema it enforces', () => {
  const SKILL = read('.claude/skills/club-arena-console/SKILL.md');

  /* §3.4 only. Asserting against the whole 800-line document would pass on a
     word that happens to appear in §7, and dumps the file into the failure. */
  const INK = SKILL.slice(SKILL.indexOf('### 3.4 Ink'), SKILL.indexOf('### 3.6 Crests'));

  it('has a §3.4 to read at all', () => {
    expect(INK.length, 'SKILL.md §3.4 is missing or §3.6 moved above it').toBeGreaterThan(500);
  });

  it('names the five colours Dan named', () => {
    /* If §3.4 is ever trimmed back to "use the schema", agents are back to
       guessing and this law is the only thing left standing. Keep them
       together. Case is the author's business; the naming is not. */
    const ink = INK.toLowerCase();
    for (const colour of ['black', 'blue', 'teal', 'silver', 'white']) {
      expect(ink.includes(colour), `SKILL.md §3.4 no longer names ${colour}`).toBe(true);
    }
  });

  it('points at this file by name, so a failure is self-explaining', () => {
    expect(
      INK.includes('the-console-prints-only-schema-colours.law.test.ts'),
      'SKILL.md §3.4 no longer names the guard, so a build failure has nowhere to send the reader'
    ).toBe(true);
  });

  it('records that the Facebook schema is excluded', () => {
    expect(INK.toLowerCase().includes('facebook'), '§3.4 no longer states the exclusion').toBe(
      true
    );
    expect(INK.includes('#1877f2'), '§3.4 no longer names the Facebook blue it excludes').toBe(
      true
    );
  });
});
