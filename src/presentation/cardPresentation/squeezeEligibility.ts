/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHO MAY SQUEEZE (VIP all-in squeeze, Dan 2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "THIS FEATURE SHOULD ONLY BE PRESENTED AS AN OPTION AND
 * DISPLAYED ON 'ALL INS' (BEFORE THE RIVER OBVIOUSLY) AND SHOULD NEVER APPEAR
 * ON RUN IT 2X OR 3X. AND THIS SHOULD BE A VIP GATED PERK AND 'TURNED ON' BY
 * DEFAULT. IF A NONE VIP MEMBER TRIES TO TURN IT ON THEY SHOULD BE INSTRUCTED
 * THAT THEY NEED A VIP CARD TO USE THIS FEATURE. AND ONLY TO THE USERS THAT
 * ARE 'ALL IN' THE BOARD AND RUN OUT SHOULD APPEAR 'NORMAL' AND NO DIFFERENT
 * FOR ANY OTHER USERS AT THE TABLE. IF ANY OTHER 'ALL IN PLAYERS' DON'T HAVE
 * VIP, OR HAVE IT 'TURNED OFF' IT SHOULD ONLY DISPLAY FOR THE USERS WHO HAVE
 * ACCESS TO IS, AND HAVE IT ENABLED."
 *
 * Every clause is one input below, and the answer is PER VIEWER: it is
 * computed on the client from what that client already knows about itself
 * and its own hand. Nothing is broadcast for it (a wire field naming who is
 * squeezing would tell the table who is a VIP), and nothing about the
 * server's run-out rhythm depends on it, so two all-in players - one with
 * the perk, one without - are dealt the same cards at the same instants and
 * each sees the right thing.
 *
 * "VIP card" is the membership itself: `is_vip` + `vip_tier` +
 * `vip_expires_at`, resolved only by src/utils/vipStatus.ts (docs/laws.d/
 * vip-is-not-a-ladder.md). There is no other rung to hold.
 */

export interface SqueezeEligibilityInput {
  /** The viewer is seated and their status this hand is all_in. */
  readonly heroAllIn: boolean;
  /** resolveVipStatus() !== 'none' for the viewer. */
  readonly isVip: boolean;
  /** user_table_settings.all_in_squeeze, default true. */
  readonly settingOn: boolean;
  /** The hand is being run more than once (Run It Twice / three times). */
  readonly runItMultiple: boolean;
}

/** True when THIS viewer may squeeze the run-out cards of THIS hand. */
export function viewerMaySqueeze(i: SqueezeEligibilityInput): boolean {
  return i.heroAllIn && i.isVip && i.settingOn && !i.runItMultiple;
}

/**
 * The board-level half of the same rule: a board that is one of several runs
 * never squeezes, whatever the viewer's standing. Kept separate from the
 * page-level check on purpose - the RIT boards are rendered by a different
 * branch of the felt that does not carry the page's eligibility at all, and a
 * rule that lives in one place is only enforced in one place.
 */
export function boardMaySqueeze(eligible: boolean | undefined, runs: number | undefined): boolean {
  return eligible === true && (runs ?? 1) === 1;
}

/**
 * The upsell a non-VIP sees when they try to switch the perk on. Title Case
 * Every Word and no em dashes (CLAUDE.md 5.7); the Toast layer applies the
 * house transform again, which is a no-op on text already in it.
 */
export const ALL_IN_SQUEEZE_VIP_REQUIRED_MESSAGE =
  'You Need A VIP Card To Use The All In Squeeze. Visit The VIP Page To Get One.';
