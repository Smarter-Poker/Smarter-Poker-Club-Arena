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
