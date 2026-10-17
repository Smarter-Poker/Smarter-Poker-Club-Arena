// A send operation owns its immutable wire payload until an authoritative
// receipt arrives. Reloading never sends it; only an explicit retry does.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX = 'sp-messenger-send-v1:';
const MAX_PENDING = 100;
const MAX_RECORD_BYTES = 32768;
const copy = value => JSON.parse(JSON.stringify(value));

export function createMessengerSendOperation({ actorId, conversationId, content, metadata = null,
    messageType = 'text', profile = null, requestId = globalThis.crypto.randomUUID(), createdAt = new Date().toISOString() }) {
    if (!UUID.test(requestId) || !UUID.test(actorId) || !UUID.test(conversationId)
        || typeof content !== 'string' || !content.trim() || content.length > MAX_RECORD_BYTES / 2) {
        throw new Error('Invalid Message Operation');
    }
    const payload = { requestId, conversationId, content, message_type: messageType, media_metadata: copy(metadata) };
    return { actorId, requestId, conversationId, createdAt, profile: copy(profile),
        body: JSON.stringify(payload), status: 'failed', receipt: null, inFlight: null };
}

const key = operation => `${PREFIX}${operation.actorId}:${operation.requestId}`;
export function saveMessengerSendOperation(storage, operation) {
    const { actorId, requestId, conversationId, createdAt, profile, body } = operation;
    const record = JSON.stringify({ actorId, requestId, conversationId, createdAt, profile, body });
    if (record.length > MAX_RECORD_BYTES) throw new Error('Message Retry Record Is Too Large');
    if (!storage.getItem(key(operation))) {
        let pending = 0;
        for (let index = 0; index < storage.length; index++) {
            if (storage.key(index)?.startsWith(`${PREFIX}${actorId}:`)) pending++;
        }
        // Never discard an unresolved operation to make space for a new send.
        if (pending >= MAX_PENDING) throw new Error('Resolve Pending Messages Before Sending More');
    }
    storage.setItem(key(operation), record);
}
export function forgetMessengerSendOperation(storage, operation) {
    storage.removeItem(key(operation));
}
export function restoreMessengerSendOperations(storage, actorId) {
    const operations = [];
    const prefix = `${PREFIX}${actorId}:`;
    for (let index = 0; index < storage.length; index++) {
        const name = storage.key(index);
        if (!name?.startsWith(prefix)) continue;
        try {
            const record = storage.getItem(name);
            if (!record || record.length > MAX_RECORD_BYTES) continue;
            const value = JSON.parse(record);
            const payload = JSON.parse(value.body);
            if (value.actorId !== actorId || value.requestId !== payload.requestId || !UUID.test(value.requestId)
                || !UUID.test(value.actorId) || !UUID.test(value.conversationId)
                || value.conversationId !== payload.conversationId || typeof payload.content !== 'string'
                || !payload.content.trim() || payload.content.length > MAX_RECORD_BYTES / 2
                || !Number.isFinite(Date.parse(value.createdAt))
                || !['text', 'shared_post', 'gif', 'image', 'system'].includes(payload.message_type)
                || name !== key(value)) continue;
            operations.push({ ...value, status: 'failed', receipt: null, inFlight: null });
        } catch { /* A corrupt pending record cannot become a new send. */ }
    }
    return operations;
}

export function messengerOperationMessage(operation) {
    const payload = JSON.parse(operation.body);
    return { id: `temp-${operation.requestId}`, request_id: operation.requestId, conversation_id: operation.conversationId,
        sender_id: operation.actorId, content: payload.content, message_type: payload.message_type,
        media_metadata: payload.media_metadata, profiles: operation.profile, created_at: operation.createdAt,
        status: operation.status };
}

export function sameMessengerOperation(message, operation) {
    return message?.request_id === operation.requestId && message.sender_id === operation.actorId
        && message.conversation_id === operation.conversationId;
}

export function reconcileMessengerMessage(messages, incoming) {
    const matching = message => message?.id === incoming.id || (incoming.request_id && message?.request_id === incoming.request_id
        && message.sender_id === incoming.sender_id && message.conversation_id === incoming.conversation_id);
    const previous = messages.find(matching);
    if (previous && !String(previous.id).startsWith('temp-') && String(incoming.id).startsWith('temp-')) {
        return reconcileMessengerMessage(messages, { ...incoming, ...previous });
    }
    const merged = { ...previous, ...incoming, profiles: incoming.profiles || previous?.profiles || null };
    // A delayed acknowledgment must not move an already delivered/read row back.
    if (incoming.status === 'sent' && ['read', 'delivered'].includes(previous?.status)) merged.status = previous.status;
    let inserted = false;
    const rows = messages.flatMap(message => {
        if (!matching(message)) return [message];
        if (inserted) return [];
        inserted = true;
        return [merged];
    });
    return inserted ? rows : [...rows, merged];
}

export function mergeMessengerPendingMessages(messages, operations, actorId, conversationId) {
    let rows = messages;
    for (const operation of operations) {
        if (operation.actorId !== actorId || operation.conversationId !== conversationId || operation.receipt) continue;
        if (rows.some(message => sameMessengerOperation(message, operation) && !String(message.id).startsWith('temp-'))) continue;
        rows = reconcileMessengerMessage(rows, messengerOperationMessage(operation));
    }
    return rows;
}

export function acknowledgeMessengerSend(operation, message, storage) {
    if (!sameMessengerOperation(message, operation) || !UUID.test(message.id)) return false;
    operation.receipt = { ...message, status: 'sent' };
    operation.status = 'sent';
    // Storage cleanup failure cannot turn a durable send into a failed send.
    try { forgetMessengerSendOperation(storage, operation); } catch { /* Replay remains idempotent. */ }
    return true;
}

export function performMessengerSend(operation, { storage, currentActor, send, changed }) {
    if (operation.inFlight) return operation.inFlight;
    if (operation.receipt) return Promise.resolve(operation.receipt);
    if (currentActor() !== operation.actorId) return Promise.resolve(null);
    // Persist before any network action. If persistence is unavailable, no send
    // is attempted because a timeout could otherwise lose its retry identity.
    saveMessengerSendOperation(storage, operation);
    operation.status = 'sending';
    changed(operation);
    const task = (async () => {
        try {
            await Promise.resolve();
            if (currentActor() !== operation.actorId) throw new Error('Account Changed. Reopen The Original Account To Retry.');
            const response = await send(operation.body);
            const result = await response.json();
            if (!response.ok || result.success !== true || !UUID.test(result.msgId || '')
                || result.requestId !== operation.requestId) throw new Error(result.error || 'Message Was Not Confirmed');
            acknowledgeMessengerSend(operation, { ...messengerOperationMessage(operation), id: result.msgId,
                content: result.content ?? JSON.parse(operation.body).content, status: 'sent' }, storage);
        } catch (error) {
            // Realtime may have already supplied the durable row even when the
            // HTTP response was lost. Never replace that receipt with failure.
            if (!operation.receipt) { operation.status = 'failed'; operation.error = error.message; }
        } finally {
            operation.inFlight = null;
            changed(operation);
        }
        return operation.receipt;
    })();
    operation.inFlight = task;
    return task;
}
