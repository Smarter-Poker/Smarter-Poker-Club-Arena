/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A MEMBERSHIP HAS NO ID OF ITS OWN (2026-09-29, binding)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * club_members is keyed by (club_id, user_id). It has no `id` column.
 *
 * fn_remove_settled_club_member read `v_target.id` and `cm.id` - the downline
 * check, the audit row and the departure UPDATE - and PL/pgSQL does not check
 * a record's fields until the line runs. The function was created cleanly and
 * failed at run time, 42703 `record "v_target" has no field "id"`, for every
 * settled member club staff tried to remove (measured on production as SHARK
 * CLUB's owner). No staff removal had ever succeeded; audit_trail held no
 * depart_club_member row.
 *
 * THE LAW, over the definition in force of every function in the corpus: a
 * variable declared `club_members%ROWTYPE` is never read as `.id`, and a
 * function that aliases club_members as `cm` never reads `cm.id`. A membership
 * is named by its club and its player.
 *
 * Registry: docs/laws.d/a-membership-has-no-id-of-its-own.md
 */
import { describe, expect, it } from 'vitest';
import { latestDeclaring, migrationFiles, readMigration } from './helpers/migrations';

const DECLARATION = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(/gi;

/** The BODY of each function's last declaration: from `AS $tag$` to its closing `$tag$`. */
function latestDeclarations(): Map<string, { file: string; text: string }> {
  const latest = new Map<string, { file: string; text: string }>();
  for (const file of migrationFiles()) {
    const sql = readMigration(file);
    if (!/club_members/i.test(sql)) continue;
    for (const m of sql.matchAll(DECLARATION)) {
      const from = (m.index ?? 0) + m[0].length;
      const open = /\bAS\s+(\$[A-Za-z_]*\$)/i.exec(sql.slice(from));
      if (!open) continue;
      const bodyStart = from + open.index + open[0].length;
      const bodyEnd = sql.indexOf(open[1], bodyStart);
      if (bodyEnd < 0) continue;
      latest.set(m[1], { file, text: sql.slice(bodyStart, bodyEnd).replace(/--[^\n]*/g, '') });
    }
  }
  return latest;
}

describe('a membership is named by its club and its player', () => {
  it('fn_remove_settled_club_member finds, audits and departs the membership by (club_id, user_id)', () => {
    const { name, sql } = latestDeclaring('fn_remove_settled_club_member');
    const code = sql.replace(/--[^\n]*/g, '');
    expect(code, name).not.toMatch(/\bv_target\.id\b/);
    expect(code, name).not.toMatch(/\bcm\.id\b/);
    expect(code).toMatch(/cm\.agent_id = p_user_id\s+OR cm\.parent_agent_id = p_user_id/);
    expect(code).toMatch(/'depart_club_member', 'membership', v_target\.user_id, p_club_id/);
    expect(code).toMatch(
      /WHERE cm\.club_id = p_club_id\s+AND cm\.user_id = p_user_id\s+AND cm\.membership_lifecycle_status = 'active'/
    );
  });

  it('no function in force reads .id from a club_members row', () => {
    const offenders: string[] = [];
    for (const [fn, { file, text }] of latestDeclarations()) {
      const vars = [...text.matchAll(/(\w+)\s+(?:public\.)?club_members%ROWTYPE/gi)].map(
        (m) => m[1]
      );
      for (const v of vars) {
        if (new RegExp(`\\b${v}\\.id\\b`).test(text)) offenders.push(`${fn} (${file}): ${v}.id`);
      }
      const cmIsMembers = /\bclub_members\s+(?:AS\s+)?cm\b/i.test(text);
      const cmIsOther =
        /\b(?!club_members\b)\w+\s+(?:AS\s+)?cm\b(?=\s*(?:WHERE|JOIN|ON|,|\)|$))/i.test(
          text.replace(/\bclub_members\s+(?:AS\s+)?cm\b/gi, '')
        );
      if (cmIsMembers && !cmIsOther && /\bcm\.id\b/.test(text))
        offenders.push(`${fn} (${file}): cm.id`);
    }
    expect(offenders).toEqual([]);
  });
});
