/** The persisted MTT table suffix, never a buy-in or an array position. */
export function tournamentTableLabel(name: string | null | undefined): string | null {
  const match = (name || '').trim().match(/\btable\s*#?\s*(\d+)\s*$/i);
  if (match) {
    const number = Number(match[1]);
    if (Number.isSafeInteger(number) && number > 0) return `Table ${number.toLocaleString()}`;
  }
  return /\bfinal\s+table\s*$/i.test(name || '') ? 'Final Table' : null;
}
