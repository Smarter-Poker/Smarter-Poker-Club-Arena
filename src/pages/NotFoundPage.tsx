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
      description={`No current page matches ${location.pathname}. The destination may have moved, or the link may be incomplete.`}
      action={{ label: 'Return To Club Arena', onClick: () => navigate('/', { replace: true }) }}
      secondaryAction={{ label: 'Go Back', onClick: () => navigate(-1) }}
    />
  );
}
