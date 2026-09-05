/**
 * THE VPIP FLOOR IS PLAYED TO (Dan 2026-09-04).
 *
 * "IF ANYONE FALLS UNDER THE SET THRESHOLD FOR THE GAME AFTER 10 HANDS, OR
 * ANYTIME AFTER THE 10 HANDS, THEY GET BOOTED." Horses included (10.5) - and
 * a horse that is booted every ten hands is not obeying the floor, it is
 * churning the game. So the brain reads the floor and its own judged figure
 * and widens toward the floor, the way a regular at that table would.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vpipFloorMul } from './HorseLogic.js';

const ROOT = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('vpipFloorMul', () => {
  it('is 1 on a table with no floor, whatever the sample says', () => {
    expect(vpipFloorMul({})).toBe(1);
    expect(vpipFloorMul({ vpipFloor: 0, ownVpip: { hands: 30, vpip: 5 } })).toBe(1);
  });

  it('arrives loose enough before there is a sample (the prior)', () => {
    // Action hold'em: floor 30 -> target 40 -> 0.28 / 0.40 = 0.7
    expect(vpipFloorMul({ vpipFloor: 30 })).toBeCloseTo(0.7, 5);
    expect(vpipFloorMul({ vpipFloor: 30, ownVpip: { hands: 2, vpip: 0 } })).toBeCloseTo(0.7, 5);
    // Madness PLO: floor 70 -> target 80 -> 0.35 floored (0.28 / 0.80 = 0.35)
    expect(vpipFloorMul({ vpipFloor: 70 })).toBeCloseTo(0.35, 5);
    // A floor so high the target caps at 95%.
    expect(vpipFloorMul({ vpipFloor: 90 })).toBeCloseTo(0.35, 5);
  });

  it('closes the loop on the judged figure: under target loosens, over target does nothing', () => {
    // Madness hold'em, floor 60 -> target 70. At 45% the gap is 25 points -> 1 - 0.375
    expect(vpipFloorMul({ vpipFloor: 60, ownVpip: { hands: 12, vpip: 45 } })).toBeCloseTo(0.625, 5);
    // At 15% the gap is 55 points -> 0.175, floored at 0.35
    expect(vpipFloorMul({ vpipFloor: 60, ownVpip: { hands: 20, vpip: 15 } })).toBeCloseTo(0.35, 5);
    // Above the target: the horse's own style resumes, never tightened.
    expect(vpipFloorMul({ vpipFloor: 60, ownVpip: { hands: 20, vpip: 72 } })).toBe(1);
    expect(vpipFloorMul({ vpipFloor: 60, ownVpip: { hands: 20, vpip: 95 } })).toBe(1);
  });

  it('never exceeds 1 and never goes below the 0.35 floor', () => {
    for (const floor of [1, 30, 40, 60, 70, 100]) {
      for (const vpip of [null, 0, 10, 50, 100]) {
        const m = vpipFloorMul({ vpipFloor: floor, ownVpip: { hands: 10, vpip } });
        expect(m).toBeGreaterThanOrEqual(0.35);
        expect(m).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('the wiring', () => {
  const LOGIC = read('server/src/engine/HorseLogic.ts');
  const TURNS = read('server/src/engine/ServerTableEngineTurns.ts');
  const BASE = read('server/src/engine/ServerTableEngineBase.ts');
  const NIT = read('server/src/services/supabase/nitGame.ts');
  const ENGINE = read('server/src/engine/ServerTableEngine.ts');
  const SQL = read(
    'supabase/migrations/20260904231353_the_ten_hand_vpip_window_and_the_status_readers.sql'
  );

  it('the brain scales preflop tightness by the floor, last', () => {
    expect(LOGIC).toMatch(/params\.tightness \*= vpipFloorMul\(gs\);/);
    expect(LOGIC).toMatch(/vpipFloor\?: number;/);
    expect(LOGIC).toMatch(/ownVpip\?: \{ hands: number; vpip: number \| null \};/);
  });

  it("the engine hands the brain the floor and the seat's own judged figure", () => {
    expect(TURNS).toMatch(/vpipFloor: this\.vpipFloor\(\),/);
    expect(TURNS).toMatch(/this\.nitStatus\.get\(enginePlayer\.user_id\)/);
  });

  it('the judged figures are read beside the eviction, from the same rows', () => {
    expect(BASE).toMatch(
      /this\.nitStatus = await collectNitStatus\(this\.tableId\);\s*const nits = await collectNitEvictions\(this\.tableId\);/
    );
    expect(NIT).toMatch(/supabase\.rpc\('fn_nit_status', \{ p_table_id: tableId \}\)/);
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_nit_status\(p_table_id uuid\)/);
    expect(SQL).toMatch(/GRANT EXECUTE ON FUNCTION public\.fn_nit_status\(uuid\) TO service_role;/);
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_nit_status\(uuid\) FROM PUBLIC, anon, authenticated;/
    );
  });

  it('the window is ten hands everywhere a window is written', () => {
    expect(SQL).toMatch(/v_vpip_window := 10;/);
    expect(SQL).toMatch(/jsonb_set\(ruleset_snapshot, '\{vpip_window\}', '10'::jsonb\)/);
    expect(SQL).toMatch(/SET maintain_hands = 10/);
  });

  it('the hero reader is keyed on auth.uid() and open to authenticated only', () => {
    expect(SQL).toMatch(/v_uid\s+uuid := auth\.uid\(\);/);
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_cash_vpip_status\(uuid\) TO authenticated, service_role;/
    );
  });

  it('the regular ante is published with the snapshot', () => {
    expect(ENGINE).toMatch(/\.\.\.this\.anteSnapshotFields\(\),/);
    expect(ENGINE).toMatch(
      /ante_mode: info\.big_blind_ante_enabled === true \? 'big_blind' : 'per_player'/
    );
  });
});
