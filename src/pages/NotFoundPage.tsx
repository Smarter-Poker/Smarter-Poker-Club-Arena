import { useLocation, useNavigate } from 'react-router-dom';
import { EmptyState } from '../components/common/EmptyState';

/**
 * A route failure is still part of the product experience.
 *
 * Keep the invalid path visible in the browser for diagnosis, but provide
 * deterministic exits instead of a generic blue 404 card that visually forks
 * from the rest of Club Arena.
 */
export default function NotFoundPage() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <EmptyState
      icon="404"
      eyebrow="Route Not Found"
      title="This Arena Door Is Closed"
      description={`No Current Page Matches ${location.pathname}. The Destination May Have Moved, Or The Link May Be Incomplete.`}
      action={{ label: 'Return To Club Arena', onClick: () => navigate('/', { replace: true }) }}
      secondaryAction={{ label: 'Go Back', onClick: () => navigate(-1) }}
    />
  );
}
