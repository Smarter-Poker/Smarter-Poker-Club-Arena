/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DETAIL / OVERVIEW TAB — everything about the event, on one screen
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25, verbatim: "THE DETAILS PAGE NEEDS TO SHOW EVERYTHING ON ONE
 * 'OVERVIEW' WITHOUT SCROLLING DOWN. THIS PAGE NEEDS TO BE VISUALLY OPTIMIZED
 * AND BALANCED BETTER."
 *
 * WHAT WAS WRONG
 * --------------
 * The old Detail block was a column of four full-width sections stacked in
 * arrival order, not importance order: a 200px countdown numeral, the
 * projector-sized TournamentClock under it, a seven-tile stat grid, then
 * fourteen full-width label/value rows. On a 375px phone that is roughly three
 * screens of scrolling to answer "what is this event and where is it up to" —
 * and the two most valuable facts (the level clock and the current blinds) were
 * the ones separated by the most vertical distance.
 *
 * THE SHAPE NOW — four bands, in the order a player asks the questions:
 *
 *   1. HERO BAND    where the event is RIGHT NOW: level clock beside the live
 *                   blinds and the next level, with a progress meter under it.
 *                   One line-group, ~90px, not a 200px numeral. For a COMPLETED
 *                   event the podium takes this slot instead, because "who won"
 *                   is the only live question left.
 *   2. STAT GRID    the nine figures that change: remaining, avg stack, total
 *                   chips, tables, level, blinds up, late reg, prize pool,
 *                   eliminated. Compact numerals (12.5K) so a tile never wraps.
 *   3. RULE TAGS    every rule variant as one wrapping row of chips. These used
 *                   to be six separate coloured paragraphs.
 *   4. INFO GRID    the former label/value list as a two-column definition grid
 *                   with small labels. Figures already shown as a stat tile
 *                   (prize pool, entries, late reg) are NOT repeated here.
 *
 * THE CLOCK TICKS FROM HERE. A 1s interval in this component reads
 * `tournamentService.getCurrentLevelState(tournament)`, which resolves against
 * the server-persisted `current_level` / `level_started_at` — so the countdown
 * matches the engine rather than a wall-clock guess, and the tab does not
 * depend on the page re-rendering it. The interval is cleared on unmount and
 * never starts at all for an event that is neither running nor upcoming.
 *
 * ACCESSIBILITY: the hero band is `aria-live="off"` on purpose. A region that
 * announces itself once a second is a screen-reader denial-of-service.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TournamentTabProps, NormalisedBlindLevel } from './types';
import {
  chips,
  chipsCompact,
  clockText,
  effectivePrizePool,
  isPlayerLive,
  lastPaidPlace,
  ordinal,
  parsePayoutStructure,
  placePrize,
} from './types';
import { tournamentService } from '../../../services/TournamentService';
import { supabase } from '../../../lib/supabase';
import { reportError } from '../../../utils/errorReporter';
import { formatBuyIn, money } from '../../../utils/buyIn';
import { spinMultiplierLabel } from '../../../utils/spinReveal';
import { useToast } from '../../common/Toast';
import RegistrationApprovalsPanel from '../RegistrationApprovalsPanel';
import TournamentLobbyCard from '../TournamentLobbyCard';
import { HandForHandBanner } from '../HandForHandBanner';
import {
  activationStatusLine,
  formatCents,
  topBountyCents,
} from '../../../services/MysteryBountyService';
import { useSatellites } from './useSatellites';
import '../../../styles/tournament-lobby-3d.css';
import './DetailOverviewTab.css';

/* ─────────────────────────────────────────────────────────────────────────
   Small readers. Every one of these tolerates a missing field, because the
   tournaments table has three generations of column spellings in it and a
   details page that throws on an old row is worse than one showing a dash.
   ───────────────────────────────────────────────────────────────────────── */

interface LooseLevel {
  level?: number;
  small_blind?: number;
  smallBlind?: number;
  big_blind?: number;
  bigBlind?: number;
  ante?: number;
  isBreak?: boolean;
}

function sbOf(level: LooseLevel | null | undefined): number {
  return Number(level?.small_blind ?? level?.smallBlind ?? 0) || 0;
}
function bbOf(level: LooseLevel | null | undefined): number {
  return Number(level?.big_blind ?? level?.bigBlind ?? 0) || 0;
}
function anteOf(level: LooseLevel | null | undefined): number {
  return Number(level?.ante ?? 0) || 0;
}

/** A wait longer than a day reads as "2d 4h"; anything shorter is a clock. */
function untilText(seconds: number): string {
  if (seconds <= 0) return '0:00';
  if (seconds >= 86_400) {
    const d = Math.floor(seconds / 86_400);
    const h = Math.floor((seconds % 86_400) / 3600);
    return `${d}d ${h}h`;
  }
  return clockText(seconds);
}

/** "Aug 25, 19:30" — short enough to sit on one line beside the clock. */
function shortDate(value: string | null | undefined): string {
  if (!value) return 'TBD';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'TBD';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* The local `payoutRows()` that used to sit here is gone (2026-08-26 audit). It
   returned the stored rows verbatim, so a structure written as one RANGE row -
   `{from: 2, to: 9, percentage: 6.25}` - counted as ONE paid place. That number
   was handed to HandForHandBanner as `paidPositions`, which put the money bubble
   nine places too early, and the podium's `p.place === position` lookup found
   nothing for 2nd or 3rd and printed a dash over a real prize. `types.ts` now
   owns the one parser, and Rewards reads the same one. */

interface StatTile {
  key: string;
  label: string;
  value: string;
  sub?: string;
  tone?: 'accent' | 'good' | 'warn';
}

interface InfoItem {
  key: string;
  label: string;
  value: string;
  wide?: boolean;
  tone?: 'accent' | 'danger';
}

export default function DetailOverviewTab({
  tournament,
  entries,
  tables,
  blindLevels,
  currentUserId,
  isRegistered,
  mysteryBounty,
  onOpenTab,
}: TournamentTabProps) {
  /* Shared with SatellitesTab. This used to be a private copy of the fetch and
     a byte-identical copy of the mapper, so both surfaces carried the same
     three dead column reads, the same permanent-spinner guard and the same
     one-query-per-card cost. See useSatellites for the full account. */
  const {
    cards: satellites,
    registration: satRegistration,
    loading: satLoading,
    error: satError,
    retry: satRetry,
  } = useSatellites(tournament?.id, currentUserId);

  const toast = useToast();

  /* ── The one-second heartbeat. Only runs when something on screen actually
        moves: a running level clock, or a countdown to a start time. ── */
  const [tick, setTick] = useState(0);
  const status = String(tournament?.status || '').toUpperCase();
  const isRunning = status === 'RUNNING';
  const isCompleted = status === 'COMPLETED';

  /**
   * A finished event has nothing left that moves, and an event three days out
   * does not need a per-second re-render to say "3d 4h" — the heartbeat only
   * starts once the wait is inside a day, at which point the seconds digit is
   * genuinely changing on screen. A day's tolerance also means a start time
   * that drifts (an owner rescheduling) still picks the clock up on the next
   * render rather than needing its own watcher.
   */
  const startAtMs = useMemo(() => {
    const raw = tournament?.start_time;
    if (!raw) return null;
    const t = new Date(raw).getTime();
    return Number.isNaN(t) ? null : t;
  }, [tournament?.start_time]);

  const startsWithinADay =
    startAtMs !== null &&
    startAtMs - Date.now() < 86_400_000 &&
    startAtMs - Date.now() > -86_400_000;

  useEffect(() => {
    if (isCompleted) return;
    if (!isRunning && !startsWithinADay) return;
    const id = setInterval(() => setTick((n) => (n + 1) % 86_400), 1000);
    return () => clearInterval(id);
  }, [isCompleted, isRunning, startsWithinADay]);

  /* Who is still in, counted ONCE. `field` below builds its figures from this
     same list, so the deal gate and the displayed count cannot disagree -- and
     the gate is needed up here, before the poll. */
  const aliveList = useMemo(
    () => (Array.isArray(entries) ? entries : []).filter(isPlayerLive),
    [entries]
  );
  const aliveCount = aliveList.length;

  /* ── Final-table deal votes. Own state, own poll: the tab contract does not
        carry them and no other tab needs them. ── */
  const dealEnabled = Boolean(tournament?.final_table_deal_enabled) && isRunning;
  const [dealVoteCount, setDealVoteCount] = useState(0);
  const [hasVotedDeal, setHasVotedDeal] = useState(false);
  const [votingDeal, setVotingDeal] = useState(false);

  /**
   * The poll only runs once the panel it feeds can actually appear.
   *
   * It used to be gated on `dealEnabled` alone -- `final_table_deal_enabled &&
   * isRunning` -- while the PANEL additionally requires the field to be down to
   * one table. So a 500-runner event with final-table deals turned on polled
   * `tournament_deal_votes` every fifteen seconds from level one, for hours,
   * for a number nothing on screen was reading. `dealPanel` is declared below
   * this effect, so the gate is recomputed here rather than referenced.
   */
  const ftSize = Number(tournament?.table_size) || 9;
  const dealPanelPossible = dealEnabled && aliveCount >= 2 && aliveCount <= ftSize;

  useEffect(() => {
    if (!dealPanelPossible || !tournament?.id) return;
    let alive = true;
    /* Request ordering. Two loads can be in flight across a vote -- the
       optimistic +1 in handleVoteForDeal and a poll issued just before the
       insert landed -- and whichever RESOLVES last used to win. A sequence
       number means a stale response is dropped instead of overwriting a fresher
       count with an older one. */
    let seq = 0;
    const load = async () => {
      const mine = ++seq;
      const { data, error } = await supabase
        .from('tournament_deal_votes')
        .select('user_id')
        .eq('tournament_id', tournament.id);
      if (!alive || mine !== seq) return;
      if (error) {
        /* Was `if (!alive || error || !data) return;` -- a permission failure
           left the panel showing "0/6 Votes", which is a factual claim about a
           real vote count, with nothing reported anywhere. */
        reportError(error, 'DetailOverviewTab.dealVotes');
        return;
      }
      if (!data) return;
      setDealVoteCount(data.length);
      setHasVotedDeal(Boolean(currentUserId && data.some((v) => v.user_id === currentUserId)));
    };
    void load();
    const iv = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [dealPanelPossible, tournament?.id, currentUserId]);

  const handleVoteForDeal = useCallback(async () => {
    if (!currentUserId || !tournament?.id || votingDeal) return;
    setVotingDeal(true);
    try {
      const { data, error } = await supabase.rpc('fn_cast_tournament_deal_vote', {
        p_tournament_id: tournament.id,
      });
      if (error) {
        throw error;
      }
      const result = (data ?? {}) as { ok?: boolean; voted?: boolean; reason?: string };
      if (result.ok !== true || result.voted !== true) {
        throw new Error(result.reason || 'The deal vote was refused');
      }
      setHasVotedDeal(true);
      if ((result as { already?: boolean }).already !== true) {
        setDealVoteCount((n) => n + 1);
        toast.success('Your deal vote is in.');
      } else {
        toast.success('Your deal vote is already in.');
      }
    } catch (e) {
      reportError(e, 'DetailOverviewTab.voteForDeal');
      toast.error('Could not record your vote.');
    } finally {
      setVotingDeal(false);
    }
  }, [currentUserId, tournament?.id, votingDeal, toast]);

  /* ── Field figures. ──
        Counted with the SHARED predicate. This block used to define "still in"
        as `playing | registered` while Ranking used `not out`, so a completed
        event's winner was counted by one tab and not the other, and Total Chips
        summed only the `playing` rows while Ranking summed everyone still in.
        Two tabs of one screen quoting two figures for one number
        (2026-08-26 audit). */
  const field = useMemo(() => {
    const list = Array.isArray(entries) ? entries : [];
    const alive = aliveList;
    const eliminated = list.length - alive.length;
    const totalChips = alive.reduce((sum, e) => sum + (Number(e.chips) || 0), 0);
    const avgStack =
      alive.length > 0 && totalChips > 0
        ? Math.trunc(totalChips / alive.length)
        : Number(tournament?.starting_chips) || 0;
    return {
      entries: list.length,
      alive: alive.length,
      eliminated,
      totalChips,
      avgStack,
    };
  }, [entries, aliveList, tournament?.starting_chips]);

  /* ── Live level state. Recomputed every tick so the clock actually counts. ── */
  const level = useMemo(() => {
    void tick; // the heartbeat: this memo is the clock
    const opening = (blindLevels?.[0] || null) as NormalisedBlindLevel | null;
    const fallback = {
      index: Math.max(0, Number(tournament?.current_level) || 0),
      isBreak: false,
      sb: opening?.smallBlind ?? 0,
      bb: opening?.bigBlind ?? 0,
      ante: opening?.ante ?? 0,
      nextSb: blindLevels?.[1]?.smallBlind ?? 0,
      nextBb: blindLevels?.[1]?.bigBlind ?? 0,
      remaining: 0,
      duration: (opening?.duration ?? 0) * 60,
    };
    if (!tournament) return fallback;
    try {
      const ls = tournamentService.getCurrentLevelState(tournament);
      const cur = ls.currentLevel as LooseLevel | null;
      const next = ls.nextLevel as LooseLevel | null;
      const durMin = Number(blindLevels?.[ls.levelIndex]?.duration) || 0;
      return {
        index: ls.levelIndex,
        isBreak: Boolean(cur?.isBreak),
        sb: sbOf(cur),
        bb: bbOf(cur),
        ante: anteOf(cur),
        nextSb: sbOf(next),
        nextBb: bbOf(next),
        remaining: Math.max(0, Math.floor(Number(ls.timeRemainingSeconds) || 0)),
        duration: durMin * 60,
      };
    } catch (e) {
      reportError(e, 'DetailOverviewTab.getCurrentLevelState');
      return fallback;
    }
  }, [tournament, blindLevels, tick]);

  /** Seconds until the scheduled start, for an event that has not begun. */
  const secondsToStart = useMemo(() => {
    void tick;
    if (startAtMs === null) return 0;
    return Math.max(0, Math.floor((startAtMs - Date.now()) / 1000));
  }, [startAtMs, tick]);

  /* ── Prize pool: the stored pool is authoritative, the guarantee is a floor. ── */
  const prize = useMemo(
    () => ({
      effective: effectivePrizePool(tournament?.prize_pool, tournament?.guaranteed_prize),
      guarantee: Number(tournament?.guaranteed_prize) || 0,
    }),
    [tournament?.guaranteed_prize, tournament?.prize_pool]
  );

  const lateRegText = useMemo(() => {
    const levels = Number(tournament?.late_reg_levels) || 0;
    const mins = Number(tournament?.late_reg_mins) || 0;
    if (levels > 0) return `Lv ${levels}`;
    if (mins > 0) return `${mins}m`;
    return 'Closed';
  }, [tournament?.late_reg_levels, tournament?.late_reg_mins]);

  /* ── The nine stat tiles. ── */
  const stats = useMemo<StatTile[]>(() => {
    const maxPlayers = Number(tournament?.max_players) || 0;
    return [
      {
        key: 'remaining',
        label: 'Remaining',
        value: chips(field.alive),
        sub: maxPlayers > 0 ? `of ${chips(maxPlayers)} max` : `of ${chips(field.entries)} entries`,
        tone: 'accent',
      },
      {
        key: 'avg',
        label: 'Avg Stack',
        value: chipsCompact(field.avgStack),
      },
      {
        key: 'total',
        label: 'Total Chips',
        value: chipsCompact(
          field.totalChips || field.entries * (Number(tournament?.starting_chips) || 0)
        ),
      },
      { key: 'tables', label: 'Tables', value: chips(tables?.length || 0) },
      {
        key: 'level',
        label: 'Level',
        value: isCompleted ? 'Done' : level.isBreak ? 'Break' : chips(level.index + 1),
      },
      {
        key: 'blindsup',
        label: 'Blinds Up',
        value: isRunning ? clockText(level.remaining) : '-',
        tone: isRunning && level.remaining <= 60 ? 'warn' : undefined,
      },
      { key: 'latereg', label: 'Late Reg', value: lateRegText },
      {
        key: 'prize',
        label: 'Prize Pool',
        value: prize.effective > 0 ? chipsCompact(prize.effective) : 'TBD',
        sub: prize.guarantee > 0 ? `${chipsCompact(prize.guarantee)} GTD` : undefined,
        tone: 'accent',
      },
      { key: 'out', label: 'Eliminated', value: chips(field.eliminated) },
    ];
  }, [
    field,
    tables,
    level,
    isRunning,
    isCompleted,
    lateRegText,
    prize,
    tournament?.max_players,
    tournament?.starting_chips,
  ]);

  /* ── Rule tags. One wrapping row; these were six separate paragraphs. ── */
  const tags = useMemo(() => {
    const t = tournament || ({} as Record<string, unknown>);
    const out: Array<{ label: string; kind: 'default' | 'action' | 'good' | 'danger' | 'mute' }> =
      [];
    if (t.is_rebuy) out.push({ label: 'Rebuy', kind: 'action' });
    else if (t.is_reentry) out.push({ label: 'Re-Entry', kind: 'action' });
    else out.push({ label: 'Freezeout', kind: 'mute' });
    if (t.add_on_available) out.push({ label: 'Add-On', kind: 'action' });
    if (t.is_mystery_bounty) out.push({ label: 'Mystery Bounty', kind: 'danger' });
    else if (t.is_pko) out.push({ label: 'PKO', kind: 'danger' });
    else if (t.is_bounty) out.push({ label: 'Bounty', kind: 'danger' });
    if (t.is_multi_day) out.push({ label: 'Multi-Day', kind: 'default' });
    if (t.is_xmtt) out.push({ label: 'XMTT', kind: 'default' });
    if (t.is_vip_only) out.push({ label: 'VIP Only', kind: 'default' });
    if (t.all_in_or_fold) out.push({ label: 'All-In Or Fold', kind: 'danger' });
    if (t.big_blind_ante || (blindLevels || []).some((b) => (b?.ante || 0) > 0))
      out.push({ label: 'BB Ante', kind: 'default' });
    if (t.accelerated_mtt) out.push({ label: 'Accelerated', kind: 'action' });
    if (t.bubble_protection) out.push({ label: 'Bubble Protection', kind: 'good' });
    if (t.final_table_deal_enabled) out.push({ label: 'Final Table Deal', kind: 'default' });
    if (t.ban_chat) out.push({ label: 'No Chat', kind: 'mute' });
    if (t.early_bird_enabled && Number(t.early_bird_chips) > 0)
      out.push({ label: `Early Bird +${chipsCompact(Number(t.early_bird_chips))}`, kind: 'good' });
    if (isRegistered) out.push({ label: 'You Are In', kind: 'good' });
    return out;
  }, [tournament, blindLevels, isRegistered]);

  /* ── The former label/value list, minus everything the stat grid already
        answers (prize pool, entries, late reg). ── */
  const info = useMemo<InfoItem[]>(() => {
    const t = tournament || ({} as Record<string, unknown>);
    const rebuyThrough = Number(t.late_reg_levels ?? t.rebuy_levels ?? 8) || 8;
    const addonFrom = rebuyThrough;
    const addonTo = rebuyThrough + (Number(t.addon_levels ?? 1) || 1);
    const firstDuration = Number(blindLevels?.[0]?.duration) || 0;
    const speed =
      firstDuration === 0
        ? 'Standard'
        : firstDuration <= 5
          ? 'Turbo'
          : firstDuration <= 10
            ? 'Regular'
            : 'Deep Stack';

    const rows: InfoItem[] = [
      {
        key: 'game',
        label: 'Game',
        value: `${String(t.game_type || 'nlh').toUpperCase()}${
          Number(t.table_size) > 0 ? ` ${Number(t.table_size)}-Max` : ''
        }`,
        tone: 'accent',
      },
      {
        key: 'buyin',
        label: 'Buy-In',
        value: formatBuyIn(Number(t.buy_in_amount) || 0, Number(t.buy_in_fee) || 0),
      },
      { key: 'stack', label: 'Starting Stack', value: chips(t.starting_chips) },
      { key: 'speed', label: 'Structure', value: speed },
      {
        key: 'levels',
        label: 'Levels',
        value: firstDuration ? `${firstDuration} Min` : 'Standard',
      },
      {
        key: 'rebuy',
        label: 'Rebuy',
        value: t.is_rebuy
          ? `${chipsCompact(Number(t.rebuy_chips) || Number(t.starting_chips) || 0)} thru Lv ${rebuyThrough}`
          : t.is_reentry
            ? `Re-Entry thru Lv ${rebuyThrough}`
            : 'None',
      },
      {
        key: 'addon',
        label: 'Add-On',
        value: t.add_on_available
          ? `${chipsCompact(Number(t.addon_chips) || Number(t.starting_chips) || 0)} Lv ${addonFrom}-${addonTo}`
          : 'None',
      },
      {
        key: 'when',
        label: isRunning ? 'Started' : isCompleted ? 'Ended' : 'Starts',
        value: shortDate(
          isRunning ? t.started_at : isCompleted ? t.ended_at || t.started_at : t.start_time
        ),
      },
      { key: 'entries', label: 'Entries', value: chips(field.entries) },
    ];

    if (t.is_bounty) {
      const parts = [`${money(Number(t.bounty_amount) || 0)} per KO`];
      if (t.is_pko) parts.push('50% to knocker, 50% to bounty');
      /* `mystery_bounty_min` / `mystery_bounty_max` used to be appended here.
         They were a per-head advertised RANGE drawn at registration time, and
         since the chest inventory shipped (2026-08-25) the engine does not read
         them at all: the draw now happens once, when the mystery phase opens,
         and produces a real ladder. Printing the dead columns told a player a
         number nothing would ever pay. The advertisement is the TOP CHEST THAT
         EXISTS, two rows below, off the same fetch that feeds the Rewards
         ladder. */
      rows.push({
        key: 'bounty',
        label: 'Bounty',
        value: parts.join(' - '),
        wide: true,
        tone: 'danger',
      });
    }
    if (t.is_mystery_bounty) {
      const top = topBountyCents(mysteryBounty?.inventory ?? null);
      rows.push({
        key: 'mysterytop',
        label: 'Top Mystery Bounty',
        value: top > 0 ? `${formatCents(top)} Chips` : 'Drawn When The Mystery Phase Opens',
        tone: 'accent',
      });
      rows.push({
        key: 'mysterystatus',
        label: 'Mystery Status',
        value: activationStatusLine(mysteryBounty?.inventory ?? null),
      });
    }
    if (t.variant === 'spin' || t.tournament_type === 'SPIN') {
      rows.push({
        key: 'spin',
        label: 'Spin Multiplier',
        value: spinMultiplierLabel(tournament) ?? 'Revealed at start',
        tone: 'accent',
      });
    }
    if (t.is_multi_day) {
      rows.push({
        key: 'days',
        label: 'Multi-Day',
        value: `Day ${Number(t.day_number) || 1} of ${Number(t.total_days) || 2}`,
      });
    }
    return rows;
  }, [tournament, blindLevels, isRunning, isCompleted, field.entries, mysteryBounty?.inventory]);

  /* ── Podium, for a finished event. ── */
  const podium = useMemo(() => {
    if (!isCompleted) return [];
    const structure = parsePayoutStructure(tournament?.payout_structure) ?? [];
    /* The EFFECTIVE pool, not the raw one. Rewards prints first place off the
       guarantee-floored figure; printing the raw `prize_pool` here made the two
       tabs quote different money for the same finish on any overlay event. */
    const pool = prize.effective;
    return (Array.isArray(entries) ? entries : [])
      .filter((e) => typeof e.position === 'number' && (e.position as number) <= 3)
      .sort((a, b) => (a.position || 99) - (b.position || 99))
      .map((player) => {
        const row = structure.find((p) => p.place === player.position);
        // The whole structure, not one percentage: the last paid place absorbs
        // the residual, so a place cannot be priced without the others.
        return { player, prizeValue: row ? placePrize(pool, structure, row.place) : 0 };
      });
  }, [isCompleted, entries, tournament?.payout_structure, prize.effective]);

  /**
   * The runners-up list under the podium.
   *
   * It used to start at 1st, so the top three appeared twice on the same panel
   * - once as a podium card and again as the first three list rows. It starts
   * below the podium now, and it is only rendered when there is somebody there.
   */
  const finishers = useMemo(() => {
    if (!isCompleted) return [];
    return (Array.isArray(entries) ? entries : [])
      .filter((e) => typeof e.position === 'number' && (e.position as number) > 3)
      .sort((a, b) => (a.position || 999) - (b.position || 999))
      .slice(0, 10);
  }, [isCompleted, entries]);

  /* ── Final-table deal gate: one table left, on an FT-deal event. ── */
  const dealPanel = useMemo(() => {
    if (!dealEnabled) return null;
    const ftSize = Number(tournament?.table_size) || 9;
    if (field.alive < 2 || field.alive > ftSize) return null;
    const mySeat = currentUserId
      ? (entries || []).find((e) => e.user_id === currentUserId)
      : undefined;
    /* TWO DEFINITIONS OF "STILL IN" ON ONE SCREEN (2026-08-29). `field.alive`
       above counts with the shared `isPlayerLive`, this line used to test
       `status === 'playing'`. A player sitting at a final table with status
       `registered` was inside the denominator -- the panel rendered, and their
       vote was one of the votes being counted towards unanimity -- but got no
       vote button, so they could not cast it and the deal could never pass.
       This is the exact divergence the comment above `field` says was fixed for
       the Ranking tab; it was still live here. */
    return { amSeated: mySeat ? isPlayerLive(mySeat) : false, remaining: field.alive };
  }, [dealEnabled, tournament?.table_size, field.alive, entries, currentUserId]);

  /* The LAST PAID PLACE, not how many places are paid. See lastPaidPlace in
     types.ts: on a structure whose places do not run contiguously from 1, the
     count is a place that is not in the money, and hand-for-hand would start
     at the wrong point. */
  const paidPositions = useMemo(
    () => lastPaidPlace(tournament?.payout_structure),
    [tournament?.payout_structure]
  );

  if (!tournament) {
    return (
      <div className="tl-panel dov-empty">
        <div className="tl-empty">
          This Event Is No Longer Available
          <span className="tl-empty__hint">It May Have Been Cancelled Or Removed</span>
        </div>
      </div>
    );
  }

  const levelProgress =
    level.duration > 0
      ? Math.min(100, Math.max(0, (1 - level.remaining / level.duration) * 100))
      : 0;
  const urgent = isRunning && level.remaining > 0 && level.remaining <= 60;

  const heroTime = isRunning
    ? clockText(level.remaining)
    : isCompleted
      ? '-'
      : untilText(secondsToStart);
  const heroEyebrow = isRunning
    ? level.isBreak
      ? 'Break Ends In'
      : `Level ${level.index + 1} Ends In`
    : 'Starts In';
  const heroNote = isRunning
    ? `Running Since ${shortDate(tournament.started_at)}`
    : `${shortDate(tournament.start_time)} - ${chips(field.entries)} Registered`;

  return (
    <section className="dov" aria-label="Tournament Overview">
      {/* Owner-only whitelist manager. Renders null for everyone else. */}
      <RegistrationApprovalsPanel
        tournamentId={tournament.id}
        clubId={String(tournament.club_id || '')}
        authorizedToRegister={Boolean(tournament.authorized_to_register)}
      />

      {/* ── BAND 1 — where the event is right now ── */}
      {isCompleted ? (
        <div className="tl-panel dov-podium-panel">
          <div className="tl-section-head">
            <h3>Final Results</h3>
            <span className="tl-section-note">{chips(field.entries)} Entries</span>
          </div>
          {podium.length === 0 ? (
            <div className="tl-empty">
              Results Are Being Finalised
              <span className="tl-empty__hint">Check Back In A Moment</span>
            </div>
          ) : (
            <div className="dov-podium">
              {podium.map(({ player, prizeValue }) => (
                <div
                  key={player.user_id}
                  className={`dov-podium__card dov-podium__card--p${player.position}`}
                >
                  <span className="dov-podium__place">{ordinal(player.position)}</span>
                  <span className="dov-podium__name">{player.username}</span>
                  <span className="dov-podium__prize">
                    {prizeValue > 0 ? `${chipsCompact(prizeValue)} Chips` : '-'}
                  </span>
                </div>
              ))}
            </div>
          )}
          {finishers.length > 0 && (
            <>
              <span className="dov-finishers__label">In The Money Behind Them</span>
              <ul
                className="dov-finishers tl-scroll"
                aria-label="Finishing Positions Below The Podium"
              >
                {finishers.map((player) => (
                  <li key={player.user_id} className="dov-finisher">
                    <span className="dov-finisher__pos">{ordinal(player.position)}</span>
                    <span className="dov-finisher__name">{player.username}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : (
        <div className="tl-panel dov-hero" aria-live="off">
          <div className="dov-hero__main">
            <div className="dov-hero__clockcol">
              <span className="dov-hero__eyebrow">{heroEyebrow}</span>
              <span
                className={`tl-clock dov-hero__time${urgent ? ' tl-clock--urgent' : ''}${
                  isRunning ? '' : ' tl-clock--paused'
                }`}
              >
                {heroTime}
              </span>
              <span className="dov-hero__note">{heroNote}</span>
            </div>
            <div className="dov-hero__blinds">
              <div className="dov-blind">
                <span className="dov-blind__label">
                  {isRunning ? (level.isBreak ? 'On Break' : 'Blinds') : 'Opening Blinds'}
                </span>
                <span className="dov-blind__value">
                  {chipsCompact(level.sb)} / {chipsCompact(level.bb)}
                </span>
                <span className="dov-blind__ante">
                  {level.ante > 0 ? `Ante ${chipsCompact(level.ante)}` : 'No Ante'}
                </span>
              </div>
              <div className="dov-blind dov-blind--next">
                <span className="dov-blind__label">Next</span>
                <span className="dov-blind__value">
                  {level.nextBb > 0
                    ? `${chipsCompact(level.nextSb)} / ${chipsCompact(level.nextBb)}`
                    : '-'}
                </span>
              </div>
            </div>
          </div>
          {/* Decoration: the hero clock above it IS the value. */}
          <div className="tl-meter dov-hero__meter" aria-hidden="true">
            <div
              className={`tl-meter__fill${urgent ? ' tl-meter__fill--under' : ''}`}
              style={{ width: `${levelProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* Bubble play. Renders null unless hand-for-hand is actually on. */}
      {isRunning && Boolean(tournament.hand_for_hand) && (
        <HandForHandBanner
          active={Boolean(tournament.hand_for_hand)}
          playersRemaining={field.alive}
          paidPositions={paidPositions}
        />
      )}

      {/* ── BAND 2 — the figures that move ── */}
      <div className="tl-stat-grid dov-stats">
        {stats.map((tile) => (
          <div key={tile.key} className="tl-stat">
            <span className="tl-stat__label">{tile.label}</span>
            <span className={`tl-stat__value${tile.tone ? ` tl-stat__value--${tile.tone}` : ''}`}>
              {tile.value}
            </span>
            {tile.sub && <span className="tl-stat__sub">{tile.sub}</span>}
          </div>
        ))}
      </div>

      {/* ── BAND 3 — rule tags ── */}
      {tags.length > 0 && (
        <div className="dov-tags" aria-label="Tournament Rules">
          {tags.map((tag) => (
            <span
              key={tag.label}
              className={`tl-badge${tag.kind === 'default' ? '' : ` tl-badge--${tag.kind}`}`}
            >
              {tag.label}
            </span>
          ))}
        </div>
      )}

      {/* Final-table deal vote. Only at one table, only on an FT-deal event. */}
      {dealPanel && (
        <div className="tl-panel dov-deal">
          <div className="dov-deal__head">
            <span className="dov-deal__label">Final Table Deal</span>
            <span className="dov-deal__count">
              {chips(dealVoteCount)}/{chips(dealPanel.remaining)} Votes
            </span>
          </div>
          {dealPanel.amSeated &&
            (hasVotedDeal ? (
              <p className="dov-deal__note">
                Your Vote Is In. A Deal Happens When Every Remaining Player Votes.
              </p>
            ) : (
              <button
                type="button"
                className="dov-deal__btn"
                onClick={handleVoteForDeal}
                disabled={votingDeal}
                aria-label="Vote To Split The Remaining Prize Pool"
              >
                {votingDeal ? 'Voting...' : 'Vote For Deal'}
              </button>
            ))}
        </div>
      )}

      {/* ── BAND 4 — the definition grid the long list became ──
           Every value in this band used to be an inline style, and three of
           them were broken:

             padding: 0 on the panel overrode `.dov-info`'s own padding AND its
             `@media (max-width: 400px)` override, so the band's mobile tuning
             was dead;

             backgroundColor: 'var(--surface)' on both inner panels referenced a
             token that IS NOT DEFINED anywhere in this repo (grep --surface:
             returns nothing), so they had no background and the wrapper's
             rgba(255,255,255,0.05) -- meant to show through a 1px gap as a
             hairline -- washed the whole band instead;

             padding: 16 hardcoded on each inner panel, replacing the 9px the
             mobile rule would have applied, squeezing a two-column grid of
             nowrap values into ~161px at 375px.

           It is all in DetailOverviewTab.css now, where the media queries can
           reach it. */}
      <div className="tl-panel dov-info tl-scroll dov-info--band">
        <div className="dov-band">
          {/* TOURNAMENT DETAILS */}
          <div className="dov-band__section">
            <h3 className="dov-band__title">Tournament Details</h3>
            <dl className="dov-info__grid">
              {info.map((item) => (
                <div
                  key={item.key}
                  className={`dov-info__item${item.wide ? ' dov-info__item--wide' : ''}`}
                >
                  <dt className="dov-info__label">{item.label}</dt>
                  <dd
                    className={`dov-info__value${item.tone ? ` dov-info__value--${item.tone}` : ''}`}
                  >
                    {item.value}
                  </dd>
                </div>
              ))}
            </dl>
            {Boolean(tournament.is_mystery_bounty) && onOpenTab && (
              <button
                type="button"
                className="dov-ladder-link"
                onClick={() => onOpenTab('rewards')}
              >
                Open The Full Mystery Ladder
              </button>
            )}
          </div>

          {/* SATELLITE DETAILS */}
          <div className="dov-band__section">
            <h3 className="dov-band__title">Satellite Details</h3>
            {satLoading ? (
              <div className="dov-band__note" role="status" aria-live="polite" aria-busy="true">
                Loading Satellites...
              </div>
            ) : satError ? (
              /* There was no error branch at all: a failed fetch reported to
                 Sentry and then rendered the empty state, telling the player
                 as a fact that this event has no satellites. */
              <div className="dov-band__note dov-band__note--error" role="alert">
                <span>{satError}</span>
                <button type="button" className="dov-band__retry" onClick={satRetry}>
                  Try Again
                </button>
              </div>
            ) : satellites.length === 0 ? (
              /* Was "NO SATELITTES AVAILABLE FOR THIS TOURNAMENT" -- two
                 misspellings, and shouted, against the Title Case rule this
                 file follows everywhere else. */
              <div className="dov-band__note">No Satellites Available For This Tournament</div>
            ) : (
              <div className="dov-band__sats">
                {satellites.map((sat) => (
                  <TournamentLobbyCard
                    key={sat.id}
                    tournament={sat}
                    knownRegistration={satRegistration ? Boolean(satRegistration[sat.id]) : null}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
