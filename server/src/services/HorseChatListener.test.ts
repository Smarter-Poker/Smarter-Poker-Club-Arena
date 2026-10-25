/**
 * ONE CHANNEL HEARS EVERY PLAYER'S LINE, AND ONLY THE TABLE'S OWN ENGINE ANSWERS
 * (2026-10-24). Driven without a socket: the channel is a fake that records
 * how it was opened, and dispatchChatRow is called the way its callback is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const h = vi.hoisted(() => {
  const state = {
    opened: [] as Array<{ topic: string; on: unknown[] }>,
    removed: 0,
    statusCb: null as ((s: string) => void) | null,
  };
  const supabase = {
    channel(topic: string) {
      const rec = { topic, on: [] as unknown[] };
      state.opened.push(rec);
      const ch = {
        on: (...args: unknown[]) => {
          rec.on = args;
          return ch;
        },
        subscribe: (cb?: (s: string) => void) => {
          state.statusCb = cb ?? null;
          return ch;
        },
      };
      return ch;
    },
    removeChannel: () => {
      state.removed++;
      return Promise.resolve();
    },
    from: () => {
      throw new Error('the listener itself never reads or writes a table');
    },
  };
  return { state, supabase };
});

vi.mock('./supabase/client.js', () => ({ supabase: h.supabase }));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn(), describeError: String }));

import {
  CHAT_REPLY_TOPIC,
  _resetChatListenerForTests,
  _setReplyForTests,
  chatLineFrom,
  chatReplyChannelOpen,
  chatReplyListenerCount,
  dispatchChatRow,
  registerChatReplies,
  unregisterChatReplies,
  type ChatReplyContext,
} from './HorseChatListener.js';
import type { SeatedPlayer, TableInfo } from '../types.js';

const TABLE = '11111111-1111-4111-8111-111111111111';
const ELSEWHERE = '99999999-9999-4999-8999-999999999999';

const tableInfo = {
  id: TABLE,
  big_blind: 2,
  max_players: 9,
  ban_chat: false,
  game_variant: 'nlh',
} as unknown as TableInfo;

const players = [
  { user_id: 'horse-1', username: 'Ingrid', seat_number: 1, is_horse: true },
  { user_id: 'human-1', username: 'danny', seat_number: 3, is_horse: false },
] as unknown as SeatedPlayer[];

const ctx = (over: Partial<ChatReplyContext> = {}): ChatReplyContext => ({
  tableInfo,
  seatedPlayers: players,
  handCount: 777,
  isTournament: false,
  ...over,
});

const row = (over: Record<string, unknown> = {}) => ({
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  table_id: TABLE,
  user_id: 'human-1',
  message: 'Nice Hand',
  message_type: 'player',
  created_at: '2026-10-24T12:00:00Z',
  ...over,
});

let replies: unknown[] = [];

beforeEach(() => {
  _resetChatListenerForTests();
  h.state.opened = [];
  h.state.removed = 0;
  h.state.statusCb = null;
  replies = [];
  _setReplyForTests(async (input) => {
    replies.push(input);
    return 'spoken';
  });
});

afterEach(() => _resetChatListenerForTests());

describe('the shared channel', () => {
  it("one channel for every table, filtered to players' lines on table_chat inserts", () => {
    registerChatReplies(TABLE, {}, () => ctx());
    registerChatReplies(ELSEWHERE, {}, () => ctx());
    expect(h.state.opened).toHaveLength(1);
    expect(h.state.opened[0].topic).toBe(CHAT_REPLY_TOPIC);
    expect(h.state.opened[0].on[0]).toBe('postgres_changes');
    expect(h.state.opened[0].on[1]).toEqual({
      event: 'INSERT',
      schema: 'public',
      table: 'table_chat',
      filter: 'message_type=eq.player',
    });
    expect(chatReplyListenerCount()).toBe(2);
  });

  it('the realtime callback hands the inserted row to dispatch', () => {
    registerChatReplies(TABLE, {}, () => ctx());
    const callback = h.state.opened[0].on[2] as (p: unknown) => void;
    callback({ new: row() });
    expect(replies).toHaveLength(1);
  });

  it('a terminal status releases the handle; the next registration opens a fresh one', () => {
    const owner = {};
    registerChatReplies(TABLE, owner, () => ctx());
    expect(chatReplyChannelOpen()).toBe(true);
    h.state.statusCb!('CHANNEL_ERROR');
    expect(chatReplyChannelOpen()).toBe(false);
    expect(h.state.removed).toBe(1);
    // the engine's throttled refresh re-registers: that is the recovery, no loop
    registerChatReplies(TABLE, owner, () => ctx());
    expect(chatReplyChannelOpen()).toBe(true);
    expect(h.state.opened).toHaveLength(2);
  });

  it('the channel closes when the last table goes', () => {
    const a = {};
    const b = {};
    registerChatReplies(TABLE, a, () => ctx());
    registerChatReplies(ELSEWHERE, b, () => ctx());
    unregisterChatReplies(TABLE, a);
    expect(chatReplyChannelOpen()).toBe(true);
    unregisterChatReplies(ELSEWHERE, b);
    expect(chatReplyChannelOpen()).toBe(false);
    expect(chatReplyListenerCount()).toBe(0);
  });

  it("a superseded engine cannot remove its successor's registration", () => {
    const old = {};
    const successor = {};
    registerChatReplies(TABLE, old, () => ctx());
    registerChatReplies(TABLE, successor, () => ctx({ handCount: 900 }));
    unregisterChatReplies(TABLE, old);
    expect(chatReplyListenerCount()).toBe(1);
    expect(dispatchChatRow(row())).toBe(true);
    expect((replies[0] as { handNumber: number }).handNumber).toBe(900);
  });
});

describe('dispatchChatRow', () => {
  it("builds the reply input from the engine's live state at that moment", () => {
    registerChatReplies(TABLE, {}, () => ctx());
    expect(dispatchChatRow(row())).toBe(true);
    expect(replies[0]).toEqual({
      table: expect.objectContaining({ tableId: TABLE, isTournament: false, maxPlayers: 9 }),
      handNumber: 777,
      seated: [
        expect.objectContaining({ userId: 'horse-1', isHorse: true, username: 'Ingrid' }),
        expect.objectContaining({ userId: 'human-1', isHorse: false }),
      ],
      chat: {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        userId: 'human-1',
        message: 'Nice Hand',
        createdAt: '2026-10-24T12:00:00Z',
      },
    });
  });

  it('a table this process does not serve is dropped; the serving process answers', () => {
    registerChatReplies(TABLE, {}, () => ctx());
    expect(dispatchChatRow(row({ table_id: ELSEWHERE }))).toBe(false);
    expect(replies).toHaveLength(0);
  });

  it('only player lines, only complete rows, never a tournament', () => {
    registerChatReplies(TABLE, {}, () => ctx());
    expect(dispatchChatRow(row({ message_type: 'system' }))).toBe(false);
    expect(dispatchChatRow(row({ message: undefined }))).toBe(false);
    expect(dispatchChatRow(row({ user_id: null }))).toBe(false);
    expect(dispatchChatRow(null)).toBe(false);
    registerChatReplies(TABLE, {}, () => ctx({ isTournament: true }));
    expect(dispatchChatRow(row())).toBe(false);
    registerChatReplies(TABLE, {}, () => ctx({ tableInfo: null }));
    expect(dispatchChatRow(row())).toBe(false);
    expect(replies).toHaveLength(0);
  });

  it('never throws into the engine: a provider that throws, a reply that rejects', async () => {
    registerChatReplies(TABLE, {}, () => {
      throw new Error('engine state mid-teardown');
    });
    expect(() => dispatchChatRow(row())).not.toThrow();
    expect(dispatchChatRow(row())).toBe(false);
    registerChatReplies(TABLE, {}, () => ctx());
    _setReplyForTests(() => Promise.reject(new Error('network')));
    expect(dispatchChatRow(row())).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
  });

  it('chatLineFrom reads numeric ids as text and a missing timestamp as null', () => {
    expect(chatLineFrom(row({ id: 42, created_at: undefined }))).toEqual({
      tableId: TABLE,
      line: { id: '42', userId: 'human-1', message: 'Nice Hand', createdAt: null },
    });
  });
});

describe('the engine wires it in, and takes it out', () => {
  const base = readFileSync(
    join(process.cwd(), 'src', 'engine', 'ServerTableEngineBase.ts'),
    'utf8'
  );
  it('registers at start and on the throttled refresh, cash tables only', () => {
    expect(base).toContain("from '../services/HorseChatListener.js'");
    expect(base.match(/this\.listenForPlayerChat\(\);/g)?.length).toBe(2);
    expect(base).toMatch(
      /protected listenForPlayerChat\(\): void \{\s*if \(!this\.tableInfo \|\| this\.isTournamentTable\(\)\) return;\s*registerChatReplies\(this\.tableId, this,/
    );
  });
  it('unregisters in stop(), by owner', () => {
    expect(base).toContain('unregisterChatReplies(this.tableId, this);');
  });
});
