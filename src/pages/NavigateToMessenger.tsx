import { useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

/**
 * Component that replaces the old embedded iframe messenger.
 * Native redirects to World Hub's messenger, passing context along.
 */
export default function NavigateToMessenger() {
  const [searchParams] = useSearchParams();
  const { clubId, conversationId } = useParams<{
    clubId?: string;
    conversationId?: string;
  }>();

  useEffect(() => {
    // Collect parameters
    const params = new URLSearchParams(searchParams);

    // Path params take precedence if they exist
    const finalClubId = clubId || searchParams.get('club');
    if (finalClubId) params.set('clubId', finalClubId);
    if (conversationId) params.set('conversation', conversationId);

    const uid = searchParams.get('uid') || searchParams.get('compose');
    if (uid) params.set('uid', uid);

    // Ensure we don't pass 'hideHeader' since we are doing a full navigation
    params.delete('hideHeader');
    params.delete('bottomPad');

    const qs = params.toString();
    const destination = `/hub/messenger${qs ? '?' + qs : ''}`;

    // Perform full native redirect
    window.location.replace(destination);
  }, [clubId, conversationId, searchParams]);

  return null;
}
