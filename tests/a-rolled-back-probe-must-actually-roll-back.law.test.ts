/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A ROLLED-BACK PROBE MUST ACTUALLY ROLL BACK (2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * CLAUDE.md 11.5 rule 1 and 10.9 clear-path test 4 both require that a function
 * touching money is proved inside a transaction that gets rolled back, and both
 * point at `scripts/dev/probe-rpc.sql` as the pattern to copy. Until today the
 * header of that file read:
 *
 *   USE IT LIKE THIS (psql, or the Supabase MCP one statement at a time)
 *
 * The parenthetical was false, and false in the direction that costs money.
 * A transaction does not span two Supabase MCP calls. One call is one
 * transaction and the call boundary ends it whatever the SQL said, so the
 * three-call shape an agent naturally writes -
 *
 *   call 1:  BEGIN;
 *   call 2:  <the probe>
 *   call 3:  ROLLBACK;
 *
 * - leaves the probe alone in the middle as its own COMMITTED transaction, and
 * then returns success from a ROLLBACK that rolled back nothing.
 *
 * MEASURED on production 2026-09-04, two consecutive MCP calls:
 *
 *   call 1:  begin; select pg_current_xact_id();   -> 275731009
 *   call 2:  select pg_current_xact_id(),
 *                   txid_status(275731009);        -> 275731249, 'aborted'
 *
 * Different transaction ids, and the first aborted at its own call boundary.
 * `Prefer: tx=rollback` does not help either: PostgREST honours it only under
 * `db-tx-end = rollback-allowed`, which this server does not set, so the header
 * is accepted and ignored.
 *
 * What it cost: on 2026-09-04 an agent running the daily horse audit probed a
 * job function this way and committed a `horse_job_runs` row for a run that
 * never happened. It noticed only because the committed row claimed 123 hands
 * in 9ms. Nothing on the platform would have caught it otherwise, and the same
 * shape over a money RPC is 11.5's original incident all over again.
 *
 * THE LAW. `probe-rpc.sql` must keep teaching both transports and must never
 * again tell an agent that the multi-statement pattern is safe over the MCP:
 *
 *   1. it names the MCP trap explicitly;
 *   2. it carries a single-call, self-aborting `DO` block for MCP callers,
 *      whose closing `RAISE EXCEPTION` is what performs the rollback;
 *   3. its header does not bless the MCP for the psql pattern.
 *
 * Registry: docs/laws.d/a-rolled-back-probe-must-actually-roll-back.md
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROBE_PATH = resolve(__dirname, '../scripts/dev/probe-rpc.sql');
const CLAUDE_PATH = resolve(__dirname, '../CLAUDE.md');

const PROBE = readFileSync(PROBE_PATH, 'utf8');
const CLAUDE = readFileSync(CLAUDE_PATH, 'utf8');

describe('a rolled-back probe must actually roll back', () => {
  it('probe-rpc.sql never blesses the MCP for the multi-statement pattern', () => {
    // The exact sentence that caused the 2026-09-04 commit, and any close
    // rewording of it. The psql pattern and the MCP must never be offered as
    // interchangeable in one breath.
    expect(PROBE).not.toMatch(/psql,\s*or\s+the\s+supabase\s+mcp/i);
    expect(PROBE).not.toMatch(/mcp\s+one\s+statement\s+at\s+a\s+time/i);
  });

  it('probe-rpc.sql states that a transaction does not span two MCP calls', () => {
    expect(PROBE).toMatch(/transaction\s+does\s+not\s+span\s+two\s+(supabase\s+)?mcp\s+calls/i);
    expect(PROBE).toMatch(/one\s+call\s+is\s+one\s+transaction/i);
  });

  it('probe-rpc.sql carries a single-call self-aborting DO block for MCP callers', () => {
    // The block exists...
    expect(PROBE).toMatch(/\$mcp_probe\$/);
    // ...and ends by raising, which is the only thing that rolls it back.
    const block = PROBE.slice(PROBE.indexOf('$mcp_probe$'));
    expect(block).toMatch(/RAISE\s+EXCEPTION/i);
  });

  it('probe-rpc.sql tells the reader that an error is the success case', () => {
    // A probe of this shape that returns success has COMMITTED. An agent who
    // does not know that reads its own incident as a clean run.
    expect(PROBE).toMatch(/error\s+is\s+the\s+success\s+case/i);
  });

  it('CLAUDE.md 11.5 carries the transport warning next to the rule it qualifies', () => {
    expect(CLAUDE).toMatch(/a\s+transaction\s+does\s+not\s+span\s+two\s+supabase\s+mcp\s+calls/i);
    // And 10.9's clear-path test points at it, because that is the section an
    // agent is reading when it decides it may settle money on its own.
    //
    // Bounded by the LIST ITEM, never by a byte count: clear-path test 4 runs
    // from its own numbered marker to the start of test 5. A fixed window here
    // is the failure tests/unit/noFixedSizeSourceWindows.test.ts exists to
    // stop - it drifts off the end of the thing it guards as the prose grows,
    // in whichever direction happens to be quiet.
    const clearPathFour = /^4\. \*\*You proved it in a transaction[\s\S]*?(?=^5\. \*\*)/m.exec(
      CLAUDE
    );
    expect(clearPathFour, 'CLAUDE.md 10.9 clear-path test 4 not found').not.toBeNull();
    expect(clearPathFour![0]).toMatch(/does\s+not\s+span\s+two\s+calls/i);
  });

  it('the measured evidence stays in the file, so nobody re-litigates it from memory', () => {
    // Two transaction ids and an 'aborted' status are what turn this from an
    // opinion about PostgREST into something a reader can check.
    expect(PROBE).toMatch(/275731009/);
    expect(PROBE).toMatch(/aborted/i);
  });
});
