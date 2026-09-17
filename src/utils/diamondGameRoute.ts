/** The wheel and its four earned games take over the screen; operations retain their shell. */
export function isDiamondGameRoute(pathname: string): boolean {
  return /^\/clubs\/[^/]+\/(?:wheel|plinko|crash|crossing|mines)\/?$/.test(pathname);
}
