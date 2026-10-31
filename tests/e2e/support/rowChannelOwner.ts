/** UI route aliases can differ; the actual joined database filter owns club scope. */
export function isClubMemberOwnerJoin(
  topic: unknown,
  event: unknown,
  payload: unknown,
  clubId: string
): boolean {
  if (
    typeof topic !== 'string' ||
    !/^realtime:club-members-.+:row:.+$/.test(topic) ||
    event !== 'phx_join'
  )
    return false;
  if (!payload || typeof payload !== 'object') return false;
  const config = (payload as { config?: unknown }).config;
  if (!config || typeof config !== 'object') return false;
  const bindings = (config as { postgres_changes?: unknown }).postgres_changes;
  return (
    Array.isArray(bindings) &&
    bindings.some((binding: unknown) => {
      if (!binding || typeof binding !== 'object') return false;
      const value = binding as Record<string, unknown>;
      return (
        value.schema === 'public' &&
        value.table === 'club_members' &&
        value.event === '*' &&
        value.filter === `club_id=eq.${clubId}`
      );
    })
  );
}
