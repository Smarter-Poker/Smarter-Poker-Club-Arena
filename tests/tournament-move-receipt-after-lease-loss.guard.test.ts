import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = (path: string) => resolve(__dirname, '..', path);
const migrationsDirectory = root('supabase/migrations');
const contractionFiles = readdirSync(migrationsDirectory).filter(
  (file) =>
    file.endsWith('_stage_b_current_postimage_contraction.sql') ||
    file.endsWith('_stage_b_current_postimage_contraction.sql.pending')
);
if (contractionFiles.length !== 1) throw new Error('Stage-B contraction migration is ambiguous');
const migration = readFileSync(resolve(migrationsDirectory, contractionFiles[0]), 'utf8');
const transport = readFileSync(root('server/src/tournament/tournamentSeatMoveRpc.ts'), 'utf8');
const probe = readFileSync(
  root('scripts/ci/probes/tournament-move-receipt-after-lease-loss.sql'),
  'utf8'
);

function functionBody(identity: string): string {
  const definition = migration.indexOf(`CREATE OR REPLACE FUNCTION ${identity}(`);
  expect(definition, `${identity} definition`).toBeGreaterThanOrEqual(0);

  const tail = migration.slice(definition);
  const opening = tail.match(/\bAS\s+(\$[A-Za-z0-9_]*\$)/i);
  expect(opening, `${identity} body delimiter`).not.toBeNull();
  const delimiter = opening![1];
  const bodyStart = definition + opening!.index! + opening![0].length;
  const bodyEnd = migration.indexOf(delimiter, bodyStart);
  expect(bodyEnd, `${identity} body terminator`).toBeGreaterThan(bodyStart);
  return migration.slice(bodyStart, bodyEnd);
}

describe('a committed tournament move receipt survives manager lease loss', () => {
  it('adds one service-only exact receipt reader with no mutation authority', () => {
    const resolver = functionBody('public.fn_resolve_committed_tournament_seat_move');
    expect(resolver).toContain("auth.role() IS DISTINCT FROM 'service_role'");
    expect(resolver).toContain("v_actor IS DISTINCT FROM 'service'");
    expect(resolver.match(/PERFORM pg_advisory_xact_lock_shared\(/g)).toHaveLength(2);
    expect(resolver).toContain("hashtextextended('ca:tournament-terminal-settlement:v1',0)");
    expect(resolver).toContain(
      "hashtextextended('ca:tournament-terminal-settlement:v1:'||p_tournament_id::text,0)"
    );
    expect(resolver).not.toContain('fn_ca_lock_settlement_lane_for_tournament');
    expect(resolver).toContain('fn_ca_tournament_seat_move_receipt(p_request_id)');
    expect(resolver).toContain('RETURN NULL');
    expect(resolver).toContain('tournament move request id belongs to another operation');
    expect(resolver).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i);
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_resolve_committed_tournament_seat_move\([\s\S]*?FROM PUBLIC,anon,authenticated;/
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_resolve_committed_tournament_seat_move\([\s\S]*?TO service_role;/
    );
  });

  it('uses a hard-coded receipt endpoint outside the expired manager actor only after ambiguity', () => {
    expect(transport).toContain('/rest/v1/rpc/fn_resolve_committed_tournament_seat_move');
    expect(transport).toContain("'x-smarter-data-actor': 'service'");
    expect(transport).toContain("'x-smarter-data-protocol': '1'");
    expect(transport).not.toContain("'x-smarter-tournament-id'");
    expect(transport).not.toContain("'x-smarter-tournament-lease-generation'");
    expect(transport).toContain(
      'if (sawAmbiguousAttempt || options.outcomeWasAlreadyUnknown === true)'
    );
    expect(transport).toContain('if (committed) return committed');
    expect(transport).toContain('no exact committed receipt was visible');
  });

  it('pins positive replay, exact mismatch refusal, missing-receipt refusal and rollback', () => {
    expect(probe).toContain("v_result->>'replayed' IS DISTINCT FROM 'true'");
    expect(probe).toContain('EXCEPTION WHEN unique_violation');
    expect(probe).toContain('IS NOT NULL THEN');
    expect(probe).toContain('receipt-only resolution changed state or leaked authority');
    expect(probe).toContain('all probe work rolled back');
    expect(probe.trimEnd()).toMatch(/ROLLBACK;$/);
  });
});
