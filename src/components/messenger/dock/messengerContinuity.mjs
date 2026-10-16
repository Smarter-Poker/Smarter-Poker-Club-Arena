export const CONTINUITY_PREFIX = 'sp-messenger-continuity-v1:';
export const continuityWorkspaceKey = workspace => workspace?.workspace === 'club'
    ? `club:${workspace.clubId}:${workspace.folder === 'invoices' ? 'invoices' : 'messages'}` : 'social:messages';
export const isMessageId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const empty = () => ({ draft: { text: '', replyToId: null, revision: 0 }, pin: { value: false, revision: 0 }, position: { messageId: null, offset: 0, revision: 0 } });
const fieldValue = (field, item) => field === 'draft' ? { text: item.text, replyToId: item.replyToId || null }
    : field === 'position' ? { messageId: item.messageId || null, offset: item.offset || 0 } : item.value;
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const validRevision = value => Number.isSafeInteger(value) && value >= 0;
const observedRevision = item => Math.max(item?.revision || 0, item?.remote?.revision || 0);
const valid = (field, item) => item && validRevision(item.revision) && (field === 'draft'
    ? typeof item.text === 'string' && item.text.length <= 2000 && (item.replyToId == null || isMessageId(item.replyToId))
    : field === 'position' ? (item.messageId == null || isMessageId(item.messageId)) && Number.isInteger(item.offset) && Math.abs(item.offset) <= 100000
        : typeof item.value === 'boolean');

export function readLocalContinuity(storage, actorId, conversationId) {
    const result = empty();
    if (!isMessageId(actorId) || !isMessageId(conversationId) || !storage) return result;
    try {
        const raw = storage.getItem(`${CONTINUITY_PREFIX}${actorId}:${conversationId}`);
        if (!raw || raw.length > 16384) return result;
        const saved = JSON.parse(raw);
        if (saved.actorId !== actorId || saved.conversationId !== conversationId) return result;
        for (const field of ['draft', 'position']) if (valid(field, saved[field])) result[field] = { ...saved[field], dirty: saved[field].dirty === true };
    } catch { /* Invalid storage cannot cross an account boundary. */ }
    return result;
}

export function visibleMessageBoundary(container) {
    if (!container) return null;
    const bounds = container.getBoundingClientRect();
    const viewport = container.ownerDocument?.defaultView;
    const top = Math.max(bounds.top, viewport?.visualViewport?.offsetTop || 0);
    const bottom = Math.min(bounds.bottom, viewport ? (viewport.visualViewport?.offsetTop || 0) + (viewport.visualViewport?.height || viewport.innerHeight) : Infinity);
    if (bottom <= top) return null;
    const visible = [...container.querySelectorAll('[data-message-id]')].filter(node => {
        const rect = node.getBoundingClientRect();
        return isMessageId(node.dataset.messageId) && rect.bottom > rect.top && rect.right > rect.left
            && rect.bottom > top && rect.top < bottom;
    });
    if (!visible.length) return null;
    return { first: visible[0].dataset.messageId, last: visible.at(-1).dataset.messageId,
        offset: Math.round(visible[0].getBoundingClientRect().top - bounds.top) };
}

// One owner per mounted account/workspace. Requests never schedule retries.
// A queued write exists only when a newer explicit edit arrived while saving.
export function createContinuityController({ actorId, workspace, storage, request, isCurrent = () => true, changed = () => {}, committed = () => {} }) {
    const records = new Map();
    const flights = new Map();
    const queued = new Map();
    const errors = new Map();
    const readSequences = new Map();
    const pendingReads = new Map();
    const savedRevisions = new Map();
    const savedReadGenerations = new Map();
    const conversationSavedReadGenerations = new Map();
    const pinReadGenerations = new Map();
    let readGeneration = 0;
    let mutationVersion = 0;
    const savedStates = new Map();
    const controller = { pins: [], saved: [], hasMoreSaved: false, nextSavedCursor: null, loading: false, errors, records };
    const notify = () => { if (isCurrent()) changed(); };
    const state = conversationId => {
        if (!records.has(conversationId)) records.set(conversationId, readLocalContinuity(storage, actorId, conversationId));
        return records.get(conversationId);
    };
    const persist = conversationId => {
        if (!storage) throw new Error('Browser Storage Is Unavailable');
        const key = `${CONTINUITY_PREFIX}${actorId}:${conversationId}`;
        const record = state(conversationId);
        if (!record.draft.dirty && !record.position.dirty && !record.draft.text && !record.draft.replyToId && !record.position.messageId) {
            storage.removeItem(key);
            return;
        }
        if (!storage.getItem(key)) {
            let count = 0;
            for (let index = 0; index < storage.length; index++) if (storage.key(index)?.startsWith(`${CONTINUITY_PREFIX}${actorId}:`)) count++;
            if (count >= 200) throw new Error('Draft Storage Is Full');
        }
        const draft = { ...fieldValue('draft', record.draft), revision: record.draft.revision, dirty: record.draft.dirty === true };
        const position = { ...fieldValue('position', record.position), revision: record.position.revision, dirty: record.position.dirty === true };
        storage.setItem(key, JSON.stringify({ actorId, conversationId, draft, position }));
    };
    const remember = conversationId => {
        try { persist(conversationId); errors.delete(`local:${conversationId}`); }
        catch (error) { errors.set(`local:${conversationId}`, { message: error.message, conversationId, local: true }); }
    };
    const applyField = (conversationId, field, remote) => {
        if (!valid(field, remote)) throw new Error('Invalid Continuity Response');
        const record = state(conversationId);
        const local = record[field];
        if (remote.revision < observedRevision(local)) return;
        if (local.dirty && !equal(fieldValue(field, local), fieldValue(field, remote))) {
            record[field] = { ...local, remote, conflict: local.revision !== remote.revision };
        } else record[field] = { ...remote, dirty: false };
    };
    controller.state = state;
    controller.read = async (conversationId = null, cursor = null) => {
        if (!actorId || !isCurrent()) return null;
        const readKey = conversationId || 'workspace';
        const sequence = (readSequences.get(readKey) || 0) + 1;
        readSequences.set(readKey, sequence);
        pendingReads.set(readKey, sequence);
        const startedVersion = mutationVersion;
        const generation = ++readGeneration;
        controller.loading = true; notify();
        try {
            const result = await request({ action: 'read', ...(conversationId ? { conversationId } : {}), workspace,
                ...(cursor ? { savedCursor: cursor } : {}) });
            if (!isCurrent() || sequence !== readSequences.get(readKey)) return null;
            if (!result.ok || !result.body.success) throw new Error(result.body.error || 'Saved Preferences Could Not Be Loaded');
            const data = result.body;
            const states = { ...(data.states || {}), ...(conversationId && data.state ? { [conversationId]: data.state } : {}) };
            for (const [id, remote] of Object.entries(states)) {
                if (!isMessageId(id)) continue;
                for (const field of ['draft', 'pin', 'position']) applyField(id, field, remote[field]);
                remember(id);
            }
            if (Array.isArray(data.pins) && startedVersion === mutationVersion) {
                const pins = new Set(conversationId ? controller.pins.filter(id => id !== conversationId) : []);
                for (const id of data.pins.filter(isMessageId)) if (!conversationId || id === conversationId) pins.add(id);
                const considered = new Set([...controller.pins, ...Object.keys(states), ...data.pins]);
                for (const id of considered) {
                    if (conversationId && id !== conversationId) continue;
                    if ((pinReadGenerations.get(id) || 0) > generation || states[id]?.pin?.revision < state(id).pin.revision) {
                        if (state(id).pin.value) pins.add(id); else pins.delete(id);
                    } else pinReadGenerations.set(id, generation);
                }
                controller.pins = [...pins];
            }
            const saved = Array.isArray(data.saved) ? data.saved.filter(item => isMessageId(item.messageId) && isMessageId(item.conversationId)
                && validRevision(item.revision) && item.revision >= (savedRevisions.get(item.messageId) || 0)
                && (conversationSavedReadGenerations.get(item.conversationId) || 0) <= generation) : [];
            if (Array.isArray(data.saved) && startedVersion === mutationVersion) {
                const retained = controller.saved.filter(item => cursor || (conversationId && item.conversationId !== conversationId)
                    || (savedReadGenerations.get(item.messageId) || 0) > generation);
                controller.saved = [...new Map([...saved, ...retained].map(item => [item.messageId, item])).values()];
                for (const item of saved) savedReadGenerations.set(item.messageId, Math.max(generation, savedReadGenerations.get(item.messageId) || 0));
                if (conversationId) conversationSavedReadGenerations.set(conversationId, generation);
                controller.ingestSavedItems(saved);
                if (!conversationId) {
                    controller.hasMoreSaved = data.hasMoreSaved === true;
                    controller.nextSavedCursor = data.nextSavedCursor || null;
                }
            }
            errors.delete(conversationId ? `read:${conversationId}` : 'read');
            return conversationId ? state(conversationId) : null;
        } catch (error) {
            if (isCurrent() && sequence === readSequences.get(readKey)) errors.set(conversationId ? `read:${conversationId}` : 'read', { message: error.message, conversationId, read: true });
            return null;
        } finally {
            if (pendingReads.get(readKey) === sequence) pendingReads.delete(readKey);
            if (isCurrent()) { controller.loading = pendingReads.size > 0; notify(); }
        }
    };
    controller.edit = (conversationId, field, value) => {
        if (!isCurrent() || !isMessageId(conversationId) || !['draft', 'position'].includes(field)) return;
        const record = state(conversationId);
        if (equal(fieldValue(field, record[field]), value)) return false;
        const next = { ...record[field], ...value, dirty: true, edit: (record[field].edit || 0) + 1 };
        if (!valid(field, next)) return;
        record[field] = next;
        remember(conversationId); notify();
        return true;
    };
    controller.write = async (conversationId, field, value, expectedRevision) => {
        if (!isCurrent() || !isMessageId(conversationId)) return false;
        const operationKey = `${conversationId}:${field}${field === 'saved' ? `:${value.messageId}` : ''}`;
        if (flights.has(operationKey)) { queued.set(operationKey, [conversationId, field, value, expectedRevision]); return flights.get(operationKey); }
        const record = state(conversationId);
        const captured = field === 'saved' ? { revision: savedRevisions.get(value.messageId) || 0 } : record[field];
        if (captured.conflict && expectedRevision === undefined) { notify(); return false; }
        const revision = expectedRevision ?? captured.revision;
        const wireValue = value === undefined ? fieldValue(field, captured) : value;
        mutationVersion++;
        const operation = (async () => {
            await Promise.resolve();
            let succeeded = false;
            try {
                if (!isCurrent()) return false;
                const result = await request({ action: 'write', conversationId, field, expectedRevision: revision, value: wireValue });
                if (!isCurrent()) return false;
                const data = result.body;
                const newestRevision = field === 'saved' ? savedRevisions.get(wireValue.messageId) || 0 : observedRevision(record[field]);
                if (validRevision(data.revision) && data.revision < newestRevision) {
                    // A later read or peer receipt already established newer
                    // state. Never replay an older HTTP receipt over it, clear
                    // its conflict, or broadcast that obsolete value to peers.
                    if (!errors.has(operationKey)) errors.set(operationKey, {
                        message: 'This Change Was Updated On Another Device', conversationId, field,
                        value: queued.get(operationKey)?.[2] ?? wireValue, revision: newestRevision,
                    });
                    return false;
                }
                if (!result.ok || data.success !== true) {
                    if (result.status === 409 && validRevision(data.revision)) {
                        if (field === 'draft' || field === 'position') record[field] = { ...record[field], conflict: true,
                            remote: { ...data.value, revision: data.revision } };
                        else if (field === 'pin') {
                            record.pin = { value: data.value === true, revision: data.revision };
                            controller.pins = data.value ? [...new Set([...controller.pins, conversationId])] : controller.pins.filter(id => id !== conversationId);
                        }
                        else if (field === 'saved') {
                            savedRevisions.set(wireValue.messageId, data.revision);
                            savedStates.set(wireValue.messageId, { ...data.value, revision: data.revision, conversationId });
                            controller.saved = controller.saved.filter(item => item.messageId !== wireValue.messageId);
                            if (data.value?.saved) controller.saved.unshift(data.item || { ...data.value, conversationId, revision: data.revision });
                        }
                    }
                    errors.set(operationKey, { message: data.error || 'Change Could Not Be Saved', conversationId, field, value: wireValue,
                        revision: result.status === 409 ? data.revision : revision });
                    return false;
                }
                if (!validRevision(data.revision)) throw new Error('Invalid Save Receipt');
                if (field === 'saved') {
                    savedRevisions.set(wireValue.messageId, data.revision);
                    savedStates.set(wireValue.messageId, { ...wireValue, revision: data.revision, conversationId });
                    controller.saved = controller.saved.filter(item => item.messageId !== wireValue.messageId);
                    if (wireValue.saved) controller.saved.unshift(data.item || { messageId: wireValue.messageId, conversationId, saved: true, revision: data.revision });
                } else if (field === 'pin') {
                    record.pin = { value: wireValue, revision: data.revision };
                    controller.pins = wireValue ? [...new Set([...controller.pins, conversationId])] : controller.pins.filter(id => id !== conversationId);
                } else {
                    const latest = record[field];
                    if (latest.edit === captured.edit && equal(fieldValue(field, latest), wireValue)) record[field] = { ...wireValue, revision: data.revision, dirty: false, edit: latest.edit };
                    else record[field] = { ...latest, revision: data.revision };
                    remember(conversationId);
                }
                errors.delete(operationKey); succeeded = true; committed(conversationId, { field, value: wireValue, revision: data.revision });
                return true;
            } catch (error) {
                if (isCurrent()) errors.set(operationKey, { message: error.message, conversationId, field, value: wireValue, revision });
                return false;
            } finally {
                flights.delete(operationKey);
                const next = queued.get(operationKey); queued.delete(operationKey);
                notify();
                // This is a coalesced newer edit, never retry of a failed write.
                if (succeeded && next && isCurrent()) void controller.write(next[0], next[1], next[2]);
            }
        })();
        flights.set(operationKey, operation); notify();
        return operation;
    };
    controller.resolve = (conversationId, field, keepLocal) => {
        const record = state(conversationId); const remote = record[field].remote;
        if (!remote || !isCurrent()) return;
        const value = keepLocal ? fieldValue(field, record[field]) : fieldValue(field, remote);
        record[field] = { ...value, revision: remote.revision, dirty: keepLocal, edit: (record[field].edit || 0) + 1 };
        errors.delete(`${conversationId}:${field}`); remember(conversationId); notify();
        if (keepLocal) return controller.write(conversationId, field);
    };
    controller.clearDraftIfUnchanged = (conversationId, captured) => {
        const draft = state(conversationId).draft;
        if (draft.edit !== captured.edit || draft.text !== captured.text || (draft.replyToId || null) !== (captured.replyToId || null)) return false;
        controller.edit(conversationId, 'draft', { text: '', replyToId: null });
        void controller.write(conversationId, 'draft');
        return true;
    };
    controller.acceptLocal = conversationId => {
        if (!isCurrent()) return;
        const remote = readLocalContinuity(storage, actorId, conversationId);
        for (const field of ['draft', 'position']) {
            const local = state(conversationId)[field];
            if (remote[field].revision < observedRevision(local)) continue;
            if (!local.dirty) state(conversationId)[field] = remote[field];
            else if (!equal(fieldValue(field, local), fieldValue(field, remote[field]))) {
                state(conversationId)[field] = { ...local, conflict: true, remote: remote[field] };
            }
        }
        notify();
    };
    controller.ingestSavedItems = items => {
        for (const item of items || []) {
            if (!isMessageId(item.messageId) || !isMessageId(item.conversationId) || !validRevision(item.revision) || typeof item.saved !== 'boolean') continue;
            if (item.revision < (savedRevisions.get(item.messageId) || 0)) continue;
            savedRevisions.set(item.messageId, item.revision);
            savedStates.set(item.messageId, item);
            if (item.saved === false) controller.saved = controller.saved.filter(saved => saved.messageId !== item.messageId);
        }
    };
    controller.acceptCommit = (conversationId, receipt, eventWorkspace = workspace) => {
        if (continuityWorkspaceKey(eventWorkspace) !== continuityWorkspaceKey(workspace)) return;
        if (!isCurrent() || !isMessageId(conversationId) || !validRevision(receipt?.revision)) return;
        mutationVersion++;
        if (receipt.field === 'saved') controller.ingestSavedItems([{ ...receipt.value, conversationId, revision: receipt.revision }]);
        // The broadcast contains only identity/revision metadata, never a draft.
        void controller.read(conversationId);
        notify();
    };
    controller.savedState = messageId => savedStates.get(messageId) || { saved: false, revision: 0 };
    controller.retry = error => error.read ? controller.read(error.conversationId)
        : error.local ? (remember(error.conversationId), notify())
            : ['draft', 'position'].includes(error.field) ? controller.write(error.conversationId, error.field)
                : controller.write(error.conversationId, error.field, error.value, error.revision);
    controller.isSaving = (conversationId, field) => [...flights.keys()].some(key => key.startsWith(`${conversationId}:${field}`));
    return controller;
}
