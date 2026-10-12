import type { ComponentProps, ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { rememberStatsEvidenceOrigin } from '../../lib/statsEvidenceNavigation';

interface Props extends Omit<ComponentProps<typeof Link>, 'children'> {
  children: ReactNode;
}

export default function StatsEvidenceLink({ children, onClick, ...props }: Props) {
  const location = useLocation();

  return (
    <Link
      {...props}
      onClick={(event) => {
        rememberStatsEvidenceOrigin(location, window.scrollY);
        onClick?.(event);
      }}
    >
      {children}
    </Link>
  );
}
