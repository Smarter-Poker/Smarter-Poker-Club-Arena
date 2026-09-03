/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ⚖️ TOS GUARD — Blocks app until Terms of Service accepted
 * ═══════════════════════════════════════════════════════════════════════════════
 * Passthrough wrapper for future TOS enforcement. When enabled, this will:
 * 1. Check if the user has accepted the latest TOS version via profileService
 * 2. Show TOSAcceptanceModal if not accepted
 * 3. Block app rendering until acceptance is confirmed
 */

import { ReactNode } from 'react';

interface TOSGuardProps {
  children: ReactNode;
}

export default function TOSGuard({ children }: TOSGuardProps) {
  return <>{children}</>;
}
