/**
 * A CLUB STAYS DELETABLE, SO A FIXTURE CAN NEVER BE STRANDED WITH ITS CHIPS.
 *
 * 2026-09-03, Dan: "WE SHOULDN'T NEED THOSE DETECTORS OR WATCH DOGS IF YOU FIX
 * THIS ALL AND MAKE IT SO ITS IMPOSSIBLE TO EVER LOSE A CHIP, OR NOT HAVE EVERY
 * SINGLE CHIP ACCOUNTED FOR AND ACCOUNTABLE. THATS THE GOAL!"
 *
 * Migration 20260903230339 built fn_ca_retire_certification_club and taught the
 * certification to fail loudly if a fixture survived. At 23:33 UTC the
 * certification ran on that exact build and reported:
 *
 *   PASS Custom And Placeholder Club Creation Certified For 89e03439..., 7abc31e6...
 *   Fixture Cleanup Failed For 89e03439...: canceling statement due to statement timeout
 *   Fixture Cleanup Failed For 7abc31e6...: canceling statement due to statement timeout
 *   Error: Certification leaked 2 fixture club(s) into Club Arena
 *
 * The guard was right and the cleanup was impossible. public.clubs has seventy
 * foreign keys; a DELETE checks every one, and a check with no usable index is a
 * sequential scan. EXPLAIN (ANALYZE) named the bill: rake_records 1,287ms,
 * table_seats 74ms, and game_management_events with no club_id index at all
 * across 867,780 rows. Two of the seven gaps LOOKED indexed -
 * idx_rake_records_club_created and idx_table_seats_club_active both lead on
 * club_id - but both are PARTIAL, and a partial index cannot answer a foreign key
 * check because the check must find the rows the predicate hides.
 *
 * Also proved and discarded here, so nobody spends the hour again: giving the
 * function `SET statement_timeout` does not work. PostgreSQL arms the timeout
 * when the statement starts and a SET inside the function does not re-arm it. A
 * probe declared '30s', sleeping 6s, under a 3s session timeout, was cancelled at
 * 3s. The work has to fit the budget.
 *
 * After the thirteen indexes, through the same PostgREST door as the same
 * service_role the certification uses: 2.43s and 2.58s, both 200 OK, 100,000.00
 * retired each, clubs back to the four estates Dan named.
 *
 * The rules this pins:
 *
 *   - every single-column foreign key into clubs has an index that can answer it,
 *     and trusted protected-main code asks production before either publish
 *     path, then again before live fixtures, without credentials in PR code;
 *   - "has an index" means valid, non-partial, and leading on the referencing
 *     column, because the other definition is the one that was already wrong;
 *   - the question is a read-only RPC, service_role only, that nothing schedules;
 *   - the migration that closed the gaps says IF NOT EXISTS, because the two large
 *     indexes were built CONCURRENTLY against production and a plain build of
 *     game_management_events blocks writes for 25 seconds.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
function read(fragment: string): string {
  const f = readdirSync(DIR)
    .filter((x) => x.includes(fragment))
    .sort()
    .pop();
  expect(f, `the migration containing "${fragment}" is missing`).toBeTruthy();
  return readFileSync(resolve(DIR, f as string), 'utf8');
}
const INDEXES = read('a_club_cannot_be_deleted_in_time');
const GAPS = read('the_repo_can_ask_production_whether_a_club_is_still_deletable');
const GATE = readFileSync(resolve(__dirname, '..', 'scripts/ci/check-club-fk-indexes.mjs'), 'utf8');
const POST_DEPLOY = readFileSync(
  resolve(__dirname, '..', '.github/workflows/post-deploy-e2e.yml'),
  'utf8'
);
const ENGINE = parse(
  readFileSync(resolve(__dirname, '..', '.github/workflows/auto-deploy-hetzner.yml'), 'utf8')
);
const CLIENT = parse(
  readFileSync(resolve(__dirname, '..', '.github/workflows/publish-club-arena.yml'), 'utf8')
);
const STRICT_GATE = 'node scripts/ci/check-club-fk-indexes.mjs';
const prepublishGate = (job: any) => {
  const gates = job.steps.filter((step: any) => step.run?.includes(STRICT_GATE));
  expect(gates).toHaveLength(1);
  const gate = gates[0];
  expect(gate.run.trim()).toBe(STRICT_GATE);
  expect(gate.if).toBeUndefined();
  expect(gate['continue-on-error']).toBeUndefined();
  expect(gate['timeout-minutes']).toBe(2);
  expect(
    job.steps
      .slice(0, job.steps.indexOf(gate))
      .some(
        (step: any) => step.uses === 'actions/setup-node@v4' && step.with?.['node-version'] === 22
      )
  ).toBe(true);
  expect(gate.env).toEqual({
    SUPABASE_URL: '${{ secrets.SUPABASE_URL }}',
    SUPABASE_SERVICE_ROLE_KEY: '${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}',
  });
  return gate;
};

const CLOSED: Array<[string, string]> = [
  ['idx_game_management_events_club_id', 'public.game_management_events'],
  ['idx_club_join_idempotency_club_id', 'public.club_join_idempotency'],
  ['idx_ad_placement_club_id', 'public.ad_placement'],
  ['idx_ca_supply_snapshot_classifications_club_id', 'public.ca_supply_snapshot_classifications'],
  ['idx_club_opening_setup_funding_club_id', 'public.club_opening_setup_funding'],
  ['idx_club_message_dismissals_club_id', 'public.club_message_dismissals'],
  ['idx_rake_records_club_id_fk', 'public.rake_records'],
  ['idx_table_seats_club_id_fk', 'public.table_seats'],
  ['idx_settlement_locks_club_id_fk', 'public.settlement_locks'],
  ['idx_blacklists_club_id_fk', 'public.blacklists'],
  ['idx_commission_rate_audit_club_id_fk', 'public.commission_rate_audit'],
  ['idx_ad_advertiser_club_id_fk', 'public.ad_advertiser'],
  ['idx_game_ticker_settings_club_id_fk', 'public.game_ticker_settings'],
];

describe('a club stays deletable', () => {
  it('closes every foreign key gap that made the delete slow', () => {
    for (const [name, table] of CLOSED) {
      expect(INDEXES, `${name} is missing`).toContain(name);
      expect(INDEXES).toContain(`ON ${table} (club_id)`);
    }
    expect(CLOSED.length).toBe(13);
  });

  it('creates them idempotently, because the big two were built concurrently on production', () => {
    const creates = INDEXES.match(/CREATE INDEX[^;]*;/g) || [];
    expect(creates.length).toBe(13);
    for (const c of creates) expect(c).toContain('IF NOT EXISTS');
    // A plain CREATE INDEX inside a migration transaction takes a SHARE lock.
    // game_management_events took 25 seconds to build; that is 25 seconds the
    // engine cannot write an event. Never reintroduce a bare build here.
    expect(INDEXES).not.toMatch(/CREATE INDEX(?! IF NOT EXISTS)/);
  });

  it('records why an index that leads on club_id can still be useless', () => {
    expect(INDEXES).toContain('partial');
    expect(INDEXES).toContain('idx_rake_records_club_created');
    expect(INDEXES).toContain('idx_table_seats_club_active');
  });

  it('refuses the migration if any single-column key into clubs is unanswerable', () => {
    expect(INDEXES).toContain('CLUB_FK_INDEXES:');
    expect(INDEXES).toMatch(/RAISE EXCEPTION\s*\n?\s*'CLUB_FK_INDEXES:/);
    // The three conditions that make an index able to answer a key.
    expect(INDEXES).toContain('i.indisvalid');
    expect(INDEXES).toContain('i.indpred IS NULL');
    expect(INDEXES).toContain('i.indkey[0] = f.attnum');
  });

  it('asks the same three conditions from the RPC the repo calls', () => {
    expect(GAPS).toContain('CREATE OR REPLACE FUNCTION public.fn_ca_fk_index_gaps');
    expect(GAPS).toContain('i.indisvalid');
    expect(GAPS).toContain('i.indpred IS NULL');
    expect(GAPS).toContain('i.indkey[0] = f.attnum');
  });

  it('keeps the question read-only, unscheduled, and out of the browser', () => {
    expect(GAPS).toMatch(/LANGUAGE sql\s+STABLE\s+SECURITY DEFINER/);
    expect(GAPS).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_fk_index_gaps\(text\) FROM PUBLIC, anon, authenticated;/
    );
    expect(GAPS).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_ca_fk_index_gaps\(text\)\s*TO service_role;/
    );
    // Dan: "NOT TO HAVE WATCH DOGS AND CRONS RUNNING ALL OVER THE PLACE."
    expect(GAPS).not.toContain('cron.schedule');
    expect(GAPS).not.toContain('fn_ca_raise_drift_incident');
  });

  it('is asked read-only after every successful publish from trusted default-branch code', () => {
    expect(GATE).toContain('fn_ca_fk_index_gaps');
    expect(GATE).toContain("const PARENTS = ['public.clubs']");
    expect(GATE).toContain('process.exit(1)');
    expect(GATE).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(POST_DEPLOY).toContain("workflows: ['Publish Club Arena']");
    expect(POST_DEPLOY).toContain('node scripts/ci/check-club-fk-indexes.mjs');
    const liveSchemaStep = POST_DEPLOY.slice(
      POST_DEPLOY.indexOf('- name: Prove every club foreign key remains deletable'),
      POST_DEPLOY.indexOf('- name: Audit the remaining live schema from trusted code')
    );
    expect(liveSchemaStep).not.toMatch(/^\s*if:/m);
    expect(liveSchemaStep).toContain('node scripts/ci/check-club-fk-indexes.mjs');
    expect(POST_DEPLOY.indexOf('node scripts/ci/check-club-fk-indexes.mjs')).toBeLessThan(
      POST_DEPLOY.indexOf('node scripts/ci/check-phantom-tables.mjs')
    );
  });

  it('refuses malformed RPC data instead of translating it to zero gaps', () => {
    expect(GATE).toContain("keys.join(',') === 'checked_at,gaps,parent'");
    expect(GATE).toContain('answer.parent === parent');
    expect(GATE).toContain('Array.isArray(answer.gaps)');
    expect(GATE).not.toContain('answer.gaps || []');
  });

  it('requires the strict catalog gate before the engine deployment dependency can succeed', () => {
    expect(Object.keys(ENGINE.on)).toEqual(['repository_dispatch']);
    expect(ENGINE.on.repository_dispatch.types).toEqual(['deploy-club-arena-engine']);
    const doors = ENGINE.jobs['engine-doors'];
    expect(doors.needs).toBe('preflight');
    expect(doors.if).toBeUndefined();
    expect(doors['continue-on-error']).toBeUndefined();
    expect(doors.environment).toBe('Production');
    expect(doors['runs-on']).toEqual(['self-hosted', 'smarter-local-publish']);
    const gate = prepublishGate(doors);
    const checkout = doors.steps.find((step: any) => step.uses === 'actions/checkout@v4');
    expect(checkout.with.ref).toBe('${{ needs.preflight.outputs.target_sha }}');
    expect(doors.steps.indexOf(checkout)).toBeLessThan(doors.steps.indexOf(gate));
    const proof = ENGINE.jobs.preflight.steps.find((step: any) => step.id === 'target').run;
    expect(proof).toContain('git merge-base --is-ancestor "$RESOLVED_SHA" "$MAIN_SHA"');
    expect(proof.indexOf('git merge-base --is-ancestor')).toBeLessThan(proof.indexOf('echo "sha='));
    expect(JSON.stringify(ENGINE.jobs.preflight)).not.toContain('secrets.');
    expect(ENGINE.jobs.deploy.needs).toContain('engine-doors');
    expect(ENGINE.jobs.deploy.if).toBeUndefined();
    expect(ENGINE.jobs.deploy['continue-on-error']).toBeUndefined();
  });

  it('requires the strict catalog gate before origin credentials or any remote mutation', () => {
    expect(Object.keys(CLIENT.on).sort()).toEqual(['push', 'repository_dispatch']);
    expect(CLIENT.on.push.branches).toEqual(['main']);
    const publish = CLIENT.jobs['publish-to-origin'];
    expect(publish.needs).toContain('publish-needed');
    expect(publish.environment).toBe('Production');
    expect(publish['runs-on']).toEqual(['self-hosted', 'smarter-local-publish']);
    expect(publish['continue-on-error']).toBeUndefined();
    const gate = prepublishGate(publish);
    const gateIndex = publish.steps.indexOf(gate);
    const checkout = publish.steps.find((step: any) => step.uses === 'actions/checkout@v4');
    expect(checkout.with.ref).toBe('${{ needs.publish-needed.outputs.target_sha }}');
    expect(checkout.with['persist-credentials']).toBe(false);
    expect(publish.steps.indexOf(checkout)).toBeLessThan(gateIndex);
    const proof = CLIENT.jobs['publish-needed'].steps.find((step: any) => step.id === 'target').run;
    expect(proof).toContain('commits/main');
    expect(proof).toContain('[ "$REQUESTED_SHA" = "$TIP" ]');
    expect(JSON.stringify(publish.steps.slice(0, gateIndex))).not.toMatch(
      /CA_ORIGIN_(SSH_KEY|HOST_KEY)|\bssh\b|\brsync\b/
    );
    const key = publish.steps.find(
      (step: any) => step.env?.KEY === '${{ secrets.CA_ORIGIN_SSH_KEY }}'
    );
    expect(publish.steps.indexOf(key)).toBeGreaterThan(gateIndex);
    expect(key.if).toBeUndefined();
    const verdict = publish.steps.find((step: any) => step.id === 'verdict');
    expect(publish.steps.indexOf(verdict)).toBeGreaterThan(gateIndex);
    expect(verdict.if).toBeUndefined();
    for (const step of publish.steps.filter((step: any) =>
      /\b(?:ssh|rsync)\s/.test(step.run ?? '')
    )) {
      expect(publish.steps.indexOf(step)).toBeGreaterThan(gateIndex);
      expect(step['continue-on-error']).toBeUndefined();
      // Failure/always cleanup can only touch a remote path after a successful
      // verdict. A failed prepublication gate never creates that verdict.
      if (/always\(\)|failure\(\)/.test(step.if ?? '')) {
        expect(step.if).toContain("steps.verdict.outputs.verdict == 'publish'");
      }
    }
  });

  for (const [name, job] of [
    ['engine', ENGINE.jobs['engine-doors']],
    ['client', CLIENT.jobs['publish-to-origin']],
  ] as const) {
    for (const [label, reply, status] of [
      [
        'indexed catalog',
        { parent: 'public.clubs', checked_at: '2026-09-16T00:00:00Z', gaps: [] },
        0,
      ],
      [
        'missing index',
        {
          parent: 'public.clubs',
          checked_at: '2026-09-16T00:00:00Z',
          gaps: [
            {
              child_table: 'public.fixture',
              child_column: 'club_id',
              constraint: 'fixture_club_fkey',
              est_rows: 1,
            },
          ],
        },
        1,
      ],
      ['malformed catalog', {}, 2],
      ['unreadable catalog', null, 2],
    ] as const) {
      it(`${name} ${label} ${status ? 'blocks' : 'permits'} the downstream publish boundary`, () => {
        const gate = prepublishGate(job);
        const temp = mkdtempSync(join(tmpdir(), 'club-catalog-gate-'));
        try {
          const stub = join(temp, 'catalog.mjs');
          const marker = join(temp, 'publish-reached');
          writeFileSync(
            stub,
            `
            import assert from 'node:assert/strict';
            globalThis.fetch = async (url, options) => {
              assert.equal(url, 'https://catalog.invalid/rest/v1/rpc/fn_ca_fk_index_gaps');
              assert.equal(options.method, 'POST');
              assert.equal(options.body, JSON.stringify({p_parent: 'public.clubs'}));
              assert.equal(options.headers.apikey, 'sb_secret_fixture_only');
              return {ok: ${reply !== null}, status: ${reply === null ? 503 : 200},
                json: async () => (${JSON.stringify(reply)}), text: async () => 'fixture unavailable'};
            };
          `
          );
          // Execute the exact workflow command using its normal fail-fast shell.
          // No production connection or credential enters this child process.
          const run = spawnSync(
            'bash',
            ['-e', '-c', `${gate.run}\nprintf reached > "$PUBLISH_MARKER"`],
            {
              cwd: resolve(__dirname, '..'),
              encoding: 'utf8',
              timeout: 5000,
              env: {
                PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
                NODE_OPTIONS: `--import=${pathToFileURL(stub).href}`,
                SUPABASE_URL: 'https://catalog.invalid',
                SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_fixture_only',
                PUBLISH_MARKER: marker,
              },
            }
          );
          expect(run.error).toBeUndefined();
          expect(run.status, run.stdout + run.stderr).toBe(status);
          expect(existsSync(marker)).toBe(status === 0);
        } finally {
          rmSync(temp, { recursive: true, force: true });
        }
      });
    }
  }
});
