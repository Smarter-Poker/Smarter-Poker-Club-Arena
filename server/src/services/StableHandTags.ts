/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  OPERATION STABLE HAND - the tag book
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `horses:tag` wrote 1,580 membership tags and 1,000 horse-state rows on
 * 2026-09-04, and until this module existed the ONLY code that touched either
 * table was the tagger itself. Every horse's mode, persona, variants,
 * preferred stakes, table limit, rest day and daily cap sat inert while the
 * seeding loop went on deciding all of it from a hash of the horse's id.
 *
 * This is the read side. It is a cache, not a query helper: the seeding cycle
 * runs every 30 seconds and asks about a thousand horses each time, so the
 * tags (which change only when the tagger runs) are held for ten minutes and
 * the state (which carries live counters) for one cycle.
 *
 * ── FAILING OPEN IS THE WHOLE CONTRACT ─────────────────────────────────────
 *
 * `load()` returns null when it could not read a COMPLETE book, and every
 * caller is written so that null means "today's behaviour, unchanged". That is
 * not politeness, it is the estate's most expensive lesson repeated twice: the
 * bankroll gate that read an unknown roll as zero emptied the cash floor for
 * forty minutes on 2026-08-31, and the truncated table list starved 134 tables
 * on 2026-09-02. A tag we cannot read is not a horse with no tag.
 *
 * So: every read is keyset-paged, `complete` is checked, a partial book is
 * discarded rather than served, and the previous good book is kept until a
 * clean one replaces it.
 */

import { supabase } from './supabase.js';
import { fetchAllRows } from './supabase/pagination.js';
import { reportError } from './errorReporter.js';
import { WALLETS_FOR_HOST } from './StableHand.js';
/* The Chicago calendar helpers live in FreeBuy because that is where a
   Chicago clock was first needed (the 5-a-day board). They are pure and
   import nothing but StableHand, so there is no cycle here. */
import { chicagoDayKey } from './FreeBuy.js';
import type { CashPersona, HorseMode, MttPersona } from './StableHand.js';
import { MAX_TABLES_PER_HORSE, MIN_TABLES_PER_HORSE } from './StableHand.js';

/** Tags change only when the tagger runs. */
export const TAG_TTL_MS = 10 * 60_000;
/**
 * State carries live counters, so it is refreshed often - but not every cycle.
 *
 * It was 25 seconds, which is shorter than the 30-second seeding cycle and
 * therefore meant a full 1,000-row read on EVERY pass. Whatever the counters
 * gain from that they do not need: this cycle folds its own writes back into
 * the cached map before the next one reads it, so the only thing a shorter TTL
 * buys is another process's writes, and there is no other writer.
 */
export const STATE_TTL_MS = 60_000;

export interface HorseTag {
  horseId: string;
  clubId: string;
  mode: HorseMode;
  cashFreeroll: boolean;
  personaCash: CashPersona | null;
  personaMtt: MttPersona | null;
  /** Cash variants this horse plays. Empty for a tourney-only horse. */
  variants: string[];
  /** Big blinds this horse sits at. Empty for a tourney-only horse. */
  preferredStakes: number[];
  maxTables: number;
}

export interface HorseState {
  horseId: string;
  /** 0-6, Sunday-first, matching Date#getDay and chicagoNow().weekday. */
  restWeekday: number | null;
  dailyCapMinutes: number | null;
  minutesPlayedToday: number;
  sessionStartBalance: number | null;
  /** gameKey -> sits taken today. */
  cashSitsToday: Record<string, number>;
  /** gameKey -> ms of the cash-out that opened the window. */
  twoHourWindow: Record<string, number>;
  countersResetOn: string | null;
}

export interface TagBook {
  /** `${horseId}:${clubId}` -> tag */
  tags: Map<string, HorseTag>;
  /** horseId -> state */
  states: Map<string, HorseState>;
  tagsReadAt: number;
  statesReadAt: number;
}

function asRecordOfNumbers(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const n = typeof raw === 'string' ? Date.parse(raw) : Number(raw);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

export function tagKey(horseId: string, clubId: string): string {
  return `${horseId}:${clubId}`;
}

export class StableHandTagBook {
  private tags: Map<string, HorseTag> | null = null;
  private states: Map<string, HorseState> | null = null;
  private tagsReadAt = 0;
  private statesReadAt = 0;
  private inFlight: Promise<TagBook | null> | null = null;

  /** For tests: drop everything so the next load re-reads. */
  reset(): void {
    this.tags = null;
    this.states = null;
    this.tagsReadAt = 0;
    this.statesReadAt = 0;
  }

  private async readTags(): Promise<Map<string, HorseTag> | null> {
    /* ── PAGED PER CLUB, AND THAT IS NOT A STYLE CHOICE ──────────────────
       The table's key is (horse_id, club_id): a horse in both JAQK and Shark
       has TWO rows sharing one horse_id. Keyset paging on horse_id alone
       therefore drops a row every time a page boundary lands between the two
       halves of one horse - measured exactly that, 1,579 of 1,580 on the
       first live read, and it is the kind of miss that reads as "this horse
       has no Shark tag" rather than as an error.

       Fixing the cursor is fixing the club: horse_id IS unique inside one
       club, so each club is read on its own. Same shape as eligibleBodies,
       for the same reason. */
    const rows: any[] = [];
    for (const clubId of new Set(Object.values(WALLETS_FOR_HOST).flat())) {
      const page = await fetchAllRows<{ horse_id: string }>(
        (cursor, want) => {
          /* `as any`: these two tables postdate the generated Database types,
             so the typed client resolves their rows to GenericStringError.
             The shapes are asserted below where they are read, and by the
             schema manifest fragment in scripts/ci/schema-manifest.d/. */
          let q = (supabase as any)
            .from('stable_hand_membership_tags')
            .select(
              'horse_id, club_id, mode, cash_freeroll, persona_cash, persona_mtt, ' +
                'variants, preferred_stakes, max_tables'
            )
            .eq('club_id', clubId)
            .order('horse_id', { ascending: true })
            .limit(want);
          if (cursor) q = q.gt('horse_id', cursor);
          return q;
        },
        { label: 'StableHandTags.tags', idKey: 'horse_id', maxRows: 100_000 }
      );
      // A HALF-READ BOOK IS NOT A BOOK. See the header.
      if (!page.complete) return null;
      rows.push(...(page.rows as any[]));
    }

    const out = new Map<string, HorseTag>();
    for (const r of rows) {
      const horseId = String(r.horse_id);
      const clubId = String(r.club_id);
      out.set(tagKey(horseId, clubId), {
        horseId,
        clubId,
        mode: String(r.mode) as HorseMode,
        cashFreeroll: r.cash_freeroll === true,
        personaCash: (r.persona_cash ?? null) as CashPersona | null,
        personaMtt: (r.persona_mtt ?? null) as MttPersona | null,
        variants: Array.isArray(r.variants) ? r.variants.map((v: unknown) => String(v)) : [],
        preferredStakes: Array.isArray(r.preferred_stakes)
          ? r.preferred_stakes
              .map((v: unknown) => Number(v))
              .filter((n: number) => Number.isFinite(n))
          : [],
        /* THE LAW'S FLOOR SURVIVES A STALE ROW (Dan 2026-09-05). A tag
           written before the table-count law, or a null, must not put a horse
           back on one table - the retag fixes the rows, this makes the reader
           safe in the window before it runs and after any future writer. */
        maxTables: Math.min(
          MAX_TABLES_PER_HORSE,
          Math.max(MIN_TABLES_PER_HORSE, Number(r.max_tables) || 0)
        ),
      });
    }
    return out;
  }

  private async readStates(): Promise<Map<string, HorseState> | null> {
    const page = await fetchAllRows<{ horse_id: string }>(
      (cursor, want) => {
        let q = (supabase as any)
          .from('stable_hand_horse_state')
          .select(
            'horse_id, rest_weekday, daily_cap_minutes, minutes_played_today, ' +
              'session_start_balance, cash_sits_today, two_hour_window, counters_reset_on'
          )
          .order('horse_id', { ascending: true })
          .limit(want);
        if (cursor) q = q.gt('horse_id', cursor);
        return q;
      },
      { label: 'StableHandTags.states', idKey: 'horse_id', maxRows: 100_000 }
    );
    if (!page.complete) return null;

    const out = new Map<string, HorseState>();
    for (const r of page.rows as any[]) {
      const horseId = String(r.horse_id);
      out.set(horseId, {
        horseId,
        restWeekday:
          r.rest_weekday === null || r.rest_weekday === undefined ? null : Number(r.rest_weekday),
        dailyCapMinutes:
          r.daily_cap_minutes === null || r.daily_cap_minutes === undefined
            ? null
            : Number(r.daily_cap_minutes),
        minutesPlayedToday: Number(r.minutes_played_today) || 0,
        sessionStartBalance:
          r.session_start_balance === null || r.session_start_balance === undefined
            ? null
            : Number(r.session_start_balance),
        cashSitsToday: asRecordOfNumbers(r.cash_sits_today),
        twoHourWindow: asRecordOfNumbers(r.two_hour_window),
        countersResetOn: r.counters_reset_on ? String(r.counters_reset_on) : null,
      });
    }
    return out;
  }

  /**
   * The book, refreshed if stale. Null when there is no COMPLETE book to
   * serve - callers fall back to today's behaviour rather than to an empty
   * book, which would read as "every horse is untagged".
   *
   * One read at a time: the seeding cycle and the executor both ask, and two
   * concurrent full reads of the same two tables is waste, not safety.
   */
  async load(nowMs: number = Date.now()): Promise<TagBook | null> {
    if (this.inFlight) return this.inFlight;
    const tagsFresh = this.tags !== null && nowMs - this.tagsReadAt < TAG_TTL_MS;
    const statesFresh = this.states !== null && nowMs - this.statesReadAt < STATE_TTL_MS;
    if (tagsFresh && statesFresh) {
      return {
        tags: this.tags!,
        states: this.states!,
        tagsReadAt: this.tagsReadAt,
        statesReadAt: this.statesReadAt,
      };
    }

    this.inFlight = (async () => {
      try {
        if (!tagsFresh) {
          const tags = await this.readTags();
          // Keep the last good book rather than dropping to nothing.
          if (tags) {
            this.tags = tags;
            this.tagsReadAt = nowMs;
          }
        }
        if (!statesFresh) {
          const states = await this.readStates();
          if (states) {
            this.states = states;
            this.statesReadAt = nowMs;
          }
        }
        /* ── THE TAGS ARE THE BOOK; THE STATES ARE AN ANNEX ─────────────────
           This used to return null unless BOTH reads succeeded, and that cost
           four hours of live running on 2026-09-04: the same key read a
           complete book from a laptop and returned null on the engine, so the
           whole tag layer - variants, stakes, lanes, table ceilings - was
           switched off and no counter was written, silently.
           The two are not equally load-bearing. Tags decide who may sit where
           and are read once every ten minutes. States carry the day's counters,
           are re-read constantly, and EVERY reader of them already fails open
           on a missing row (`dailyCapReached(undefined)` is false, the mutex
           block skips a horse with no state). So a book with tags and no states
           is a smaller, honest degradation - the texture still applies, the
           day's limits abstain - where returning null threw all of it away. */
        if (!this.tags) return null;
        return {
          tags: this.tags,
          states: this.states ?? new Map(),
          tagsReadAt: this.tagsReadAt,
          statesReadAt: this.statesReadAt,
        };
      } catch (err) {
        reportError(err, 'StableHandTagBook.load');
        return null;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
}

/** One book for the process. */
export const tagBook = new StableHandTagBook();

/* ------------------------------------------------------------------ */
/* PURE readers - the decisions, without the cache                      */
/* ------------------------------------------------------------------ */

/**
 * Does this horse play cash at all?
 *
 * `undefined` when there is no tag: the caller keeps whatever it decided
 * before, which is `gameLaneFor(id) !== 'cash'` in the seeding loop.
 */
export function tagAllowsCash(tag: HorseTag | undefined): boolean | undefined {
  if (!tag) return undefined;
  return tag.mode !== 'tourney';
}

/** Does this horse play THIS variant? Undefined when untagged. */
export function tagAllowsVariant(tag: HorseTag | undefined, variant: string): boolean | undefined {
  if (!tag) return undefined;
  if (tag.variants.length === 0) return false; // a tourney-only horse plays none
  return tag.variants.includes(String(variant).toLowerCase());
}

/**
 * Does this horse sit at THIS big blind?
 *
 * An empty preferred_stakes list on a CASH horse is a tagging gap rather than
 * a refusal, so it reads as undefined and the old stake-band rule decides.
 */
export function tagAllowsStake(tag: HorseTag | undefined, bb: number): boolean | undefined {
  if (!tag) return undefined;
  if (tag.mode === 'tourney') return false;
  if (tag.preferredStakes.length === 0) return undefined;
  return tag.preferredStakes.some((s) => Math.abs(s - bb) < 1e-9);
}

/** The horse's own table ceiling, never above the platform's four. */
export function tagMaxTables(
  tag: HorseTag | undefined,
  hardCeiling = MAX_TABLES_PER_HORSE
): number {
  if (!tag) return hardCeiling;
  /* NEVER BELOW THE LAW'S FLOOR. The clamp used to be Math.max(1, ...), so a
     single bad row could hold a horse to one table for as long as it sat
     there. Two is Dan's minimum for every horse, so two is the floor here. */
  return Math.max(MIN_TABLES_PER_HORSE, Math.min(hardCeiling, tag.maxTables));
}

/** Is today this horse's rest day? Unknown state is NOT a rest day. */
export function isRestDayFor(state: HorseState | undefined, chicagoWeekday: number): boolean {
  if (!state || state.restWeekday === null) return false;
  return state.restWeekday === chicagoWeekday;
}

/**
 * ── THE COUNTERS RESET THEMSELVES ─────────────────────────────────────────
 *
 * `counters_reset_on` carries the Chicago date the stored counters belong to,
 * and every reader below returns ZERO when that date is not today. There is
 * deliberately no midnight sweep: a nightly job that has to run for a rule to
 * be correct is a rule that is wrong whenever the job does not run, and this
 * estate has already paid for that once - the Open Claw fleet returned 401 for
 * every job after a secret rotation and nothing noticed, because a job that
 * stops does not fill a log with errors, it stops filling it at all.
 *
 * Reading the date makes the reset structural. The writer still stamps the
 * date so the stored rows do not drift, but nothing depends on it having run.
 */
export function countersAreToday(state: HorseState | undefined, todayKey: string): boolean {
  return !!state && state.countersResetOn === todayKey;
}

/** Today's Chicago calendar date, the key every counter is stamped with. */
export function chicagoCounterDay(nowMs: number = Date.now()): string {
  return chicagoDayKey(nowMs);
}

/**
 * Has this horse played out its day?
 *
 * Unknown state or an unset cap is NOT "played out" - the same fail-open rule
 * as everything else here - and neither is a counter from yesterday.
 */
export function dailyCapReached(state: HorseState | undefined, todayKey?: string): boolean {
  if (!state || state.dailyCapMinutes === null) return false;
  if (todayKey !== undefined && !countersAreToday(state, todayKey)) return false;
  return state.minutesPlayedToday >= state.dailyCapMinutes;
}

/** Sits taken on this game key today. Yesterday's count is not today's. */
export function sitsOnKeyToday(
  state: HorseState | undefined,
  key: string,
  todayKey?: string
): number {
  if (todayKey !== undefined && !countersAreToday(state, todayKey)) return 0;
  return state?.cashSitsToday?.[key] ?? 0;
}

/**
 * Is this horse still inside the two-hour window on this key?
 *
 * The window opens when it cashes OUT of a key and stops it buying straight
 * back into the same game - which is what a reload looks like, and what a real
 * player does not do.
 */
export function inTwoHourWindow(
  state: HorseState | undefined,
  key: string,
  nowMs: number,
  windowMs: number
): boolean {
  const opened = state?.twoHourWindow?.[key];
  if (!opened) return false;
  return nowMs - opened < windowMs;
}
