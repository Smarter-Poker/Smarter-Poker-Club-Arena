/**
 * "Name · Stakes" for the eyebrow, unless the name already carries the stakes
 * ("NLH 1/2 Main · 1/2" printed the same figure twice).
 */
export function withStakes(name: string, stakes: string): string {
  if (!stakes) return name;
  if (name.toLowerCase().includes(stakes.toLowerCase())) return name;
  return `${name} · ${stakes}`;
}
