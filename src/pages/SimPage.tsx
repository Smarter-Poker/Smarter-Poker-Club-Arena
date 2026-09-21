/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SIM PAGE — Browser-Based Hand Scenario Stepper
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * A deterministic, scripted playback of hand-lifecycle scenarios. Each step
 * is a frozen snapshot of what the authoritative engine state should look like
 * at that moment. Used to:
 *
 *   1. Regression-test visual bugs (BUG 029, BUG 030, BUG 031, etc.)
 *   2. Debug state transitions without waiting on a live table
 *   3. Give Dan a URL that reproduces each reported issue instantly
 *
 * Public route — no auth required, no Supabase calls, no sounds, no network.
 * Route: /sim  →  https://smarter.poker/hub/club-arena/sim
 *
 * Scenarios are defined in src/sim/scenarios.ts. Adding a new scenario does
 * not touch this page — drop it in ALL_SCENARIOS and it shows up in the dropdown.
 */

import { titleCase } from '../utils/titleCase';
import React, { useState, useMemo, useCallback } from 'react';
import { SeatSlot } from '../components/table/SeatSlot';
import { CommunityCards } from '../components/table/CommunityCards';
import { PotDisplay } from '../components/table/PotDisplay';
import { ALL_SCENARIOS, type Scenario, type SimStep, type SimViewState } from '../sim/scenarios';
import { SEAT_POSITIONS_6MAX } from '../lib/tableSeatGeometry';
import { SpadeConsole } from '../components/console/SpadeConsole';
import './SimPage.css';

// SEAT_POSITIONS_6MAX is imported from src/lib/tableSeatGeometry.ts — the
// canonical geometry used by TablePage. A local copy here had drifted
// (x: 22 vs 10.5, y: 94 vs 100) and was removed on 2026-08-26.

// ─────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────

const SimPage: React.FC = () => {
  const [scenarioIdx, setScenarioIdx] = useState(0);
  const [stepIdx, setStepIdx] = useState(0);

  const scenario: Scenario = ALL_SCENARIOS[scenarioIdx];
  /* CARD SLIDE 2026-09-04: `?slide=1` deals the hero face down on the sim
     felt so the corner peel can be exercised without a live table. A dev knob
     only - the real table reads user_table_settings.card_slide. */
  const cardSlide = useMemo(
    () =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('slide') === '1',
    []
  );
  /* `&cards=4|5|6` gives the hero a PLO hand, so the peel can be checked
     against the overlapped row where each card shows only a left slice. */
  const heroCardCountOverride = useMemo(() => {
    if (typeof window === 'undefined') return 0;
    const n = Number(new URLSearchParams(window.location.search).get('cards'));
    return n >= 4 && n <= 6 ? n : 0;
  }, []);
  /* THE VIP ALL-IN SQUEEZE ON THE SIM FELT (2026-09-05, verification).
     `?squeeze=1` presents the board as it is presented to a player who is
     all-in, holds a VIP card and has the perk on - the ONLY combination that
     resolves the interactive `all-in` profile. Without it the sim board is an
     ordinary board, which is what every other seat sees.

     This exists because the squeeze had NO end-to-end coverage: the component
     tests run in happy-dom (no pointer capture, no real CSS) and the e2e
     spec drove hand-written markup rather than the real component, so a
     defect that only appears in a browser could not be seen by anything.
     tests/e2e/river-squeeze-interactive.spec.ts drives THIS. */
  const squeezeSim = useMemo(
    () =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('squeeze') === '1',
    []
  );
  const step: SimStep = scenario.steps[stepIdx];
  const state: SimViewState = step.state;

  // ─────────────────────────────────────────────────────────────────────
  // Controls
  // ─────────────────────────────────────────────────────────────────────
  const goPrev = useCallback(() => {
    setStepIdx((i) => Math.max(0, i - 1));
  }, []);
  const goNext = useCallback(() => {
    setStepIdx((i) => Math.min(scenario.steps.length - 1, i + 1));
  }, [scenario.steps.length]);
  const goReset = useCallback(() => {
    setStepIdx(0);
  }, []);
  const onPickScenario = useCallback((ev: React.ChangeEvent<HTMLSelectElement>) => {
    setScenarioIdx(Number(ev.target.value));
    setStepIdx(0);
  }, []);

  // Rotate seats so hero is always visually at the bottom (seat 1 slot).
  // heroSeat is 1-based — seat index (0-based) is heroSeat - 1.
  const rotatedSeats = useMemo(() => {
    const maxSeats = state.maxPlayers;
    const heroIdx = Math.max(0, (state.heroSeat || 1) - 1);
    // Build an array where visual slot 0 = hero's seat, slot 1 = CCW from hero, etc.
    return Array.from({ length: maxSeats }, (_, visualSlot) => {
      const dataIdx = (heroIdx + visualSlot) % maxSeats;
      return dataIdx;
    });
  }, [state.maxPlayers, state.heroSeat]);

  return (
    <div className="sim-page">
      {/* The stepper (#ClubArenaConsole): scenario, step and description on
          the glass, Prev and Next on the two painted plates, Reset a lit word. */}
      <SpadeConsole
        className="sim-page__console"
        eyebrow="Club Arena Sim"
        title="Scenario Stepper"
        pill={`Step ${stepIdx + 1} / ${scenario.steps.length}`}
        pillInk="blue"
        plates={{
          secondary: { label: 'Prev', onClick: goPrev, disabled: stepIdx === 0 },
          primary: {
            label: 'Next',
            ink: 'white',
            onClick: goNext,
            disabled: stepIdx === scenario.steps.length - 1,
          },
        }}
      >
        <p className="sc-copy sim-page__subtitle sc-ink--muted">
          Deterministic Scenario Playback. No Live Engine. Each Step Is A Scripted State Snapshot Of
          What The UI SHOULD Render At That Moment.
        </p>

        <div className="sim-page__controls">
          <label className="sim-page__label sc-label sc-ink--blue" htmlFor="sim-scenario">
            Scenario
          </label>
          <select
            id="sim-scenario"
            className="sim-page__select"
            value={scenarioIdx}
            onChange={onPickScenario}
          >
            {ALL_SCENARIOS.map((s, i) => (
              <option key={s.id} value={i}>
                {titleCase(s.name)}
              </option>
            ))}
          </select>
        </div>

        {scenario.bug ? (
          <div className="sim-page__bug-badge sc-ink--red">
            Regression: {titleCase(scenario.bug)}
          </div>
        ) : null}
        <p className="sc-copy sim-page__description">{titleCase(scenario.description)}</p>

        <div className="sim-page__step-controls">
          <span className="sim-page__step-counter sc-ink--silver">
            Step {stepIdx + 1} / {scenario.steps.length}
          </span>
          <button className="sim-page__word sc-ink--white" onClick={goReset} type="button">
            Reset
          </button>
        </div>
      </SpadeConsole>

      {/* ─────────────────────────────────────────────────────────
          The felt — oval table with 6 seat positions, center pot,
          community cards.
          ───────────────────────────────────────────────────────── */}
      <div className="sim-page__felt-wrapper">
        <div className="sim-page__felt">
          {/* Pot display above community cards */}
          <div className="sim-page__pot">
            <PotDisplay mainPot={state.pot} bigBlind={2} />
          </div>

          {/* Community cards */}
          <div className="sim-page__community">
            <CommunityCards
              cards={state.communityCards}
              stage={state.boardStage}
              /* The squeeze needs an identity and a hand that does not change
                 as the player steps, so turn -> river reads as one hand
                 dealing its next street - exactly the real sequence. */
              tableId={squeezeSim ? 'sim-squeeze' : undefined}
              handId={squeezeSim ? scenarioIdx + 1 : undefined}
              slowReveal={squeezeSim}
              squeezeEligible={squeezeSim}
            />
          </div>

          {/* Winner hand-strength label — visible only at showdown / hand complete */}
          {state.winningHandName ? (
            <div className="sim-page__winner-label sc-ink--gold">{state.winningHandName}</div>
          ) : null}

          {/* Seats — rotated so hero always appears at bottom */}
          {rotatedSeats.map((dataIdx, visualSlot) => {
            const pos = SEAT_POSITIONS_6MAX[visualSlot];
            if (!pos) return null;
            const player = state.players[dataIdx] ?? null;
            const position = state.positions[dataIdx] ?? null;
            const lastAction = state.lastActions[dataIdx] ?? null;
            const lastBetAmount = state.lastBetAmounts[dataIdx] ?? 0;
            const isActive = state.currentPlayerSeat === dataIdx + 1;
            const isWinner = player ? state.winnerIds.includes(player.id) : false;

            return (
              <div
                key={`seat-${visualSlot}`}
                className="sim-page__seat"
                style={{
                  left: `${pos.x}%`,
                  top: `${pos.y}%`,
                }}
              >
                <SeatSlot
                  seatNumber={dataIdx + 1}
                  player={
                    heroCardCountOverride && player?.isHero && player.holeCards?.length
                      ? {
                          ...player,
                          holeCards: Array.from({ length: heroCardCountOverride }, (_, i) =>
                            i < player.holeCards!.length
                              ? player.holeCards![i]
                              : (['2c', '9d', 'Th', 'Ks'] as const).map((c) => ({
                                  rank: c[0] as never,
                                  suit: c[1] as never,
                                }))[(i - player.holeCards!.length) % 4]
                          ),
                        }
                      : player
                  }
                  position={position}
                  isActive={isActive}
                  lastAction={lastAction}
                  lastBetAmount={lastBetAmount}
                  bigBlind={2}
                  isWinner={isWinner}
                  winningHandName={isWinner ? state.winningHandName : undefined}
                  showAvatar={true}
                  showBadges={true}
                  cardSqueezeActive={
                    cardSlide && !!player?.isHero && state.boardStage !== 'showdown'
                  }
                  handNumber={1}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────
          Step log — all steps in this scenario, current highlighted.
          ───────────────────────────────────────────────────────── */}
      <SpadeConsole
        as="section"
        className="sim-page__console sim-page__log"
        eyebrow="This Scenario"
        title="Event Log"
        pill={`${scenario.steps.length} Steps`}
        pillInk="muted"
        foot="foot"
      >
        <ol className="sim-page__log-list">
          {scenario.steps.map((s, i) => (
            <li
              key={i}
              className={
                i === stepIdx
                  ? 'sim-page__log-item sim-page__log-item--current'
                  : 'sim-page__log-item'
              }
              onClick={() => setStepIdx(i)}
            >
              <div className="sim-page__log-row">
                <span className="sim-page__log-event sc-ink--blue">{titleCase(s.event)}</span>
                <span
                  className={`sim-page__log-label ${i === stepIdx ? 'sc-ink--white' : 'sc-ink--silver'}`}
                >
                  {titleCase(s.label)}
                </span>
              </div>
              {s.expect && i === stepIdx ? (
                <div className="sc-copy sim-page__log-expect">
                  <strong className="sim-page__expect-word sc-ink--gold">Expect:</strong>{' '}
                  {titleCase(s.expect)}
                </div>
              ) : null}
            </li>
          ))}
        </ol>

        {/* Raw-state inspector so we can eyeball what the UI is being fed */}
        <details className="sim-page__inspector">
          <summary className="sim-page__inspector-summary sc-ink--blue">Raw State (Debug)</summary>
          <pre className="sim-page__inspector-pre">{JSON.stringify(state, null, 2)}</pre>
        </details>
      </SpadeConsole>
    </div>
  );
};

export default SimPage;
