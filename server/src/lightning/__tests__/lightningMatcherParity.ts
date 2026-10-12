/**
 * THE MATCHER PARITY CHECK (Lightning Phase 11 remediation, 2026-10-09).
 *
 * The other half of scripts/dev/test-lightning-matcher-parity.sh. The
 * harness builds real Clusters on the real Lightning chain (PostgreSQL 17),
 * runs the REAL fn_lightning_match_plan on each fixture, and writes, for
 * every fixture, the exact snapshot that plan read: every open-pool
 * player's legality (fn_lightning_player_legality's own answer) and queue
 * keys, the Cluster's hands with their players and epochs, the config row
 * and the plan's `now`, all timestamps in epoch microseconds. This script
 * builds the TypeScript snapshot from those rows, runs the registered
 * `m1-port` (and `m1`), and asserts the identical plan: the same groups in
 * the same order, every group's players in the same seat order, the same
 * big blind, small blind and button, the same legal count and the same pool
 * diversity score. Any difference exits 1 with the first one printed.
 *
 *   node --import tsx src/lightning/__tests__/lightningMatcherParity.ts <fixtures.json>
 *
 * Lives under __tests__ so the engine image never compiles it.
 */
import { readFileSync } from 'node:fs';
import {
  lightningMatcherModel,
  lightningMatcherParams,
  type LightningPoolPlayer,
  type LightningPoolSnapshot,
  type LightningRecentHand,
} from '../LightningMatcherModel.js';

interface FixturePlayer {
  player_id: string;
  legal: boolean;
  reason_code: string | null;
  idle_since_us: number | null;
  entered_at_us: number;
  joined_at_us: number | null;
  slot_opened_us: number | null;
  last_bb_at_us: number | null;
  bb_unresolved: boolean;
  debt_since_us: number | null;
  hands_since_bb: number | null;
  newcomer: boolean;
  btn: number;
  co: number;
  hj: number;
  utg: number;
}

interface FixtureHand {
  hand_id: string;
  formed_at_us: number;
  epoch: number;
  players: string[];
}

interface Fixture {
  name: string;
  /** The fixture's ties are ones the pre-remediation port broke differently. */
  discriminates?: boolean;
  config: Record<string, unknown>;
  now_us: number;
  epoch: number;
  players: FixturePlayer[];
  hands: FixtureHand[];
  plan: {
    legal_count: number;
    pool_diversity_score: number | string;
    groups: Array<{
      players: string[];
      bb: string;
      keys: { p2: { sb: string | null }; p3: { btn: string | null } };
    }>;
  };
}

const ms = (us: number): number => us / 1000;

/**
 * `prior` drops what the Phase 11 remediation added to the snapshot (the
 * Cluster join, the slot's opening, the hand ids and epochs): the port as it
 * stood, against which a discriminating fixture must differ.
 */
export function parityGroups(f: Fixture, version: string, prior = false) {
  const model = lightningMatcherModel(version);
  if (!model) throw new Error(`no model ${version}`);
  const players: LightningPoolPlayer[] = f.players.map((p) => ({
    playerId: p.player_id,
    legal: p.legal,
    reasonCode: p.reason_code,
    // An illegal player's keys are never read; a legal one has them all.
    idleSinceMs: p.idle_since_us === null ? 0 : ms(p.idle_since_us),
    enteredAtMs: ms(p.entered_at_us),
    joinedAtMs: p.joined_at_us === null ? null : ms(p.joined_at_us),
    slotOpenedAtMs: p.slot_opened_us === null ? ms(p.entered_at_us) : ms(p.slot_opened_us),
    lastBbAtMs: p.last_bb_at_us === null ? null : ms(p.last_bb_at_us),
    bbUnresolved: p.bb_unresolved,
    debtSinceMs: p.debt_since_us === null ? 0 : ms(p.debt_since_us),
    handsSinceBb: p.hands_since_bb,
    newcomer: p.newcomer,
    positions: { btn: p.btn, co: p.co, hj: p.hj, utg: p.utg },
  }));
  if (prior)
    for (const p of players) {
      delete p.joinedAtMs;
      delete p.slotOpenedAtMs;
    }
  const recentHands: LightningRecentHand[] = f.hands.map((h) =>
    prior
      ? { players: [...h.players], formedAtMs: ms(h.formed_at_us) }
      : {
          players: [...h.players],
          formedAtMs: ms(h.formed_at_us),
          handId: h.hand_id,
          epoch: h.epoch,
        }
  );
  const snapshot: LightningPoolSnapshot = prior
    ? { nowMs: ms(f.now_us), players, recentHands }
    : { nowMs: ms(f.now_us), players, recentHands, epoch: f.epoch };
  return model.plan(snapshot, lightningMatcherParams(f.config));
}

const same = (a: ReturnType<typeof parityGroups>, sql: Fixture['plan']): boolean =>
  a.groups.length === sql.groups.length &&
  a.groups.every(
    (g, j) => g.players.join(',') === sql.groups[j].players.join(',') && g.bb === sql.groups[j].bb
  );

function main(): void {
  const file = process.argv[2];
  if (!file) throw new Error('usage: lightningMatcherParity.ts <fixtures.json>');
  const fixtures = (JSON.parse(readFileSync(file, 'utf8')) as { fixtures: Fixture[] }).fixtures;
  let failed = 0;
  let groups = 0;
  const discriminated: string[] = [];
  for (const f of fixtures) {
    for (const version of ['m1-port', 'm1']) {
      const ts = parityGroups(f, version);
      const sql = f.plan;
      const problems: string[] = [];
      if (ts.legalCount !== sql.legal_count)
        problems.push(`legal_count ts=${ts.legalCount} sql=${sql.legal_count}`);
      if (ts.groups.length !== sql.groups.length)
        problems.push(`groups ts=${ts.groups.length} sql=${sql.groups.length}`);
      if (ts.poolDiversityScore !== Number(sql.pool_diversity_score))
        problems.push(
          `pool_diversity_score ts=${ts.poolDiversityScore} sql=${sql.pool_diversity_score}`
        );
      for (let j = 0; j < Math.min(ts.groups.length, sql.groups.length); j++) {
        const a = ts.groups[j];
        const b = sql.groups[j];
        const sqlSb = b.keys.p2.sb ?? b.bb;
        const sqlBtn = b.keys.p3.btn ?? sqlSb;
        if (a.players.join(',') !== b.players.join(','))
          problems.push(`group ${j + 1} seats ts=[${a.players}] sql=[${b.players}]`);
        if (a.bb !== b.bb) problems.push(`group ${j + 1} bb ts=${a.bb} sql=${b.bb}`);
        if (a.sb !== sqlSb) problems.push(`group ${j + 1} sb ts=${a.sb} sql=${sqlSb}`);
        if (a.btn !== sqlBtn) problems.push(`group ${j + 1} btn ts=${a.btn} sql=${sqlBtn}`);
      }
      if (problems.length > 0) {
        failed++;
        console.log(`FAIL ${f.name} (${version}): ${problems.slice(0, 5).join('; ')}`);
      } else if (version === 'm1-port') {
        groups += ts.groups.length;
        console.log(
          `  ok  ${f.name}: ${ts.groups.length} groups, ${ts.legalCount} legal, ` +
            `diversity ${ts.poolDiversityScore} - identical seats, blinds and buttons`
        );
      }
    }
  }
  for (const f of fixtures) {
    if (!f.discriminates) continue;
    if (same(parityGroups(f, 'm1', true), f.plan)) {
      failed++;
      console.log(`FAIL ${f.name}: the pre-remediation port agrees, so the fixture proves nothing`);
    } else discriminated.push(f.name);
  }
  if (discriminated.length > 0)
    console.log(`DISCRIMINATES the pre-remediation port differs on: ${discriminated.join('; ')}`);
  if (failed > 0) {
    console.log(`FAIL: ${failed} plan(s) differ from fn_lightning_match_plan`);
    process.exit(1);
  }
  console.log(`PARITY ${fixtures.length} fixtures ${groups} groups identical`);
}

main();
