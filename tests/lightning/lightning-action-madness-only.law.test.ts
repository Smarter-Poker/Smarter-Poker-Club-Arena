import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
import {
  lightningEntryDecision,
  parseLightningClusterMeta,
} from '../../src/lightning/lightningSession';
import { cashEntry } from '../../src/components/lobby/lobbyEntries';

const id = '22222222-2222-4222-8222-222222222222';
const game = (template: unknown) => ({
  id,
  club_id: null,
  name: 'Private Game',
  variant: 'nlh',
  sb: 1,
  bb: 2,
  handedness: 6,
  cluster_mode: 'lightning',
  enabled: true,
  template_name: template,
});
const row = (template: unknown) => ({
  id,
  name: 'Private Game',
  game_variant: 'NLH',
  status: 'active',
  small_blind: 1,
  big_blind: 2,
  max_players: 6,
  current_players: 3,
  cluster_id: id,
  cluster_mode: 'lightning',
  cluster_template: template,
  cluster_players: 18,
  cluster_tables: 3,
  cluster_must_move: true,
});

describe('Lightning is only available for Action and Madness', () => {
  for (const template of ['classic', null, undefined, 'unknown']) {
    it(`keeps ${String(template)} on the normal game entry and lobby door`, () => {
      expect(lightningEntryDecision(null, parseLightningClusterMeta(game(template)))).toEqual({
        kind: 'entry',
        joinLabel: 'Join Game',
        lightning: false,
      });
      const entry = cashEntry(row(template) as Parameters<typeof cashEntry>[0]);
      expect(entry.game?.lightning).toBeUndefined();
      expect(entry.rules.some((rule) => rule.key === 'lightning_live')).toBe(false);
    });
  }
  for (const template of ['action', 'madness']) {
    it(`allows ${template} to offer Lightning when its mode is live`, () => {
      expect(lightningEntryDecision(null, parseLightningClusterMeta(game(template)))).toEqual({
        kind: 'entry',
        joinLabel: 'Join Lightning',
        lightning: true,
      });
      expect(
        cashEntry(row(template) as Parameters<typeof cashEntry>[0]).game?.lightning
      ).toBeDefined();
    });
  }
});
