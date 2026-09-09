import { reportError } from '../services/errorReporter.js';

/** A chip is two decimal places, everywhere it is stored (#3358). */
const round2 = (n: number): number => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ATOMIC STACK SERVICE — In-Process Stack Versioning
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ D22 (2026-08-20) — READ THIS BEFORE RELYING ON THE NAME.
 *
 * "Atomic" here means atomic WITHIN THIS PROCESS. Every version number, every
 * compare-and-set and every batch settlement below lives in a JavaScript Map.
 * None of it is a database transaction, and none of it survives a restart.
 *
 * What actually makes stack mutation safe on this platform is single-engine
 * authority: exactly one engine owns a table at a time (see the table-lease
 * mechanism in GameServer), so there is no second writer to race with. This
 * class is a consistency check on top of that, not the guarantee itself.
 *
 * The distinction matters because the name invites the opposite reading. If you
 * are about to run two engines against one table, this class will NOT protect
 * you — the lease will, and this will silently agree with whichever writer got
 * there first.
 *
 * `tableLocks` is vestigial: it is declared, deleted and cleared, and never
 * acquired or awaited anywhere. It confers no mutual exclusion of any kind.
 *
 * Prevents stack mutation race conditions using versioned optimistic locking:
 * - Each stack read includes a version number
 * - Each write verifies the version hasn't changed since read
 * - Batch settlement for entire hand in a single atomic operation
 * - Retry logic for version conflicts
 *
 * This eliminates races between concurrent rebuy, cashout, and hand settlement.
 *
 * Ported from client: src/engine/AtomicStackService.ts
 * Server adaptation: No masterBus — uses optional event callbacks.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface StackVersion {
  stack: number;
  version: number;
}

export interface StackSettlement {
  userId: string;
  delta: number; // Positive = won chips, negative = lost chips
}

export interface AtomicResult {
  success: boolean;
  newStack?: number;
  newVersion?: number;
  error?: string;
}

export interface BatchSettlementResult {
  success: boolean;
  settled: Map<string, number>; // userId → final stack
  errors: string[];
}

export type StackEventType = 'STACK_RACE_DETECTED' | 'STACK_SETTLEMENT';

export interface StackEvent {
  type: StackEventType;
  tableId: string;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ATOMIC STACK SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class AtomicStackService {
  // In-memory version tracking per player per table
  // Format: tableId:userId → { stack, version }
  private versions: Map<string, StackVersion> = new Map();

  // Lock per table to serialize batch operations
  private tableLocks: Map<string, Promise<void>> = new Map();

  private onEvent?: (event: StackEvent) => void;

  constructor(onEvent?: (event: StackEvent) => void) {
    this.onEvent = onEvent;
  }

  /**
   * Get current stack with version number.
   * Version is incremented on every mutation.
   */
  getStackWithVersion(tableId: string, userId: string): StackVersion {
    const key = `${tableId}:${userId}`;
    let sv = this.versions.get(key);
    if (!sv) {
      sv = { stack: 0, version: 0 };
      this.versions.set(key, sv);
    }
    return { ...sv };
  }

  /**
   * Initialize a player's stack (e.g., on sit-down).
   * Always succeeds and resets the version.
   */
  initializeStack(tableId: string, userId: string, stack: number): void {
    const key = `${tableId}:${userId}`;
    this.versions.set(key, { stack, version: 1 });
  }

  /**
   * Atomic debit — deduct from stack, fails if version mismatch.
   * Used for: bets, blinds, antes.
   */
  atomicDebit(
    tableId: string,
    userId: string,
    amount: number,
    expectedVersion: number
  ): AtomicResult {
    const key = `${tableId}:${userId}`;
    const sv = this.versions.get(key);

    if (!sv) {
      return { success: false, error: `No stack record for ${userId} at table ${tableId}` };
    }

    if (sv.version !== expectedVersion) {
      this.emitEvent({
        type: 'STACK_RACE_DETECTED',
        tableId,
        userId,
        operation: 'debit',
        expectedVersion,
        actualVersion: sv.version,
      });
      return {
        success: false,
        error: `Version conflict: expected ${expectedVersion}, got ${sv.version}`,
      };
    }

    if (amount > sv.stack) {
      return { success: false, error: `Insufficient stack: ${sv.stack} < ${amount}` };
    }

    if (amount < 0) {
      return { success: false, error: 'Debit amount must be positive' };
    }

    // A chip is two decimal places (#3358). This Map is the baseline the next
    // hand's delta is measured against AND the value `amount > sv.stack`
    // compares an exact all-in against, so a 1e-13 drift here refuses a debit
    // that is exactly the stack.
    sv.stack = round2(sv.stack - amount);
    sv.version++;
    return { success: true, newStack: sv.stack, newVersion: sv.version };
  }

  /**
   * Atomic credit — add to stack, always succeeds.
   * Used for: pot winnings, rakeback distributions.
   * No version check needed since credits never conflict.
   */
  atomicCredit(tableId: string, userId: string, amount: number): AtomicResult {
    const key = `${tableId}:${userId}`;
    let sv = this.versions.get(key);

    if (!sv) {
      sv = { stack: 0, version: 0 };
      this.versions.set(key, sv);
    }

    if (amount < 0) {
      return { success: false, error: 'Credit amount must be positive' };
    }

    sv.stack = round2(sv.stack + amount);
    sv.version++;
    return { success: true, newStack: sv.stack, newVersion: sv.version };
  }

  /**
   * Batch settle an entire hand in one atomic operation.
   * All settlements applied together — either all succeed or all fail.
   * Used at end of hand to apply all chip movements simultaneously.
   */
  atomicSettle(tableId: string, settlements: StackSettlement[]): BatchSettlementResult {
    const errors: string[] = [];
    const settled = new Map<string, number>();

    // 1. Validate all debits first (dry run)
    for (const s of settlements) {
      if (s.delta < 0) {
        const key = `${tableId}:${s.userId}`;
        const sv = this.versions.get(key);
        if (!sv) {
          errors.push(`No stack record for ${s.userId}`);
          continue;
        }
        if (sv.stack + s.delta < 0) {
          errors.push(
            `${s.userId} would go negative: ${sv.stack} + ${s.delta} = ${sv.stack + s.delta}`
          );
        }
      }
    }

    if (errors.length > 0) {
      return { success: false, settled, errors };
    }

    // 2. Apply all settlements atomically
    for (const s of settlements) {
      const key = `${tableId}:${s.userId}`;
      let sv = this.versions.get(key);
      if (!sv) {
        sv = { stack: 0, version: 0 };
        this.versions.set(key, sv);
      }

      sv.stack = round2(sv.stack + s.delta);
      sv.version++;
      settled.set(s.userId, sv.stack);
    }

    this.emitEvent({
      type: 'STACK_SETTLEMENT',
      tableId,
      playerCount: settlements.length,
      totalMoved: settlements.reduce((sum, s) => sum + Math.abs(s.delta), 0),
    });

    return { success: true, settled, errors: [] };
  }

  /**
   * Get all player stacks for a table.
   */
  getTableStacks(tableId: string): Map<string, StackVersion> {
    const result = new Map<string, StackVersion>();
    for (const [key, sv] of this.versions) {
      if (key.startsWith(`${tableId}:`)) {
        const userId = key.slice(tableId.length + 1);
        result.set(userId, { ...sv });
      }
    }
    return result;
  }

  /**
   * Clean up all state for a table.
   */
  clearTable(tableId: string): void {
    for (const key of [...this.versions.keys()]) {
      if (key.startsWith(`${tableId}:`)) {
        this.versions.delete(key);
      }
    }
    this.tableLocks.delete(tableId);
  }

  /**
   * Full cleanup.
   */
  dispose(): void {
    this.versions.clear();
    this.tableLocks.clear();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE
  // ═══════════════════════════════════════════════════════════════════════════

  private emitEvent(event: StackEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch (err) {
        reportError(err, 'AtomicStackService.Event_handler_error');
      }
    }
  }
}
