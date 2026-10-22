/** Capture a server decision for one request; a delayed ACK cannot paint a later turn. */
export function lightningTimeBankRequest(
  read: () => {
    scope: string;
    lightning: boolean;
    handId: string | null;
    actionContext?: string;
    mounted: boolean;
  }
) {
  const before = { ...read() };
  const decision =
    before.lightning && before.handId && before.actionContext
      ? { handId: before.handId, actionContext: before.actionContext }
      : undefined;
  return {
    decision,
    mayDispatch: !before.lightning || !!decision,
    isCurrent: () => {
      const now = read();
      return (
        now.mounted &&
        now.scope === before.scope &&
        (!before.lightning ||
          (now.lightning &&
            now.handId === before.handId &&
            now.actionContext === before.actionContext))
      );
    },
  };
}
