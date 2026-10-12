/** Backend enum copy is checked independently of rendered player identity. */
export function financialConsoleEnumCopy(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  // This is CreditAdminPanel's displayName field, never a status, amount,
  // permission or error. UUID checking still uses the entire original copy.
  copy.querySelectorAll('[class*="_agentIdentity_"] > strong').forEach((name) => name.remove());
  // Every other console names a player through an explicit marker: Credit
  // Admin's audit rows, the credit request inbox and the Disputes submitter
  // line print a poker alias ("the_kicker") inside [data-player-name].
  copy.querySelectorAll('[data-player-name]').forEach((name) => name.remove());
  const walker = element.ownerDocument.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  while (walker.nextNode()) parts.push(walker.currentNode.textContent || '');
  return parts.join('\n');
}
