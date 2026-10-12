/**
 * A RETAINED TOURNAMENT HAND SETTLES PAST AN ADD-ON CREDITED WHILE IT WAITED (2026-10-02)
 *
 * 09a56a25 "Prime Time Free Buy (NLH)" dealt nothing on its three 9-handed
 * tables from 01:49 UTC. Each held a finished hand retained by dead
 * generation 68bbf392, and on each one chair had been credited the event's
 * 10,000-chip add-on while the hand waited. fn_ca_resume_hand_submission
 * demanded every named chair hold exactly stack_before and refused
 * HAND_SUBMISSION_HANDOFF_STATE_CHANGED on every resume.
 *
 * 20261002060742 admits, on a tournament table only, a chair holding exactly
 * stack_before + the event's addon_chips when its registration bought the
 * add-on. The settlement runs in delta mode and preserves the credit. This
 * law pins the one anchored edit, the digests and the scope.
 *
 * docs/changelog/2026-10-02-a-retained-tournament-hand-settles-past-an-add-on-credited-while-it-waited.md
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const FILE = readFileSync(
  join(
    MIGRATIONS,
    '20261002060742_a_retained_tournament_hand_settles_past_an_add_on_credited_w.sql'
  ),
  'utf8'
);

/** prosrc of the live door on 2026-10-02 06:06 UTC, as 20260929031904 installed it. */
const PRE_MD5 = '4cc9df92758a39ed78ce6ade1e26849c';
const PRE_DEF_MD5 = '0d0668ccaba3d7215ebebad1dff203a6';
/** Its body after exactly the one edit below, computed from that live prosrc. */
const POST_MD5 = '09fdd355fff94da94c4dcdc8667364d4';
const POST_DEF_MD5 = 'a29b3dbcc63bba8bcd61dd127241f862';

const STRICT = "       AND seat.left_at IS NULL AND seat.stack=(x->>'stack_before')::numeric))\n";

function edits(): Array<{ name: string; old: string; next: string }> {
  const block = FILE.slice(
    FILE.indexOf('DO $retained_addon_patch$'),
    FILE.indexOf('$retained_addon_patch$;')
  );
  const out: Array<{ name: string; old: string; next: string }> = [];
  const re = /-- (\w+)\n {2}v_old := \$a\$([\s\S]*?)\$a\$;\n {2}v_new := \$b\$([\s\S]*?)\$b\$;/g;
  for (let m = re.exec(block); m; m = re.exec(block))
    out.push({ name: m[1], old: m[2], next: m[3] });
  return out;
}

describe('a retained tournament hand settles past an add-on credited while it waited', () => {
  it('is one transaction that refuses unless the live door is the exact pre-image', () => {
    expect(FILE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(FILE.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(FILE).toContain("SET LOCAL lock_timeout = '2s';");
    expect(FILE).toContain(`AND md5(p.prosrc) = '${PRE_MD5}'`);
    expect(FILE).toContain(`AND md5(pg_get_functiondef(p.oid)) = '${PRE_DEF_MD5}'`);
    expect(FILE).toContain(`AND md5(p.prosrc) = '${POST_MD5}'`);
    expect(FILE).toContain(`AND md5(pg_get_functiondef(p.oid)) = '${POST_DEF_MD5}'`);
    expect(FILE).toContain("AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'");
    expect(FILE).toContain(`@live-proof: (SELECT md5(prosrc)='${POST_MD5}'`);
    expect(FILE).toContain('public.fn_ca_break_window_refuses_migrations(now())');
  });

  it('applies one anchored edit to the stack_before clause, required to occur exactly once', () => {
    const e = edits();
    expect(e.map((x) => x.name)).toEqual(['addon']);
    expect(e[0].old).toBe(STRICT);
    expect(FILE).toContain("RAISE EXCEPTION 'RETAINED_ADDON_ANCHOR_FOUND_%_TIMES', n;");
  });

  it('admits only the event add-on, only on a tournament table, only for a registration that bought it', () => {
    const next = edits()[0].next;
    expect(next).toContain(
      "AND seat.left_at IS NULL AND (seat.stack=(x->>'stack_before')::numeric"
    );
    expect(next).toContain(
      'OR (tour IS NOT NULL AND EXISTS(SELECT 1 FROM public.tournament_players tp'
    );
    expect(next).toContain(
      'WHERE tp.tournament_id=tour AND tp.user_id=seat.user_id AND tp.add_on IS TRUE'
    );
    expect(next).toContain('AND COALESCE(ev.addon_chips,0)>0');
    expect(next).toContain("AND seat.stack=(x->>'stack_before')::numeric+ev.addon_chips)))))");
    // The edit adds one OR branch and nothing else: removing it restores the clause.
    const restored = next
      .replace(/\n {7}-- [^\n]*/g, '')
      .replace(/\n {7}OR \(tour IS NOT NULL[\s\S]*addon_chips\)\)\)\)\)/, '))')
      .replace('AND (seat.stack=', 'AND seat.stack=');
    expect(restored).toBe(STRICT);
  });

  it('writes no row and schedules nothing', () => {
    const code = FILE.split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(code).not.toMatch(
      /\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+(public|smarter_private)\.)/i
    );
    expect(code).not.toMatch(/cron\./i);
    expect(code).not.toMatch(/^GRANT /m);
  });

  it('stays digest-consistent with its own body edit', () => {
    const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');
    expect(md5(STRICT)).not.toBe(md5(edits()[0].next));
  });
});
