/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  "ONLINE" HAS ONE DEFINITION (2026-10-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A person is online when the database says so through fn_profile_presence:
 * profiles.is_online AND a last_seen heartbeat under five minutes old. Horses
 * keep a real heartbeat in the same two columns (migration 20261005174041),
 * so the fresh answer is the only one that treats every account alike - the
 * law that a player must never be able to tell a house bot from a person.
 *
 * What it replaces. Several surfaces read the raw profiles.is_online flag, and
 * on 2026-10-05 that flag was true on 768 of 927 human rows and 442 of 1,000
 * horse rows while not one human heartbeat was fresh. So those surfaces showed
 * most people online forever, and disagreed with the surfaces that already
 * asked the presence door. A realtime UPDATE payload on profiles is the same
 * raw flag delivered faster; it decides nothing on its own either.
 *
 * What this module adds to readPresence (src/lib/ownProfile.ts, the only
 * caller of fn_profile_presence): a dot that STAYS honest. A heartbeat goes
 * stale with no row change at all - nothing is written when somebody simply
 * leaves - so an answer read once is right only until five minutes pass. Every
 * watched account is re-asked every PRESENCE_RECHECK_MS while something on
 * screen is watching it, and all watched accounts go in ONE batched call
 * (readPresence chunks at 500), however many dots are mounted. A newly
 * mounted dot waits one microtask so a list that mounts fifty dots at once
 * asks once. A hidden tab is not re-asked; it is re-asked when it returns.
 *
 * An account whose presence cannot be read is offline. That is the honest
 * default readPresence already documents, and it is what a failed re-check
 * leaves behind rather than a stale "online".
 */
import { readPresence } from './ownProfile';
import { reportError } from '../utils/errorReporter';

/** How often a watched account is re-asked while it is on screen. */
export const PRESENCE_RECHECK_MS = 60_000;

export type PresenceAnswer = ReadonlyMap<string, boolean>;
type Listener = (answer: PresenceAnswer) => void;

interface Watch {
  ids: ReadonlySet<string>;
  listener: Listener;
}

const watches = new Set<Watch>();
let answers = new Map<string, boolean>();
let timer: ReturnType<typeof setInterval> | null = null;
let queuedIds: Set<string> | null = null;
let visibilityBound = false;
/*
 * Every ask is numbered, and each account remembers the number of the ask
 * whose answer it holds. An answer lands only if no later ask has already
 * answered that account, so a slow first read cannot overwrite the re-ask
 * that overtook it (2026-10-05 audit). `epoch` changes whenever every watcher
 * has gone: a read still in flight from before then answers nobody and must
 * not refill the cache the next watcher would trust without asking.
 */
let askSeq = 0;
const answeredBy = new Map<string, number>();
let epoch = 0;

function watchedIds(): Set<string> {
  const ids = new Set<string>();
  for (const w of watches) for (const id of w.ids) ids.add(id);
  return ids;
}

function notify(): void {
  const snapshot: PresenceAnswer = new Map(answers);
  for (const w of watches) w.listener(snapshot);
}

async function ask(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const seq = ++askSeq;
  const askedIn = epoch;
  let fresh: Map<string, boolean> | null = null;
  try {
    fresh = await readPresence(ids);
  } catch (e) {
    reportError(e, 'profilePresence.ask');
  }
  if (askedIn !== epoch) return;
  const stillWatched = watchedIds();
  let changed = false;
  for (const id of ids) {
    if (!stillWatched.has(id)) continue;
    if ((answeredBy.get(id) ?? 0) > seq) continue;
    answeredBy.set(id, seq);
    // Unreadable is offline: a failed read never leaves the last "online".
    answers.set(id, fresh?.get(id) === true);
    changed = true;
  }
  if (changed) notify();
}

/** Forget every answer no watcher is looking at, so a later watcher asks afresh. */
function forgetUnwatched(): void {
  const stillWatched = watchedIds();
  for (const id of [...answers.keys()]) {
    if (!stillWatched.has(id)) {
      answers.delete(id);
      answeredBy.delete(id);
    }
  }
}

function tabHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function recheckAll(): void {
  if (tabHidden()) return;
  void ask([...watchedIds()]);
}

function onVisibilityChange(): void {
  if (!tabHidden()) recheckAll();
}

function queue(ids: Iterable<string>): void {
  const first = queuedIds === null;
  queuedIds ??= new Set();
  for (const id of ids) queuedIds.add(id);
  if (!first) return;
  queueMicrotask(() => {
    const watched = watchedIds();
    const batch = [...(queuedIds ?? [])].filter((id) => watched.has(id));
    queuedIds = null;
    void ask(batch);
  });
}

function start(): void {
  if (timer === null) timer = setInterval(recheckAll, PRESENCE_RECHECK_MS);
  if (!visibilityBound && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
    visibilityBound = true;
  }
}

function stop(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  if (visibilityBound && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }
  visibilityBound = false;
}

/**
 * Watch who of these accounts is online now. The listener is called with the
 * current answers whenever any watched account is (re-)asked. Returns the
 * unsubscribe. An account not yet answered is absent from the map: offline.
 */
export function watchProfilePresence(userIds: readonly string[], listener: Listener): () => void {
  const ids = new Set(userIds.filter(Boolean));
  const watch: Watch = { ids, listener };
  watches.add(watch);
  start();
  const unknown = [...ids].filter((id) => !answers.has(id));
  if (unknown.length > 0) queue(unknown);
  if (unknown.length < ids.size) listener(new Map(answers));
  return () => {
    if (!watches.delete(watch)) return;
    if (watches.size === 0) {
      stop();
      // Nothing is watching: forget, so the next watcher asks afresh rather
      // than starting from an answer that may be minutes old - and a read
      // still in flight from now on answers nobody.
      answers = new Map();
      answeredBy.clear();
      epoch++;
      return;
    }
    // An account that is no longer on screen is not re-asked, so its answer
    // ages; drop it rather than hand it, minutes old, to the next watcher.
    forgetUnwatched();
  };
}

/** Test seam: drop every watch and answer. */
export function resetProfilePresenceForTests(): void {
  watches.clear();
  stop();
  answers = new Map();
  answeredBy.clear();
  epoch++;
  queuedIds = null;
}
