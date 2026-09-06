import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { resolveUnionUUID, resolveUnionUUIDSync } from '../utils/unionIdResolver';

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
export function useUnionRouteId(): { unionId: string | undefined; unionRef: string | undefined } {
  const { unionId: unionRef } = useParams<{ unionId: string }>();
  const [resolved, setResolved] = useState<{
    ref: string | undefined;
    id: string | undefined;
  }>(() => ({
    ref: unionRef,
    id: unionRef ? (resolveUnionUUIDSync(unionRef) ?? undefined) : undefined,
  }));

  useEffect(() => {
    if (!unionRef) {
      setResolved({ ref: undefined, id: undefined });
      return;
    }
    const sync = resolveUnionUUIDSync(unionRef);
    if (sync) {
      setResolved({ ref: unionRef, id: sync });
      return;
    }
    let live = true;
    setResolved({ ref: unionRef, id: undefined });
    resolveUnionUUID(unionRef).then((id) => {
      if (live) setResolved({ ref: unionRef, id });
    });
    return () => {
      live = false;
    };
  }, [unionRef]);

  // Effects run after render. Associating the resolved UUID with the route ref
  // means a slug-to-slug navigation cannot expose the previous route's UUID
  // for even that intervening render while the new lookup is still pending.
  return {
    unionId: resolved.ref === unionRef ? resolved.id : undefined,
    unionRef,
  };
}
