/**
 * LAW: a late home game RSVP opens a plain direct message.
 * ===========================================================================
 * rsvp_to_home_game answers an RSVP to a game that has already started with
 * "This game has already started. Message the host directly." and a link to
 * that conversation. It called
 *
 *     fn_get_or_create_conversation(p_caller_user_id, v_game.host_id, 'direct')
 *
 * but the only overloads are (uuid, uuid) and
 * (uuid, uuid, p_context_entity_id uuid, p_context_entity_type text). Three
 * arguments resolve to the four-argument one, 'direct' is cast to a uuid, and
 * the call raised 22P02 for every late RSVP (proved on production in a
 * rolled-back probe on 2026-10-19). A plain direct message is the
 * two-argument overload.
 *
 * Fixed in 20261019093626_late_home_game_rsvp_opens_a_plain_direct_message.
 * This pins the RSVP call, and refuses the same shape anywhere: no current
 * function declaration passes a quoted string as the third argument, where the
 * only three-argument resolution takes a uuid.
 */
import { describe, expect, it } from 'vitest';
import { functionBody, latestDeclaring, migrationFiles, readMigration } from './helpers/migrations';

const DECLARATION = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(/gi;
const STRING_AS_CONTEXT_ID = /fn_get_or_create_conversation\(\s*[^,()]+,\s*[^,()]+,\s*'[^']*'\s*\)/;

describe('a late home game RSVP opens a plain direct message', () => {
  it('rsvp_to_home_game calls the two-argument direct conversation', () => {
    const { sql } = latestDeclaring('rsvp_to_home_game');
    const body = functionBody(sql, 'rsvp_to_home_game');
    expect(body).toContain("'GAME_STARTED'");
    expect(body).toMatch(
      /public\.fn_get_or_create_conversation\(\s*p_caller_user_id,\s*v_game\.host_id\s*\)/
    );
    expect(body).not.toMatch(STRING_AS_CONTEXT_ID);
  });

  it('no current declaration passes a string where the context id is a uuid', () => {
    const current = new Map<string, string>();
    for (const file of migrationFiles()) {
      const sql = readMigration(file);
      if (!sql.includes('FUNCTION public.')) continue;
      for (const match of sql.matchAll(DECLARATION)) {
        const rest = sql.slice(match.index);
        const quote = /\bAS\s+(\$\w*\$)/i.exec(rest);
        if (!quote) continue;
        const start = quote.index + quote[0].length;
        const end = rest.indexOf(quote[1], start);
        if (end >= 0) current.set(match[1], `${file}\n${rest.slice(start, end)}`);
      }
    }
    const offenders = [...current]
      .filter(([, text]) => STRING_AS_CONTEXT_ID.test(text))
      .map(([name, text]) => `${name} (${text.split('\n')[0]})`);
    expect(offenders).toEqual([]);
  }, 60_000);
});
