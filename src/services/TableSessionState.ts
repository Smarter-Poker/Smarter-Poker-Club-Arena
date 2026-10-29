/** Session recap counters follow a confirmed chair move, never an unrelated tab. */
type Ref<T> = { current: T };
export interface SessionCarry {
  handsPlayed: number;
  handsWon: number;
  fundingAdjustment: number;
}
export interface TableSessionState {
  sessionStartRef: Ref<number>;
  handsPlayedRef: Ref<number>;
  handsWonRef: Ref<number>;
  biggestPotRef: Ref<number>;
  peakStackRef: Ref<number>;
  sessionPLRef: Ref<number>;
  totalBuyInRef: Ref<number>;
  totalRebuysRef: Ref<number>;
  vpipCountRef: Ref<number>;
  sessionCarryRef: Ref<SessionCarry>;
  bustPromptFiredRef: Ref<boolean>;
  heroWonCurrentHandRef: Ref<boolean>;
  hadShowdownRef: Ref<boolean>;
}
const states = new Map<string, { refs: TableSessionState; active: boolean }>();
const key = (tableId: string, userId: string) => `${userId}:${tableId}`;
export function newTableSessionState(): TableSessionState {
  return {
    sessionStartRef: { current: Date.now() },
    handsPlayedRef: { current: 0 },
    handsWonRef: { current: 0 },
    biggestPotRef: { current: 0 },
    peakStackRef: { current: 0 },
    sessionPLRef: { current: 0 },
    totalBuyInRef: { current: 0 },
    totalRebuysRef: { current: 0 },
    vpipCountRef: { current: 0 },
    sessionCarryRef: { current: { handsPlayed: 0, handsWon: 0, fundingAdjustment: 0 } },
    bustPromptFiredRef: { current: false },
    heroWonCurrentHandRef: { current: false },
    hadShowdownRef: { current: false },
  };
}
export function tableSessionState(
  tableId?: string | null,
  userId?: string | null
): TableSessionState {
  if (!tableId || !userId || userId === 'guest') return newTableSessionState();
  const id = key(tableId, userId);
  let state = states.get(id);
  if (!state) {
    state = { refs: newTableSessionState(), active: false };
    states.set(id, state);
  }
  return state.refs;
}
export function bindTableSessionState(
  tableId: string,
  userId: string,
  refs: TableSessionState
): void {
  const id = key(tableId, userId);
  if (!states.has(id)) states.set(id, { refs, active: false });
}
export function activateTableSessionState(tableId: string, userId: string): void {
  tableSessionState(tableId, userId);
  states.get(key(tableId, userId))!.active = true;
}
export function releaseTableSessionState(tableId: string, userId: string): void {
  const id = key(tableId, userId);
  if (!states.get(id)?.active) states.delete(id);
}
export function endTableSessionState(tableId: string, userId: string): void {
  states.delete(key(tableId, userId));
}
export function clearTableSessionStates(): void {
  states.clear();
}
export function moveTableSessionState(
  from: string,
  to: string,
  userId: string,
  stack: number
): void {
  const source = states.get(key(from, userId));
  if (!source?.active || from === to) return;
  const destination = tableSessionState(to, userId);
  const s = source.refs;
  destination.sessionStartRef.current = s.sessionStartRef.current;
  destination.handsPlayedRef.current = s.handsPlayedRef.current;
  destination.handsWonRef.current = s.handsWonRef.current;
  destination.biggestPotRef.current = s.biggestPotRef.current;
  destination.peakStackRef.current = s.peakStackRef.current;
  destination.sessionPLRef.current = s.sessionPLRef.current;
  destination.totalBuyInRef.current = s.totalBuyInRef.current;
  destination.totalRebuysRef.current = s.totalRebuysRef.current;
  destination.vpipCountRef.current = s.vpipCountRef.current;
  destination.sessionCarryRef.current = {
    handsPlayed: s.handsPlayedRef.current,
    handsWon: s.handsWonRef.current,
    fundingAdjustment: Math.round((s.totalBuyInRef.current - stack) * 100) / 100,
  };
  // Per-hand action flags belong to the new chair, never to the prior hand.
  destination.bustPromptFiredRef.current = false;
  destination.heroWonCurrentHandRef.current = false;
  destination.hadShowdownRef.current = false;
  states.set(key(to, userId), { refs: destination, active: true });
  states.delete(key(from, userId));
}
