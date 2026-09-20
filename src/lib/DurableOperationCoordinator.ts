// Shared durable accepted-generation coordinator. Storage acknowledgment is
// coordination evidence only; financial/control proof belongs to each strict RPC adapter.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface OperationReference {
  readonly hash: string;
  readonly historyId: string;
  readonly generation: number;
  readonly operationId: string;
  readonly repeatable: boolean;
}
export interface GenerationCoordinatorConfig {
  historyPrefix: string;
  legacyPrefix: string;
  markerPrefix: string;
  allowLegacyAdoption: boolean;
  identityError: string;
  storageError: string;
  scopeError: string;
}
interface OperationGeneration {
  generation: number;
  operationId: string;
  acknowledged: boolean;
  starts: { startId: string; acknowledged: boolean }[];
}
interface OperationHistory {
  version: 2;
  historyId: string;
  hash: string;
  repeatable: boolean;
  state: 'initializing' | 'active';
  head: number;
  generations: OperationGeneration[];
}
interface OperationPointer {
  version: 2;
  historyId: string;
  generation: number;
  operationId: string;
  startId: string;
}
interface OperationSelection {
  hash: string;
  historyId: string;
  generation: number;
  operationId: string;
  repeatable: boolean;
  isCurrent: () => boolean;
}
declare const preparedBrand: unique symbol;
declare const capturedBrand: unique symbol;
declare const admittedBrand: unique symbol;
export interface PreparedOperation {
  readonly [preparedBrand]: true;
}
export interface CapturedOperation {
  readonly [capturedBrand]: true;
}
export interface AdmittedOperation {
  readonly operationId: string;
  readonly [admittedBrand]: true;
}
export function createGenerationCoordinator(config: GenerationCoordinatorConfig) {
  const HISTORY_PREFIX = config.historyPrefix;
  const PREFIX = config.legacyPrefix;
  const MARKER_PREFIX = config.markerPrefix;
  const preparedOperations = new WeakMap<PreparedOperation, OperationSelection>();
  const capturedOperations = new WeakMap<
    CapturedOperation,
    OperationSelection & { startId: string }
  >();
  const admittedOperations = new WeakMap<
    AdmittedOperation,
    OperationSelection & { startId: string }
  >();

  function identityError(): never {
    throw new Error(config.identityError);
  }
  function operationStorage(): { shared: Storage; session: Storage } {
    if (
      !globalThis.crypto?.subtle ||
      !globalThis.crypto?.getRandomValues ||
      typeof window === 'undefined' ||
      typeof navigator === 'undefined' ||
      !navigator.locks
    ) {
      throw new Error(config.storageError);
    }
    return { shared: window.localStorage, session: window.sessionStorage };
  }
  function operationId(): string {
    operationStorage();
    // Do not use the generic utility's non-cryptographic compatibility fallback.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  function operationUUID(value: unknown): value is string {
    return typeof value === 'string' && UUID.test(value) && value === value.toLowerCase();
  }
  function operationObject(value: unknown, keys: string[]): value is Record<string, unknown> {
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    );
  }
  function assertCurrent(isCurrent: () => boolean): void {
    if (!isCurrent()) throw new Error(config.scopeError);
  }
  function saveOperation(storage: Storage, key: string, value: string): void {
    storage.setItem(key, value);
    if (storage.getItem(key) !== value) identityError();
  }
  function readOperationHistory(
    raw: string | null,
    hash: string,
    repeatable: boolean
  ): OperationHistory | null {
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return identityError();
    }
    if (
      !operationObject(value, [
        'version',
        'historyId',
        'hash',
        'repeatable',
        'state',
        'head',
        'generations',
      ]) ||
      value.version !== 2 ||
      !operationUUID(value.historyId) ||
      value.hash !== hash ||
      value.repeatable !== repeatable ||
      !['initializing', 'active'].includes(value.state as string) ||
      !Number.isSafeInteger(value.head) ||
      (value.head as number) < 1 ||
      !Array.isArray(value.generations) ||
      value.generations.length !== value.head ||
      (!repeatable && value.head !== 1)
    )
      return identityError();
    const operations = new Set<string>();
    const starts = new Set<string>();
    for (const [index, item] of value.generations.entries()) {
      if (
        !operationObject(item, ['generation', 'operationId', 'acknowledged', 'starts']) ||
        item.generation !== index + 1 ||
        !operationUUID(item.operationId) ||
        operations.has(item.operationId) ||
        typeof item.acknowledged !== 'boolean' ||
        !Array.isArray(item.starts)
      )
        return identityError();
      operations.add(item.operationId);
      let acknowledged = false;
      for (const start of item.starts) {
        if (
          !operationObject(start, ['startId', 'acknowledged']) ||
          !operationUUID(start.startId) ||
          starts.has(start.startId) ||
          typeof start.acknowledged !== 'boolean'
        )
          return identityError();
        starts.add(start.startId);
        acknowledged ||= start.acknowledged;
      }
      if (
        acknowledged !== item.acknowledged ||
        (index < value.generations.length - 1 && !acknowledged)
      )
        return identityError();
    }
    const history = value as unknown as OperationHistory;
    if (
      history.state === 'initializing' &&
      (history.head !== 1 || history.generations[0].starts.length)
    ) {
      return identityError();
    }
    return history;
  }
  function readOperationPointer(
    raw: string | null,
    history: OperationHistory
  ): OperationPointer | null {
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return identityError();
    }
    if (
      !operationObject(value, ['version', 'historyId', 'generation', 'operationId', 'startId']) ||
      value.version !== 2 ||
      value.historyId !== history.historyId ||
      !Number.isSafeInteger(value.generation) ||
      (value.generation as number) < 1 ||
      !operationUUID(value.operationId) ||
      !operationUUID(value.startId)
    )
      return identityError();
    const generation = history.generations[(value.generation as number) - 1];
    if (
      !generation ||
      generation.operationId !== value.operationId ||
      !generation.starts.some((start) => start.startId === value.startId)
    )
      return identityError();
    return value as unknown as OperationPointer;
  }
  function legacyOperationId(value: string | null): string | null {
    if (value === null) return null;
    if (!UUID.test(value)) return identityError();
    return value.toLowerCase();
  }
  function operationMarker(history: OperationHistory): string {
    return MARKER_PREFIX + history.historyId;
  }
  function loadActiveOperation(
    selection: OperationSelection,
    allowOtherPointer = false
  ): {
    history: OperationHistory;
    shared: Storage;
    session: Storage;
    pointer: OperationPointer | null;
  } {
    const { shared, session } = operationStorage();
    const history = readOperationHistory(
      shared.getItem(HISTORY_PREFIX + selection.hash),
      selection.hash,
      selection.repeatable
    );
    if (
      !history ||
      history.state !== 'active' ||
      history.historyId !== selection.historyId ||
      shared.getItem(PREFIX + selection.hash) !== operationMarker(history)
    )
      return identityError();
    const generation = history.generations[selection.generation - 1];
    if (!generation || generation.operationId !== selection.operationId) return identityError();
    const prior = legacyOperationId(session.getItem(PREFIX + selection.hash));
    const pointer = readOperationPointer(session.getItem(HISTORY_PREFIX + selection.hash), history);
    if (prior !== null && !history.generations.some((item) => item.operationId === prior))
      return identityError();
    // Another saved, uncertain intent must not be displaced by this delayed start.
    if (
      !allowOtherPointer &&
      ((prior !== null && prior !== selection.operationId) ||
        (pointer !== null &&
          (pointer.generation !== selection.generation ||
            pointer.operationId !== selection.operationId)))
    )
      return identityError();
    return { history, shared, session, pointer };
  }

  /** Prepare only: no transition dispatch. The selected operation cannot change after this returns. */
  async function prepare(
    hash: string,
    repeatable: boolean,
    isCurrent: () => boolean
  ): Promise<PreparedOperation> {
    operationStorage();
    assertCurrent(isCurrent);
    if (!/^[a-f0-9]{64}$/.test(hash)) return identityError();
    return navigator.locks.request(PREFIX + hash, { mode: 'exclusive' }, () => {
      assertCurrent(isCurrent);
      const { shared, session } = operationStorage();
      const key = HISTORY_PREFIX + hash;
      let history = readOperationHistory(shared.getItem(key), hash, repeatable);
      const rawLegacy = shared.getItem(PREFIX + hash);
      const savedLegacy = legacyOperationId(session.getItem(PREFIX + hash));
      if (!config.allowLegacyAdoption && (savedLegacy !== null || (!history && rawLegacy !== null)))
        return identityError();
      if (!history) {
        // A marker/pointer without its history is loss of identity, not an empty slot.
        if (session.getItem(key) !== null) return identityError();
        const sharedLegacy = legacyOperationId(rawLegacy);
        if (savedLegacy !== null && sharedLegacy !== null && savedLegacy !== sharedLegacy)
          return identityError();
        history = {
          version: 2,
          historyId: operationId(),
          hash,
          repeatable,
          state: 'initializing',
          head: 1,
          generations: [
            {
              generation: 1,
              operationId: savedLegacy ?? sharedLegacy ?? operationId(),
              acknowledged: false,
              starts: [],
            },
          ],
        };
        saveOperation(shared, key, JSON.stringify(history));
      }
      if (history.state === 'initializing') {
        // Recovery is allowed only before any start could have dispatched. Keep
        // the adopted UUID when either write was interrupted; never select a new one.
        if (session.getItem(key) !== null) return identityError();
        const prior = rawLegacy === operationMarker(history) ? null : legacyOperationId(rawLegacy);
        if (
          (prior !== null && prior !== history.generations[0].operationId) ||
          (savedLegacy !== null && savedLegacy !== history.generations[0].operationId)
        )
          return identityError();
        saveOperation(shared, PREFIX + hash, operationMarker(history));
        history.state = 'active';
        saveOperation(shared, key, JSON.stringify(history));
      } else if (rawLegacy !== operationMarker(history)) return identityError();
      const pointer = readOperationPointer(session.getItem(key), history);
      const legacyGeneration =
        savedLegacy === null
          ? undefined
          : history.generations.find((item) => item.operationId === savedLegacy);
      if (
        (savedLegacy !== null && !legacyGeneration) ||
        (pointer && legacyGeneration && pointer.operationId !== legacyGeneration.operationId)
      )
        return identityError();
      let selected = pointer
        ? history.generations[pointer.generation - 1]
        : (legacyGeneration ?? history.generations[history.head - 1]);
      if (!pointer && !legacyGeneration && repeatable && selected.acknowledged) {
        if (!Number.isSafeInteger(history.head + 1)) return identityError();
        selected = {
          generation: history.head + 1,
          operationId: operationId(),
          acknowledged: false,
          starts: [],
        };
        if (history.generations.some((item) => item.operationId === selected.operationId))
          return identityError();
        history.generations.push(selected);
        history.head = selected.generation;
        saveOperation(shared, key, JSON.stringify(history));
      }
      assertCurrent(isCurrent);
      const prepared = Object.freeze({}) as PreparedOperation;
      preparedOperations.set(prepared, {
        hash,
        historyId: history.historyId,
        generation: selected.generation,
        operationId: selected.operationId,
        repeatable,
        isCurrent,
      });
      return prepared;
    });
  }

  /** Synchronous accepted-gesture boundary. Call before settlement checks or any await. */
  function capture(prepared: PreparedOperation, isCurrent: () => boolean): CapturedOperation {
    const selection = preparedOperations.get(prepared);
    if (!selection) return identityError();
    assertCurrent(selection.isCurrent);
    assertCurrent(isCurrent);
    let valid = true;
    const current = () => (valid = valid && selection.isCurrent() && isCurrent());
    const start = Object.freeze({}) as CapturedOperation;
    capturedOperations.set(start, { ...selection, isCurrent: current, startId: operationId() });
    return start;
  }

  /** @internal Receipt-only wrapper recapture; keeps the exact original generation. */
  function recapture(original: CapturedOperation, isCurrent: () => boolean): CapturedOperation {
    const selection = capturedOperations.get(original);
    if (!selection || typeof isCurrent !== 'function') return identityError();
    assertCurrent(isCurrent);
    const start = Object.freeze({}) as CapturedOperation;
    capturedOperations.set(start, { ...selection, isCurrent, startId: operationId() });
    return start;
  }

  /** Durable admission only. The exact captured generation is required, even behind a newer head. */
  async function admit(start: CapturedOperation): Promise<AdmittedOperation> {
    const selection = capturedOperations.get(start);
    if (!selection) return identityError();
    assertCurrent(selection.isCurrent);
    operationStorage();
    return navigator.locks.request(PREFIX + selection.hash, { mode: 'exclusive' }, () => {
      assertCurrent(selection.isCurrent);
      const { history, shared, session } = loadActiveOperation(selection);
      const generation = history.generations[selection.generation - 1];
      const existing = generation.starts.find((item) => item.startId === selection.startId);
      if (!existing) {
        if (
          history.generations.some((item) =>
            item.starts.some((saved) => saved.startId === selection.startId)
          )
        )
          return identityError();
        generation.starts.push({ startId: selection.startId, acknowledged: false });
        saveOperation(shared, HISTORY_PREFIX + selection.hash, JSON.stringify(history));
      }
      // Replacing a same-generation pointer preserves its exact operation. An old
      // acknowledgment can clear only its own start, never this newer pointer.
      const pointer: OperationPointer = {
        version: 2,
        historyId: history.historyId,
        generation: generation.generation,
        operationId: generation.operationId,
        startId: selection.startId,
      };
      saveOperation(session, HISTORY_PREFIX + selection.hash, JSON.stringify(pointer));
      assertCurrent(selection.isCurrent);
      const admitted = Object.freeze({ operationId: generation.operationId }) as AdmittedOperation;
      admittedOperations.set(admitted, selection);
      return admitted;
    });
  }

  /** @internal Adapter calls only after strict canonical receipt validation; this is not financial proof. */
  async function acknowledge(admitted: AdmittedOperation): Promise<boolean> {
    const selection = admittedOperations.get(admitted);
    if (!selection) return false;
    try {
      assertCurrent(selection.isCurrent);
      operationStorage();
      return await navigator.locks.request(PREFIX + selection.hash, { mode: 'exclusive' }, () => {
        assertCurrent(selection.isCurrent);
        // A late G1 acknowledgment may record only G1 while a valid G2 pointer
        // exists. Admission refuses that conflict; acknowledgment never replaces it.
        const { history, shared, session, pointer } = loadActiveOperation(selection, true);
        const generation = history.generations[selection.generation - 1];
        const start = generation.starts.find((item) => item.startId === selection.startId);
        if (!start) return identityError();
        start.acknowledged = true;
        generation.acknowledged = true;
        saveOperation(shared, HISTORY_PREFIX + selection.hash, JSON.stringify(history));
        // Shared acknowledgment precedes tab cleanup. A crash repeats the same
        // service receipt; it never silently advances this tab's unknown identity.
        if (pointer?.startId === selection.startId) {
          session.removeItem(HISTORY_PREFIX + selection.hash);
          if (session.getItem(HISTORY_PREFIX + selection.hash) !== null) return identityError();
        }
        const legacy = legacyOperationId(session.getItem(PREFIX + selection.hash));
        if (legacy === selection.operationId) {
          session.removeItem(PREFIX + selection.hash);
          if (session.getItem(PREFIX + selection.hash) !== null) return identityError();
        }
        return true;
      });
    } catch {
      // Preserve a confirmed service result on coordination failure. Retained
      // identity forces a later explicit action to replay, never to mint a retry.
      return false;
    }
  }

  function reference(
    value: PreparedOperation | CapturedOperation | AdmittedOperation
  ): OperationReference {
    const selection =
      preparedOperations.get(value as PreparedOperation) ??
      capturedOperations.get(value as CapturedOperation) ??
      admittedOperations.get(value as AdmittedOperation);
    if (!selection) return identityError();
    const { hash, historyId, generation, operationId, repeatable } = selection;
    return Object.freeze({ hash, historyId, generation, operationId, repeatable });
  }
  async function restore(
    ref: OperationReference,
    isCurrent: () => boolean
  ): Promise<PreparedOperation> {
    operationStorage();
    assertCurrent(isCurrent);
    if (
      !operationObject(ref, ['hash', 'historyId', 'generation', 'operationId', 'repeatable']) ||
      !/^[a-f0-9]{64}$/.test(ref.hash) ||
      !operationUUID(ref.historyId) ||
      !operationUUID(ref.operationId) ||
      !Number.isSafeInteger(ref.generation) ||
      ref.generation < 1 ||
      typeof ref.repeatable !== 'boolean'
    )
      return identityError();
    return navigator.locks.request(PREFIX + ref.hash, { mode: 'exclusive' }, () => {
      assertCurrent(isCurrent);
      const selection = { ...ref, isCurrent };
      loadActiveOperation(selection, true);
      const prepared = Object.freeze({}) as PreparedOperation;
      preparedOperations.set(prepared, selection);
      return prepared;
    });
  }
  async function wasAcknowledged(value: AdmittedOperation): Promise<boolean> {
    const selection = admittedOperations.get(value);
    if (!selection) return identityError();
    operationStorage();
    assertCurrent(selection.isCurrent);
    return navigator.locks.request(PREFIX + selection.hash, { mode: 'exclusive' }, () => {
      assertCurrent(selection.isCurrent);
      return loadActiveOperation(selection, true).history.generations[selection.generation - 1]
        .acknowledged;
    });
  }
  return { prepare, capture, recapture, admit, acknowledge, reference, restore, wasAcknowledged };
}
