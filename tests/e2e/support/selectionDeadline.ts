/** A failed final read supplies no new occupancy or stall evidence. */
export class SelectionObservationDeadline extends Error {
  constructor(readonly cause: unknown) {
    super(
      'The selection observation deadline expired before the final health read completed. Current subject availability and stall state are unknown.'
    );
    this.name = 'SelectionObservationDeadline';
  }
}

export async function observeBeforeSelectionDeadline<T>(
  deadline: number,
  read: () => Promise<T>,
  now: () => number = Date.now
): Promise<T> {
  if (now() >= deadline) throw new SelectionObservationDeadline(null);
  try {
    return await read();
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError' && now() >= deadline)
      throw new SelectionObservationDeadline(error);
    throw error;
  }
}

/** Only a fully successful observation clears its preceding operational failure. */
export function createSelectionObservation() {
  let precedingFailure: unknown = null;
  return async function observe<T>(deadline: number, operation: () => Promise<T>): Promise<T> {
    try {
      const result = await observeBeforeSelectionDeadline(deadline, operation);
      precedingFailure = null;
      return result;
    } catch (error) {
      if (error instanceof SelectionObservationDeadline && precedingFailure !== null)
        throw precedingFailure;
      if (!(error instanceof SelectionObservationDeadline)) precedingFailure = error;
      throw error;
    }
  };
}
