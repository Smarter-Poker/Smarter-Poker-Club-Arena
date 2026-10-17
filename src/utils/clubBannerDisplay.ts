/** The retired shared campaign must never stand in for a club-owned banner. */
export function isRetiredClubBanner(url: string | null | undefined): boolean {
  return (
    typeof url === 'string' &&
    /(?:^|\/)shark-club-championship-ad-(?:mobile-v4|v2)\.(?:png|webp)(?:[?#]|$)/i.test(url)
  );
}
