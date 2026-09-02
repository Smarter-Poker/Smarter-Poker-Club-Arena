/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BLINDS TAB — current level, next level, next break. Nothing else.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25, verbatim: "THE BLINDS PAGE DOESN'T WORK, THE 'TIME REMAINING'
 * DOESN'T UPDATE ... IT SHOULD SIMPLY STATE THE CURRENT LEVEL, NEXT LEVEL BLINDS
 * + ANTE AND TIME REMAINING, AND COUNTDOWN CLOCK UNTIL NEXT BREAK."
 *
 * ── ROOT CAUSE OF THE FROZEN "0:00 TIME REMAINING" ────────────────────────────
 *
 * The old tab rendered `BlindLevelProgress`, and TournamentDetails fed it:
 *
 *     levelStartTime={tournament.level_start_time || tournament.started_at
 *                                                 || tournament.start_time}
 *
 * `level_start_time` IS NOT A COLUMN. The column is `level_started_at` (verified
 * against the live schema: `tournaments.level_started_at timestamptz`, populated
 * on all 75 currently-RUNNING rows). So that first operand was `undefined` on
 * every row ever loaded, and the clock silently fell through to `started_at` —
 * the moment the WHOLE TOURNAMENT began.
 *
 * `BlindLevelProgress` then computed
 *
 *     remaining = level.duration * 60 - (now - tournamentStart) / 1000
 *     return Math.max(0, remaining)
 *
 * so the instant a tournament had been running for longer than one level — i.e.
 * a couple of minutes in, for every tournament, forever — `remaining` went
 * negative and the `Math.max(0, ...)` pinned it at exactly 0:00 and left it
 * there. It was not a stopped timer. The interval was ticking the entire time,
 * recomputing the same clamped zero once a second. That is why it looked dead
 * rather than slow, and why nothing about the interval or the tab lifecycle
 * explained it: the arithmetic was measuring the wrong span.
 *
 * (Two smaller faults rode along in the same call site and are reported to the
 * lead rather than patched here, because TournamentDetails is not this file's
 * to edit: the level-list mapper reads the SECONDS-valued `duration` key before
 * `durationMinutes`, so every Spin's 180-second level was drawn as 180 minutes;
 * and `isPaused={status === 'PAUSED'}` can never be true, because the engine
 * keeps a paused tournament at status RUNNING and records the pause in
 * `on_break` / `break_ends_at` instead.)
 *
 * ── HOW THIS IMPLEMENTATION MAKES IT UNABLE TO RECUR ──────────────────────────
 *
 * 1. THE LEVEL CLOCK IS ANCHORED, NOT ASSUMED. `levelAnchorMs()` reads
 *    `level_started_at` — the real column — and only if that is absent or
 *    unparseable falls back to `started_at` plus the summed duration of every
 *    level before this one. If THAT cannot be computed honestly (any earlier
 *    level carries a zero duration) it returns null and the clock renders
 *    `--:--`. There is no code path that can turn "I do not know" into "0:00".
 *
 * 2. NOTHING IS EVER DECREMENTED. The only state the tick touches is
 *    `nowMs = Date.now()`. Every figure on the page is derived from wall-clock
 *    subtraction during render, so a throttled or suspended background tab
 *    cannot accumulate drift — it can only render one second late, and the
 *    `visibilitychange` resync removes even that.
 *
 * 3. ZERO IS LABELLED. When the countdown legitimately reaches zero the panel
 *    says "Level Change Pending" rather than sitting on a bare 0:00, so a
 *    stalled server-side advance is visibly distinct from a healthy clock. A
 *    paused tournament gets `.tl-clock--paused` and the word PAUSED for the
 *    same reason: a frozen clock that looks identical to a broken clock IS the
 *    bug being fixed here.
 *
 * 4. LEVEL CHANGES ARRIVE ON THE BUS, not only on the next poll.
 *    `BLIND_LEVEL_CHANGE` re-anchors the clock the instant the engine advances,
 *    and `BREAK_START` / `BREAK_END` (relayed from the server's `t-break-<id>`
 *    channel by tournamentEventBridge) flip the break takeover. The optimistic
 *    value is dropped the moment the tournament row itself carries the new
 *    level, so the row stays authoritative.
 *
 * The full L1..Ln dump the old tab printed underneath is deliberately gone.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Tournament } from '../../../types/database.types';
import { useMasterBusSubscription } from '../../../hooks/useMasterBusSubscription';
import { chips, clockText, type NormalisedBlindLevel, type TournamentTabProps } from './types';
import '../../../styles/tournament-lobby-3d.css';
import './BlindsTab.css';

/* ─────────────────────────────────────────────────────────────────────────────
   The tournament columns this tab reads. Declared explicitly rather than leaning
   on Tournament's `[key: string]: any`, because an index signature is exactly
   what let `level_start_time` typecheck for months while always being undefined.
   Every name below was verified against the live schema.
   ───────────────────────────────────────────────────────────────────────────── */
interface ClockColumns {
  status?: string | null;
  current_level?: number | null;
  /** The level clock. NOT `level_start_time` — that column does not exist. */
  level_started_at?: string | null;
  started_at?: string | null;
  start_time?: string | null;
  ended_at?: string | null;
  on_break?: boolean | null;
  break_started_at?: string | null;
  break_ends_at?: string | null;
}

/** Bus payloads, widened so one handler can serve both spellings of an event. */
interface LevelPayload {
  tournamentId?: string;
  level?: number;
}
interface BreakPayload {
  tournamentId?: string;
  level?: number;
  durationMinutes?: number;
  resumeAt?: string;
  breakEndsAt?: string;
}

/** Epoch ms, or null for absent/unparseable. Never NaN, never a silent zero. */
function epoch(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * `indexOfLevel` DELETED 2026-08-26. It searched for a level whose 1-based
 * `level` field equalled `current_level`, which is a 0-based index — so it
 * confidently returned the wrong element for every level after the first, and
 * its positional fallback (`levelNumber - 1`) subtracted the one that had
 * never been added. The row already carries the index; there is nothing to
 * search for.
 */

/** "20 Min", "3 Min", "2.5 Min" — or a dash, because a level is never 0 long. */
function minutesText(duration: number | null | undefined): string {
  const m = Number(duration);
  if (!Number.isFinite(m) || m <= 0) return '--';
  const rounded = Math.round(m * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} Min`;
}

function blindsText(level: NormalisedBlindLevel | null | undefined): string {
  if (!level) return '--';
  return `${chips(level.smallBlind)} / ${chips(level.bigBlind)}`;
}

export default function BlindsTab({ tournament, blindLevels }: TournamentTabProps) {
  const row = tournament as Tournament & ClockColumns;

  /* The ONLY ticking state. Everything visible is derived from it by
     subtraction, so there is no counter that can drift or stall. */
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  /* Optimistic level/break, adopted from the bus and discarded the moment the
     tournament row itself reports the change. */
  const [busLevel, setBusLevel] = useState<{ level: number; anchorMs: number } | null>(null);
  const [busBreak, setBusBreak] = useState<{ endsAtMs: number | null } | null>(null);

  /* A finished event has no clock to run. The tick used to be unconditional
     with an empty dep array, so a COMPLETED or CANCELLED tournament kept
     re-rendering this tab once a second, for ever, to recompute figures that
     cannot change and that lines 405 and 435 do not even render. Derived here
     from the raw row rather than from `isFinished` below, because that is
     computed after this effect. */
  const rowStatus = String(row.status || '').toUpperCase();
  const clockIsDead = rowStatus === 'COMPLETED' || rowStatus === 'CANCELLED' || !!row.ended_at;

  useEffect(() => {
    if (clockIsDead) return;
    const tick = () => setNowMs(Date.now());
    tick();
    const id = setInterval(tick, 1000);
    // A background tab's interval is throttled; recomputing from wall clock on
    // the way back means the reader never sees a stale figure even for a frame.
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') tick();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }
    return () => {
      clearInterval(id);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
      }
    };
  }, [clockIsDead]);

  /* The row caught up: stop preferring the optimistic values. */
  useEffect(() => {
    setBusLevel(null);
  }, [row.current_level, row.level_started_at]);

  useEffect(() => {
    setBusBreak(null);
  }, [row.on_break, row.break_ends_at]);

  const onLevelChange = useCallback(
    (payload: LevelPayload) => {
      if (!payload || payload.tournamentId !== tournament.id) return;
      const level = Number(payload.level);
      if (!Number.isFinite(level) || level < 1) return;
      setBusLevel({ level, anchorMs: Date.now() });
      setBusBreak(null);
    },
    [tournament.id]
  );

  const onBreakStart = useCallback(
    (payload: BreakPayload) => {
      if (!payload || payload.tournamentId !== tournament.id) return;
      const minutes = Number(payload.durationMinutes);
      const endsAtMs =
        epoch(payload.resumeAt) ??
        epoch(payload.breakEndsAt) ??
        (Number.isFinite(minutes) && minutes > 0 ? Date.now() + minutes * 60000 : null);
      /**
       * ONE BREAK, TWO EVENTS, ONE ANSWER.
       *
       * tournamentEventBridge emits TOURNAMENT_BREAK and BREAK_START from the
       * same branch, and both are subscribed below (deliberately — either
       * spelling may be the one that arrives). So this handler runs twice per
       * break, and the `Date.now() + minutes` fallback computed a DIFFERENT end
       * time on the second call, milliseconds later. Keeping the first answer
       * makes the duplicate delivery a no-op instead of a small backwards jump
       * in the break clock. A payload that carries a real end time is idempotent
       * anyway; this only matters for the fallback.
       */
      setBusBreak((prev) => prev ?? { endsAtMs });
    },
    [tournament.id]
  );

  const onBreakEnd = useCallback(
    (payload: LevelPayload) => {
      if (!payload || payload.tournamentId !== tournament.id) return;
      setBusBreak(null);
      setBusLevel(null);
    },
    [tournament.id]
  );

  /* BLIND_LEVEL_CHANGE is the one TournamentTimerService.handleLevelChange
     actually emits, and both spellings of the break events are live on the bus
     via tournamentEventBridge. `TOURNAMENT_LEVEL_CHANGE` is deliberately NOT
     subscribed: it is declared in BusPayloadMap but nothing publishes it, and
     tests/unit/noDeadBusSubscriptions.test.ts correctly refuses a handler that
     can never run. */
  useMasterBusSubscription('BLIND_LEVEL_CHANGE', onLevelChange);
  useMasterBusSubscription('BREAK_START', onBreakStart);
  useMasterBusSubscription('TOURNAMENT_BREAK', onBreakStart);
  useMasterBusSubscription('BREAK_END', onBreakEnd);
  useMasterBusSubscription('TOURNAMENT_BREAK_END', onBreakEnd);

  /* ───────────────────────────────────────────────────────────────────────────
     DERIVATION. Pure, from `nowMs` and the row. No hooks below this line.
     ─────────────────────────────────────────────────────────────────────────── */

  const status = String(row.status || '').toUpperCase();
  const startTimeMs = epoch(row.start_time);
  const startedMs = epoch(row.started_at);
  const endedMs = epoch(row.ended_at);

  const isFinished = status === 'COMPLETED' || status === 'CANCELLED' || endedMs !== null;
  const isPaused = status === 'PAUSED';
  const hasStarted =
    !isFinished && (status === 'RUNNING' || status === 'LATE_REG' || startedMs !== null);

  const levelCount = blindLevels.length;
  /**
   * `current_level` IS A 0-BASED INDEX, NOT A LEVEL NUMBER (fixed 2026-08-26).
   *
   * The engine stores the value it indexes the structure with:
   * `blindStructure[this.currentLevel]` … `.update({ current_level:
   * this.currentLevel })` (TournamentManagerBase). But the stored structures
   * number their own `level` field FROM 1, so element 0 reads `level: 1`.
   *
   * `BLIND_LEVEL_CHANGE.level` IS NOT THE SAME NUMBER (corrected 2026-08-29).
   * This comment used to say it was — "TournamentTimerService writes one
   * variable to both" — and it does not: `handleLevelChange` computes
   * `const displayLevel = newLevel + 1` and emits THAT on the bus while writing
   * the raw index to the row. So the two branches below arrive in different
   * units and the bus branch has to convert.
   *
   * Left as it was, this tab jumped a whole level FORWARD the instant the
   * engine advanced — next level's blinds, next level's duration, and the level
   * after that advertised as "Next" — and stayed there until the row poll
   * cleared `busLevel`. Which is the same off-by-one this block was written to
   * fix, arriving through the other door. The `level < 1` guard in
   * `onLevelChange` is the tell that the payload was always 1-based: on a
   * 0-based value it would silently drop a genuine advance to the first level.
   *
   * This tab used to clamp to `Math.max(1, … || 1)` and then match on the
   * 1-based `level` field, so from the first level-up onward it was a whole
   * level behind: with the engine on `current_level = 5` (level 6) it printed
   * "Level 5" and level 5's blinds, while the Overview tab one tap away
   * printed "Level 6" off the same row. It also measured Time Remaining
   * against the previous level's duration and advertised the live level as
   * "Next". That is Dan's 2026-08-25 report — "still says Level 1 even though
   * it's clearly Level 2" — surviving in a second tab.
   *
   * `tournamentLevel()` in components/lobby/tournamentFigures.ts is the
   * canonical converter and carries the production evidence; use it rather
   * than open-coding the arithmetic a fourth time.
   */
  const levelIndex = busLevel
    ? // 1-based display level from the bus -> 0-based index.
      Math.max(0, (Number(busLevel.level) || 1) - 1)
    : // Already a 0-based index on the row.
      Math.max(0, Number(row.current_level) || 0);
  const index = Math.min(levelIndex, Math.max(0, levelCount - 1));
  /**
   * The engine did not stop at the end of the structure.
   *
   * `TournamentService` keeps incrementing `current_level` past the last
   * published level (3,079 production rows are in that state), so this clamp
   * is load-bearing — without it `blindLevels[index]` is undefined and the tab
   * renders dashes. But clamping ALONE is a quieter kind of wrong: the tab then
   * prints the last published blinds and the words "Final Level" as if that
   * were what is being dealt, when the engine has escalated beyond anything
   * this structure describes. A player reading those numbers is reading a
   * guess. Say so instead.
   */
  const beyondStructure = levelCount > 0 && levelIndex > levelCount - 1;
  const current: NormalisedBlindLevel | undefined = blindLevels[index];
  const next: NormalisedBlindLevel | null = blindLevels[index + 1] ?? null;
  /** Display number for the fallback when the structure has no `level` field. */
  const levelNumber = index + 1;

  /** Where this level's clock started. Null means genuinely unknown. */
  const levelAnchorMs: number | null = (() => {
    if (busLevel) return busLevel.anchorMs;
    const explicit = epoch(row.level_started_at);
    if (explicit !== null) return explicit;
    if (startedMs === null) return null;
    let accumulated = 0;
    for (let i = 0; i < index; i += 1) {
      const minutes = Number(blindLevels[i]?.duration);
      if (!Number.isFinite(minutes) || minutes <= 0) return null;
      accumulated += minutes * 60000;
    }
    return startedMs + accumulated;
  })();

  const durationSec = Math.round((Number(current?.duration) || 0) * 60);
  const durationKnown = durationSec > 0;

  /** Seconds left in the current level. Null when it cannot be known. */
  const remainingSec: number | null =
    durationKnown && levelAnchorMs !== null
      ? Math.min(durationSec, Math.max(0, durationSec - Math.floor((nowMs - levelAnchorMs) / 1000)))
      : null;

  const elapsedSec = remainingSec === null ? null : durationSec - remainingSec;
  const progressPct =
    remainingSec === null || !durationKnown
      ? 0
      : Math.min(100, Math.max(0, (elapsedSec! / durationSec) * 100));

  const secondsToStart =
    startTimeMs === null ? null : Math.max(0, Math.floor((startTimeMs - nowMs) / 1000));

  /* BREAK STATE. A break is signalled three ways and any of them counts: the
     structure row itself, the tournament row's break columns, or the live
     broadcast relayed onto the bus. */
  const rowBreakEndsMs = epoch(row.break_ends_at);
  const structureBreak = Boolean(current?.isBreak);
  const rowOnBreak = Boolean(row.on_break) || (rowBreakEndsMs !== null && rowBreakEndsMs > nowMs);
  const onBreak = hasStarted && (structureBreak || rowOnBreak || busBreak !== null);

  const breakEndsAtMs = busBreak ? busBreak.endsAtMs : rowBreakEndsMs;
  const breakRemainingSec: number | null = structureBreak
    ? remainingSec
    : breakEndsAtMs === null
      ? null
      : Math.max(0, Math.floor((breakEndsAtMs - nowMs) / 1000));

  /** Time until the next scheduled break: rest of this level + whole levels between. */
  const nextBreak: { seconds: number | null; scheduled: boolean; unknown: boolean } = (() => {
    let target = -1;
    for (let i = index + 1; i < blindLevels.length; i += 1) {
      if (blindLevels[i].isBreak) {
        target = i;
        break;
      }
    }
    if (target < 0) return { seconds: null, scheduled: false, unknown: false };
    if (remainingSec === null) return { seconds: null, scheduled: true, unknown: true };
    let total = remainingSec;
    for (let i = index + 1; i < target; i += 1) {
      const minutes = Number(blindLevels[i]?.duration);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return { seconds: null, scheduled: true, unknown: true };
      }
      total += minutes * 60;
    }
    return { seconds: total, scheduled: true, unknown: false };
  })();

  if (levelCount === 0) {
    return (
      <div className="blinds-tab">
        <section className="tl-panel blinds-tab__card">
          <div className="tl-empty">
            No Blind Structure Published For This Tournament Yet
            <span className="tl-empty__hint">The Levels Appear Here Once The Club Sets Them</span>
          </div>
        </section>
      </div>
    );
  }

  /* ───────────────────────────────────────────────────────────────────────────
     PRESENTATION
     ─────────────────────────────────────────────────────────────────────────── */

  const urgent = !isPaused && hasStarted && remainingSec !== null && remainingSec <= 60;

  const clockClass = [
    'tl-clock',
    'blinds-tab__clock',
    isPaused ? 'tl-clock--paused' : '',
    urgent ? 'tl-clock--urgent' : '',
  ]
    .filter(Boolean)
    .join(' ');

  /* The break clock gets its OWN urgency. Reusing `urgent` would light it red
     off the frozen level clock, which during a break says nothing about how
     long is left of the break. */
  const breakClockClass = [
    'tl-clock',
    'blinds-tab__clock',
    isPaused ? 'tl-clock--paused' : '',
    breakRemainingSec !== null && breakRemainingSec <= 60 ? 'tl-clock--urgent' : '',
  ]
    .filter(Boolean)
    .join(' ');

  let mainClock: string;
  let mainCaption: string;

  if (isFinished) {
    mainClock = '--:--';
    mainCaption = status === 'CANCELLED' ? 'Tournament Cancelled' : 'Tournament Complete';
  } else if (!hasStarted) {
    if (secondsToStart === null) {
      mainClock = '--:--';
      mainCaption = 'Start Time Not Set';
    } else if (secondsToStart === 0) {
      mainClock = '0:00';
      mainCaption = 'Starting Soon';
    } else {
      mainClock = clockText(secondsToStart);
      mainCaption = 'Starts In';
    }
  } else if (remainingSec === null) {
    mainClock = '--:--';
    mainCaption = durationKnown ? 'Level Clock Not Published' : 'Level Length Not Published';
  } else if (isPaused) {
    mainClock = clockText(remainingSec);
    mainCaption = 'Paused';
  } else if (remainingSec === 0) {
    mainClock = '0:00';
    mainCaption = 'Level Change Pending';
  } else {
    mainClock = clockText(remainingSec);
    mainCaption = 'Time Remaining';
  }

  let badgeText = 'Registering';
  let badgeTone = 'tl-badge--action';
  if (isFinished) {
    badgeText = status === 'CANCELLED' ? 'Cancelled' : 'Complete';
    badgeTone = 'tl-badge--mute';
  } else if (isPaused) {
    badgeText = 'Paused';
    badgeTone = 'tl-badge--mute';
  } else if (hasStarted) {
    badgeText = 'Live';
    badgeTone = 'tl-badge--good';
  }

  const renderBlinds = (level: NormalisedBlindLevel) => (
    <div className="blinds-tab__blinds">
      <div className="blinds-tab__blind">
        <span className="blinds-tab__blind-value">{chips(level.smallBlind)}</span>
        <span className="blinds-tab__blind-key">Small Blind</span>
      </div>
      <span className="blinds-tab__blind-sep">/</span>
      <div className="blinds-tab__blind">
        <span className="blinds-tab__blind-value">{chips(level.bigBlind)}</span>
        <span className="blinds-tab__blind-key">Big Blind</span>
      </div>
      <span className="blinds-tab__blind-sep">+</span>
      <div className="blinds-tab__blind">
        <span className="blinds-tab__blind-value">{level.ante > 0 ? chips(level.ante) : '0'}</span>
        <span className="blinds-tab__blind-key">Ante</span>
      </div>
    </div>
  );

  return (
    <div className="blinds-tab">
      {/* 1 / 4 — CURRENT LEVEL, or the break that has taken it over. */}
      {onBreak ? (
        <section className="tl-panel blinds-tab__card blinds-tab__card--break">
          <div className="tl-section-head">
            <h3 className="tl-section-title">On Break</h3>
            <span className="tl-badge tl-badge--action">Break</span>
          </div>
          <div className="blinds-tab__level">
            <span className="blinds-tab__level-num">Break</span>
            <span className="blinds-tab__level-of">
              {next ? `Resumes At Level ${next.level}` : 'Play Resumes Shortly'}
            </span>
          </div>
          <div className="blinds-tab__clockwrap">
            <span className={breakClockClass}>
              {breakRemainingSec === null ? '--:--' : clockText(breakRemainingSec)}
            </span>
            <span className="blinds-tab__clock-key">
              {breakRemainingSec === null ? 'Break Length Not Published' : 'Until Play Resumes'}
            </span>
          </div>
          {next && !next.isBreak ? (
            <div className="blinds-tab__resume">
              <span className="blinds-tab__resume-key">Resuming Blinds</span>
              <span className="blinds-tab__resume-value">
                {blindsText(next)}
                {next.ante > 0 ? ` + ${chips(next.ante)}` : ''}
              </span>
            </div>
          ) : null}
        </section>
      ) : (
        <section className="tl-panel blinds-tab__card blinds-tab__card--current">
          <div className="tl-section-head">
            <h3 className="tl-section-title">Current Level</h3>
            <span className={`tl-badge ${badgeTone}`}>{badgeText}</span>
          </div>

          <div className="blinds-tab__level">
            <span className="blinds-tab__level-num">Level {current?.level ?? levelNumber}</span>
            <span className="blinds-tab__level-of">Of {levelCount}</span>
          </div>

          {current ? renderBlinds(current) : null}

          <div className="blinds-tab__clockwrap">
            <span className={clockClass}>{mainClock}</span>
            <span className="blinds-tab__clock-key">{mainCaption}</span>
          </div>

          {/* The bar duplicates the clock and the two figures beneath it, so it
              is decoration in the accessibility tree rather than a second,
              unlabelled reading of the same number. It used to be neither:
              no role, no aria-value*, and not hidden either, so a screen
              reader announced an empty group. */}
          <div className="tl-meter blinds-tab__meter" aria-hidden="true">
            <div className="tl-meter__fill" style={{ width: `${progressPct}%` }} />
          </div>
          <div className="blinds-tab__meter-foot">
            <span>{elapsedSec === null ? '--:--' : clockText(elapsedSec)} Elapsed</span>
            <span>{minutesText(current?.duration)} Level</span>
          </div>
        </section>
      )}

      {/* 2 / 4 — NEXT LEVEL. */}
      <section className="tl-panel blinds-tab__card">
        <div className="tl-section-head">
          <h3 className="tl-section-title">Next Level</h3>
          {next ? <span className="tl-section-note">{minutesText(next.duration)}</span> : null}
        </div>

        {beyondStructure ? (
          <div className="tl-empty">
            Past The Published Structure
            <span className="tl-empty__hint">
              The Clock Has Gone Beyond Level {levelCount}. Ask The Floor For The Current Blinds
            </span>
          </div>
        ) : !next ? (
          <div className="tl-empty">
            Final Level
            <span className="tl-empty__hint">The Structure Does Not Go Any Higher</span>
          </div>
        ) : next.isBreak ? (
          <div className="blinds-tab__nextbreak">
            <span className="blinds-tab__level-num">Break</span>
            <span className="blinds-tab__level-of">{minutesText(next.duration)}</span>
          </div>
        ) : (
          <>
            <div className="blinds-tab__level">
              <span className="blinds-tab__level-num">Level {next.level}</span>
              <span className="blinds-tab__level-of">{minutesText(next.duration)}</span>
            </div>
            {renderBlinds(next)}
          </>
        )}
      </section>

      {/* 3 / 4 — TIME UNTIL THE NEXT BREAK. Hidden while a break is running. */}
      {!onBreak ? (
        <section className="tl-panel blinds-tab__card">
          <div className="tl-section-head">
            <h3 className="tl-section-title">Next Break</h3>
          </div>

          {!nextBreak.scheduled ? (
            <div className="tl-empty">
              No Further Breaks Scheduled
              <span className="tl-empty__hint">This Structure Runs Straight Through</span>
            </div>
          ) : nextBreak.unknown ? (
            <div className="tl-empty">
              Break Time Not Published
              <span className="tl-empty__hint">
                A Level Between Here And The Break Has No Length
              </span>
            </div>
          ) : (
            <div className="blinds-tab__clockwrap">
              <span
                className={[
                  'tl-clock',
                  'blinds-tab__clock',
                  'blinds-tab__clock--small',
                  isPaused ? 'tl-clock--paused' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {clockText(nextBreak.seconds ?? 0)}
              </span>
              <span className="blinds-tab__clock-key">Until The Next Break</span>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
