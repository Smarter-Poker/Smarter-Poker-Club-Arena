import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Minus, X, Maximize2, Send, ImagePlus, Reply, Smile, ThumbsUp } from './DockIcons';
import { dockName } from './messengerDock.mjs';
import { createContinuityController, visibleMessageBoundary, isMessageId, CONTINUITY_PREFIX } from './messengerContinuity.mjs';
import { createMessengerSendOperation, restoreMessengerSendOperations, performMessengerSend,
    mergeMessengerPendingMessages, reconcileMessengerMessage, messengerOperationMessage, acknowledgeMessengerSend } from './messengerSendOperation.mjs';

const MESSAGE_ROUTES = { 'get-messages': '/api/messenger/get-messages', 'mark-read': '/api/messenger/mark-read' };
function safeMedia(content) {
    const match = /^\[(Image|Video|GIF|Audio)\]\((https:\/\/[^\s)]+)\)/i.exec(content || '');
    return match ? { kind: match[1].toLowerCase(), url: match[2] } : null;
}
export default function MessengerChat({ actorId, identity, conversation, services, onMinimize, onClose, onRead }) {
    const id = conversation.id;
    const [messages, setMessages] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [typing, setTyping] = useState(false);
    const [engaged, setEngaged] = useState(false);
    const [older, setOlder] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [newAvailable, setNewAvailable] = useState(false);
    const [emojis, setEmojis] = useState(false);
    const [, render] = useState(0);
    const mounted = useRef(true);
    const sequence = useRef(0);
    const scroll = useRef(null);
    const composer = useRef(null);
    const file = useRef(null);
    const nearBottom = useRef(true);
    const channel = useRef(null);
    const typingTimer = useRef(null);
    const typingSent = useRef(0);
    const readThrough = useRef(null);
    const reading = useRef(false);
    const positionTimer = useRef(null);
    const hasLoaded = useRef(false);
    const ops = useRef(new Map());
    const request = async (path, body) => {
        const response = await services.request(MESSAGE_ROUTES[path], { method: 'POST', body: JSON.stringify(body), actorId, currentActor: () => identity.current });
        const data = await response.json();
        if (!response.ok || data.success !== true) throw Object.assign(new Error(data.error || 'Messages Are Unavailable'), { status: response.status });
        return data;
    };
    const current = () => mounted.current && identity.current === actorId;
    const continuity = useMemo(() => {
        let storage = null;
        try { storage = window.localStorage; } catch { /* Controller reports the failure. */ }
        return createContinuityController({ actorId, workspace: conversation.dockWorkspace || { workspace: 'social' }, storage,
            isCurrent: () => identity.current === actorId, changed: () => { if (current()) render(value => value + 1); },
            committed: (conversationId, receipt) => services.broadcastSync('smarter_poker_continuity_sync', { actorId, conversationId,
                workspace: conversation.dockWorkspace || { workspace: 'social' }, receipt: { field: receipt.field, revision: receipt.revision } }),
            request: async body => {
                const response = await services.request('/api/messenger/continuity', { method: 'POST', body: JSON.stringify(body), actorId, currentActor: () => identity.current });
                return { ok: response.ok, status: response.status, body: await response.json() };
            },
        });
    }, [actorId, id, services]);
    const draftTimer = useRef(null);
    const draft = continuity.state(id).draft;
    const editDraft = text => {
        continuity.edit(id, 'draft', { text, replyToId: continuity.state(id).draft.replyToId });
        clearTimeout(draftTimer.current);
        draftTimer.current = setTimeout(() => void continuity.write(id, 'draft'), 600);
    };
    const load = useCallback(async (before = null, anchor = null) => {
        const requestSequence = ++sequence.current;
        const previousHeight = scroll.current?.scrollHeight || 0;
        const position = continuity.state(id).position;
        const boundary = visibleMessageBoundary(scroll.current);
        const anchorId = anchor || (!hasLoaded.current && isMessageId(position.messageId) ? position.messageId : null);
        const offset = boundary?.first === anchorId ? boundary.offset : position.messageId === anchorId ? position.offset : 0;
        try {
            const data = await request('get-messages', { conversationId: id, limit: 50,
                ...(before ? { before: before.created_at, beforeId: before.id } : anchorId ? { anchorMessageId: anchorId } : {}) });
            if (!current() || sequence.current !== requestSequence || !Array.isArray(data.messages)) return;
            setMessages(previous => {
                let next = before ? previous : [];
                for (const message of data.messages) next = reconcileMessengerMessage(next, message);
                for (const operation of ops.current.values()) {
                    const receipt = data.messages.find(message => message.request_id === operation.requestId && message.sender_id === actorId);
                    if (receipt) acknowledgeMessengerSend(operation, receipt, window.localStorage);
                }
                next = mergeMessengerPendingMessages(next, [...ops.current.values()], actorId, id);
                return next.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
            });
            hasLoaded.current = true;
            setOlder(data.hasOlder === true || data.messages.length === 50);
            setError('');
            requestAnimationFrame(() => {
                if (!current() || !scroll.current) return;
                if (anchorId) {
                    const row = scroll.current.querySelector(`[data-message-id="${anchorId}"]`);
                    if (row) scroll.current.scrollTop += row.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top - offset;
                }
                else if (before) scroll.current.scrollTop += scroll.current.scrollHeight - previousHeight;
                else if (nearBottom.current) scroll.current.scrollTop = scroll.current.scrollHeight;
            });
        } catch (failure) { if (current() && sequence.current === requestSequence) { if ([401,403,404].includes(failure.status)) setMessages([]); setError(failure.message); } }
        finally { if (current() && sequence.current === requestSequence) setLoading(false); }
    }, [actorId, id, services]);

    useEffect(() => {
        mounted.current = true;
        try {
            const pending = restoreMessengerSendOperations(window.localStorage, actorId).filter(operation => operation.conversationId === id);
            ops.current = new Map(pending.map(operation => [operation.requestId, operation]));
        } catch { /* A new send will explicitly report missing durable storage. */ }
        void continuity.read(id).then(() => { if (current()) void load(); });
        let refreshTimer = null;
        const refresh = payload => {
            if (!current()) return;
            clearTimeout(refreshTimer);
            if (payload?.eventType === 'INSERT' && !nearBottom.current) { setNewAvailable(true); return; }
            const anchor = !nearBottom.current ? visibleMessageBoundary(scroll.current)?.first : null;
            refreshTimer = setTimeout(() => void load(null, anchor), 50);
        };
        const realtime = services.supabase.channel(`dock-conversation:${actorId}:${id}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'social_messages', filter: `conversation_id=eq.${id}` }, refresh)
            .subscribe(status => { if (status === 'SUBSCRIBED' && current()) void load(); });
        const live = services.supabase.channel(`typing:${id}`)
            .on('broadcast', { event: 'typing' }, event => {
                if (!current() || event.payload?.userId === actorId) return;
                setTyping(true); clearTimeout(typingTimer.current);
                typingTimer.current = setTimeout(() => { if (current()) setTyping(false); }, 3000);
            }).on('broadcast', { event: 'read_receipt' }, event => {
                const payload = event.payload;
                if (!current() || payload?.readerId === actorId || payload?.conversationId !== id || !Number.isFinite(Date.parse(payload.readThrough))) return;
                setMessages(previous => previous.map(message => message.sender_id === actorId && Date.parse(message.created_at) <= Date.parse(payload.readThrough)
                    ? { ...message, is_read: true, status: 'read' } : message));
            }).subscribe();
        channel.current = live;
        const returned = () => { if (document.visibilityState === 'visible') { void load(null, !nearBottom.current ? visibleMessageBoundary(scroll.current)?.first : null); void continuity.read(id); } };
        const stored = event => { if (event.key === `${CONTINUITY_PREFIX}${actorId}:${id}`) continuity.acceptLocal(id); };
        const stop = services.listenBroadcast('smarter_poker_continuity_sync', event => {
            if (event?.actorId === actorId && event.conversationId === id) continuity.acceptCommit(id, event.receipt, event.workspace);
        });
        document.addEventListener('visibilitychange', returned);
        window.addEventListener('online', returned);
        window.addEventListener('storage', stored);
        return () => {
            clearTimeout(draftTimer.current); clearTimeout(positionTimer.current); void continuity.write(id, 'draft'); void continuity.write(id, 'position');
            mounted.current = false; ++sequence.current;
            clearTimeout(refreshTimer); clearTimeout(typingTimer.current); stop();
            services.supabase.removeChannel(realtime); services.supabase.removeChannel(live);
            channel.current = null;
            document.removeEventListener('visibilitychange', returned); window.removeEventListener('online', returned); window.removeEventListener('storage', stored);
        };
    }, [actorId, id, services, continuity, load]);

    const markVisible = useCallback(async () => {
        if (!engaged || !current() || reading.current || document.visibilityState !== 'visible') return;
        const boundary = visibleMessageBoundary(scroll.current);
        if (!boundary || boundary.last === readThrough.current) return;
        reading.current = true;
        let confirmed = false;
        try {
            const result = await request('mark-read', { conversationId: id, throughMessageId: boundary.last });
            if (identity.current !== actorId) return;
            // The acknowledged read still refreshes badges if this panel was
            // minimized while the request was in flight. No unmounted UI write.
            services.broadcastSync('smarter_poker_unread_sync', 'refresh_unread');
            if (!mounted.current) return;
            readThrough.current = boundary.last; confirmed = true;
            const prefs = await services.getPreferences(actorId);
            if (current() && prefs.readReceipts !== false) void channel.current?.send({ type: 'broadcast', event: 'read_receipt', payload: { readerId: actorId, conversationId: id, readThrough: result.readThrough } });
            if (current()) onRead();
        } catch (failure) { if (current()) setError(failure.message); }
        finally {
            reading.current = false;
            const latest = visibleMessageBoundary(scroll.current);
            if (confirmed && current() && latest && latest.last !== readThrough.current) void markVisible();
        }
    }, [engaged, actorId, id, services]);
    useEffect(() => { const frame = requestAnimationFrame(() => void markVisible()); return () => cancelAnimationFrame(frame); }, [messages, engaged, markVisible]);

    const attempt = async (operation, capturedDraft) => {
        try {
            await performMessengerSend(operation, { storage: window.localStorage, currentActor: () => identity.current,
                send: body => services.request('/api/messenger/send-message', { method: 'POST', body, actorId, currentActor: () => identity.current }),
                changed: changed => {
                    if (!current()) return;
                    setMessages(previous => reconcileMessengerMessage(previous, changed.receipt || messengerOperationMessage(changed)));
                },
            });
            if (current() && operation.receipt) {
                if (capturedDraft) { continuity.clearDraftIfUnchanged(id, capturedDraft); void continuity.write(id, 'draft'); }
                nearBottom.current = true; void load();
            }
        } catch (failure) { if (current()) setError(failure.message); }
    };
    const send = (content = draft.text, consume = true) => {
        if (!current() || !content.trim() || content.length > 2000) return;
        const captured = continuity.state(id).draft;
        const quoted = consume && captured.replyToId ? messages.find(message => message.id === captured.replyToId) : null;
        const wireContent = quoted ? `[REPLY:${String(quoted.content || 'Attachment').replace(/\]/g, '').slice(0, 80)}] ${content}` : content;
        if (wireContent.length > 2000) { setError('Reply Is Too Long. Shorten The Message'); return; }
        // Repeated Enter/clicks while a send is ambiguous retain its request ID.
        const pending = [...ops.current.values()].find(operation => !operation.receipt && JSON.parse(operation.body).content === wireContent);
        if (pending) { void attempt(pending, consume ? captured : null); return; }
        const operation = createMessengerSendOperation({ actorId, conversationId: id, content: wireContent });
        ops.current.set(operation.requestId, operation);
        void attempt(operation, consume ? captured : null);
    };
    const upload = async event => {
        const media = event.target.files?.[0]; event.target.value = '';
        if (!media || !current()) return;
        if (!/^(image|video)\//.test(media.type) || media.size > (media.type.startsWith('video/') ? 50 : 10) * 1024 * 1024) { setError('Choose An Image Under 10MB Or Video Under 50MB'); return; }
        setUploading(true);
        try {
            const response = await services.request('/api/social/upload-url', { method: 'POST', body: JSON.stringify({ fileName: media.name, fileSize: media.size, mimeType: media.type, folder: 'messages', prefix: actorId }), actorId, currentActor: () => identity.current });
            const result = await response.json();
            if (!response.ok || !result.success || !result.signedUrl || !result.publicUrl) throw new Error('Upload Could Not Be Started');
            if (!current()) return;
            const uploaded = await fetch(result.signedUrl, { method: 'PUT', headers: { 'Content-Type': media.type }, body: media, signal: AbortSignal.timeout(300000) });
            if (!uploaded.ok) throw new Error('Upload Did Not Complete');
            if (current()) send(`[${media.type.startsWith('image/') ? 'Image' : 'Video'}](${result.publicUrl})`, false);
        } catch (failure) { if (current()) setError(failure.message); }
        finally { if (current()) setUploading(false); }
    };
    const name = dockName(conversation);
    return <div className="dock-chat" data-dock-conversation={id} onFocusCapture={() => setEngaged(true)} onPointerDown={() => setEngaged(true)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onMinimize(); } }}>
        <header className="dock-chat-header">
            {conversation.otherUser?.avatar_url ? <img className="dock-chat-avatar" src={conversation.otherUser.avatar_url} alt="" /> : <span className="dock-chat-avatar dock-initial">{name.slice(0, 1)}</span>}
            <button type="button" className="dock-chat-person" onClick={() => services.openMessenger(id)}><strong>{name}</strong><small>{typing ? 'Typing...' : 'Messenger'}</small></button>
            <button type="button" aria-label="Expand Conversation" title="Open In Messenger" onClick={() => services.openMessenger(id)}><Maximize2 size={17} /></button>
            <button type="button" aria-label="Minimize Conversation" onClick={onMinimize}><Minus size={20} /></button>
            <button type="button" aria-label="Close Conversation" onClick={onClose}><X size={20} /></button>
        </header>
        {error && <div className="dock-chat-error" role="alert">{error} <button type="button" onClick={() => { void load(); void markVisible(); }}>Retry</button></div>}
        {draft.conflict && <div className="dock-chat-error" role="alert">Draft Changed In Another Window <button type="button" onClick={() => continuity.resolve(id, 'draft', true)}>Keep This Draft</button> <button type="button" onClick={() => continuity.resolve(id, 'draft', false)}>Use Synced Draft</button></div>}
        {!draft.conflict && [...continuity.errors.values()].length > 0 && <div className="dock-chat-error" role="status">Conversation Sync Needs Attention <button type="button" onClick={() => { void continuity.read(id); void continuity.write(id, 'draft'); void continuity.write(id, 'position'); }}>Retry</button></div>}
        <div className="dock-chat-messages" ref={scroll} role="log" aria-label={`Messages With ${name}`} aria-live="polite" onScroll={() => {
            if (scroll.current) nearBottom.current = scroll.current.scrollHeight - scroll.current.clientHeight - scroll.current.scrollTop < 64;
            if (engaged) {
                const boundary = visibleMessageBoundary(scroll.current);
                if (boundary) { continuity.edit(id, 'position', { messageId: boundary.first, offset: boundary.offset }); clearTimeout(positionTimer.current); positionTimer.current = setTimeout(() => void continuity.write(id, 'position'), 400); }
            }
            void markVisible();
        }}>
            {loading && <p role="status">Loading Messages...</p>}
            {older && <button className="dock-history" type="button" onClick={() => void load(messages.find(message => isMessageId(message.id)))}>Load Earlier Messages</button>}
            {!loading && !messages.length && !error && <p className="dock-empty">Start A Conversation With {name}</p>}
            {messages.map(message => {
                const own = message.sender_id === actorId;
                const media = !message.is_deleted && safeMedia(message.content);
                return <div key={message.id} data-message-id={message.id} className={`dock-message ${own ? 'dock-own' : ''}`}>
                    <div className="dock-message-bubble" title={new Date(message.created_at).toLocaleString()}>
                        {message.is_deleted ? <em>Message Removed</em> : message.message_type === 'invoice' ? <button type="button" onClick={() => services.openMessenger(id)}>Open Invoice In Messenger</button>
                            : media?.kind === 'image' || media?.kind === 'gif' ? <a href={media.url} target="_blank" rel="noreferrer"><img src={media.url} alt="Message Attachment" loading="lazy" /></a>
                            : media?.kind === 'video' ? <video src={media.url} controls playsInline /> : media?.kind === 'audio' ? <audio src={media.url} controls /> : message.content}
                    </div>
                    {own && <small className="dock-message-status">{message.status === 'sending' ? 'Sending...' : message.status === 'failed' ? <button type="button" onClick={() => { const operation = ops.current.get(message.request_id); if (operation) void attempt(operation); }}>Not Sent. Retry</button> : message.is_read || message.status === 'read' ? 'Seen' : 'Sent'}</small>}
                    {!message.is_deleted && isMessageId(message.id) && <button type="button" className="dock-reply" aria-label="Reply To Message" onClick={() => { continuity.edit(id, 'draft', { text: draft.text, replyToId: message.id }); composer.current?.focus(); }}><Reply size={14} /></button>}
                </div>;
            })}
            {typing && <div className="dock-typing" role="status">{name} Is Typing...</div>}
        </div>
        {newAvailable && <button type="button" className="dock-new-messages" onClick={() => { setNewAvailable(false); nearBottom.current = true; void load(); }}>New Messages</button>}
        {draft.replyToId && <div className="dock-reply-banner">Replying To Message <button type="button" aria-label="Cancel Reply" onClick={() => { continuity.edit(id, 'draft', { text: draft.text, replyToId: null }); void continuity.write(id, 'draft'); }}><X size={14} /></button></div>}
        {emojis && <div className="dock-emojis">{['\u{1f600}','\u{1f602}','\u{2764}\u{fe0f}','\u{1f44d}','\u{1f389}','\u{1f60e}'].map(emoji => <button key={emoji} type="button" aria-label={`Insert ${emoji}`} onClick={() => { editDraft((draft.text + emoji).slice(0, 2000)); setEmojis(false); composer.current?.focus(); }}>{emoji}</button>)}</div>}
        <form className="dock-composer" onSubmit={event => { event.preventDefault(); send(); }}>
            <input ref={file} type="file" accept="image/*,video/*" hidden onChange={upload} />
            <button type="button" aria-label="Attach Photo Or Video" disabled={uploading} onClick={() => file.current?.click()}><ImagePlus size={21} /></button>
            <textarea ref={composer} aria-label={`Message ${name}`} placeholder={uploading ? 'Uploading...' : 'Aa'} rows={1} maxLength={2000} value={draft.text} onChange={event => {
                editDraft(event.target.value);
                if (Date.now() - typingSent.current > 1500) { typingSent.current = Date.now(); void channel.current?.send({ type: 'broadcast', event: 'typing', payload: { userId: actorId } }); }
            }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
            <button type="button" aria-label="Choose Emoji" aria-expanded={emojis} onClick={() => setEmojis(value => !value)}><Smile size={21} /></button>
            {draft.text.trim() ? <button type="submit" aria-label="Send Message"><Send size={21} /></button> : <button type="button" aria-label="Send Like" onClick={() => send('\u{1f44d}', false)}><ThumbsUp size={21} /></button>}
        </form>
    </div>;
}
