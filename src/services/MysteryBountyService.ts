/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MYSTERY BOUNTY — the client's ONLY read path
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Sections 66 and 69: the client is never authoritative. Every number the lobby,
 * the results table and the result card show about a mystery bounty comes from
 * one of three SECURITY DEFINER functions, and nothing here derives a total from
 * a broadcast.
 *
 *   fn_mystery_bounty_inventory(uuid)              the tier ladder
 *   fn_mystery_bounty_awards(uuid, int, int)       what has been won, newest first
 *   fn_mystery_bounty_leaderboard(uuid)            who has won it
 *
 * THIS IS NOT A STYLE PREFERENCE. `tournament_bounty_chests`,
 * `tournament_bounty_awards` and `tournament_bounty_award_recipients` all have
 * RLS ON WITH NO SELECT POLICY, so a direct `.from('tournament_bounty_chests')`
 * returns an empty array and no error. Code written that way looks like a
 * tournament with no chests in it. Go through the RPCs.
 *
 * MONEY IS INTEGER CENTS EVERYWHERE the engine touches it (`*_cents`). It stays
 * in cents through this module and is divided by 100 exactly once, at the
 * formatting boundary. No float arithmetic on a cent value, ever.
 */

import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import { tierRank } from '../config/mysteryBountyTiers';
import { formatPrizeCentsAtUnit } from '../utils/format';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES — the exact shapes the three functions return
// ═══════════════════════════════════════════════════════════════════════════════

export type MysteryBountyStage = 'pending' | 'active' | 'complete';

export interface MysteryBountyTierRow {
  tier: string;
  amountCents: number;
  /** How many chests of this tier the draw created. */
  original: number;
  /** Reserved, revealed or paid. Section 33: still shown when remaining is 0. */
  awarded: number;
  remaining: number;
}

export interface MysteryBountyInventory {
  poolCents: number;
  stage: MysteryBountyStage;
  profile: string | null;
  activation: string | null;
  activationValue: number | null;
  activatedPlayers: number | null;
  activatedAt: string | null;
  tiers: MysteryBountyTierRow[];
}

export interface MysteryBountyRecipient {
  userId: string;
  username: string;
  amountCents: number;
}

export interface MysteryBountyAward {
  awardId: string;
  amountCents: number;
  tier: string;
  isJackpot: boolean;
  revealedAt: string | null;
  handId: string | null;
  tableId: string | null;
  eliminated: { userId: string; username: string };
  recipients: MysteryBountyRecipient[];
}

export interface MysteryBountyAwards {
  total: number;
  rows: MysteryBountyAward[];
}

export interface MysteryBountyLeaderboardRow {
  userId: string;
  username: string;
  bountiesWon: number;
  earningsCents: number;
}

/** What one player has won, assembled from the award rows. */
export interface MysteryBountyPlayerTotals {
  userId: string;
  username: string;
  bountiesWon: number;
  earningsCents: number;
  /** Section 43: the single biggest chest this player opened. */
  largestCents: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARSERS — a missing field is a zero, never a crash
// ═══════════════════════════════════════════════════════════════════════════════

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

function isStage(v: unknown): v is MysteryBountyStage {
  return v === 'pending' || v === 'active' || v === 'complete';
}

export function parseInventory(raw: unknown): MysteryBountyInventory {
  const o = (raw ?? {}) as Record<string, unknown>;
  const tiers = Array.isArray(o.tiers) ? o.tiers : [];
  return {
    poolCents: Math.round(num(o.pool_cents)),
    stage: isStage(o.stage) ? o.stage : 'pending',
    profile: typeof o.profile === 'string' ? o.profile : null,
    activation: typeof o.activation === 'string' ? o.activation : null,
    activationValue: o.activation_value == null ? null : num(o.activation_value),
    activatedPlayers: o.activated_players == null ? null : Math.round(num(o.activated_players)),
    activatedAt: typeof o.activated_at === 'string' ? o.activated_at : null,
    tiers: tiers
      .map((t) => {
        const r = (t ?? {}) as Record<string, unknown>;
        return {
          tier: str(r.tier, 'base'),
          amountCents: Math.round(num(r.amount_cents)),
          original: Math.round(num(r.original)),
          awarded: Math.round(num(r.awarded)),
          remaining: Math.round(num(r.remaining)),
        };
      })
      /* The function already orders by amount; re-sorting here means a client
         that received them in any order still renders the ladder top down, and
         two tiers priced identically break to the tier ORDER rather than to
         whatever the aggregate happened to emit. */
      .sort((a, b) => b.amountCents - a.amountCents || tierRank(a.tier) - tierRank(b.tier)),
  };
}

export function parseAwards(raw: unknown): MysteryBountyAwards {
  const o = (raw ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(o.rows) ? o.rows : [];
  return {
    total: Math.round(num(o.total)),
    rows: rows.map((x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      const elim = (r.eliminated ?? {}) as Record<string, unknown>;
      const recips = Array.isArray(r.recipients) ? r.recipients : [];
      return {
        awardId: str(r.award_id),
        amountCents: Math.round(num(r.amount_cents)),
        tier: str(r.tier, 'base'),
        isJackpot: r.is_jackpot === true,
        revealedAt: typeof r.revealed_at === 'string' ? r.revealed_at : null,
        handId: typeof r.hand_id === 'string' ? r.hand_id : null,
        tableId: typeof r.table_id === 'string' ? r.table_id : null,
        eliminated: {
          userId: str(elim.user_id),
          username: str(elim.username, 'Player'),
        },
        recipients: recips.map((y) => {
          const rc = (y ?? {}) as Record<string, unknown>;
          return {
            userId: str(rc.user_id),
            username: str(rc.username, 'Player'),
            amountCents: Math.round(num(rc.amount_cents)),
          };
        }),
      };
    }),
  };
}

export function parseLeaderboard(raw: unknown): MysteryBountyLeaderboardRow[] {
  const o = (raw ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(o.rows) ? o.rows : [];
  return (
    rows
      .map((x) => {
        const r = (x ?? {}) as Record<string, unknown>;
        return {
          userId: str(r.user_id),
          username: str(r.username, 'Player'),
          bountiesWon: Math.round(num(r.bounties_won)),
          earningsCents: Math.round(num(r.earnings_cents)),
        };
      })
      /* Section 36: sorted by EARNINGS, not by count. The function orders it that
       way already; this makes the rule true of the array regardless of how it
       arrived, which is what the test pins. */
      .sort((a, b) => b.earningsCents - a.earningsCents || a.username.localeCompare(b.username))
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PURE HELPERS — used by the lobby, the results table and the result card
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Cents to a figure a player can read, ON THE GRID THE EVENT PAYS ON.
 *
 * `.toLocaleString()`, never `.padStart()` (CLAUDE.md 5.5, and the Bad Beat
 * Jackpot bug that rule came from). At a chip event, whole amounts print whole
 * and a chest that genuinely carries cents keeps them rather than being
 * rounded into a lie. At a Diamond event there are no cents to keep: a chest
 * holds whole Diamonds, `a_diamond_mystery_chest_holds_whole_diamonds` is the
 * migration that makes that true in the database, and a decimal point here
 * would advertise a chest that cannot be paid.
 *
 * THE UNIT IS REQUIRED AND HAS NO DEFAULT, which is the whole design.
 * `a-tournament-prize-knows-its-unit.law.test.ts` was written because four
 * money rules defaulted theirs to a cent and every caller omitted it, so the
 * unit work looked finished from every call site and was wired to nothing. A
 * caller here passes `tournamentRowUnitCents(tournament)` when it holds the
 * arena embed, or `UNIT_CENTS_ASSET_NOT_READ` where it genuinely has not read
 * a club - and the second one is greppable, which an omitted argument is not.
 *
 * One rule, in one place: the body is `formatPrizeCentsAtUnit`, which is
 * `formatPrizeAtUnit` over cents.
 */
export function formatCents(cents: number | null | undefined, unitCents: number): string {
  return formatPrizeCentsAtUnit(cents, unitCents);
}

/**
 * Section 10: the advertised TOP bounty. Derived from the inventory, so the
 * number on the card is a chest that actually exists.
 *
 * Deliberately the largest tier that was ever DRAWN, not the largest still
 * available: an event whose jackpot has been won still ran as a "Top Mystery
 * Bounty 5,000" event, and quietly dropping the headline the moment it is
 * claimed would rewrite the advertisement after the fact.
 */
export function topBountyCents(inv: MysteryBountyInventory | null): number {
  if (!inv || inv.tiers.length === 0) return 0;
  return inv.tiers.reduce(
    (max, t) => (t.original > 0 && t.amountCents > max ? t.amountCents : max),
    0
  );
}

/** Total still sitting in unopened chests. */
export function remainingCents(inv: MysteryBountyInventory | null): number {
  if (!inv) return 0;
  return inv.tiers.reduce((sum, t) => sum + t.remaining * t.amountCents, 0);
}

/** Total already handed out, straight off the ladder. */
export function awardedCents(inv: MysteryBountyInventory | null): number {
  if (!inv) return 0;
  return inv.tiers.reduce((sum, t) => sum + t.awarded * t.amountCents, 0);
}

/** Chests drawn, and chests left. */
export function chestCounts(inv: MysteryBountyInventory | null): {
  original: number;
  remaining: number;
  awarded: number;
} {
  if (!inv) return { original: 0, remaining: 0, awarded: 0 };
  return inv.tiers.reduce(
    (acc, t) => ({
      original: acc.original + t.original,
      remaining: acc.remaining + t.remaining,
      awarded: acc.awarded + t.awarded,
    }),
    { original: 0, remaining: 0, awarded: 0 }
  );
}

/**
 * Per-player totals from the AWARD rows.
 *
 * The leaderboard function already gives count and earnings; this gives the
 * third thing a result card needs and the leaderboard cannot know, the LARGEST
 * single bounty (section 43). Built from award rows rather than from a running
 * client tally, so a reload reconstructs it exactly (section 69).
 */
export function playerTotalsFromAwards(
  awards: readonly MysteryBountyAward[]
): Map<string, MysteryBountyPlayerTotals> {
  const out = new Map<string, MysteryBountyPlayerTotals>();
  for (const a of awards) {
    for (const r of a.recipients) {
      if (!r.userId) continue;
      const prev = out.get(r.userId);
      if (prev) {
        prev.bountiesWon += 1;
        prev.earningsCents += r.amountCents;
        if (r.amountCents > prev.largestCents) prev.largestCents = r.amountCents;
        if (prev.username === 'Player' && r.username !== 'Player') prev.username = r.username;
      } else {
        out.set(r.userId, {
          userId: r.userId,
          username: r.username,
          bountiesWon: 1,
          earningsCents: r.amountCents,
          largestCents: r.amountCents,
        });
      }
    }
  }
  return out;
}

/** The single biggest bounty won in the whole event, and who took it. */
export function largestAward(
  awards: readonly MysteryBountyAward[]
): { amountCents: number; award: MysteryBountyAward } | null {
  let best: MysteryBountyAward | null = null;
  for (const a of awards) {
    if (!best || a.amountCents > best.amountCents) best = a;
  }
  return best ? { amountCents: best.amountCents, award: best } : null;
}

/**
 * Section 73: before the mystery phase opens, say WHY.
 *
 * The three activation modes are the server's (mysteryBountyActivation.ts):
 * 'at_the_money', 'percent_field', 'player_count'. Whichever is configured, the
 * rebuy/add-on close is a precondition of all three, so it is named first and
 * the threshold is added when there is one to name.
 *
 * Title Case, no em dashes (CLAUDE.md 5.7, enforced by scripts/ci/check-ui-text).
 */
export function activationStatusLine(inv: MysteryBountyInventory | null): string {
  if (!inv) return 'Mystery Bounty Details Are Loading';
  if (inv.stage === 'active') return 'Mystery Bounties Are Live';
  if (inv.stage === 'complete') return 'Every Mystery Bounty Has Been Awarded';

  const base = 'Mystery Bounties Begin After The Rebuy And Add-On Period Ends';
  const value = inv.activationValue;
  switch (inv.activation) {
    case 'at_the_money':
      return `${base} And The Tournament Reaches The Money`;
    case 'percent_field':
      return value && value > 0
        ? `${base} And The Field Is Down To The Top ${num(value).toLocaleString('en-US')} Percent`
        : base;
    case 'player_count':
      return value && value > 0
        ? `${base} And ${Math.round(num(value)).toLocaleString('en-US')} Players Remain`
        : base;
    default:
      return base;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE CALLS
// ═══════════════════════════════════════════════════════════════════════════════

/** Largest page fn_mystery_bounty_awards will serve. It clamps to this itself. */
export const AWARDS_PAGE_SIZE = 200;

/** A hard ceiling on how many award rows the client will ever hold in memory. */
export const AWARDS_MAX_ROWS = 1000;

export const MysteryBountyService = {
  async getInventory(tournamentId: string): Promise<MysteryBountyInventory | null> {
    if (!tournamentId) return null;
    try {
      const { data, error } = await supabase.rpc('fn_mystery_bounty_inventory', {
        p_tournament_id: tournamentId,
      });
      if (error) throw error;
      if (!data) return null;
      return parseInventory(data);
    } catch (err) {
      reportError(err, 'MysteryBountyService.getInventory');
      return null;
    }
  },

  async getAwards(tournamentId: string, limit = 50, offset = 0): Promise<MysteryBountyAwards> {
    if (!tournamentId) return { total: 0, rows: [] };
    try {
      const { data, error } = await supabase.rpc('fn_mystery_bounty_awards', {
        p_tournament_id: tournamentId,
        p_limit: limit,
        p_offset: offset,
      });
      if (error) throw error;
      return parseAwards(data);
    } catch (err) {
      reportError(err, 'MysteryBountyService.getAwards');
      return { total: 0, rows: [] };
    }
  },

  /**
   * Every award, paged.
   *
   * A result card's "largest mystery bounty" and a results table's per-player
   * split both need the whole set, and one call cannot serve more than 200 rows.
   * Bounded by AWARDS_MAX_ROWS so a pathological event cannot make a lobby page
   * loop forever.
   */
  async getAllAwards(tournamentId: string): Promise<MysteryBountyAwards> {
    if (!tournamentId) return { total: 0, rows: [] };
    const first = await MysteryBountyService.getAwards(tournamentId, AWARDS_PAGE_SIZE, 0);
    const rows = [...first.rows];
    const wanted = Math.min(first.total, AWARDS_MAX_ROWS);
    while (rows.length < wanted && rows.length > 0) {
      const page = await MysteryBountyService.getAwards(
        tournamentId,
        AWARDS_PAGE_SIZE,
        rows.length
      );
      if (page.rows.length === 0) break;
      rows.push(...page.rows);
    }
    return { total: first.total, rows };
  },

  async getLeaderboard(tournamentId: string): Promise<MysteryBountyLeaderboardRow[]> {
    if (!tournamentId) return [];
    try {
      const { data, error } = await supabase.rpc('fn_mystery_bounty_leaderboard', {
        p_tournament_id: tournamentId,
      });
      if (error) throw error;
      return parseLeaderboard(data);
    } catch (err) {
      reportError(err, 'MysteryBountyService.getLeaderboard');
      return [];
    }
  },
};

export default MysteryBountyService;
