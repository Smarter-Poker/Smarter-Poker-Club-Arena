import { supabase } from '../lib/supabase';
import { notifyServerLeaveOccupancy, notifyServerKickOccupancy } from './GameServerAPI';

type Intent = {
  version: 1;
  userId: string;
  tableId: string;
  seatNumber: number;
  occupancyId: string;
  state: 'pending' | 'resolved';
  action?: 'kick';
  reason?: string;
};
export type SeatOccupancyTarget = { seatNumber: number; occupancyId: string };
export type SeatLeaveResult = {
  success: boolean;
  chipsReturned: number;
  deferred?: boolean;
  occupancyId?: string;
  error?: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const running = new Map<string, Promise<SeatLeaveResult>>();
function validIntent(
  value: unknown,
  userId: string,
  tableId: string,
  action: 'leave' | 'kick'
): value is Intent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const x = value as Intent;
  return (
    x.version === 1 &&
    (action === 'kick'
      ? x.action === 'kick' && typeof x.reason === 'string'
      : x.action === undefined) &&
    x.userId === userId &&
    x.tableId === tableId &&
    Number.isInteger(x.seatNumber) &&
    x.seatNumber >= 0 &&
    typeof x.occupancyId === 'string' &&
    UUID.test(x.occupancyId) &&
    (x.state === 'pending' || x.state === 'resolved')
  );
}

/** An unknown response retains the original target across retries and reloads. */
export function leaveSeatWithIntent(tableId: string, userId: string): Promise<SeatLeaveResult> {
  return requestSeatWithIntent(tableId, userId, { kind: 'leave' });
}
export function kickSeatWithIntent(
  tableId: string,
  userId: string,
  reason: string,
  target?: SeatOccupancyTarget
): Promise<SeatLeaveResult> {
  return requestSeatWithIntent(tableId, userId, { kind: 'kick', reason }, target);
}
async function requestSeatWithIntent(
  tableId: string,
  userId: string,
  action: { kind: 'leave' } | { kind: 'kick'; reason: string },
  target?: SeatOccupancyTarget
): Promise<SeatLeaveResult> {
  const key =
    (action.kind === 'kick' ? 'ca:seat-kick:v1:' : 'ca:seat-leave:v1:') + userId + ':' + tableId;
  const active = running.get(key);
  if (active)
    return target
      ? {
          success: false,
          chipsReturned: 0,
          error: 'A Removal Is Already In Progress For This Table.',
        }
      : active;
  // Capture the request generation before waiting behind another browser tab.
  // A queued click cannot become a new cashout merely because the first tab
  // resolved the original request while this tab waited for its Web Lock.
  let invocationRaw: string | null;
  try {
    invocationRaw = globalThis.localStorage.getItem(key);
  } catch (error) {
    return {
      success: false,
      chipsReturned: 0,
      error: error instanceof Error ? error.message : 'Could Not Read The Leave Request.',
    };
  }
  const execute = async (): Promise<SeatLeaveResult> => {
    try {
      if (!UUID.test(tableId) || !UUID.test(userId)) throw new Error('Invalid Table Or Player.');
      const storage = globalThis.localStorage;
      const raw = storage.getItem(key);
      const interveningAction = raw !== invocationRaw;
      let intent: Intent | null = null;
      if (invocationRaw !== null) {
        const invoked: unknown = JSON.parse(invocationRaw);
        if (!validIntent(invoked, userId, tableId, action.kind))
          throw new Error('The Saved Leave Request Could Not Be Verified.');
        if (invoked.state === 'pending') intent = invoked;
      }
      if (!intent && raw !== null) {
        const saved: unknown = JSON.parse(raw);
        if (!validIntent(saved, userId, tableId, action.kind))
          throw new Error('The Saved Leave Request Could Not Be Verified.');
        intent = saved;
      }
      if (!intent || (intent.state === 'resolved' && !interveningAction)) {
        const { data, error } = target
          ? {
              data: { seat_number: target.seatNumber, occupancy_id: target.occupancyId },
              error: null,
            }
          : await supabase
              .from('table_seats')
              .select('seat_number, occupancy_id')
              .eq('table_id', tableId)
              .eq('user_id', userId)
              .is('left_at', null)
              .maybeSingle();
        if (error) throw new Error('Could Not Read Your Seat. Please Try Again.');
        if (data) {
          const candidate = {
            version: 1,
            userId,
            tableId,
            seatNumber: data.seat_number,
            occupancyId: data.occupancy_id,
            state: 'pending',
            ...(action.kind === 'kick' ? { action: 'kick', reason: action.reason } : {}),
          };
          if (!validIntent(candidate, userId, tableId, action.kind))
            throw new Error('Your Seat Identity Could Not Be Verified.');
          intent = candidate;
        }
        if (!intent) throw new Error('No Seat Was Found For This Leave Request.');
      }
      if (
        target &&
        (intent.occupancyId !== target.occupancyId || intent.seatNumber !== target.seatNumber)
      )
        throw new Error('An Earlier Removal Must Be Confirmed Before Removing A Different Seat.');
      intent = { ...intent, state: 'pending' };
      // Persist before sending. Storage failure must not create an unrepeatable request.
      storage.setItem(key, JSON.stringify(intent));
      const response =
        action.kind === 'kick'
          ? await notifyServerKickOccupancy(
              tableId,
              userId,
              intent.seatNumber,
              intent.occupancyId,
              intent.reason!
            )
          : await notifyServerLeaveOccupancy(tableId, intent.seatNumber, intent.occupancyId);
      if (!response || typeof response !== 'object' || Array.isArray(response)) {
        throw new Error('The Server Did Not Confirm The Leave.');
      }
      const result = response as Record<string, unknown>;
      const matches =
        result.protocol === 'seat-occupancy-v1' &&
        result.occupancyId === intent.occupancyId &&
        result.seatNumber === intent.seatNumber;
      if (result.success !== true) {
        if (matches && (result.code === 'STALE_OCCUPANCY' || result.code === 'LEAVE_LOCKED')) {
          storage.setItem(key, JSON.stringify({ ...intent, state: 'resolved' }));
        }
        return {
          success: false,
          chipsReturned: 0,
          error:
            typeof result.error === 'string'
              ? result.error
              : 'The Server Did Not Confirm The Leave.',
        };
      }
      if (!matches || typeof result.immediate !== 'boolean') {
        throw new Error('The Server Did Not Confirm The Original Seat.');
      }
      let outcome: SeatLeaveResult;
      if (result.immediate === false && result.cashout === null) {
        outcome = { success: true, chipsReturned: 0, deferred: true };
      } else if (result.tournament === true && result.cashout === null) {
        outcome = { success: true, chipsReturned: 0 };
      } else {
        const receipt = result.cashout as Record<string, unknown> | null;
        if (
          !receipt ||
          typeof receipt !== 'object' ||
          Array.isArray(receipt) ||
          receipt.ok !== true ||
          receipt.reason !== undefined ||
          receipt.user_id !== userId ||
          receipt.table_id !== tableId ||
          receipt.occupancy_id !== intent.occupancyId ||
          receipt.seat_number !== intent.seatNumber ||
          receipt.idempotency_key !== 'cashout:occupancy:' + intent.occupancyId ||
          receipt.tournament_table !== false ||
          typeof receipt.credited !== 'boolean' ||
          typeof receipt.stack !== 'number' ||
          !Number.isFinite(receipt.stack) ||
          receipt.stack < 0 ||
          Math.round(receipt.stack * 100) / 100 !== receipt.stack
        ) {
          throw new Error('The Server Did Not Confirm The Cashout.');
        }
        outcome = { success: true, chipsReturned: receipt.stack };
      }
      storage.setItem(key, JSON.stringify({ ...intent, state: 'resolved' }));
      return { ...outcome, occupancyId: intent.occupancyId };
    } catch (error) {
      return {
        success: false,
        chipsReturned: 0,
        error:
          error instanceof Error ? error.message : 'Could Not Confirm The Leave. Please Try Again.',
      };
    }
  };
  const work = Promise.resolve(
    globalThis.navigator?.locks ? globalThis.navigator.locks.request(key, execute) : execute()
  );
  running.set(key, work);
  try {
    return await work;
  } catch (error) {
    return {
      success: false,
      chipsReturned: 0,
      error: error instanceof Error ? error.message : 'Could Not Acquire The Leave Request Lock.',
    };
  } finally {
    if (running.get(key) === work) running.delete(key);
  }
}
