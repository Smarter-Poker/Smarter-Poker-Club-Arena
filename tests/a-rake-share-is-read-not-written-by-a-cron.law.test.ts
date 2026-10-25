/**
 * A RAKE SHARE IS READ, NOT WRITTEN BY A CRON (Dan 2026-10-24, CLAUDE.md 10.12).
 *
 * Dan ruled that from 2026-10-24 22:21:59.97593 UTC half of WooWoo's earned
 * rake in KINGS CLUB is reported as KingFish's. It first reached production as
 * migration 20261024223153 (recorded byte-exact in this repo): pg_cron job
 * `woowoo-half-rake-to-kingfish` ran a sync function every five minutes that
 * upserted `*-split-<day>` rows into smarter_private.player_fee_redemptions. A
 * compensating write: the reported figures trailed the hands by up to five
 * minutes and the rule lived only as constants in a function body.
 *
 * 20261025030629 replaced it with smarter_private.player_rake_share_rules,
 * applied by the three fee readers at read time. This pins both halves:
 *
 *   1. After every migration in order, no scheduled cron job's command touches
 *      the fee redemptions or the rule table, directly or through a function
 *      that writes the redemptions.
 *   2. The latest definition of each reader reads the rule (the fee reader the
 *      table itself, the two statistics readers the shared helper, which reads
 *      the table), and none of them looks for a cron's split rows.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = 'supabase/migrations';
const SHARE = '20261025030629_a_standing_rake_share_replaces_the_woowoo_cron.sql';
const OUT_OF_BAND = '20261024223153_woowoo_half_earned_rake_credited_to_kingfish.sql';

type Migration = { file: string; sql: string };

function migrations(): Migration[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(DIR, file), 'utf8') }));
}

const REDEMPTIONS = /player_fee_redemptions/i;
const WRITES_REDEMPTIONS =
  /(insert\s+into|update|delete\s+from)\s+smarter_private\.player_fee_redemptions/i;

/**
 * Replays cron.schedule / cron.unschedule and function create / drop across
 * the files in order, and returns the jobs still scheduled at the end whose
 * command reaches the fee redemptions.
 */
export function cronJobsThatWriteFeeRedemptions(files: Migration[]): string[] {
  const jobs = new Map<string, string>();
  const writers = new Set<string>();
  for (const { sql } of files) {
    if (!/cron\.|player_fee_redemptions|drop\s+function/i.test(sql)) continue;
    // Functions whose body writes the redemptions (one CREATE ... $tag$ body $tag$ each).
    const fn =
      /create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\([^)]*\)[\s\S]*?\bas\s+(\$\w*\$)([\s\S]*?)\2/gi;
    for (const m of sql.matchAll(fn)) {
      const name = m[1].toLowerCase().replace(/^public\./, '');
      if (WRITES_REDEMPTIONS.test(m[3])) writers.add(name);
      else writers.delete(name);
    }
    for (const m of sql.matchAll(/drop\s+function\s+(?:if\s+exists\s+)?([\w.]+)/gi)) {
      writers.delete(m[1].toLowerCase().replace(/^public\./, ''));
    }
    for (const m of sql.matchAll(
      /cron\.schedule\(\s*'([^']+)'\s*,\s*'[^']*'\s*,\s*(\$\w*\$[\s\S]*?\$\w*\$|'(?:[^']|'')*')\s*\)/gi,
    )) {
      jobs.set(m[1], m[2]);
    }
    for (const m of sql.matchAll(/cron\.unschedule\(\s*'([^']+)'\s*\)/gi)) jobs.delete(m[1]);
    // The by-jobid form: FOR ... SELECT jobid FROM cron.job WHERE jobname = 'x' ... cron.unschedule(...)
    if (/cron\.unschedule\(/i.test(sql)) {
      for (const m of sql.matchAll(/from\s+cron\.job\s+\w*\s*where\s+\w*\.?jobname\s*=\s*'([^']+)'/gi)) {
        jobs.delete(m[1]);
      }
    }
  }
  const bad: string[] = [];
  for (const [name, command] of jobs) {
    const reaches =
      REDEMPTIONS.test(command) ||
      /player_rake_share_rules/i.test(command) ||
      [...writers].some((w) => command.toLowerCase().includes(w));
    if (reaches) bad.push(name);
  }
  return bad;
}

function latestDefinition(files: Migration[], signature: string): Migration {
  const create = new RegExp(`create\\s+or\\s+replace\\s+function\\s+${signature.replace('.', '\\.')}\\(`, 'i');
  const patch = new RegExp(`pg_get_functiondef\\(\\s*'${signature.replace('.', '\\.')}\\(`, 'i');
  const hits = files.filter((m) => create.test(m.sql) || patch.test(m.sql));
  expect(hits.length, `${signature} has a definition`).toBeGreaterThan(0);
  return hits[hits.length - 1];
}

function body(sql: string, signature: string): string {
  const start = sql.search(
    new RegExp(`create\\s+or\\s+replace\\s+function\\s+${signature.replace('.', '\\.')}\\(`, 'i'),
  );
  expect(start, `${signature} is created, not patched`).toBeGreaterThanOrEqual(0);
  const rest = sql.slice(start);
  const end = rest.indexOf('$function$;');
  expect(end).toBeGreaterThan(0);
  return rest.slice(0, end);
}

describe('a rake share is read, not written by a cron', () => {
  const all = migrations();

  it('leaves no cron job writing the fee redemptions after every migration', () => {
    expect(cronJobsThatWriteFeeRedemptions(all)).toEqual([]);
  });

  it('would have caught the five-minute WooWoo cron', () => {
    const upTo = all.filter((m) => m.file <= OUT_OF_BAND);
    expect(upTo.some((m) => m.file === OUT_OF_BAND)).toBe(true);
    expect(cronJobsThatWriteFeeRedemptions(upTo)).toEqual(['woowoo-half-rake-to-kingfish']);
  });

  it('retires the job, its function and only its split rows in one transaction', () => {
    const share = all.find((m) => m.file === SHARE);
    expect(share).toBeDefined();
    const sql = share!.sql;
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("PERFORM cron.unschedule('woowoo-half-rake-to-kingfish');");
    expect(sql).toContain('DROP FUNCTION smarter_private.fn_woowoo_half_rake_to_kingfish_sync();');
    expect(sql).toContain("r.operation_key = 'woowoo-half-split-' || r.effective_on");
    expect(sql).toContain("r.operation_key = 'kingfish-from-woowoo-split-' || r.effective_on");
    // The two fixed 520.52 events and the October 23 redemption stay declared.
    expect(sql).toContain("('woowoo-half-earned-rake-20261024'");
    expect(sql).toContain("('kingfish-from-woowoo-half-earned-rake-20261024'");
    expect(sql).toContain('CHECK (amount_cents <> 0)');
    // Guarded against the exact bodies it replaces.
    for (const md5 of [
      '880e4cb61670362810c397980e763abc',
      '58d29df1098c97800ea79759b6f67dd5',
      '28ef1947a0bf2b455ea3addb95d5589a',
      '07856466d30eb04ce34698e82110c1f7',
    ]) {
      expect(sql).toContain(md5);
    }
  });

  it('keeps the rule table service-only', () => {
    const sql = all.find((m) => m.file === SHARE)!.sql;
    expect(sql).toContain('ALTER TABLE smarter_private.player_rake_share_rules ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain(
      'REVOKE ALL ON smarter_private.player_rake_share_rules FROM PUBLIC, anon, authenticated;',
    );
    expect(sql).toContain('GRANT SELECT ON smarter_private.player_rake_share_rules TO service_role;');
  });

  it('has every reader apply the rule at read time', () => {
    const helper = body(
      all.find((m) => m.file === SHARE)!.sql.replace(
        'CREATE FUNCTION smarter_private.fn_player_rake_share_hand_cents(',
        'CREATE OR REPLACE FUNCTION smarter_private.fn_player_rake_share_hand_cents(',
      ),
      'smarter_private.fn_player_rake_share_hand_cents',
    );
    expect(helper).toContain('FROM smarter_private.player_rake_share_rules r');
    expect(helper).toContain('public.cash_participant_funding_receipts');

    const fee = 'public.ca_club_member_fee_totals';
    const feeBody = body(latestDefinition(all, fee).sql, fee);
    expect(feeBody).toContain('FROM smarter_private.player_rake_share_rules r');
    expect(feeBody).toContain('JOIN public.rake_attributions ra');

    for (const reader of ['public.ca_player_rake_stats', 'public.ca_player_rake_stats_by_club']) {
      const b = body(latestDefinition(all, reader).sql, reader);
      expect(b, reader).toContain('smarter_private.fn_player_rake_share_hand_cents(');
    }
    for (const reader of [fee, 'public.ca_player_rake_stats', 'public.ca_player_rake_stats_by_club']) {
      expect(body(latestDefinition(all, reader).sql, reader), reader).not.toMatch(/-split-/);
    }
  });
});
