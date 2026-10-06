/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - "ONLINE" HAS ONE DEFINITION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan's law: a player must never be able to tell a house player (a horse)
 * from a person. Presence is one of the places that law is easiest to break,
 * because there were several answers to "is this person online" and they did
 * not agree:
 *
 *  - the presence door, fn_profile_presence: profiles.is_online AND a
 *    last_seen heartbeat under five minutes old;
 *  - the raw profiles.is_online flag, read straight from the table (or from a
 *    realtime row payload) - on 2026-10-05 true on 768 of 927 human rows and
 *    442 of 1,000 horse rows while not one human heartbeat was fresh, so it
 *    showed most accounts online forever;
 *  - a Realtime presence channel, which only people can ever join.
 *
 * Since migration 20261005174041 horses keep a real heartbeat in the same two
 * columns, so the door is the one answer that treats every account alike.
 * This pins that the Club Arena client decides "online" from the door alone:
 *
 *  1. no read of profiles names is_online - not in a select (direct or
 *     embedded), a filter or an order;
 *  2. no realtime subscription on profiles decides anything from is_online or
 *     last_seen in its payload;
 *  3. the browser never computes freshness itself: no code names last_seen,
 *     and only the door's wrapper calls fn_profile_presence;
 *  4. the shared watcher re-asks every watched account, batched, on a timer
 *     shorter than the five-minute window, so a dot goes dark when its
 *     heartbeat goes stale;
 *  5. every surface that shows a person online asks through it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blankNonCode, sliceMethod } from './helpers/sourceWindow';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const word = (c: string) => new RegExp(`(^|[^A-Za-z0-9_])${c}([^A-Za-z0-9_]|$)`);
const IS_ONLINE = word('is_online');
const LAST_SEEN = word('last_seen');
/** Comments out, string literals kept (a column name lives in a string). */
const withoutComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1 ');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|__tests__/.test(p)) out.push(p);
  }
  return out;
}

const FILES = sourceFiles(join(ROOT, 'src')).map((path) => {
  const src = readFileSync(path, 'utf8');
  return { file: relative(ROOT, path), src, blank: blankNonCode(src) };
});

/** Every string constant declared in src, by name, to resolve `${NAME}` in a column list. */
const CONSTANTS = (() => {
  const map = new Map<string, string>();
  const decl = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*(['`])([^'`]*?)\2/g;
  for (const { src } of FILES) {
    for (const m of src.matchAll(decl)) if (!map.has(m[1])) map.set(m[1], m[3]);
  }
  return map;
})();
const resolveConstants = (text: string, depth = 0): string =>
  depth > 4
    ? text
    : text.replace(/\$\{\s*([A-Z][A-Z0-9_]*)\s*\}/g, (all, name: string) =>
        CONSTANTS.has(name) ? resolveConstants(CONSTANTS.get(name) as string, depth + 1) : all
      );

/** Every call of `.<method>(` in code, as its full raw text up to the matching paren. */
function calls(methods: readonly string[]) {
  const out: { where: string; text: string }[] = [];
  const re = new RegExp(`\\.(${methods.join('|')})\\(`, 'g');
  for (const { file, src, blank } of FILES) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(blank))) {
      const open = m.index + m[0].length - 1;
      let depth = 0;
      let close = -1;
      for (let i = open; i < blank.length; i++) {
        if (blank[i] === '(') depth++;
        else if (blank[i] === ')' && --depth === 0) {
          close = i;
          break;
        }
      }
      if (close < 0) continue;
      out.push({
        where: `${file}:${src.slice(0, m.index).split('\n').length}`,
        text: src.slice(m.index, close + 1),
      });
    }
  }
  return out;
}

describe('LAW: online is decided by the presence door alone', () => {
  it('no read names profiles.is_online - not a select, an embedded select, a filter or an order', () => {
    const reads = calls([
      'select',
      'eq',
      'neq',
      'is',
      'in',
      'not',
      'or',
      'order',
      'filter',
      'match',
    ]);
    expect(reads.length).toBeGreaterThan(500);
    // A column is named in a string (or a template) - an array's
    // `.filter((f) => f.is_online)` over rows an RPC answered is not a read.
    const literals = (text: string) =>
      [...withoutComments(text).matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)].map((m) =>
        resolveConstants(m[2])
      );
    const offending = reads
      .filter(
        (r) =>
          literals(r.text).some((l) => IS_ONLINE.test(l)) ||
          (r.text.startsWith('.match(') && IS_ONLINE.test(withoutComments(r.text)))
      )
      .map((r) => r.where);
    expect(
      offending,
      'ask readPresence() / useProfilePresence(): the raw flag stays true long after somebody leaves'
    ).toEqual([]);
  });

  it('no realtime subscription on profiles decides presence from its payload', () => {
    const subs = calls(['on']).filter(
      (c) => c.text.includes('postgres_changes') && /table:\s*['"`]profiles['"`]/.test(c.text)
    );
    const offending = subs
      .filter((c) => {
        const body = withoutComments(c.text);
        return IS_ONLINE.test(body) || LAST_SEEN.test(body);
      })
      .map((c) => c.where);
    expect(
      offending,
      'a row payload cannot say a heartbeat is fresh: re-ask the presence door instead'
    ).toEqual([]);
  });

  it('the browser never judges freshness itself, and only the door wrapper calls the door', () => {
    // Identifiers only: a private column may be NAMED in a string (the owner
    // door lists it), never read as a value.
    const freshnessInCode = FILES.filter(({ blank }) => LAST_SEEN.test(blank)).map((f) => f.file);
    expect(freshnessInCode).toEqual([]);
    const doorCallers = FILES.filter(({ src }) =>
      /rpc\(\s*['"`]fn_profile_presence['"`]/.test(src)
    ).map((f) => f.file);
    expect(doorCallers).toEqual(['src/lib/ownProfile.ts']);
  });

  it('no Realtime presence channel is a second definition of online on the social surfaces', () => {
    for (const file of [
      'src/pages/FriendsPage.tsx',
      'src/utils/socialGraph.ts',
      'src/components/social/FriendListPanel.tsx',
      'src/components/social/OnlineFriendsPill.tsx',
      'src/components/social/PresenceIndicator.tsx',
    ]) {
      const code = blankNonCode(read(file));
      expect(code, file).not.toContain('presenceState(');
    }
    const gate = sliceMethod(read('src/utils/socialGraph.ts'), 'isSocialProfileOnline(');
    expect(gate).toContain('livePresence: ReadonlyMap<string, boolean>');
    expect(gate).not.toContain('Set<string>');
  });
});

describe('LAW: an answer is re-asked before its heartbeat can go stale', () => {
  const WATCHER = read('src/lib/profilePresence.ts');

  it('re-asks every watched account, in one batched call, inside the five-minute window', () => {
    const m = WATCHER.match(/export const PRESENCE_RECHECK_MS = ([0-9_]+);/);
    expect(m, 'PRESENCE_RECHECK_MS must be a literal').not.toBeNull();
    const ms = Number((m as RegExpMatchArray)[1].replace(/_/g, ''));
    expect(ms).toBeGreaterThanOrEqual(30_000); // not hammering the database
    expect(ms).toBeLessThan(5 * 60_000); // shorter than the freshness window
    expect(sliceMethod(WATCHER, 'function start()')).toContain(
      'setInterval(recheckAll, PRESENCE_RECHECK_MS)'
    );
    // One call for every watched id, not one per dot.
    expect(sliceMethod(WATCHER, 'function recheckAll()')).toContain('ask([...watchedIds()])');
    expect(sliceMethod(WATCHER, 'async function ask(')).toContain('await readPresence(ids)');
  });

  it('an unreadable answer is offline, never the last "online"', () => {
    const ask = sliceMethod(WATCHER, 'async function ask(');
    // A failed read leaves `fresh` null, and every asked id is set from it.
    expect(ask).toContain('let fresh: Map<string, boolean> | null = null;');
    expect(ask).toContain('answers.set(id, fresh?.get(id) === true);');
    // The behaviour itself: tests/unit/profilePresence.test.ts.
  });

  it('an answer older than the last ask, or than the last watcher, is never shown (2026-10-05 audit)', () => {
    const ask = sliceMethod(WATCHER, 'async function ask(');
    expect(ask).toContain('if (askedIn !== epoch) return;');
    expect(ask).toContain('if ((answeredBy.get(id) ?? 0) > seq) continue;');
  });
});

describe('LAW: every surface that shows a person online asks the door', () => {
  const asks: [string, string][] = [
    ['src/components/social/PresenceIndicator.tsx', 'useIsProfileOnline('],
    ['src/components/social/FriendListPanel.tsx', 'useProfilePresence('],
    ['src/components/social/FriendSuggestions.tsx', 'useProfilePresence('],
    ['src/components/social/OnlineFriendsPill.tsx', 'readPresence('],
    ['src/pages/FriendsPage.tsx', 'useProfilePresence('],
    ['src/pages/SuperAgentDashboard.tsx', 'useProfilePresence('],
    ['src/pages/AgentDashboardPage.tsx', 'readPresence('],
    ['src/pages/ClubMembersPage.tsx', 'useOnlineNow('],
    ['src/pages/DiamondPlayersPage.tsx', 'useOnlineNow('],
    ['src/pages/MemberManagementPage.tsx', 'useOnlineNow('],
    ['src/services/PlayerStatusService.ts', 'readPresence('],
    ['src/services/FriendSuggestionService.ts', 'readPresence('],
    ['src/services/AgentService.ts', 'readPresence('],
    ['src/lib/profilePresence.ts', 'readPresence('],
  ];

  it.each(asks)('%s asks through %s', (file, token) => {
    expect(blankNonCode(read(file))).toContain(token);
  });

  it('a roster row shows the re-asked answer, not the row it loaded', () => {
    for (const file of ['src/pages/ClubMembersPage.tsx', 'src/pages/DiamondPlayersPage.tsx']) {
      const code = blankNonCode(read(file));
      expect(code, file).not.toMatch(/\.is_online \?/);
    }
    expect(blankNonCode(read('src/pages/MemberManagementPage.tsx'))).not.toMatch(
      /presence\.is_online\s*\?/
    );
  });

  it('a seat is online wherever the row is lit (2026-10-05 audit)', () => {
    /* The re-asked door answers heartbeats only. A seated person's open tab
       keeps one and a seated horse's need not, so a ring lit by the door
       alone would light a person's seat and not a horse's. */
    const page = blankNonCode(read('src/pages/MemberManagementPage.tsx'));
    expect(page).toContain('const avatarLit = detail?.presence.is_seated === true || onlineNow;');
    expect(read('src/pages/MemberManagementPage.tsx')).toContain(
      "className={`mm-avatar${avatarLit ? ' mm-avatar--online' : ''}`}"
    );
  });

  it('the friends cache never restores an "online" (2026-10-05 audit)', () => {
    const page = blankNonCode(read('src/pages/FriendsPage.tsx'));
    expect(page).toMatch(/source_online: false,\s*is_online: false,/);
  });
});

describe('LAW: a person in the arena has the same heartbeat a horse has', () => {
  const BEAT = read('src/lib/presenceHeartbeat.ts');
  const HOOK = read('src/hooks/usePresenceHeartbeat.ts');

  it('nothing in src writes profiles.is_online directly', () => {
    const writes = calls(['update', 'upsert', 'insert']);
    expect(writes.length).toBeGreaterThan(100);
    const offending = writes
      .filter((w) => IS_ONLINE.test(withoutComments(w.text)))
      .map((w) => w.where);
    expect(
      offending,
      'a flag without a fresh last_seen is the stale row the one definition ignores: beat through fn_update_presence'
    ).toEqual([]);
  });

  it('only the heartbeat calls fn_update_presence', () => {
    const writers = FILES.filter(({ src }) => /rpc\(\s*['"`]fn_update_presence['"`]/.test(src)).map(
      (f) => f.file
    );
    expect(writers).toEqual(['src/lib/presenceHeartbeat.ts']);
    expect(sliceMethod(BEAT, 'async function sendPresence(')).toContain('p_is_online: online');
  });

  it('beats inside the five-minute window, only while visible, and again on return', () => {
    const m = BEAT.match(/export const PRESENCE_HEARTBEAT_MS = ([0-9_]+);/);
    expect(m, 'PRESENCE_HEARTBEAT_MS must be a literal').not.toBeNull();
    const ms = Number((m as RegExpMatchArray)[1].replace(/_/g, ''));
    expect(ms).toBeGreaterThanOrEqual(60_000);
    expect(ms).toBeLessThan(5 * 60_000);
    const hook = blankNonCode(sliceMethod(HOOK, 'export function usePresenceHeartbeat('));
    expect(hook).toContain('setInterval(beat, PRESENCE_HEARTBEAT_MS)');
    expect(hook).toContain('if (stopped || tabHidden()) return;');
    expect(sliceMethod(HOOK, 'export function usePresenceHeartbeat(')).toContain(
      "document.addEventListener('visibilitychange', onVisibility)"
    );
  });

  it('is mounted exactly once, at the app root', () => {
    const mounts = FILES.flatMap(({ file, blank }) =>
      [...blank.matchAll(/<PresenceHeartbeat\b/g)].map(() => file)
    );
    expect(mounts).toEqual(['src/App.tsx']);
    const hookUsers = FILES.filter(
      ({ file, blank }) =>
        file !== 'src/hooks/usePresenceHeartbeat.ts' &&
        file !== 'src/components/common/PresenceHeartbeat.tsx' &&
        blank.includes('usePresenceHeartbeat(')
    ).map((f) => f.file);
    expect(hookUsers).toEqual([]);
  });

  it('sign-out sends the last beat before the session ends', () => {
    const logout = blankNonCode(sliceMethod(read('src/core/IdentityDNA.ts'), 'async logout()'));
    const off = logout.indexOf('signalOffline(');
    expect(off).toBeGreaterThan(-1);
    expect(off).toBeLessThan(logout.indexOf('supabase.auth.signOut()'));
  });

  it('a union online figure never comes from a channel only people can join', () => {
    const page = blankNonCode(read('src/pages/UnionDetailPage.tsx'));
    expect(page).not.toContain('presenceService');
    expect(page).not.toContain('union.onlineCount');
  });
});

describe('LAW: an online figure is counted by the database, never invented', () => {
  it('a union is counted by fn_union_online_count, and a failed read says so', () => {
    const svc = sliceMethod(read('src/services/UnionService.ts'), 'async getOnlineCount(');
    expect(svc).toContain("supabase.rpc('fn_union_online_count', {");
    expect(svc).toContain('if (error) throw error;');
    for (const file of ['src/pages/UnionDetailPage.tsx', 'src/pages/UnionsPage.tsx']) {
      const code = blankNonCode(read(file));
      expect(code, file).toContain('unionService.getOnlineCount(');
      expect(code, file).toContain('COUNT_UNKNOWN');
      expect(code, file).not.toContain('presenceService');
    }
    // The detail page follows heartbeats going stale on the presence cadence.
    const detail = blankNonCode(read('src/pages/UnionDetailPage.tsx'));
    expect(detail).toContain('setInterval(ask, PRESENCE_RECHECK_MS)');
    // ...and the moment a hidden tab returns, with only the latest ask answering.
    expect(detail).toMatch(/addEventListener\([^)]*onVisibility\)/);
    expect(detail).toMatch(/removeEventListener\([^)]*onVisibility\)/);
    expect(detail).toContain('seq === latest');
  });

  it('nothing reads the union online column that does not exist', () => {
    const union = read('src/services/UnionService.ts');
    expect(blankNonCode(union)).not.toMatch(/\bonlineCount\b/);
    expect(union).not.toMatch(/u\.online_count/);
  });

  it('no online figure is a fraction of a member count', () => {
    // 2026-10-05: UnionService.getStats said 20% of members were online and
    // MembershipService.getMemberCounts said 15%. Neither was measured.
    const invented = FILES.filter(({ blank }) =>
      /online\w*\s*[:=][^;\n]*\*\s*0?\.\d+/i.test(blank)
    ).map((f) => f.file);
    expect(invented).toEqual([]);
    expect(blankNonCode(read('src/services/UnionService.ts'))).not.toContain('onlinePlayers');
    expect(
      blankNonCode(sliceMethod(read('src/services/MembershipService.ts'), 'async getMemberCounts('))
    ).not.toMatch(/\bonline\b/);
  });
});
