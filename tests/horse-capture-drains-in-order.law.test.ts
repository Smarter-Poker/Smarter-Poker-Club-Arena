import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

/**
 * HORSE CAPTURE DRAINS IN ORDER (2026-10-25).
 *
 * The horse opponent-observation capture queue lost about 60% of its windows.
 * Sources are readable for 24 hours, so a lost window is lost for good. Four
 * lines produced it, each pinned here against its root fix in
 * 20261025042223_horse_capture_drains_in_order.sql:
 *
 *   1. Claims ordered by available_at round-robined across every open
 *      request; the oldest expired part-done and the 256 slots never freed.
 *   2. A success grew the next slice 3x, overshot the 512-hand budget and was
 *      halved, wasting about half of all reads.
 *   3. A timed-out slice (source_unavailable) retried at the same width
 *      until it expired.
 *   4. Each new discovery epoch jumped to the newest boundary, skipping whole
 *      windows.
 *
 * And the engine loop that ran one slice per 1 s pause even with the journal
 * idle. No backfill job, sweep or repair cron is allowed as the fix (CLAUDE.md
 * 10.11, 10.12).
 */
const ROOT = path.resolve(__dirname, '..');
const FILE = 'supabase/migrations/20261025042223_horse_capture_drains_in_order.sql';
const MIGRATION = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/** The body between the $function$ quotes, exactly as Postgres stores prosrc. */
const body = (sql: string, name: string): string => {
  const m = new RegExp(
    'CREATE (?:OR REPLACE )?FUNCTION public\\.' + name + '\\([\\s\\S]*?AS \\$function\\$([\\s\\S]*?)\\$function\\$'
  ).exec(sql);
  expect(m, name).not.toBeNull();
  return m![1];
};
const code = (sql: string) => sql.replace(/--[^\n]*/g, '');

/** Where each replaced body was last written, and its production md5. */
const PREIMAGES: Record<string, [string, string]> = {
  fn_claim_horse_observation_capture: [
    'supabase/migrations/20260914041305_preserve_horse_capture_source_witnesses.sql',
    'fe2b696a91799229417765107f1781e4',
  ],
  fn_finish_horse_observation_capture: [
    'supabase/migrations/20260914032826_recover_horse_observation_capture_slices.sql',
    'c4851c48d6be944246e135c5c7142b7f',
  ],
  fn_discover_horse_observation_requests: [
    'supabase/migrations/20261017040330_horse_capture_terminal_gaps_free_their_slots.sql',
    '105a4349232226552dd175535f6bb167',
  ],
  fn_horse_committed_observation_snapshot: [
    'supabase/migrations/20261022054023_horse_observation_snapshot_refuses_an_overflowing_window_fro.sql',
    'e1ce00018f43c4517b6b5dc52f762734',
  ],
};

describe('1. claims take the oldest request first', () => {
  const claim = code(body(MIGRATION, 'fn_claim_horse_observation_capture'));
  it('orders by created_at then request_key, never by available_at', () => {
    expect(claim).toContain('ORDER BY w.created_at,w.request_key LIMIT 1 FOR UPDATE SKIP LOCKED');
    expect(claim).not.toMatch(/ORDER BY w\.available_at/);
  });
});

describe('2. a slice ends at a hand boundary inside the 512-hand budget', () => {
  const helper = code(body(MIGRATION, 'fn_horse_capture_hand_budget_through'));
  const claim = code(body(MIGRATION, 'fn_claim_horse_observation_capture'));
  const finish = code(body(MIGRATION, 'fn_finish_horse_observation_capture'));
  const snapshot = code(body(MIGRATION, 'fn_horse_committed_observation_snapshot'));
  it('the boundary is read from the snapshot precheck: the same indexes, oldest first, 513 rows', () => {
    expect(helper).toContain('FROM public.ca_hand_player_idx i');
    expect(helper).toContain('WHERE h.created_at = i.created_at AND h.id = i.hand_id');
    expect(helper).toContain('ORDER BY i.created_at');
    expect(helper).toContain('LIMIT 513');
    expect(helper).toContain('least(512, coalesce(p_hands');
    // The millisecond of the last hand kept, or the one before the next.
    expect(helper).toContain('WHERE r.n = b.hands)) * 1000)::bigint');
    expect(helper).toContain('WHERE r.n = b.hands + 1)) * 1000)::bigint - 1');
    for (const banned of ['players', 'actions', 'hole_cards', 'hand_atomic_commits'])
      expect(helper).not.toContain(banned);
  });
  it('the snapshot precheck returns the 512th hand boundary with an unchanged refusal', () => {
    expect(snapshot).toContain(
      'v_budget := public.fn_horse_capture_hand_budget_through(p_actor, p_from_ms, p_through_ms, 512);'
    );
    expect(snapshot).toContain("'reason','hand_budget_exceeded'");
    expect(snapshot).toContain("'budgetThroughMs',CASE WHEN v_budget > p_from_ms THEN v_budget END");
    expect(snapshot.indexOf('fn_horse_capture_hand_budget_through')).toBeLessThan(
      snapshot.indexOf('WITH found AS MATERIALIZED')
    );
  });
  it('the claim ends the slice at that boundary and can only narrow it', () => {
    expect(claim).toContain(
      'budget_ms:=public.fn_horse_capture_hand_budget_through(r.actor_id,first_ms,last_ms,coalesce(hand_cap,512));'
    );
    expect(claim).toContain('IF budget_ms>first_ms AND budget_ms<last_ms THEN last_ms:=budget_ms; END IF;');
    expect(claim.indexOf('budget_ms:=')).toBeLessThan(claim.indexOf("SET state='leased'"));
  });
  it('a success continues to the end of the request: no 3x overshoot, so no refine follows', () => {
    expect(finish).toContain('next_ms:=r.through_ms;');
    expect(finish).not.toContain('last_ms+2*(last_ms-first_ms)');
  });
});

describe('3. a timeout halves the slice the way source_budget_exceeded does', () => {
  const finish = code(body(MIGRATION, 'fn_finish_horse_observation_capture'));
  it('source_unavailable is refined narrower at once, not retried at the same width', () => {
    expect(finish).toContain(
      "IF v_reason IN ('source_budget_exceeded','source_unavailable') AND last_ms-first_ms>1 THEN"
    );
    expect(finish).toContain('next_ms:=first_ms+(last_ms-first_ms)/2;');
    expect(finish).toContain("ELSE 'source_unavailable_refined' END");
  });
  it('queue backpressure still defers instead of refining', () => {
    expect(finish).toContain(
      "v_reason:=CASE WHEN queued->>'reason' IN ('queue_full','capacity_busy') THEN queued->>'reason' ELSE 'queue_unavailable' END;"
    );
    expect(finish).toContain("RETURN jsonb_build_object('version',1,'status','deferred'");
  });
});

describe('4. discovery resumes each new epoch from the previous epoch end', () => {
  const discover = code(body(MIGRATION, 'fn_discover_horse_observation_requests'));
  it('the next end is the boundary after the previous end, floored only at the readable day', () => {
    expect(discover).toContain(
      'end_ms:=least(end_ms,greatest(previous_end+18000000,((at_ms-61200000+60000+17999999)/18000000)*18000000-60000));'
    );
    expect(discover.indexOf('previous_end+18000000')).toBeGreaterThan(
      discover.indexOf('SELECT through_ms INTO previous_end')
    );
    expect(discover.indexOf('previous_end+18000000')).toBeLessThan(
      discover.indexOf('IF previous_end IS NOT NULL AND end_ms<=previous_end THEN')
    );
  });
  it('the resumed window never skips a readable window and stays readable (arithmetic)', () => {
    const H = 18000000;
    const newest = (at: number) => Math.floor(at / H) * H - 60000;
    const resume = (at: number, prev: number) =>
      Math.min(
        newest(at),
        Math.max(prev + H, Math.floor((at - 61200000 + 60000 + H - 1) / H) * H - 60000)
      );
    for (let i = 0; i < 20000; i++) {
      const at = 1792000000000 + Math.floor(Math.random() * 1e9);
      const prev = newest(at) - H * Math.floor(Math.random() * 12);
      const end = resume(at, prev);
      if (end <= prev) continue;
      expect((end + 60000) % H).toBe(0);
      expect(end - 21600000).toBeGreaterThanOrEqual(at - 82800000 - 1);
      if (end !== prev + H) expect(prev + H - 21600000).toBeLessThan(at - 82800000);
    }
  });
  it('no backfill, sweep or repair job is created (CLAUDE.md 10.12)', () => {
    const c = code(MIGRATION);
    expect(c).not.toMatch(/cron\.schedule|fn_\w*_(repair|backfill|sweep|catchup|heal|redrive)_/i);
    expect(c).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b[^;]*\b(horse_observation_capture_work|horse_observation_discovery_epochs)\b(?![\s\S]*\$function\$)/);
  });
});

describe('the migration is one guarded transaction that preserves every contract', () => {
  it('is one BEGIN/COMMIT with lock_timeout, and creates a function (its own live proof)', () => {
    expect(MIGRATION.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIGRATION).toMatch(/^SET LOCAL lock_timeout = '2s';$/m);
    expect(MIGRATION).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_horse_capture_hand_budget_through(p_actor uuid, p_from_ms bigint, p_through_ms bigint, p_hands integer)'
    );
    expect(MIGRATION).not.toMatch(/^-- @live-proof:/m);
    expect(MIGRATION).not.toMatch(/@install-window/);
    expect(code(MIGRATION)).not.toMatch(/\b(ALTER|DROP|LOCK)\s+TABLE\b/i);
  });
  it('guards every replaced body by its measured production md5, and the bases reproduce it', () => {
    for (const [name, [file, expected]] of Object.entries(PREIMAGES)) {
      expect(md5(body(read(file), name)), name).toBe(expected);
      expect(MIGRATION).toContain(`'${expected}','${md5(body(MIGRATION, name))}'`);
      expect(MIGRATION).toContain(`-- ${name}: rebuilt from the installed body, md5(prosrc) ${expected}`);
    }
    expect(MIGRATION).toContain('HORSE_CAPTURE_DRAINS_IN_ORDER_PREIMAGE_CHANGED');
    const guard = MIGRATION.indexOf('$horse_capture_drains_in_order_guard$');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(MIGRATION.indexOf('CREATE OR REPLACE FUNCTION'));
  });
  it('changes each base body only by its anchored edits', () => {
    // Every line of each base survives except the ones the fix replaces.
    const replaced: Record<string, string[]> = {
      fn_claim_horse_observation_capture: [
        'DECLARE r public.horse_observation_capture_work%ROWTYPE; first_ms bigint; last_ms bigint; gap_reason text;',
        '    ORDER BY w.available_at,w.created_at,w.request_key LIMIT 1 FOR UPDATE SKIP LOCKED;',
      ],
      fn_finish_horse_observation_capture: [
        '  next_ms bigint; n integer; total bigint; new_state text; ack jsonb;',
        '      next_ms:=least(r.through_ms,last_ms+2*(last_ms-first_ms));',
        "  IF v_reason='source_budget_exceeded' AND last_ms-first_ms>1 THEN",
        "      reason='source_budget_refined',available_at=clock_timestamp() WHERE request_key=p_request_key;",
      ],
      fn_discover_horse_observation_requests: [],
      fn_horse_committed_observation_snapshot: [
        '  SELECT count(*)::integer INTO v_count FROM (',
        '    SELECT 1 FROM public.ca_hand_player_idx i',
        '     WHERE i.user_id = p_actor AND i.created_at > v_from AND i.created_at <= v_through',
        '       AND EXISTS (SELECT 1 FROM public.hand_history h',
        '                    WHERE h.created_at = i.created_at AND h.id = i.hand_id)',
        '     LIMIT 513) overflow;',
        '  IF v_count > 512 THEN',
        "      'handCount',v_count,'actionCount',NULL,'sourceBytes',NULL,'hands','[]'::jsonb);",
      ],
    };
    for (const [name, [file]] of Object.entries(PREIMAGES)) {
      const after = body(MIGRATION, name);
      for (const line of body(read(file), name).split('\n')) {
        if (!line.trim() || replaced[name].includes(line)) continue;
        expect(after.includes(line), `${name} lost: ${line}`).toBe(true);
      }
    }
  });
  it('keeps each SECURITY mode, setting and grant, and asserts them after', () => {
    const header = (name: string) => {
      const i = MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(');
      return MIGRATION.slice(i, MIGRATION.indexOf('AS $function$', i));
    };
    for (const name of [
      'fn_claim_horse_observation_capture',
      'fn_finish_horse_observation_capture',
      'fn_discover_horse_observation_requests',
    ]) {
      expect(header(name)).toContain('SECURITY DEFINER');
      expect(header(name)).toContain("SET lock_timeout TO '2s'");
      expect(header(name)).not.toContain('STABLE');
    }
    expect(header('fn_horse_committed_observation_snapshot')).toContain('STABLE');
    expect(header('fn_horse_committed_observation_snapshot')).not.toContain('SECURITY DEFINER');
    expect(header('fn_horse_capture_hand_budget_through')).not.toContain('SECURITY DEFINER');
    for (const sig of [
      'fn_claim_horse_observation_capture(uuid)',
      'fn_finish_horse_observation_capture(text, uuid, text, text)',
      'fn_discover_horse_observation_requests()',
      'fn_horse_committed_observation_snapshot(uuid, bigint, bigint)',
      'fn_horse_capture_hand_budget_through(uuid, bigint, bigint, integer)',
    ]) {
      expect(MIGRATION).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
      expect(MIGRATION).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
    }
    const post = MIGRATION.slice(MIGRATION.indexOf('$horse_capture_drains_in_order_post$'));
    expect(post).toContain('HORSE_CAPTURE_DRAINS_IN_ORDER_POSTIMAGE');
    for (const check of [
      'p.prosecdef <> expected.secdef',
      'p.provolatile::text <> expected.volatility',
      'p.proconfig IS DISTINCT FROM expected.config',
      "NOT has_function_privilege('service_role', p.oid, 'EXECUTE')",
      "has_function_privilege('anon', p.oid, 'EXECUTE')",
      "has_function_privilege('authenticated', p.oid, 'EXECUTE')",
    ])
      expect(post).toContain(check);
    expect(post.indexOf('HORSE_CAPTURE_DRAINS_IN_ORDER_POSTIMAGE')).toBeLessThan(post.indexOf('COMMIT;'));
  });
  it('has a native proof that runs it against real PostgreSQL on every change', () => {
    const proof = read('scripts/ci/test-horse-capture-drains-in-order.py');
    expect(proof).toContain(FILE.split('/').pop()!);
    const workflow = read('.github/workflows/horse-snapshot-overflow-precheck.yml');
    expect(workflow).toContain('python3 scripts/ci/test-horse-capture-drains-in-order.py');
    expect(workflow).toContain('- ' + FILE);
  });
});

describe('the engine mirrors the database', () => {
  const capture = read('server/src/services/HorseObservationCapture.ts');
  const loop = read('server/src/services/horseAdaptiveJournal/loop.ts');
  it('accepts the rest-of-request next slice and a refine of a timed-out read', () => {
    expect(capture).toContain('data.nextThroughMs !== request.throughMs &&');
    expect(capture).toContain(
      "(reason === 'source_budget_exceeded' || reason === 'source_unavailable') &&"
    );
    expect(capture).toContain('data.nextThroughMs < slice.throughMs');
  });
  it('runs capture slices back to back while the journal has no work, and keeps the fairness pause otherwise', () => {
    expect(loop).toContain('export const CAPTURE_BACK_TO_BACK_PAUSE_MS = 0;');
    expect(loop).toContain('const backToBack: boolean = captureProgress && !captureFromBacklog;');
    expect(loop).toContain('captureFromBacklog = !journalIdle && !ownBatch;');
    expect(loop).toContain('export const CAPTURE_FAIRNESS_JOURNAL_TURNS = 8;');
    // A zero pause still yields once and still runs a due audit step.
    expect(loop).toContain('if (!signal.aborted) await d.wait(0, signal);');
  });
});
