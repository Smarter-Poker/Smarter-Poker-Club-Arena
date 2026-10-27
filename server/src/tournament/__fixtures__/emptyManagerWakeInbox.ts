/** Empty durable inbox for sweep fixtures exercising unrelated business stages. */
export function emptyManagerWakeInbox(): any {
  const query: any = {};
  for (const name of ['select', 'eq', 'is', 'order']) query[name] = () => query;
  query.limit = () => Promise.resolve({ data: [], error: null });
  return query;
}
