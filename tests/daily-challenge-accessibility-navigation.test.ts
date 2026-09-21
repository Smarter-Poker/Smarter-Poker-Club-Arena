import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDailyChallengesUnit } from './helpers/dailyChallengesSources';
import { CHALLENGE_TYPES, type ChallengeType } from '../src/services/DailyChallengeService';
import { getChallengeMissionAction } from '../src/utils/challengeMissionAction';

const PAGE = readFileSync(resolve(__dirname, '../src/pages/DailyChallengesPage.tsx'), 'utf8');
const CSS = readFileSync(resolve(__dirname, '../src/pages/DailyChallengesPage.module.css'), 'utf8');
const APP_LAYOUT = readFileSync(
  resolve(__dirname, '../src/components/layouts/AppLayout.tsx'),
  'utf8'
);

describe('Daily Missions directed actions', () => {
  it('maps every declared challenge type without a silent default destination', () => {
    expect(CHALLENGE_TYPES.map((type) => getChallengeMissionAction(type))).toHaveLength(
      CHALLENGE_TYPES.length
    );
  });

  it('routes social and tournament contracts to the surfaces that advance them', () => {
    expect(getChallengeMissionAction('friends_added')).toEqual({
      label: 'Find Friends',
      path: '/friends',
    });
    expect(getChallengeMissionAction('tournaments_played')).toEqual({
      label: 'Open Tournaments',
      path: '/tournaments',
    });
  });

  it('routes every poker-hand contract to the canonical cash-game lobby', () => {
    const cashGameTypes: ChallengeType[] = [
      'hands_played',
      'hands_won',
      'showdowns',
      'showdowns_won',
      'hands_won_no_showdown',
      'big_pots',
      'strong_hands',
      'chips_won',
    ];

    for (const type of cashGameTypes) {
      expect(getChallengeMissionAction(type)).toEqual({ label: 'Find A Table', path: '/' });
    }
  });
});

describe('Daily Missions accessibility contract', () => {
  it('sets the browser title from the active direct-route cycle', () => {
    expect(PAGE).toContain(
      'document.title = `${TIER_PRESENTATION[activeTier].title} | Smarter Poker`'
    );
    expect(PAGE).toContain("title: 'Daily Challenges'");
    expect(PAGE).toContain("title: 'Weekly Challenges'");
    expect(PAGE).toContain("title: 'Monthly Challenges'");
  });

  it('keeps shell route focus from stealing the challenge tabs roving focus', () => {
    expect(APP_LAYOUT).toContain(
      'const focusRouteKey = /^\\/challenges\\/(?:daily|weekly|monthly)$/.test(normalizedPath)'
    );
    expect(APP_LAYOUT).toContain("? '/challenges'");
    expect(APP_LAYOUT).toContain('}, [focusRouteKey]);');
  });

  it('uses the shell main landmark instead of nesting a second main', () => {
    expect(PAGE).not.toMatch(/<main\b/);
  });

  it('makes the reward payoff a labelled, trapped, untimed dialog', () => {
    expect(PAGE).toContain("useFocusTrap(!!reward, '#challenge-reward-title')");
    expect(PAGE).toContain("useFocusTrap(confirmingFreeze, '#freeze-purchase-title')");
    expect(PAGE).toMatch(/id="challenge-reward-title"[\s\S]{0,120}tabIndex=\{-1\}/);
    expect(PAGE).toMatch(/id="freeze-purchase-title"[\s\S]{0,120}tabIndex=\{-1\}/);
    expect(PAGE).toContain('aria-modal="true"');
    expect(PAGE).toContain('aria-labelledby="challenge-reward-title"');
    expect(PAGE).toContain('aria-describedby="challenge-reward-description"');
    expect(PAGE).toContain('inert={reward || confirmingFreeze ? true : undefined}');
    expect(PAGE).toContain('useInertAppShell(!!reward || confirmingFreeze)');
    expect(PAGE).toContain("if (e.key === 'Escape') dismissReward()");
    expect(PAGE).not.toMatch(/setTimeout\([^)]*setReward\(null\)[\s\S]{0,80}5000/);
  });

  it('requires confirmation before a 5,000 Diamond streak-freeze purchase', () => {
    expect(PAGE).toContain('Secure A Streak Freeze?');
    expect(PAGE).toContain('Balance After Purchase');
    expect(PAGE).toContain('aria-labelledby="freeze-purchase-title"');
    expect(PAGE).toContain('if (!economyGuardRef.current) setConfirmingFreeze(true)');
    expect(PAGE).toContain('onClick={handleBuyFreeze}');
    const freezeDialog = PAGE.slice(
      PAGE.indexOf('id="freeze-purchase-title"'),
      PAGE.indexOf('{reward &&')
    );
    expect(freezeDialog).not.toContain('autoFocus');
  });

  it('returns focus to a stable mission target after reward dismissal', () => {
    expect(PAGE).toContain('returnFocusId: `mission-card-${challenge.id}`');
    expect(PAGE).toContain("returnFocusId: 'mission-board-title'");
    expect(PAGE).toContain(
      'const origin = returnFocusId ? document.getElementById(returnFocusId) : null'
    );
    expect(PAGE).toContain("document.getElementById('mission-board-title') ??");
    expect(PAGE).toContain('document.getElementById(`mission-tab-${activeTier}`)');
    expect(PAGE).toContain('(origin ?? fallback)?.focus()');
  });

  it('recovers focus when stale claim receipts remove the activated control', () => {
    expect(PAGE).toContain(
      'requestAnimationFrame(() => document.getElementById(targetId)?.focus())'
    );
    expect(PAGE).toContain('focusAfterMissionUpdate(`mission-card-${challenge.id}`)');
    expect(PAGE.match(/focusAfterMissionUpdate\('mission-board-title'\)/g)).toHaveLength(2);
  });

  it('restores purchase and reroll focus only after their controls unlock', () => {
    expect(PAGE).toContain('rerollFocusRestorePendingRef.current');
    expect(PAGE).toContain('!rerollConfirmationOpen &&');
    expect(PAGE).toContain('!economyBusy');
    expect(PAGE).toContain('freezeFocusRestorePendingRef.current = true');
    expect(PAGE).toContain("document.getElementById('streak-console-title')?.focus()");
    expect(PAGE).toContain('buyButton && !buyButton.disabled');
  });

  it('does not let a closing card steal focus from a newly opened reroll confirmation', () => {
    expect(PAGE).toContain('rerollConfirmationOpen={confirmingRerollId !== null}');
    expect(PAGE).toContain('rerollFocusRestorePendingRef.current = !rerollConfirmationOpen');
    expect(PAGE).toMatch(
      /disabled=\{\s*rerolling \|\| economyBusy \|\| rerollConfirmationOpen \|\| !canAffordReroll\s*\}/
    );
  });

  it('exposes progress, tabs, sync state, and reroll confirmation semantically', () => {
    expect(PAGE.match(/role="progressbar"/g)).toHaveLength(2);
    expect(PAGE).toContain('aria-valuetext=');
    expect(PAGE).toContain('role="tablist"');
    expect(PAGE).toContain('role="tabpanel"');
    expect(PAGE).toContain('aria-controls="mission-panel"');
    expect(PAGE).toContain('id="mission-panel"');
    expect(PAGE).not.toContain('aria-controls={`mission-panel-${tier}`}');
    expect(readDailyChallengesUnit('MissionHero.tsx')).toContain(
      'role="status" aria-live="polite"'
    );
    expect(PAGE).toContain("if (event.key === 'Escape') onCancelReroll()");
  });

  it('honors reduced motion in JavaScript-driven animation and confetti', () => {
    expect(PAGE).toContain('useReducedMotion()');
    expect(PAGE).toContain('initial={reduceMotion ? false');
    expect(PAGE).toContain('{!reduceMotion && (');
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('keeps controls touch-sized and protects narrow and forced-color layouts', () => {
    expect(CSS).toContain('min-height: 44px;');
    expect(CSS).toContain('@media (max-width: 420px)');
    expect(CSS).toContain('grid-template-columns: minmax(0, 1fr);');
    expect(CSS).toMatch(/\.cardActions > \*,[\s\S]*\.missionActionButton,[\s\S]*\.rerollButton/);
    expect(CSS).toContain('@media (forced-colors: active)');
    expect(CSS).not.toContain('#68747e');
    expect(CSS).not.toContain('#66737d');
    expect(CSS).not.toContain('#69757e');
  });

  it('keeps both dialogs reachable on short screens and exposes every custom focus ring', () => {
    expect(CSS).toContain('max-height: calc(100dvh - 48px);');
    expect(CSS).toContain('overflow-y: auto;');
    expect(CSS).toContain('@media (max-height: 640px)');
    expect(CSS).toContain('.alertButton:focus-visible');
    expect(CSS).toContain('.alertSecondaryButton:focus-visible');
    expect(CSS).toContain('.streakCount:focus-visible');
    expect(CSS).toContain('.boardHeader h2:focus-visible');
    expect(CSS).toContain('outline-offset: -4px');
  });
});
