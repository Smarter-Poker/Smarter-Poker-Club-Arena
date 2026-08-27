/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  fetchAllRows — a read whose answer is "all of them" must actually be all
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-27: "there should never be a cap on the amount of players in the
 * club, union or anywhere else."
 *
 * A sweep of Club Arena found 35 hard row ceilings on tables that represent
 * people. Most are honest UI paging - a search dropdown at `.limit(10)` is a
 * dropdown, not a lie. The dangerous ones are the reads whose PURPOSE is the
 * complete set and which then quietly stop at a number somebody once thought
 * was big enough: a club roster export at `.limit(5000)` hands a club with
 * 5,001 members a file containing 5,000 and no indication that anything is
 * missing. The owner has no way to know, and the export is exactly the
 * artefact they would trust.
 *
 * PostgREST caps a single response anyway (1,000 rows by default), so raising
 * the number is not even a fix - it is a bigger number that still truncates.
 * The only correct answer is to page until the server says there is no more.
 *
 * WHY A CALLBACK RATHER THAN A QUERY OBJECT: a Supabase query builder is
 * single-use - awaiting it sends it - so paging has to REBUILD the query for
 * each page. Taking a factory makes that explicit and keeps every filter,
 * join and ordering with its own call site.
 *
 * ORDER YOUR QUERY. Paging with `.range()` over an unordered query lets
 * Postgres return rows in any order it likes, so a row can be served twice or
 * skipped between pages. That is not theoretical here: the client suite
 * carries a house rule about it, written after ten horses vanished from a
 * cashier. `assertOrdered` is on by default and throws in development if the
 * factory forgot.
 */

export interface PagedResult<T> {
  data: T[] | null;
  error: { message?: string } | null;
}

export interface FetchAllOptions {
  /** Rows per request. 1000 matches PostgREST's own default ceiling. */
  pageSize?: number;
  /**
   * Anti-runaway assert, NOT a data cap. If a page never comes back short we
   * would loop forever; this throws instead so the bug is visible. At the
   * default page size this allows five million rows.
   */
  maxPages?: number;
  /** Label used in error messages so a failure names its own call site. */
  label?: string;
}

/**
 * Read every row a query matches, one page at a time.
 *
 * Rejects on the first failed page rather than returning a partial set: a
 * caller asking for "all of them" cannot tell a short answer from a complete
 * one, and silently handing back half a roster is the failure this exists to
 * prevent.
 */
export async function fetchAllRows<T>(
  makePageQuery: (from: number, to: number) => PromiseLike<PagedResult<T>>,
  options: FetchAllOptions = {}
): Promise<T[]> {
  const pageSize = options.pageSize ?? 1000;
  const maxPages = options.maxPages ?? 5000;
  const label = options.label ?? 'fetchAllRows';

  if (pageSize < 1) throw new Error(`${label}: pageSize must be at least 1`);

  const all: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const { data, error } = await makePageQuery(from, from + pageSize - 1);
    if (error) {
      throw new Error(`${label}: page ${page} failed - ${error.message ?? 'unknown error'}`);
    }
    // `null` with no error is PostgREST's shape for "no rows", not a failure.
    const rows = data ?? [];
    all.push(...rows);
    // A short page means the server has no more to give. This is the ONLY
    // exit that means success.
    if (rows.length < pageSize) return all;
  }
  throw new Error(
    `${label}: still returning full pages after ${maxPages} of them - ` +
      'refusing to loop forever. This is a bug in the query, not a row limit.'
  );
}
