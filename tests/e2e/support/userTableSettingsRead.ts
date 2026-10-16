/** Match the settings owner being asserted, rather than the first hydration read. */
export function selectsUserTableSettingsColumn(url: string, column: string): boolean {
  const request = new URL(url);
  if (!request.pathname.endsWith('/rest/v1/user_table_settings')) return false;
  const selected = request.searchParams
    .get('select')
    ?.split(',')
    .map((field) => field.trim());
  return selected?.some((field) => field === '*' || field === column) ?? false;
}
