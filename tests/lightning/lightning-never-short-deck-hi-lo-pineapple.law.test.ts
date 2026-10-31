import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
import {
  lightningEntryDecision,
  parseLightningClusterMeta,
} from '../../src/lightning/lightningSession';
import {
  isLightningEligible,
  isLightningVariant,
  LIGHTNING_EXCLUDED_VARIANTS,
} from '../../src/lightning/lightningLobby';
import { cashTemplateVariantAvailable } from '../../src/config/cashGames';
import { cashEntry } from '../../src/components/lobby/lobbyEntries';

// Dan, 2026-10-25 16:55 Central, verbatim:
//   "SHORT DESK AND OMAHA HI LOW SHOULD NOT BE RUNNING LIGHTNING AT THIS POINT,
//    JUST FEEDER GAMES."
//   "AND PINNEAPPLE AS WELL, SHOULD ONLY BE FEEDER GAME, NOT LIGHTNING"
// Short Deck, Omaha Hi-Lo (PLO8, FLO8) and Pineapple run only as ordinary
// feeder games. Every Lightning door refuses them by name.

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const MIGRATION =
  'supabase/migrations/20261026015255_lightning_never_runs_short_deck_omaha_hi_lo_or_pineapple.sql';
const EXCLUDED = ['short_deck', 'flo8', 'plo8', 'pineapple'];
const ALLOWED = ['nlh', 'flh', 'plo4', 'plo5', 'plo6'];
const id = '33333333-3333-4333-8333-333333333333';

const game = (variant: string) => ({
  id,
  club_id: null,
  name: 'Private Game',
  variant,
  sb: 0.25,
  bb: 0.5,
  handedness: 6,
  cluster_mode: 'lightning',
  enabled: true,
  template_name: 'madness',
});
const row = (variant: string) => ({
  id,
  name: 'Private Game',
  game_variant: variant,
  status: 'active',
  small_blind: 0.25,
  big_blind: 0.5,
  max_players: 6,
  current_players: 3,
  cluster_id: id,
  cluster_mode: 'lightning',
  cluster_template: 'madness',
  cluster_handedness: 6,
  cluster_players: 18,
  cluster_tables: 3,
  cluster_must_move: true,
});
const entry = (variant: string) => cashEntry(row(variant) as Parameters<typeof cashEntry>[0]);

describe('Short Deck, Omaha Hi-Lo and Pineapple never run Lightning (owner, 2026-10-25)', () => {
  it('names the excluded variants, in any spelling the platform uses', () => {
    for (const v of EXCLUDED) expect(LIGHTNING_EXCLUDED_VARIANTS).toContain(v);
    for (const v of [...EXCLUDED, 'SHORT_DECK', 'Short Deck', 'FLO8', 'pineapple_holdem', '', null])
      expect(isLightningVariant(v), String(v)).toBe(false);
    for (const v of [...ALLOWED, 'NLH', 'PLO5']) expect(isLightningVariant(v), v).toBe(true);
  });

  for (const v of EXCLUDED) {
    it(`keeps a six-seat Madness ${v} game on the ordinary Join Game door and lobby`, () => {
      expect(isLightningEligible('madness', 6, v)).toBe(false);
      expect(lightningEntryDecision(null, parseLightningClusterMeta(game(v)))).toEqual({
        kind: 'entry',
        joinLabel: 'Join Game',
        lightning: false,
      });
      const e = entry(v);
      expect(e.game?.lightning).toBeUndefined();
      expect(e.rules.some((rule) => rule.key === 'lightning_live')).toBe(false);
    });
    it(`never offers ${v} as a Lightning game on the create screen`, () => {
      expect(cashTemplateVariantAvailable('madness', v)).toBe(false);
      expect(cashTemplateVariantAvailable('action', v)).toBe(false);
      expect(cashTemplateVariantAvailable('classic', v)).toBe(true);
    });
  }

  it('still offers Lightning for every other variant', () => {
    for (const v of ALLOWED) {
      expect(isLightningEligible('madness', 6, v)).toBe(true);
      expect(cashTemplateVariantAvailable('madness', v)).toBe(true);
      expect(lightningEntryDecision(null, parseLightningClusterMeta(game(v))).joinLabel).toBe(
        'Join Lightning'
      );
      expect(entry(v).game?.lightning).toBeDefined();
    }
  });

  it('the lobby gives the Lightning mark only to a variant that may run Lightning', () => {
    const table = read('src/components/lobby/LobbyTable.tsx');
    const identity = table.match(
      /function isLightningCashRow\(entry: LobbyEntry\): boolean \{([\s\S]*?)\n\}/
    )?.[1];
    expect(identity).toContain("entry.kind === 'cash'");
    expect(identity).toContain('!entry.game?.noLightning');
    expect(identity).toContain("cashTemplateKey(entry.game?.template ?? '') === 'madness'");
    expect(table.match(/isLightningCashRow\(entry\)/g)?.length).toBe(3);
    for (const v of EXCLUDED) expect(entry(v).game?.noLightning, v).toBe(true);
    for (const v of ALLOWED) expect(entry(v).game?.noLightning, v).toBeUndefined();
  });

  it('the database refuses them by name at every Lightning door', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain(
      "('short_deck','shortdeck','flo8','plo8','omaha8','o8','pineapple','pineapple_holdem'), false)"
    );
    expect(sql).toContain('ADD CONSTRAINT cash_games_lightning_variant_allowed CHECK');
    for (const door of [
      'fn_lightning_operator_control(uuid,text,text,jsonb)',
      'fn_lightning_rollout_readiness(uuid)',
      'fn_lightning_form_hand(uuid,uuid[]',
      'fn_lightning_hand_template_guard()',
      'fn_cash_cluster_lightning_thresholds(uuid)',
      'fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)',
    ])
      expect(sql).toContain(`'public.${door}`);
    expect(sql).toContain('LIGHTNING_VARIANT_NOT_ALLOWED');
    expect(sql).toContain('lightning_variant_not_allowed');
    expect(sql).toContain('lightning_hand_variant_allowed');
    // The floor trigger reads fn_cash_template_defaults on every write, so it
    // must not raise for these variants or the existing games stop writing.
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fn_cash_template_defaults/);
    expect(sql).not.toMatch(/is_horse/);
  });

  it('the four drained games no longer call themselves Lightning Games', () => {
    const sql = read(MIGRATION);
    for (const g of [
      '0bc9bdf3-7fa6-43ed-855a-9be01b5a6073',
      '1db812e6-159c-4fc0-9a0f-fa715210f4d1',
      '59a58b1c-6881-416f-a122-4804db63b6dc',
      'a80b38df-58ab-4192-b960-ddadc4ecd382',
    ])
      expect(sql).toContain(`'${g}'`);
    expect(sql).toContain("CASE g.template_name WHEN 'action' THEN 'Action' ELSE 'Madness' END");
    expect(sql).toContain("name NOT LIKE '%Lightning%'");
  });
});
