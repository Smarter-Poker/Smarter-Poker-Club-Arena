export const ROSTER_SUMMARY_REUSE_MS = 30_000;

interface SummaryEntry<T> {
  key: string;
  generation: number;
  value?: T;
  settledAt: number | null;
  inFlight: Promise<T> | null;
}

/**
 * Keeps query-only roster changes from restarting an identical summary read.
 * The coordinator is intentionally page-local: summary capabilities are scoped
 * to a viewer and must never leak through a process-wide cache.
 */
export class RosterSummaryCoordinator<T> {
  private entry: SummaryEntry<T> | null = null;
  private generation = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  read(key: string, reader: () => Promise<T>, options: { force?: boolean } = {}): Promise<T> {
    const current = this.entry;
    if (current?.key === key) {
      if (current.inFlight) return current.inFlight;
      if (
        !options.force &&
        current.settledAt !== null &&
        this.clock() - current.settledAt < ROSTER_SUMMARY_REUSE_MS &&
        'value' in current
      ) {
        return Promise.resolve(current.value as T);
      }
    }

    const generation = ++this.generation;
    const entry: SummaryEntry<T> = {
      key,
      generation,
      settledAt: null,
      inFlight: null,
    };
    const request = Promise.resolve()
      .then(reader)
      .then((value) => {
        if (this.entry === entry && entry.generation === generation) {
          entry.value = value;
          entry.settledAt = this.clock();
          entry.inFlight = null;
        }
        return value;
      })
      .catch((error: unknown) => {
        if (this.entry === entry && entry.generation === generation) this.entry = null;
        throw error;
      });
    entry.inFlight = request;
    this.entry = entry;
    return request;
  }

  reset(): void {
    this.generation += 1;
    this.entry = null;
  }
}

interface IndependentRosterReads<TSummary, TPage> {
  summary: Promise<TSummary>;
  page: Promise<TPage>;
  onSummary: (summary: TSummary) => void;
  onPage: (page: TPage) => void;
  onSummaryError: (error: unknown) => void;
  onPageError: (error: unknown) => void;
}

/**
 * Runs both reads concurrently but delivers each result as soon as it settles.
 * A slow totals query therefore cannot hold a successful directory page behind
 * its timeout/retry window, while callers can still await both for refresh UI.
 */
export function settleRosterReadsIndependently<TSummary, TPage>({
  summary,
  page,
  onSummary,
  onPage,
  onSummaryError,
  onPageError,
}: IndependentRosterReads<TSummary, TPage>): Promise<
  [PromiseSettledResult<TSummary>, PromiseSettledResult<TPage>]
> {
  const summaryDelivery = summary.then(
    (value) => {
      onSummary(value);
      return value;
    },
    (error: unknown) => {
      onSummaryError(error);
      throw error;
    }
  );
  const pageDelivery = page.then(
    (value) => {
      onPage(value);
      return value;
    },
    (error: unknown) => {
      onPageError(error);
      throw error;
    }
  );
  return Promise.allSettled([summaryDelivery, pageDelivery]);
}
