/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NEW CONVERSATION PAGE (DEPRECATED)
 * ═══════════════════════════════════════════════════════════════════════════════
 * This page is deprecated in favor of the premium embedded multi-identity
 * messenger which has high-fidelity search, groups, and composer built-in.
 * It immediately redirects users to /messages.
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export default function NewConversationPage() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate('/messages', { replace: true });
  }, [navigate]);

  return null;
}
