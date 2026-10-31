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
  isLightningTableSize,
  LIGHTNING_TABLE_SIZE,
} from '../../src/lightning/lightningLobby';
import { cashEntry } from '../../src/components/lobby/lobbyEntries';

// Dan, 2026-10-19 19:44 Central, verbatim: "classic games never get lightning
// games, only action and madness, make all lightning games 6 handed."
// The first half is lightning-action-madness-only.law.test.ts. This is the
// second: Lightning exists only on a six-seat Action or Madness game.

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const id = '22222222-2222-4222-8222-222222222222';
const game = (template: string, handedness: unknown) => ({
  id,
  club_id: null,
  name: 'Private Game',
  variant: 'nlh',
  sb: 1,
  bb: 2,
  handedness,
  cluster_mode: 'lightning',
  enabled: true,
  template_name: template,
});
const row = (template: string, maxPlayers: number, clusterHandedness?: number | null) => ({
  id,
  name: 'Private Game',
  game_variant: 'NLH',
  status: 'active',
  small_blind: 1,
  big_blind: 2,
  max_players: maxPlayers,
  current_players: 3,
  cluster_id: id,
  cluster_mode: 'lightning',
  cluster_template: template,
  ...(clusterHandedness !== undefined ? { cluster_handedness: clusterHandedness } : {}),
  cluster_players: 18,
  cluster_tables: 3,
  cluster_must_move: true,
});
const entry = (r: ReturnType<typeof row>) => cashEntry(r as Parameters<typeof cashEntry>[0]);

describe('Lightning is only available on six-seat games (owner, 2026-10-19)', () => {
  it('names exactly six, and nothing else is eligible', () => {
    expect(LIGHTNING_TABLE_SIZE).toBe(6);
    expect(isLightningTableSize(6)).toBe(true);
    for (const size of [2, 5, 7, 8, 9, 10, null, undefined, '6', 6.5])
      expect(isLightningTableSize(size), String(size)).toBe(false);
    expect(isLightningEligible('action', 6)).toBe(true);
    expect(isLightningEligible('madness', 6)).toBe(true);
    expect(isLightningEligible('classic', 6)).toBe(false);
    expect(isLightningEligible('madness', 9)).toBe(false);
  });

  for (const template of ['action', 'madness']) {
    for (const size of [9, 8, 2, null, undefined]) {
      it(`keeps ${template} at ${String(size)} seats on the normal game entry and lobby door`, () => {
        expect(
          lightningEntryDecision(null, parseLightningClusterMeta(game(template, size)))
        ).toEqual({ kind: 'entry', joinLabel: 'Join Game', lightning: false });
      });
    }
    it(`offers ${template} Lightning at six seats when its mode is live`, () => {
      expect(lightningEntryDecision(null, parseLightningClusterMeta(game(template, 6)))).toEqual({
        kind: 'entry',
        joinLabel: 'Join Lightning',
        lightning: true,
      });
      expect(entry(row(template, 6)).game?.lightning).toBeDefined();
      expect(entry(row(template, 6, 6)).game?.lightning).toBeDefined();
    });
    it(`never offers ${template} Lightning in the lobby at any other size`, () => {
      for (const r of [row(template, 9), row(template, 6, 9), row(template, 8, 8)]) {
        const e = entry(r);
        expect(e.game?.lightning).toBeUndefined();
        expect(e.rules.some((rule) => rule.key === 'lightning_live')).toBe(false);
      }
    });
  }

  it('the engine forms only for six seats and reads the size beside the template', () => {
    const sup = read('server/src/lightning/LightningSupervisor.ts');
    expect(sup).toContain("'id, cluster_mode, lightning_enabled, template_name, handedness'");
    expect(sup).toContain('!isLightningTableSize(r.handedness)');
    expect(sup).toMatch(/return handedness === LIGHTNING_TABLE_SIZE;/);
    expect(sup).toMatch(/export const LIGHTNING_TABLE_SIZE = 6;/);
  });

  it('the database refuses every other size by name at every Lightning door', () => {
    const sql = read(
      'supabase/migrations/20261020005222_lightning_only_on_six_seat_action_and_madness.sql'
    );
    expect(sql).toContain('SELECT coalesce(p_handedness = 6, false)');
    expect(sql).toContain('ADD CONSTRAINT cash_games_lightning_six_seat_only CHECK');
    for (const door of [
      'fn_lightning_operator_control(uuid,text,text,jsonb)',
      'fn_lightning_rollout_readiness(uuid)',
      'fn_lightning_form_hand(uuid,uuid[]',
      'fn_lightning_hand_template_guard()',
      'fn_cash_cluster_lightning_thresholds(uuid)',
    ])
      expect(sql).toContain(`'public.${door}`);
    expect(sql).toContain('LIGHTNING_TABLE_SIZE_NOT_ALLOWED');
    expect(sql).toContain('lightning_table_size_not_allowed');
    expect(sql).toContain('lightning_hand_table_size_allowed');
    expect(sql).not.toMatch(/is_horse/);
    expect(read('scripts/dev/test-lightning-template-boundary.sh')).toContain(
      'scripts/dev/test-lightning-six-seat-boundary.sh'
    );
  });
});

// The Lightning Internal Pilot and its tooling were removed on 2026-10-31
// (owner instruction); Lightning runs live in Midway Union.
