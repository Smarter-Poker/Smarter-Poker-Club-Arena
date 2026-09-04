/**
 * CASH GAMES - the client's vocabulary for the New Cash Game flow (Operation
 * Table Stakes, Slice 1; OPORD 1.3 sections 7-8, OPORD 1.4 section 2.6).
 *
 * The DATABASE owns the defaults (`fn_cash_template_defaults`) and the
 * validation (`fn_cash_game_create`). This file holds only what a picker has
 * to know before it asks: the three templates, the variants the engine deals
 * today (pinned against the engine's own KNOWN_VARIANTS by
 * tests/unit/cashGamesVocabulary.test.ts), and the shape of a resolved
 * snapshot so the overrides panel is typed.
 */

export type CashTemplate = 'classic' | 'action' | 'madness';

export const CASH_TEMPLATES: ReadonlyArray<{ id: CashTemplate; label: string; blurb: string }> = [
  {
    id: 'classic',
    label: 'Classic',
    blurb: 'Standard Ring Game. No Antes, No Bombs, No VPIP Floor.',
  },
  {
    id: 'action',
    label: 'Action',
    blurb: 'Small Blind Ante, VPIP Floor, Double Board Bomb Every 15 Minutes.',
  },
  {
    id: 'madness',
    label: 'Madness',
    blurb: 'Big Blind Ante, High VPIP Floor, Double Board Bomb Every Orbit.',
  },
];

/**
 * Every variant the engine deals, in the order the picker shows them. A
 * variant that is NOT here is offered disabled with "This Variant Is Not
 * Available Yet" and the database refuses it too (ROE 16) - nothing is ever
 * silently saved as NLHE.
 */
export const CASH_VARIANTS: ReadonlyArray<{
  id: string;
  label: string;
  family: 'holdem' | 'plo' | 'shortdeck' | 'pineapple';
}> = [
  { id: 'nlh', label: 'NLH', family: 'holdem' },
  { id: 'plo4', label: 'PLO4', family: 'plo' },
  { id: 'plo5', label: 'PLO5', family: 'plo' },
  { id: 'plo6', label: 'PLO6', family: 'plo' },
  { id: 'plo8', label: 'PLO8', family: 'plo' },
  { id: 'flo8', label: 'FLO8', family: 'plo' },
  { id: 'flh', label: 'FLH', family: 'holdem' },
  { id: 'short_deck', label: 'Short Deck', family: 'shortdeck' },
  { id: 'pineapple', label: 'Pineapple', family: 'pineapple' },
];

export const CASH_VARIANT_IDS: readonly string[] = CASH_VARIANTS.map((v) => v.id);

export function isDealtVariant(id: string | null | undefined): boolean {
  return !!id && CASH_VARIANT_IDS.includes(id);
}

/** What fn_cash_template_defaults returns and fn_cash_game_create resolves. */
export interface CashRulesetSnapshot {
  template: CashTemplate;
  variant: string;
  family: 'holdem' | 'plo' | 'shortdeck' | 'pineapple';
  seats: number;
  seats_locked: boolean;
  seat_choices: number[];
  min_buyin_bb: number;
  max_buyin_bb: number;
  regular_ante: 'none' | 'sb' | 'bb';
  vpip_floor: number;
  vpip_window: number;
  bombs: {
    enabled: boolean;
    trigger: 'timed_15m' | 'every_orbit' | null;
    ante_bb: number | null;
    boards: number | null;
  };
  straddle: false;
  stay_clock_min: number;
  rejoin_window_min: number;
  run_it_n_times: 'opt_in';
  rake: 'existing';
}

/** The host's editable copy of the section 8 fields, sent as `p_overrides`. */
export interface CashGameOverrides {
  min_buyin_bb: number;
  max_buyin_bb: number;
  regular_ante: 'none' | 'sb' | 'bb';
  vpip_floor: number;
  vpip_window: number;
  bombs: {
    enabled: boolean;
    trigger: 'timed_15m' | 'every_orbit';
    ante_bb: number;
    boards: number;
  };
  stay_clock_min: number;
  rejoin_window_min: number;
  options: {
    is_private: boolean;
    is_vip_only: boolean;
    is_anonymous: boolean;
    ban_chat: boolean;
    insurance_enabled: boolean;
    seven_deuce_enabled: boolean;
    action_time_seconds: number;
  };
}

export function overridesFromSnapshot(s: CashRulesetSnapshot): CashGameOverrides {
  return {
    min_buyin_bb: s.min_buyin_bb,
    max_buyin_bb: s.max_buyin_bb,
    regular_ante: s.regular_ante,
    vpip_floor: s.vpip_floor,
    vpip_window: s.vpip_window,
    bombs: {
      enabled: s.bombs.enabled,
      trigger: s.bombs.trigger ?? (s.template === 'madness' ? 'every_orbit' : 'timed_15m'),
      ante_bb: s.bombs.ante_bb ?? (s.template === 'madness' ? 3 : 2),
      boards: s.bombs.boards ?? 2,
    },
    stay_clock_min: s.stay_clock_min,
    rejoin_window_min: s.rejoin_window_min,
    options: {
      is_private: false,
      is_vip_only: false,
      is_anonymous: false,
      ban_chat: false,
      insurance_enabled: false,
      seven_deuce_enabled: false,
      action_time_seconds: 15,
    },
  };
}

/** The refusals fn_cash_game_create raises, in words a host can read. */
export function cashGameCreateRefusalText(raw: unknown): string | null {
  const m = String((raw as { message?: string })?.message ?? raw ?? '');
  if (!m) return null;
  if (/VARIANT_UNAVAILABLE/.test(m)) return 'This Variant Is Not Available Yet';
  if (/GAME_EXISTS/.test(m)) {
    const which = m.match(/already runs (.+)$/);
    return which
      ? `This Club Already Runs ${which[1]}. Join That Game Instead.`
      : 'This Club Already Runs That Game. Join It Instead.';
  }
  if (/NOT_AUTHORIZED/.test(m)) return 'You Cannot Create Games In This Club';
  if (/STAY_CLOCK_BELOW_FLOOR/.test(m)) return 'The Stay Clock Can Only Be Raised Above 10 Minutes';
  if (/REJOIN_WINDOW_BELOW_FLOOR/.test(m))
    return 'The Rejoin Window Can Only Be Raised Above 120 Minutes';
  if (/HANDEDNESS_INVALID/.test(m)) return 'That Table Size Is Not Offered For This Game';
  if (/BUYIN_BAND_INVALID/.test(m)) return 'The Buy In Range Is Not Valid';
  if (/BOMB_/.test(m)) return 'The Bomb Pot Settings Are Not Valid';
  if (/STAKES_INVALID/.test(m)) return 'Those Stakes Are Not Valid';
  if (/SESSION_REVOKED/.test(m)) return 'Your Session Is Signed Out. Sign In Again.';
  return null;
}
