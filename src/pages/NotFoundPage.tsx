import { useNavigate } from 'react-router-dom';
import { EmptyState } from '../components/common/EmptyState';
import { usePageTitle } from '../hooks/usePageTitle';

/**
 * A route failure is still part of the product experience.
 *
 * Keep the invalid path visible in the browser for diagnosis, but provide
 * deterministic exits instead of a generic blue 404 card that visually forks
 * from the rest of Club Arena.
 */
export default function NotFoundPage() {
  usePageTitle('Page Not Found');
  const navigate = useNavigate();

  return (
    <EmptyState
      icon="404"
      eyebrow="Route Not Found"
      title="This Arena Door Is Closed"
      /* The path stays in the address bar. Printed here it went through the
         card's Title Case and read "/clubs/shark-Club/leaderboard", a path
         that does not exist (2026-10-17). */
      description="No Current Page Matches This Address. The Destination May Have Moved, Or The Link May Be Incomplete."
      action={{ label: 'Return To Club Arena', onClick: () => navigate('/', { replace: true }) }}
      secondaryAction={{ label: 'Go Back', onClick: () => navigate(-1) }}
    />
  );
}
