import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { blankNonCode, sliceDollarQuoted } from '../helpers/sourceWindow';

/**
 * PHASE 8 - CLUB CONTROL
 *
 * The last phase of Dan's Club Operations upgrade. Four surfaces: settings,
 * rules, the promo vault and the offer feed. Two of them were telling an
 * operator that something had happened when nothing had.
 *
 * THE VAULT SENT NOTHING. `ca_promo_vault_grant` decremented the shelf, wrote
 * a record and returned success, and the recipient received nothing at all -
 * no entitlement, no trigger, no follow-up job. Its own migration said so:
 * "Deliberately does NOT try to activate the benefit on the recipient's
 * account ... wiring each item type to its subsystem is follow-up work."
 *
 * THE CLAIM BUTTON PAID NOTHING, while emitting BALANCE_UPDATED and toasting
 * "Promotion claimed!", and the row it wrote carried a bonus figure the
 * BROWSER had computed under a policy that only checks who is claiming.
 *
 * THE RULES SAVE reported success when RLS refused it, and rewrote the whole
 * `settings` document to change one key inside it.
 *
 * THE SETTINGS PAGE wrote four columns it does not offer a control for, one of
 * which the lobby reads.
 */

const M = (f: string) => readFileSync(`supabase/migrations/${f}`, 'utf8');
const VAULT = M('20260905083005_a_granted_item_reaches_the_player_or_is_not_spent.sql');
const RULES = M('20260905083442_the_rules_save_writes_one_key_and_says_who_may_write_it.sql');
const CLAIM = M('20260905084034_a_claim_records_what_the_promotion_says_not_what_the_client_.sql');

const SETTINGS_PAGE = readFileSync('src/pages/ClubSettingsPage.tsx', 'utf8');
const RULES_PAGE = readFileSync('src/pages/ClubRulesPage.tsx', 'utf8');
const VAULT_PAGE = readFileSync('src/pages/PromoVaultPage.tsx', 'utf8');
const PROMO_SERVICE = readFileSync('src/services/PromotionService.ts', 'utf8');
const PROMO_PAGE = readFileSync('src/pages/PromotionsPage.tsx', 'utf8');
const PROMO_DETAIL = readFileSync('src/components/promotions/PromotionDetail.tsx', 'utf8');

const fnIn = (sql: string, name: string) => {
  const start = sql.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return sliceDollarQuoted(sql.slice(start), '$function$');
};

describe('a granted vault item reaches the player, or is not spent', () => {
  it('writes the entitlement in the same transaction as the decrement', () => {
    const body = blankNonCode(fnIn(VAULT, 'ca_promo_vault_grant'));
    expect(body).toContain('INSERT INTO public.feature_purchases');
    expect(body).toContain('UPDATE public.promo_vault_inventory');
  });

  it('asks whether an item can be delivered BEFORE it touches the stock', () => {
    // Position, not presence. A check that runs after the decrement is not a
    // check: the shelf would already be down when it refused.
    const body = blankNonCode(fnIn(VAULT, 'ca_promo_vault_grant'));
    expect(body.indexOf('fn_promo_vault_delivery_for')).toBeGreaterThan(-1);
    expect(body.indexOf('fn_promo_vault_delivery_for')).toBeLessThan(
      body.indexOf('UPDATE public.promo_vault_inventory')
    );
    expect(VAULT).toContain('the deliverability check runs after the stock is decremented');
  });

  it('refuses the three items nothing on the platform could receive', () => {
    // VIP cards, the mystery card and the multiplier. Their subsystems do not
    // exist - `mystery_card` appears only in the catalogue seed, and the
    // catalogue's bronze/sapphire/gold tiers map to a vocabulary the platform
    // does not have. Refusing is the honest half of this migration.
    // RAW, not blankNonCode: every check here is ON a string literal, and
    // blanking literals is exactly what would erase the thing under test.
    const raw = fnIn(VAULT, 'fn_promo_vault_delivery_for');
    expect(raw).toContain("v_cat.category = 'vip_card'");
    expect(raw).toContain('Cannot Be Sent Yet');
    for (const key of ['vip_card_gold_30d', 'mystery_card_30d', 'multiplier_1500_30d']) {
      expect(VAULT, `${key} is asserted undeliverable`).toContain(key);
    }
  });

  it('is retryable, and the old five-argument form still answers the live bundle', () => {
    expect(VAULT).toContain('p_op_id uuid DEFAULT NULL');
    expect(VAULT).toContain('promo_vault_records_op_key');
    expect(VAULT).toContain("'replayed', true");
    // Dropping the wrapper would break the Send button between this migration
    // and the next publish.
    expect(VAULT).toContain('expected the grant and its compatibility wrapper');
    expect(VAULT_PAGE).toContain('p_op_id: opId');
  });
});

describe('the rules save writes one key and says who may write it', () => {
  it('sets one key rather than rewriting the whole settings document', () => {
    const raw = fnIn(RULES, 'fn_set_club_rules');
    expect(blankNonCode(raw)).toContain('jsonb_set(');
    // The path itself is a literal, so this half reads the raw body.
    expect(raw).toContain("'{rules_text}'");
  });

  it('returns what it stored, so a refusal cannot read as a success', () => {
    const raw = fnIn(RULES, 'fn_set_club_rules');
    expect(blankNonCode(raw)).toContain('RETURN QUERY');
    expect(raw).toContain("ERRCODE = '42501'");
    // And the page believes the row, not the button it just pressed.
    expect(RULES_PAGE).toContain("supabase\n        .rpc('fn_set_club_rules'");
    expect(RULES_PAGE).toContain('Those Rules Were Not Saved');
    expect(RULES_PAGE).not.toContain('.update({ settings: newSettings })');
  });

  it('lets the audit trigger see a rules rewrite at last', () => {
    expect(RULES).toContain("'settings','tagline','lobby_message'");
    expect(RULES).toContain('the audit trigger still cannot see a rules rewrite');
  });
});

describe('a claim records what the promotion says', () => {
  it('overwrites the three columns the browser used to choose', () => {
    const body = blankNonCode(fnIn(CLAIM, 'fn_promotion_claim_takes_the_promotions_word'));
    for (const col of ['NEW.bonus_amount', 'NEW.wager_required', 'NEW.status']) {
      expect(body, `${col} is decided by the server`).toContain(col);
    }
    expect(CLAIM).toContain('zz_promotion_claim_server_decides');
  });

  it('stops the client sending a figure into a money column', () => {
    // The insert now carries the promotion id, the user and nothing else that
    // costs anything.
    expect(PROMO_SERVICE).not.toContain('bonus_amount: promo.prizePool');
    expect(PROMO_SERVICE).not.toContain("status: promo.wagerRequirement ? 'active' : 'completed'");
  });

  it('stops both Claim buttons announcing a balance that did not move', () => {
    for (const [name, src] of [
      ['PromotionsPage', PROMO_PAGE],
      ['PromotionDetail', PROMO_DETAIL],
    ] as const) {
      expect(src, `${name} no longer emits BALANCE_UPDATED on a claim`).not.toContain(
        "'BALANCE_UPDATED', { source: 'promotion_claim'"
      );
      expect(src, `${name} says what actually happened`).toContain('Your Reward Is Recorded');
    }
  });
});

describe('the settings page writes only what it offers', () => {
  it('no longer writes the four columns it has no control for', () => {
    // `spins_enabled` is the live one: the lobby READS it, SpinActivationPanel
    // owns it, and this page blind-wrote whatever it had loaded on every save.
    // THE SAVE PAYLOAD ONLY. `spins_enabled` is still LOADED - the page reads
    // the column to know the club's state - and SpinActivationPanel owns the
    // control. What was wrong was writing it back from here on every save.
    const saveStart = SETTINGS_PAGE.indexOf('lobby_message_updated_at:');
    const saveEnd = SETTINGS_PAGE.indexOf(".select('id')", saveStart);
    expect(saveStart, 'the save payload is findable').toBeGreaterThan(-1);
    expect(saveEnd, 'the save payload ends at its .select()').toBeGreaterThan(saveStart);
    const payload = SETTINGS_PAGE.slice(saveStart, saveEnd);
    for (const col of [
      'bbj_rake_enabled:',
      'spins_enabled:',
      'spins_preseed_amount:',
      'spins_wallet_funding:',
    ]) {
      expect(payload, `${col} is not in the save payload`).not.toContain(col);
    }
  });

  it('removed the BBJ switch rather than wiring a rake policy on its own authority', () => {
    expect(SETTINGS_PAGE).not.toContain('aria-label="BBJ Rake"');
    expect(SETTINGS_PAGE).toContain('reserves that to Dan');
  });

  it('reads the union flag it had been carrying and never setting', () => {
    // `setInUnion` had no caller, so the Rake & BBJ section it guards was shown
    // to clubs whose rake their union governs.
    expect(SETTINGS_PAGE).toContain('setInUnion(Boolean(data.union_id))');
  });
});
