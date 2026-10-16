// Bind the exact captured JWT to the operation owner after async refresh.
// This is a client race guard; the existing API still verifies authentication.
export async function requestForDockActor(url, options, getToken, fetcher = fetch) {
    const { actorId, currentActor, ...request } = options;
    if (!actorId || typeof currentActor !== 'function' || currentActor() !== actorId)
        throw new Error('Account Changed. Reopen This Conversation');
    const token = await getToken();
    let subject = null;
    try {
        const raw = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        subject = JSON.parse(atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, '='))).sub;
    } catch { /* A missing or malformed token cannot own a request. */ }
    if (!token || subject !== actorId || currentActor() !== actorId)
        throw new Error('Account Changed. Reopen This Conversation');
    return fetcher(url, { ...request, signal: request.signal || AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json', ...request.headers, Authorization: `Bearer ${token}` } });
}
