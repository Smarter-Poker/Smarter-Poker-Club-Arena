/**
 * Browser-harness stand-in for src/hooks/useAuthUser. The harness server
 * aliases the real hook to this file so the REAL FirstRunPushPrompt renders
 * for a signed-in player without a Supabase project. The player id comes from
 * the page URL (?uid=...), so each test chooses who is signed in.
 */
export function useAuthUser() {
  const uid = new URLSearchParams(window.location.search).get('uid') || 'harness-player-0001';
  return { user: { id: uid }, isAuthenticated: true, isHydrating: false };
}
