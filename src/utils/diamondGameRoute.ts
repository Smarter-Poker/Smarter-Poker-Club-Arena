/** Only the four playable games take over the screen; wheel and operations keep their shell. */
export function isDiamondGameRoute(pathname: string): boolean {
  return /^\/clubs\/[^/]+\/(?:plinko|crash|crossing|mines)\/?$/.test(pathname);
}
