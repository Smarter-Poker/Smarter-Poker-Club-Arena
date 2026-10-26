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
import { validateLightningMatchResult } from '../LightningRpc.js';
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
    /** Whether the plan's entry big blind gate was open (20261025050528). */
    entry_big_blind?: boolean;
    groups: Array<{
      players: string[];
      bb: string;
      entry_bb?: string[];
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
  // The plan's own entry big blind gate, as the engine's A/A path reads it.
  const entryBigBlind = f.plan.entry_big_blind === true;
  const snapshot: LightningPoolSnapshot = prior
    ? { nowMs: ms(f.now_us), players, recentHands, entryBigBlind }
    : { nowMs: ms(f.now_us), players, recentHands, epoch: f.epoch, entryBigBlind };
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
    const actual = validateLightningMatchResult(f.plan);
    if (!actual.ok || !actual.value.authoritativeSnapshot || !actual.value.snapshotBinding) {
      failed++;
      console.log(
        `FAIL ${f.name}: actual RPC snapshot unavailable or invalid (${actual.ok ? 'missing' : actual.reason})`
      );
      continue;
    }
    for (const version of ['m1-port', 'm1']) {
      const ts = parityGroups(f, version);
      const fromRpc = lightningMatcherModel(version)!.plan(
        actual.value.authoritativeSnapshot,
        lightningMatcherParams(f.config)
      );
      const sql = f.plan;
      const problems: string[] = [];
      if (
        JSON.stringify(fromRpc.groups) !== JSON.stringify(ts.groups) ||
        fromRpc.legalCount !== ts.legalCount ||
        fromRpc.poolDiversityScore !== ts.poolDiversityScore
      )
        problems.push(
          'actual RPC snapshot disagrees with independently captured queue/blind/history keys'
        );
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
        const sqlEntry = (b.entry_bb ?? []).join(',');
        if (a.entryBb.join(',') !== sqlEntry)
          problems.push(`group ${j + 1} entry_bb ts=[${a.entryBb}] sql=[${sqlEntry}]`);
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
