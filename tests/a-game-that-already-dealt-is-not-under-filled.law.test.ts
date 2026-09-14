/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A GAME THAT ALREADY DEALT IS NOT AN UNDER-FILLED GAME
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-12)
 *
 * Forty tournaments dealt hands on 2026-09-08, eliminated 82 players, and
 * stopped. They sat in REGISTERING for three days and twenty-one hours holding
 * 2,574.12 of player money across 125 players. `Breakfast Turbo` paid places
 * 2, 3, 4 and 5 between 14:38 and 14:43 and never paid place 1: its champion
 * was owed 53.12 for four days.
 *
 * ── THE FIX EXISTED AND COULD NOT REACH THEM ──────────────────────────────
 *
 * On 2026-09-11 this was diagnosed and two of the three layers were fixed:
 *
 *   GameServer start gate  `finishingADealtGame` offers the row. Deployed and
 *                          firing, once every five minutes, in the live log.
 *   completion RPC         `fn_prove_played_launch_recovery` generalises the
 *                          roster proof. Installed, and NEVER REACHED.
 *
 * The middle layer was missed. `startTournament` counts the field and stands
 * down before it writes the launch receipt:
 *
 *     [Tournament:90c4d93f] Only 1 of 2 player(s) - standing down so the field
 *                           can be filled (NOT cancelling)
 *
 * Its played-game escape hatch is Spin-only:
 *
 *     if (spinPaidGateWillRun && requiredField === SPEC_SPIN_SEATS && regCount === 2)
 *
 * A heads-up game holding one of two, or an MTT holding two of four, is not a
 * paid Spin holding two of three. So the manager stood down, no receipt was
 * written, and the completion proof written for exactly these games was never
 * called for any of them: `have_a_receipt = 0` on all forty, against 1,839
 * receipts written the same day by launches that cleared this gate.
 *
 * The chain was generalised at its end and left narrow in its middle. These
 * pins keep all three layers agreeing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

const migration = (needle: string): string => {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes(needle));
  if (!file) throw new Error(`no migration matching "${needle}" - was it renamed?`);
  return readFileSync(join(MIGRATIONS, file), 'utf8');
};

/** Executable SQL only: every header in this estate quotes what it refuses. */
const executable = (sql: string): string =>
  sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

/** TypeScript with `//` and `/* *\/` comment bodies removed. */
const code = (ts: string): string =>
  ts
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

const PROOF = () => executable(migration('a_played_launch_proves_itself_from_the_board'));
const MANAGER = () =>
  code(readFileSync(join(ROOT, 'server', 'src', 'tournament', 'TournamentManagerBase.ts'), 'utf8'));

describe('the proof derives the start instead of demanding it', () => {
  it('takes the first hand in hand_history as the moment the game began', () => {
    const sql = PROOF();
    expect(sql).toMatch(/min\(h\.created_at\)/);
    expect(sql).toContain('hand_history');
  });

  it('refuses a tournament that never dealt a hand, before asking anything else', () => {
    const sql = PROOF();
    expect(sql).toContain("'no_hand_was_dealt'");
    // The refusal must come before the generalised proof is consulted, or an
    // undealt game reaches a check written for a played one.
    expect(sql.indexOf("'no_hand_was_dealt'")).toBeLessThan(
      sql.indexOf('fn_prove_played_launch_recovery')
    );
  });

  it('delegates every other question to the generalised proof', () => {
    // This must never grow its own copy of the roster or seat rules.
    expect(PROOF()).toContain('fn_prove_played_launch_recovery');
  });

  it('hands back the start it derived, so the receipt can carry the truth', () => {
    expect(PROOF()).toMatch(/jsonb_set\(\s*v_proof,\s*'\{started_at\}'/);
  });

  it('is service_role only, like every other launch proof', () => {
    const sql = PROOF();
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.fn_prove_played_launch_from_board\(uuid\)/);
    expect(sql).toContain('FROM PUBLIC, anon, authenticated');
    expect(sql).toMatch(/GRANT EXECUTE[\s\S]{0,120}TO service_role/);
  });
});

describe('the manager asks before it stands down', () => {
  it('consults the board proof when the field is short', () => {
    expect(MANAGER()).toContain("'fn_prove_played_launch_from_board'");
  });

  it('asks it before the stand-down, not after', () => {
    const src = MANAGER();
    const asked = src.indexOf("'fn_prove_played_launch_from_board'");
    const stoodDown = src.indexOf('standing down so the field can be filled');
    // Both must be present, or "before" is satisfied by an absent call.
    expect(asked).toBeGreaterThan(-1);
    expect(stoodDown).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(stoodDown);
  });

  it('treats an unreadable answer as a stand-down, never as "it played"', () => {
    const src = MANAGER();
    expect(src).toContain('Tournament.played_launch_recovery_unreadable');
    // UNKNOWN must not fall through into the launch.
    expect(src).toMatch(
      /played_launch_recovery_unreadable[\s\S]{0,200}this\.running = false;[\s\S]{0,40}return;/
    );
  });

  it('refuses to stamp a receipt from a proof with no usable first-hand time', () => {
    expect(MANAGER()).toContain('Tournament.played_launch_recovery_malformed');
  });

  it('stamps the derived first-hand time into the receipt, ahead of the advertised start', () => {
    // The completion RPC re-derives the first hand and refuses a receipt that
    // disagrees, so the scheduled start these rows still carry would fail it.
    expect(MANAGER()).toMatch(
      /const requestedStartedAtIso = playedLaunchStartedAtIso\s*\?\s*playedLaunchStartedAtIso/
    );
  });

  it('does not replace the Spin path, which keeps its own narrower proof', () => {
    const src = MANAGER();
    expect(src).toContain("'fn_prove_played_spin_launch_recovery'");
    // The general door only opens when the Spin one did not.
    expect(src).toMatch(
      /playedSpinRecovery === null\s*\)\s*\{[\s\S]{0,400}fn_prove_played_launch_from_board/
    );
  });
});
