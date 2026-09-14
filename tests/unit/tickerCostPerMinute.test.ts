/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WHAT THE STRIP COSTS TO KEEP ON SCREEN (2026-09-14)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The ticker is a notification bar. It sits above a live poker table, on the
 * same main thread as the table, for as long as the player is in the arena. So
 * the question that matters is not whether it works - the other files prove
 * that - but what it costs per minute while it is doing nothing in particular.
 *
 * Until today it cost a full re-render of itself SIXTY TIMES A MINUTE. `now`
 * lived in the container as state advanced by a 1Hz interval, and every tick
 * re-ran the lane memo, re-rendered TickerRail and rebuilt every field of every
 * announcement - to change four characters of a countdown.
 *
 * The fix is structural, so the pins are structural: the clock is its own
 * component with its own second, and the container ticks at a fifth of the
 * rate for the two things that actually need it (expiring an announcement, and
 * the spoken line, which is rounded to the MINUTE precisely so a screen reader
 * is not told the news sixty times a minute).
 *
 * These assertions read source. A behavioural test cannot see the difference
 * between "renders correctly" and "renders correctly sixty times a minute",
 * which is exactly why this regressed silently for as long as it did.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blankNonCode, sliceCall, sliceStatement } from '../helpers/sourceWindow';

const read = (rel: string) => readFileSync(resolve(__dirname, '../../src', rel), 'utf8');

const HOST = read('components/tournament/TournamentStartingTicker.tsx');
const RAIL = read('components/tournament/TickerRail.tsx');
const CLOCK = read('components/tournament/TickerClock.tsx');

describe('the clock owns its own second, and only its own', () => {
  it('is a component, and the rail renders it', () => {
    expect(RAIL).toContain("import { TickerClock } from './TickerClock'");
    expect(RAIL).toContain('<TickerClock');
  });

  it('keeps the 1Hz interval INSIDE the clock', () => {
    const interval = sliceCall(CLOCK, 'setInterval(');
    expect(interval).toContain('1000');
  });

  it('stops counting once the deadline has passed', () => {
    /* An interval that outlives its reason is how a phone loses a percent an
       hour to a bar nobody is reading. */
    expect(CLOCK).toContain('clearInterval(tick)');
    expect(blankNonCode(CLOCK)).toMatch(/if \(deadlineMs - current <= 0\) clearInterval/);
  });

  it('counts to an INSTANT, not a duration, so a slept tab wakes up correct', () => {
    expect(CLOCK).toContain('deadlineMs: number');
    expect(blankNonCode(CLOCK)).toContain('countdown(deadlineMs - now)');
  });
});

describe('the container stopped re-rendering the strip to move four characters', () => {
  it('declares its tick as a named constant, not a magic 1000', () => {
    const decl = sliceStatement(HOST, 'const CONTAINER_TICK_MS');
    expect(decl).toContain('5_000');
  });

  it('uses that constant for the expiry tick', () => {
    const effect = sliceCall(
      HOST,
      'useEffect(() => {\n    if (!hasClock && lane.length === 0) return undefined;'
    );
    expect(effect).toContain('CONTAINER_TICK_MS');
    expect(effect).not.toContain('1000');
  });

  it('uses it for the toast sweep too, which was the OTHER 1Hz loop', () => {
    /* This one renders nothing, which is why it survived the first pass: it
       just walked every announcement once a second, for every registered
       player, to catch two thresholds that are not exact and never were. */
    const effect = sliceCall(
      HOST,
      'useEffect(() => {\n    if (upcomingForToasts.length === 0) return undefined;'
    );
    expect(effect).toContain('CONTAINER_TICK_MS');
    expect(effect).not.toContain('}, 1000);');
  });

  it('leaves the late-arrival guards in place, which is what makes 5s safe', () => {
    /* A reading four seconds late must never produce a toast that lies. These
       two suppressions were written for a backgrounded tab and they cover it. */
    const effect = sliceCall(
      HOST,
      'useEffect(() => {\n    if (upcomingForToasts.length === 0) return undefined;'
    );
    expect(effect).toContain('sLeft > 120');
    expect(effect).toContain('sLeft > 10');
  });

  it('has no bare 1Hz interval left anywhere in the container', () => {
    const host = blankNonCode(HOST);
    expect(host).not.toContain('}, 1000);');
  });

  it('no longer renders the countdown itself', () => {
    /* THE REGRESSION PIN. If the rail ever formats a countdown again it is
       because `now` came back down as a prop, and the 1Hz re-render of the
       whole strip came back with it. */
    const rail = blankNonCode(RAIL);
    expect(rail).not.toContain('countdown(');
  });
});

describe('the strip announces itself exactly once per announcement', () => {
  it('reports and chimes from an effect, never from the render body', () => {
    /* A side effect in a render body is double-invoked under StrictMode, and
       this render body used to run every second. */
    const effect = sliceCall(
      HOST,
      'useEffect(() => {\n    if (!speakingId || !speakingKind) return;'
    );
    expect(effect).toContain('tickerTelemetry.shown(speakingKind, speakingId)');
    expect(effect).toContain('announceToChime(speakingKind, speakingId)');
  });

  it('keys that effect on the announcement, so a poll that changes nothing is free', () => {
    const host = blankNonCode(HOST);
    expect(host).toContain('}, [speakingId, speakingKind]);');
  });
});
