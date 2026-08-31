import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChallengeType } from '../src/services/DailyChallengeService';
import { getChallengeMissionAction } from '../src/utils/challengeMissionAction';

const PAGE = readFileSync(resolve(__dirname, '../src/pages/DailyChallengesPage.tsx'), 'utf8');
const CSS = readFileSync(resolve(__dirname, '../src/pages/DailyChallengesPage.module.css'), 'utf8');

describe('Daily Missions directed actions', () => {
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
  it('uses the shell main landmark instead of nesting a second main', () => {
    expect(PAGE).not.toMatch(/<main\b/);
  });

  it('makes the reward payoff a labelled, trapped, untimed dialog', () => {
    expect(PAGE).toContain('useFocusTrap(!!reward)');
    expect(PAGE).toContain('aria-modal="true"');
    expect(PAGE).toContain('aria-labelledby="challenge-reward-title"');
    expect(PAGE).toContain('aria-describedby="challenge-reward-description"');
    expect(PAGE).toContain('inert={reward ? true : undefined}');
    expect(PAGE).toContain("if (e.key === 'Escape') dismissReward()");
    expect(PAGE).not.toMatch(/setTimeout\([^)]*setReward\(null\)[\s\S]{0,80}5000/);
  });

  it('returns focus to a stable mission target after reward dismissal', () => {
    expect(PAGE).toContain('returnFocusId: `mission-card-${challenge.id}`');
    expect(PAGE).toContain("returnFocusId: 'mission-board-title'");
    expect(PAGE).toContain('document.getElementById(returnFocusId)?.focus()');
  });

  it('exposes progress, tabs, sync state, and reroll confirmation semantically', () => {
    expect(PAGE.match(/role="progressbar"/g)).toHaveLength(2);
    expect(PAGE).toContain('aria-valuetext=');
    expect(PAGE).toContain('role="tablist"');
    expect(PAGE).toContain('role="tabpanel"');
    expect(PAGE).toContain('role="status" aria-live="polite"');
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
    expect(CSS).toContain('@media (forced-colors: active)');
    expect(CSS).not.toContain('#68747e');
    expect(CSS).not.toContain('#66737d');
    expect(CSS).not.toContain('#69757e');
  });
});
