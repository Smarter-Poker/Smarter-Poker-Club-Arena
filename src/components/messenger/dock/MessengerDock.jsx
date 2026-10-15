import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { MessageCircle, X, ExternalLink, Settings, Check } from './DockIcons';
import { DOCK_STORAGE_PREFIX, dockId, dockName, dockLayout, dockCapacity, restoreDock, updateDock } from './messengerDock.mjs';
import MessengerChat from './MessengerChat';

function Portrait({ conversation }) {
    const name = dockName(conversation);
    return conversation?.otherUser?.avatar_url ? <img src={conversation.otherUser.avatar_url} alt="" className="dock-avatar" />
        : <span className="dock-avatar dock-initial">{name.slice(0, 1)}</span>;
}
export default function MessengerDock({ services }) {
    const { supabase, getAuthUser, getPreferences, listenBroadcast, openMessenger } = services;
    const inboxRequest = async body => {
        const response = await services.request('/api/messenger/get-conversations', { method: 'POST', body: JSON.stringify(body) });
        const data = await response.json();
        if (!response.ok || data.success !== true || !Array.isArray(data.conversations)) throw new Error(data.error || 'Messages Are Unavailable');
        return data;
    };
    const [actorId, setActorId] = useState(null);
    const [chats, dispatch] = useReducer(updateDock, []);
    const [inbox, setInbox] = useState(false);
    const [conversations, setConversations] = useState([]);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [viewport, setViewport] = useState({ width: 1024, height: 768 });
    const [popups, setPopups] = useState(true);
    const [settings, setSettings] = useState(false);
    const [hydrated, setHydrated] = useState(null);
    const viewportRef = useRef(viewport);
    viewportRef.current = viewport;
    const identity = useRef(null);
    const interactions = useRef(new Map());
    const [bottom, setBottom] = useState(76);
    const chatsRef = useRef(chats);
    chatsRef.current = chats;
    const generation = useRef(0);
    const inboxSequence = useRef(0);
    const seen = useRef(new Set());
    const loadedActor = useRef(null);
    const preferences = useRef(null);
    const automatic = useRef(popups);
    automatic.current = popups;
    const startedAt = useRef(Date.now());
    const lastTimes = useRef(new Map());
    const layout = dockLayout(chats, viewport, inbox);

    const resolve = useCallback(async (id, incoming = false) => {
        if (!dockId(id) || !identity.current) return;
        const actor = identity.current;
        const epoch = generation.current;
        const interaction = interactions.current.get(id) || 0;
        try {
            const data = await inboxRequest({ workspace: 'resolve', conversationId: id });
            if (identity.current !== actor || generation.current !== epoch || (interactions.current.get(id) || 0) !== interaction || data.conversation?.id !== id) return;
            const prefs = await preferences.current;
            if (identity.current !== actor || generation.current !== epoch || (interactions.current.get(id) || 0) !== interaction) return;
            // Explicitly opening a conversation is always allowed. Automatic
            // opening respects both the existing account setting and dock toggle.
            if (incoming && (!automatic.current || prefs?.notifications === false)) return;
            const occupied = chatsRef.current.filter(chat => !chat.minimized).length >= dockCapacity(viewportRef.current.width);
            const preserveComposer = incoming && occupied && document.activeElement?.closest('.dock-chat');
            dispatch({ type: 'open', minimized: !!preserveComposer, conversation: { ...data.conversation, dockWorkspace: { workspace: data.clubId ? 'club' : 'social', clubId: data.clubId, folder: data.folder } }, incoming });
            if (!incoming) setInbox(false);
        } catch (failure) {
            if (identity.current !== actor || generation.current !== epoch) return;
            if (!incoming) setError(failure.message);
        }
    }, []);

    const refresh = useCallback(async (catchUp = false) => {
        const actor = identity.current;
        if (!actor) return;
        const epoch = generation.current;
        const sequence = ++inboxSequence.current;
        setLoading(true);
        try {
            const data = await inboxRequest({ workspace: 'social' });
            if (identity.current !== actor || generation.current !== epoch || sequence !== inboxSequence.current) return;
            setConversations(data.conversations);
            setError('');
            for (const conversation of data.conversations) {
                const previous = lastTimes.current.get(conversation.id) || startedAt.current;
                const next = Date.parse(conversation.last_message_at);
                lastTimes.current.set(conversation.id, Math.max(previous, next || 0));
                if (catchUp && next > previous && conversation.unreadCount > 0) void resolve(conversation.id, true);
                if (chatsRef.current.some(chat => chat.id === conversation.id)) dispatch({ type: 'refresh', conversation: { ...conversation, dockWorkspace: chatsRef.current.find(chat => chat.id === conversation.id)?.conversation?.dockWorkspace } });
            }
        } catch (failure) {
            if (identity.current === actor && generation.current === epoch && sequence === inboxSequence.current) setError(failure.message);
        } finally {
            if (identity.current === actor && generation.current === epoch && sequence === inboxSequence.current) setLoading(false);
        }
    }, [resolve]);

    useEffect(() => {
        let mounted = true;
        const accept = user => {
            if (!mounted || identity.current === (user?.id || null)) return;
            identity.current = user?.id || null;
            ++generation.current;
            setActorId(identity.current);
            for (const chat of chatsRef.current) dispatch({ type: 'close', id: chat.id });
            setConversations([]); setInbox(false); setError('');
            seen.current.clear(); lastTimes.current.clear(); interactions.current.clear();
            loadedActor.current = null; setHydrated(null);
            startedAt.current = Date.now();
            preferences.current = user?.id ? getPreferences(user.id).catch(() => ({ notifications: false })) : null;
        };
        const seed = getAuthUser?.();
        if (seed && typeof seed.then !== 'function') accept(seed);
        const authGeneration = generation.current;
        void Promise.resolve(seed).then(user => { if (mounted && generation.current === authGeneration && user?.id) accept(user); }).catch(() => { if (mounted && generation.current === authGeneration) setError('Sign In To Open Messages'); });
        const { data } = supabase.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_OUT') { if (!identity.current) ++generation.current; accept(null); }
            else if (session?.user) accept(session.user);
        });
        return () => { mounted = false; ++generation.current; data?.subscription?.unsubscribe(); };
    }, []);

    useEffect(() => {
        if (!actorId) return;
        const epoch = generation.current;
        let stored = [];
        try {
            stored = restoreDock(sessionStorage.getItem(`${DOCK_STORAGE_PREFIX}${actorId}`));
            setPopups(localStorage.getItem(`${DOCK_STORAGE_PREFIX}popups:${actorId}`) !== 'false');
        } catch { /* Storage is optional for window geometry. */ }
        // Resolve restored IDs before mounting any content or showing a name.
        void Promise.all(stored.map(async chat => {
            try {
                const result = await inboxRequest({ workspace: 'resolve', conversationId: chat.id });
                if (identity.current !== actorId || generation.current !== epoch || result.conversation?.id !== chat.id) return;
                dispatch({ type: 'open', conversation: { ...result.conversation, dockWorkspace: { workspace: result.clubId ? 'club' : 'social', clubId: result.clubId, folder: result.folder } } });
                if (chat.minimized) dispatch({ type: 'minimize', id: chat.id });
            } catch { /* Revoked/deleted threads must not reappear. */ }
        })).then(() => { if (identity.current === actorId && generation.current === epoch) { loadedActor.current = actorId; setHydrated(actorId); } });
        void refresh();

        const channel = supabase.channel(`messenger-dock:${actorId}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'social_messages' }, payload => {
                const message = payload.new;
                if (identity.current !== actorId || generation.current !== epoch || message.sender_id === actorId || !dockId(message.id)) return;
                if (seen.current.has(message.id)) return;
                seen.current.add(message.id);
                if (seen.current.size > 512) seen.current.delete(seen.current.values().next().value);
                void resolve(message.conversation_id, true);
                void refresh();
            }).subscribe(status => {
                if (status === 'SUBSCRIBED' && identity.current === actorId && generation.current === epoch) void refresh(true);
            });
        const stop = listenBroadcast('smarter_poker_unread_sync', message => {
            if (message === 'refresh_unread') void refresh();
        });
        const visible = () => { if (document.visibilityState === 'visible') void refresh(true); };
        const online = () => void refresh(true);
        document.addEventListener('visibilitychange', visible);
        window.addEventListener('online', online);
        window.addEventListener('focus', visible);
        return () => {
            supabase.removeChannel(channel); stop();
            document.removeEventListener('visibilitychange', visible);
            window.removeEventListener('online', online);
            window.removeEventListener('focus', visible);
        };
    }, [actorId, refresh, resolve]);

    useEffect(() => {
        if (!actorId || loadedActor.current !== actorId) return;
        try { sessionStorage.setItem(`${DOCK_STORAGE_PREFIX}${actorId}`, JSON.stringify(chats.map(({ id, minimized }) => ({ id, minimized })))); }
        catch { /* Window persistence must not prevent sending in Messenger. */ }
    }, [actorId, chats, hydrated]);

    useEffect(() => {
        const measure = () => {
            const view = window.visualViewport;
            const keyboard = Math.max(0, window.innerHeight - (view?.height || window.innerHeight) - (view?.offsetTop || 0));
            setViewport({ width: document.documentElement.clientWidth, height: view?.height || window.innerHeight });
            setBottom(keyboard > 80 ? keyboard + 8 : 76);
        };
        measure();
        window.addEventListener('resize', measure);
        window.visualViewport?.addEventListener('resize', measure);
        window.visualViewport?.addEventListener('scroll', measure);
        return () => {
            window.removeEventListener('resize', measure);
            window.visualViewport?.removeEventListener('resize', measure);
            window.visualViewport?.removeEventListener('scroll', measure);
        };
    }, []);
    useEffect(() => {
        const style = document.documentElement.style;
        const before = style.getPropertyValue('--sp-messenger-toast-clearance');
        style.setProperty('--sp-messenger-toast-clearance', `${actorId ? layout.height + bottom + 12 : 0}px`);
        return () => { if (before) style.setProperty('--sp-messenger-toast-clearance', before); else style.removeProperty('--sp-messenger-toast-clearance'); };
    }, [actorId, layout.height, bottom]);
    const windowAction = (type, id) => {
        interactions.current.set(id, (interactions.current.get(id) || 0) + 1);
        if (layout.mobile) for (const chat of chatsRef.current) dispatch({ type: 'minimize', id: chat.id });
        dispatch({ type, id });
    };
    const unread = conversations.reduce((total, conversation) => total + (conversation.unreadCount || 0), 0);
    const togglePopups = () => {
        const next = !popups;
        setPopups(next);
        try { localStorage.setItem(`${DOCK_STORAGE_PREFIX}popups:${actorId}`, String(next)); } catch { setError('This Preference Could Not Be Saved On This Device'); }
    };
    if (!actorId) return null;
    return <>
        <div className={`messenger-dock ${layout.mobile ? 'dock-mobile' : ''}`} aria-label="Messenger Chat Dock" onKeyDown={event => { if (event.key === 'Escape' && inbox) { event.stopPropagation(); setInbox(false); } }} style={{ width: layout.width, height: layout.height, bottom }}>
            {inbox ? <section className="dock-inbox" aria-label="Chats">
                <header><strong>Chats</strong><button type="button" aria-label="Chat Settings" onClick={() => setSettings(value => !value)}><Settings size={20} /></button><button type="button" aria-label="Close Chat List" onClick={() => setInbox(false)}><X size={20} /></button></header>
                {settings && <button type="button" className="dock-setting" onClick={togglePopups} aria-pressed={popups}><span>Pop-Up New Messages</span>{popups && <Check size={18} />}</button>}
                <div className="dock-inbox-scroll">
                    {loading && !conversations.length && <p role="status">Loading Messages...</p>}
                    {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => refresh()}>Retry</button></div>}
                    {!loading && !error && !conversations.length && <p>No Conversations Yet</p>}
                    {conversations.map(conversation => <button type="button" className="dock-conversation" key={conversation.id} onClick={() => resolve(conversation.id)}>
                        <Portrait conversation={conversation} /><span><strong>{dockName(conversation)}</strong><small>{conversation.last_message_preview || 'Open Conversation'}</small></span>
                        {conversation.unreadCount > 0 && <b className="dock-count">{conversation.unreadCount}</b>}
                    </button>)}
                </div>
                <button type="button" className="dock-open-full" onClick={() => openMessenger()}>Open Messenger <ExternalLink size={16} /></button>
            </section> : layout.expanded.map(chat => <section className="dock-window" key={chat.id} aria-label={`Chat With ${dockName(chat.conversation)}`}>
                <MessengerChat key={`${actorId}:${chat.id}`} actorId={actorId} identity={identity} conversation={chat.conversation} services={services}
                    onMinimize={() => windowAction('minimize', chat.id)} onClose={() => windowAction('close', chat.id)} onRead={() => { dispatch({ type: 'read', id: chat.id }); void refresh(); }} />
            </section>)}
            <nav className="dock-rail" aria-label="Minimized Chats">
                {layout.bubbles.map(chat => <div className="dock-bubble-wrap" key={chat.id}>
                    <button type="button" className="dock-bubble" aria-label={`Restore Chat With ${dockName(chat.conversation)}`} title={dockName(chat.conversation)} onClick={() => resolve(chat.id)}><Portrait conversation={chat.conversation} />{(chat.unread || chat.conversation?.unreadCount > 0) && <i className="dock-unread-dot" />}</button>
                    <button type="button" className="dock-bubble-close" aria-label={`Close Chat With ${dockName(chat.conversation)}`} onClick={() => windowAction('close', chat.id)}><X size={12} /></button>
                </div>)}
                <button type="button" className="dock-launcher" aria-label={`Messages${unread ? `, ${unread} Unread` : ''}`} aria-expanded={inbox} onClick={() => { setInbox(value => !value); if (!inbox) void refresh(); }}><MessageCircle size={26} />{unread > 0 && <b className="dock-count">{unread > 99 ? '99+' : unread}</b>}</button>
            </nav>
        </div>

    </>;
}
