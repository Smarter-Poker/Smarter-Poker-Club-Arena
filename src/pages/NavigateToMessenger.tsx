import { useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { leaveForHub } from '../lib/openExternal';

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
    /* `params` is a copy of the incoming search, so a `?club=` arriving from
       Club Arena navigation would ride along beside the `clubId` built from
       it and hand the Hub the same fact under two names. Drop the Arena-side
       spelling now that it has been translated. */
    params.delete('club');
    if (conversationId) params.set('conversation', conversationId);

    const uid = searchParams.get('uid') || searchParams.get('compose');
    if (uid) params.set('uid', uid);

    // Ensure we don't pass 'hideHeader' since we are doing a full navigation
    params.delete('hideHeader');
    params.delete('bottomPad');

    const qs = params.toString();
    const destination = `/hub/messenger${qs ? '?' + qs : ''}`;

    // Full navigation on the web; the in-app browser in the native app.
    leaveForHub(destination, { replace: true });
  }, [clubId, conversationId, searchParams]);

  return null;
}
