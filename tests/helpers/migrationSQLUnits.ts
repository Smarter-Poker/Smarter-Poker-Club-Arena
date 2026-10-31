/** Preserve SQL-literal boundaries. Catalog JSON may contain DDL that a later
 * EXECUTE extracts, so inspect every decoded string separately, conservatively.
 * Never join a stored, incomplete header to the following executable function.
 */
export function catalogSQLUnits(sql: string): Array<{ sql: string; offset: number }> {
  const values: Array<{ sql: string; offset: number }> = [];
  function strings(value: unknown, offset: number) {
    if (typeof value === 'string') values.push({ sql: value, offset });
    else if (value !== null && typeof value === 'object')
      Object.entries(value).forEach(([key, child]) => {
        strings(key, offset);
        strings(child, offset);
      });
  }
  function bodyUnits(text: string, base: number): string {
    const tags = /\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/g;
    let result = '';
    let from = 0;
    for (let match = tags.exec(text); match; match = tags.exec(text)) {
      const start = match.index + match[0].length;
      const end = text.indexOf(match[0], start);
      if (end < 0) break;
      const body = text.slice(start, end);
      let json: object | undefined;
      if (body.trimStart().startsWith('{') || body.trimStart().startsWith('[')) {
        try {
          const value = JSON.parse(body);
          if (value !== null && typeof value === 'object') json = value;
        } catch {
          // Invalid JSON remains SQL text; it cannot hide a declaration.
        }
      }
      result += text.slice(from, start);
      if (json) {
        strings(json, base + start);
        result += body.replace(/[^\n]/g, ' ');
      } else result += bodyUnits(body, base + start);
      result += match[0];
      from = end + match[0].length;
      tags.lastIndex = from;
    }
    return result + text.slice(from);
  }
  const outer = bodyUnits(sql, 0);
  return [{ sql: outer, offset: 0 }, ...values];
}
