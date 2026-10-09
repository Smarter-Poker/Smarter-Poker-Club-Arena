/** A lease protects an in-flight action and its acknowledgement from shell adoption. */
const holders = new Set<symbol>();

export function holdShellReload(): () => void {
  const token = Symbol('shell-reload-lease');
  holders.add(token);
  return () => {
    holders.delete(token);
  };
}

export function isShellReloadBlocked(): boolean {
  return holders.size > 0;
}
