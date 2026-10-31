import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { resolveUnionUUID, resolveUnionUUIDSync } from '../utils/unionIdResolver';
import { reportError } from '../utils/errorReporter';

/**
 * The union a /unions/:unionId route is about, as a UUID the database
 * understands - whether the URL carried the slug (/unions/midway-union) or the
 * id. `undefined` while a slug is still being looked up, so effects keyed on
 * it wait rather than query with a slug in a uuid column (22P02).
 *
 * `unionRef` is the identifier AS WRITTEN IN THE URL, for building links back
 * into the same union (/unions/${unionRef}/games): a link built from the UUID
 * would work, but only via a SlugEnforcer redirect on every click.
 */
export function useUnionRouteId(routeUnionRef?: string | null): {
  unionId: string | undefined;
  unionRef: string | undefined;
  resolutionStatus: 'loading' | 'ready' | 'not_found' | 'error';
  retryResolution: () => void;
} {
  const { unionId: matchedUnionRef } = useParams<{ unionId: string }>();
  /* Layout chrome is rendered by the parameterless parent route, so its
     useParams() context cannot see a child route's :unionId. Callers such as
     the hamburger and section rail pass the segment they read from the current
     pathname; route pages keep using the inherited match exactly as before. */
  const unionRef = routeUnionRef === null ? undefined : (routeUnionRef ?? matchedUnionRef);
  const [revision, setRevision] = useState(0);
  const [resolved, setResolved] = useState<{
    ref: string | undefined;
    id: string | undefined;
    status: 'loading' | 'ready' | 'not_found' | 'error';
  }>(() => ({
    status:
      unionRef && resolveUnionUUIDSync(unionRef) ? 'ready' : unionRef ? 'loading' : 'not_found',
    ref: unionRef,
    id: unionRef ? (resolveUnionUUIDSync(unionRef) ?? undefined) : undefined,
  }));

  useEffect(() => {
    if (!unionRef) {
      setResolved({ ref: undefined, id: undefined, status: 'not_found' });
      return;
    }
    const sync = resolveUnionUUIDSync(unionRef);
    if (sync) {
      setResolved({ ref: unionRef, id: sync, status: 'ready' });
      return;
    }
    let live = true;
    setResolved({ ref: unionRef, id: undefined, status: 'loading' });
    resolveUnionUUID(unionRef)
      .then((id) => {
        if (live)
          setResolved({ ref: unionRef, id: id ?? undefined, status: id ? 'ready' : 'not_found' });
      })
      .catch((error) => {
        if (!live) return;
        reportError(error, 'useUnionRouteId.resolve', { unionRef });
        setResolved({ ref: unionRef, id: undefined, status: 'error' });
      });
    return () => {
      live = false;
    };
  }, [unionRef, revision]);

  // Effects run after render. Associating the resolved UUID with the route ref
  // means a slug-to-slug navigation cannot expose the previous route's UUID
  // for even that intervening render while the new lookup is still pending.
  return {
    unionId: resolved.ref === unionRef ? resolved.id : undefined,
    unionRef,
    resolutionStatus: resolved.ref === unionRef ? resolved.status : 'loading',
    retryResolution: () => setRevision((value) => value + 1),
  };
}
