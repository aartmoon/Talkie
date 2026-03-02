import { useEffect, useMemo, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { APIError, api } from './lib/api';
import type { Friend, FriendsResponse, Message, Participant, Room as AppRoom, User } from './lib/types';
import { FriendsPanel } from './components/FriendsPanel';

type AuthView = 'login' | 'register' | 'verify' | 'forgot' | 'reset';
type SidebarTab = 'rooms' | 'dms' | 'friends';
type MiniProfile = { id: string; username: string; email?: string };

type VideoTrackItem = {
  key: string;
  participantId: string;
  username: string;
  track: Track;
  source: Track.Source;
};

type CallParticipant = {
  id: string;
  username: string;
  micEnabled: boolean | null;
  hasCamera: boolean;
  hasScreen: boolean;
  watchingCamera: boolean;
  watchingScreen: boolean;
};

function isVideoTrack(track: Track | undefined): track is Track {
  return Boolean(track && track.kind === Track.Kind.Video);
}

function wsBaseUrl(apiBase: string): string {
  if (apiBase.startsWith('https://')) return apiBase.replace('https://', 'wss://');
  if (apiBase.startsWith('http://')) return apiBase.replace('http://', 'ws://');
  return apiBase;
}

function mediaUrl(apiBase: string, mediaPath?: string): string {
  if (!mediaPath) return '';
  if (mediaPath.startsWith('http://') || mediaPath.startsWith('https://')) return mediaPath;
  return `${apiBase}${mediaPath}`;
}

function looksLikeImageFilename(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^[^\s]+\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(trimmed);
}

function isScreenAudioSource(source: Track.Source): boolean {
  return source === Track.Source.ScreenShareAudio || source === Track.Source.ScreenShare;
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 1;
  return Math.max(0, Math.min(1, v));
}

function volumeKey(kind: 'voice' | 'screen', participantID: string): string {
  return `talkie_${kind}_volume_${participantID}`;
}

function VideoTile({
  item,
  muted,
  onClick,
  expanded = false,
}: {
  item: VideoTrackItem;
  muted: boolean;
  onClick?: () => void;
  expanded?: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    item.track.attach(ref.current);
    return () => {
      item.track.detach(ref.current!);
    };
  }, [item]);

  return (
    <div className={`video-tile ${muted ? 'self' : ''} ${expanded ? 'expanded' : ''}`} onClick={onClick}>
      <video ref={ref} autoPlay playsInline muted={muted} />
      {expanded && (
        <button
          className="fullscreen-btn"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void ref.current?.requestFullscreen?.();
          }}
        >
          На весь экран
        </button>
      )}
      <span>{item.username}{item.source === Track.Source.ScreenShare ? ' • Экран' : ''}</span>
    </div>
  );
}

export function App() {
  const [authView, setAuthView] = useState<AuthView>('login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('talkie_token'));
  const [rooms, setRooms] = useState<AppRoom[]>([]);
  const [dmRooms, setDMRooms] = useState<AppRoom[]>([]);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('rooms');
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem('talkie_sidebar_collapsed') === '1',
  );
  const [friendsData, setFriendsData] = useState<FriendsResponse>({ friends: [], incoming: [] });
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [userSearchResults, setUserSearchResults] = useState<Friend[]>([]);
  const [sentFriendRequests, setSentFriendRequests] = useState<Record<string, boolean>>({});
  const [unreadByRoom, setUnreadByRoom] = useState<Record<string, number>>({});
  const [hasNewFriendRequest, setHasNewFriendRequest] = useState(false);
  const [miniProfile, setMiniProfile] = useState<MiniProfile | null>(null);
  const [newRoomName, setNewRoomName] = useState('');
  const [showCreateRoomModal, setShowCreateRoomModal] = useState(false);
  const [inviteQuery, setInviteQuery] = useState('');
  const [inviteResults, setInviteResults] = useState<Friend[]>([]);
  const [generatingInviteLink, setGeneratingInviteLink] = useState(false);
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState('');
  const [verificationTokenInput, setVerificationTokenInput] = useState('');
  const [isVerifyingEmail, setIsVerifyingEmail] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState('');
  const [newPasswordInput, setNewPasswordInput] = useState('');
  const [newPasswordConfirmInput, setNewPasswordConfirmInput] = useState('');
  const [creatingFriendInvite, setCreatingFriendInvite] = useState(false);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [roomMenuOpen, setRoomMenuOpen] = useState(false);
  const [roomActivityByID, setRoomActivityByID] = useState<Record<string, number>>({});
  const [activeCallsByRoom, setActiveCallsByRoom] = useState<Record<string, number>>({});
  const [selectedRoom, setSelectedRoom] = useState<AppRoom | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatParticipants, setChatParticipants] = useState<Participant[]>([]);
  const [callParticipants, setCallParticipants] = useState<CallParticipant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connectingMedia, setConnectingMedia] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [activeCallRoomID, setActiveCallRoomID] = useState<string | null>(null);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [screenEnabled, setScreenEnabled] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [joinWithMicEnabled, setJoinWithMicEnabled] = useState<boolean>(
    () => localStorage.getItem('talkie_join_with_mic') !== '0',
  );
  const [showMicSettings, setShowMicSettings] = useState(false);
  const [participantVoiceVolume, setParticipantVoiceVolume] = useState<Record<string, number>>({});
  const [participantScreenVolume, setParticipantScreenVolume] = useState<Record<string, number>>({});
  const [watchedVideoKeys, setWatchedVideoKeys] = useState<Record<string, boolean>>({});
  const [videoTracks, setVideoTracks] = useState<VideoTrackItem[]>([]);
  const [focusedTileKey, setFocusedTileKey] = useState<string | null>(null);
  const [activeSpeakerIDs, setActiveSpeakerIDs] = useState<string[]>([]);
  const [pendingImage, setPendingImage] = useState<File | null>(null);
  const [lightboxImageURL, setLightboxImageURL] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const eventsWsRef = useRef<WebSocket | null>(null);
  const roomWsReconnectRef = useRef<number | null>(null);
  const roomRef = useRef<Room | null>(null);
  const roomsRef = useRef<AppRoom[]>([]);
  const dmRoomsRef = useRef<AppRoom[]>([]);
  const callRoomIDRef = useRef<string | null>(null);
  const audioElsRef = useRef<Map<string, { participantID: string; source: Track.Source; el: HTMLAudioElement }>>(new Map());
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const micBeforeDeafenRef = useRef(false);
  const deafenedRef = useRef(false);
  const watchedVideoKeysRef = useRef<Record<string, boolean>>({});
  const callPresenceIDsRef = useRef<Set<string>>(new Set());
  const friendsInitRef = useRef(false);
  const incomingRequestsRef = useRef(0);
  const selectedRoomIDRef = useRef<string | null>(null);
  const sidebarTabRef = useRef<SidebarTab>('rooms');
  const lastRoomMessageIDsRef = useRef<Record<string, number>>({});
  const inviteJoinHandledRef = useRef(false);

  const sortedRooms = useMemo(
    () =>
      [...rooms].sort(
        (a, b) => (roomActivityByID[b.id] || new Date(b.created_at).getTime()) - (roomActivityByID[a.id] || new Date(a.created_at).getTime()),
      ),
    [rooms, roomActivityByID],
  );
  const sortedDMRooms = useMemo(
    () =>
      [...dmRooms].sort(
        (a, b) => (roomActivityByID[b.id] || new Date(b.created_at).getTime()) - (roomActivityByID[a.id] || new Date(a.created_at).getTime()),
      ),
    [dmRooms, roomActivityByID],
  );
  const hasUnreadRooms = useMemo(
    () => rooms.some((room) => (unreadByRoom[room.id] || 0) > 0),
    [rooms, unreadByRoom],
  );
  const hasUnreadDMs = useMemo(
    () => dmRooms.some((room) => (unreadByRoom[room.id] || 0) > 0),
    [dmRooms, unreadByRoom],
  );
  const hasFriendRequestBadge = hasNewFriendRequest;
  const friendIDs = useMemo(() => new Set(friendsData.friends.map((f) => f.id)), [friendsData.friends]);
  const focusedTile = useMemo(
    () => videoTracks.find((track) => track.key === focusedTileKey) || videoTracks[0] || null,
    [videoTracks, focusedTileKey],
  );
  const thumbnailTracks = useMemo(
    () => videoTracks.filter((track) => track.key !== focusedTile?.key),
    [videoTracks, focusedTile],
  );
  const activeCallRoom = useMemo(() => {
    if (!activeCallRoomID) return null;
    return [...rooms, ...dmRooms].find((room) => room.id === activeCallRoomID) || null;
  }, [activeCallRoomID, rooms, dmRooms]);
  const activeCallRoomKind = useMemo(() => {
    if (!activeCallRoom) return null;
    return dmRooms.some((room) => room.id === activeCallRoom.id) ? 'dm' : 'room';
  }, [activeCallRoom, dmRooms]);
  const selectedRoomIsDM = useMemo(
    () => Boolean(selectedRoom && dmRooms.some((room) => room.id === selectedRoom.id)),
    [selectedRoom, dmRooms],
  );
  const selectedRoomCanManage = Boolean(selectedRoom?.can_manage);

  function videoKey(participantID: string, source: Track.Source, sid?: string): string {
    return sid || `${participantID}-${source}`;
  }

  useEffect(() => {
    deafenedRef.current = deafened;
  }, [deafened]);

  useEffect(() => {
    if (!copyNotice) return;
    const id = window.setTimeout(() => setCopyNotice(null), 2200);
    return () => window.clearTimeout(id);
  }, [copyNotice]);

  useEffect(() => {
    watchedVideoKeysRef.current = watchedVideoKeys;
    const room = roomRef.current;
    if (!room) return;
    applyRemoteVideoSubscriptions(room);
    syncCallParticipants(room);
  }, [watchedVideoKeys]);

  useEffect(() => {
    selectedRoomIDRef.current = selectedRoom?.id || null;
  }, [selectedRoom?.id]);

  useEffect(() => {
    roomsRef.current = rooms;
  }, [rooms]);

  useEffect(() => {
    dmRoomsRef.current = dmRooms;
  }, [dmRooms]);

  useEffect(() => {
    sidebarTabRef.current = sidebarTab;
  }, [sidebarTab]);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const [me, list, dms, friends] = await Promise.all([
          api.me(token),
          api.listRooms(token),
          api.listDMRooms(token),
          api.listFriends(token),
        ]);
        setUser(me);
        setRooms(list);
        setDMRooms(dms);
        setFriendsData(friends);
        setRoomActivityByID((prev) => {
          const next = { ...prev };
          for (const room of [...list, ...dms]) {
            if (!next[room.id]) next[room.id] = new Date(room.created_at).getTime();
          }
          return next;
        });
        incomingRequestsRef.current = friends.incoming.length;
        friendsInitRef.current = true;
      } catch (err) {
        localStorage.removeItem('talkie_token');
        setToken(null);
        setError(err instanceof Error ? err.message : 'authentication failed');
      }
    })();
  }, [token]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const resetTokenParam = params.get('token');
    const isResetPath = window.location.pathname === '/reset-password';
    if (isResetPath && resetTokenParam) {
      setResetToken(resetTokenParam);
      if (!token) setAuthView('reset');
    }
  }, [token]);

  useEffect(() => {
    if (!token || !user || inviteJoinHandledRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const inviteToken = params.get('invite');
    if (!inviteToken) return;

    inviteJoinHandledRef.current = true;
    let mounted = true;
    setError(null);
    void api.joinByInviteLink(token, inviteToken)
      .then(async (room) => {
        if (!mounted) return;
        const [list, dms] = await Promise.all([api.listRooms(token), api.listDMRooms(token)]);
        if (!mounted) return;
        setRooms(list);
        setDMRooms(dms);
        setRoomActivityByID((prev) => ({ ...prev, [room.id]: Date.now() }));
        await openRoom(room);
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : 'failed to join via invite link');
      })
      .finally(() => {
        params.delete('invite');
        const next = window.location.pathname + (params.toString() ? `?${params.toString()}` : '');
        window.history.replaceState({}, '', next);
      });

    return () => {
      mounted = false;
    };
  }, [token, user]);

  useEffect(() => {
    if (!token || !user) return;
    const params = new URLSearchParams(window.location.search);
    const friendInviteToken = params.get('friend_invite');
    if (!friendInviteToken) return;

    setError(null);
    void api.acceptFriendInviteLink(token, friendInviteToken)
      .then(async (friend) => {
        setAuthMessage(`Вы добавили ${friend.username} в друзья.`);
        await refreshSocial();
        setSidebarTab('friends');
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'failed to accept friend invite');
      })
      .finally(() => {
        params.delete('friend_invite');
        const next = window.location.pathname + (params.toString() ? `?${params.toString()}` : '');
        window.history.replaceState({}, '', next);
      });
  }, [token, user]);

  useEffect(() => {
    if (!token || !user) return;
    let stopped = false;
    let reconnectID: number | null = null;

    const connect = () => {
      if (stopped) return;
      const wsUrl = `${wsBaseUrl(api.apiBase)}/ws/events?token=${encodeURIComponent(token)}`;
      const socket = new WebSocket(wsUrl);
      eventsWsRef.current = socket;

      socket.onmessage = (event) => {
        const payload = JSON.parse(event.data) as {
          type: string;
          message?: Message;
        };
        if (payload.type === 'room_message_event' && payload.message) {
          const incomingMessage = payload.message;
          if (incomingMessage.user_id === user.id) return;

          const roomID = incomingMessage.room_id;
          const knownRoom = roomsRef.current.some((r) => r.id === roomID) || dmRoomsRef.current.some((r) => r.id === roomID);
          if (!knownRoom) {
            void api.listDMRooms(token)
              .then((dms) => setDMRooms(dms))
              .catch(() => {
                // best effort
              });
          }
          lastRoomMessageIDsRef.current[roomID] = incomingMessage.id;
          setRoomActivityByID((prev) => {
            const ts = new Date(incomingMessage.created_at).getTime();
            if ((prev[roomID] || 0) >= ts) return prev;
            return { ...prev, [roomID]: ts };
          });
          if (selectedRoomIDRef.current !== roomID) {
            setUnreadByRoom((prev) => ({ ...prev, [roomID]: (prev[roomID] || 0) + 1 }));
          }
          return;
        }
        if (payload.type === 'friend_request_event') {
          if (sidebarTabRef.current !== 'friends') {
            setHasNewFriendRequest(true);
            playNotifyTone('request');
          }
          void api.listFriends(token)
            .then((social) => {
              setFriendsData(social);
              incomingRequestsRef.current = social.incoming.length;
              friendsInitRef.current = true;
            })
            .catch(() => {
              // best effort
            });
          return;
        }
        if (payload.type === 'friend_relationship_event') {
          void refreshSocial();
          return;
        }
        if (payload.type === 'dm_room_event') {
          void api.listDMRooms(token)
            .then((dms) => setDMRooms(dms))
            .catch(() => {
              // best effort
            });
        }
      };

      socket.onclose = () => {
        if (stopped) return;
        reconnectID = window.setTimeout(() => connect(), 1500);
      };
      socket.onerror = () => {
        socket.close();
      };
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectID !== null) {
        window.clearTimeout(reconnectID);
      }
      eventsWsRef.current?.close();
      eventsWsRef.current = null;
    };
  }, [token, user]);

  useEffect(() => {
    if (!token || !user) return;
    const roomIDs = Array.from(new Set([...rooms, ...dmRooms].map((room) => room.id)));
    if (roomIDs.length === 0) return;
    let mounted = true;

    const checkRoomUnread = async (roomID: string) => {
      try {
        const latest = await api.listMessages(token, roomID, 1);
        if (!mounted || latest.length === 0) return;
        const message = latest[0];

        setRoomActivityByID((prev) => {
          const ts = new Date(message.created_at).getTime();
          if ((prev[roomID] || 0) >= ts) return prev;
          return { ...prev, [roomID]: ts };
        });

        setUnreadByRoom((prev) => {
          const prevID = lastRoomMessageIDsRef.current[roomID];
          lastRoomMessageIDsRef.current[roomID] = message.id;
          const isActiveRoom = selectedRoomIDRef.current === roomID;
          if (prevID && message.id !== prevID && message.user_id !== user.id && !isActiveRoom) {
            return { ...prev, [roomID]: (prev[roomID] || 0) + 1 };
          }
          return prev;
        });
      } catch {
        // best effort
      }
    };

    const pollUnread = async () => {
      await Promise.all(roomIDs.map(async (roomID) => checkRoomUnread(roomID)));
    };

    void pollUnread();
    const id = window.setInterval(() => void pollUnread(), 30000);
    return () => {
      mounted = false;
      window.clearInterval(id);
    };
  }, [token, user, rooms, dmRooms]);

  useEffect(() => {
    if (!token) return;
    const roomIDs = Array.from(new Set([...rooms, ...dmRooms].map((room) => room.id)));
    if (roomIDs.length === 0) {
      setActiveCallsByRoom({});
      return;
    }
    let mounted = true;
    const pollCalls = async () => {
      const statuses = await Promise.all(
        roomIDs.map(async (roomID) => {
          try {
            const callUsers = await api.listCallParticipants(token, roomID);
            return [roomID, callUsers.length] as const;
          } catch {
            return [roomID, 0] as const;
          }
        }),
      );
      if (!mounted) return;
      const next: Record<string, number> = {};
      for (const [roomID, count] of statuses) {
        next[roomID] = count;
      }
      setActiveCallsByRoom(next);
    };
    void pollCalls();
    const id = window.setInterval(() => void pollCalls(), 8000);
    return () => {
      mounted = false;
      window.clearInterval(id);
    };
  }, [token, rooms, dmRooms]);

  useEffect(() => {
    if (!token || !selectedRoom) return;
    let mounted = true;
    const refreshRoom = async () => {
      try {
        const latest = await api.listMessages(token, selectedRoom.id, 50);
        if (!mounted) return;
        setMessages((prev) => {
          if (prev.length === latest.length && prev[prev.length - 1]?.id === latest[latest.length - 1]?.id) {
            return prev;
          }
          return latest;
        });
        if (latest.length > 0) {
          lastRoomMessageIDsRef.current[selectedRoom.id] = latest[latest.length - 1].id;
        }
        if (!inCall || callRoomIDRef.current !== selectedRoom.id) {
          try {
            const callUsers = await api.listCallParticipants(token, selectedRoom.id);
            if (!mounted) return;
            setActiveCallsByRoom((prev) => ({ ...prev, [selectedRoom.id]: callUsers.length }));
            applyCallPresence(callUsers);
          } catch {
            // best effort
          }
        }
      } catch {
        // best effort
      }
    };
    void refreshRoom();
    const id = window.setInterval(() => void refreshRoom(), 6000);
    const onFocus = () => setRefreshTick((x) => x + 1);
    window.addEventListener('focus', onFocus);
    return () => {
      mounted = false;
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [token, selectedRoom?.id, inCall, refreshTick]);

  useEffect(() => {
    if (!token) return;
    let mounted = true;
    const tick = async () => {
      try {
        const social = await api.listFriends(token);
        if (!mounted) return;
        setFriendsData(social);
        if (friendsInitRef.current && social.incoming.length > incomingRequestsRef.current && sidebarTabRef.current !== 'friends') {
          playNotifyTone('request');
          setHasNewFriendRequest(true);
        }
        incomingRequestsRef.current = social.incoming.length;
        friendsInitRef.current = true;
      } catch {
        // best effort
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 5000);
    return () => {
      mounted = false;
      window.clearInterval(id);
    };
  }, [token]);

  useEffect(() => {
    if (sidebarTab === 'friends') {
      setHasNewFriendRequest(false);
    }
  }, [sidebarTab]);

  useEffect(() => {
    localStorage.setItem('talkie_sidebar_collapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem('talkie_join_with_mic', joinWithMicEnabled ? '1' : '0');
  }, [joinWithMicEnabled]);

  useEffect(() => {
    audioElsRef.current.forEach(({ participantID, source, el }) => {
      const isScreen = isScreenAudioSource(source);
      const v = isScreen
        ? (participantScreenVolume[participantID] ?? 1)
        : (participantVoiceVolume[participantID] ?? 0.65);
      el.volume = clamp01(v);
    });
  }, [participantVoiceVolume, participantScreenVolume]);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
      roomRef.current?.disconnect();
      audioElsRef.current.forEach(({ el }) => el.remove());
      audioElsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (videoTracks.length === 0) {
      setFocusedTileKey(null);
      return;
    }
    if (!focusedTileKey || !videoTracks.some((t) => t.key === focusedTileKey)) {
      const screenTrack = videoTracks.find((t) => t.source === Track.Source.ScreenShare);
      setFocusedTileKey((screenTrack || videoTracks[0]).key);
    }
  }, [videoTracks, focusedTileKey]);

  useEffect(() => {
    if (!lightboxImageURL) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLightboxImageURL(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [lightboxImageURL]);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages, selectedRoom?.id]);

  useEffect(() => {
    setInviteQuery('');
    setInviteResults([]);
    setRoomMenuOpen(false);
  }, [selectedRoom?.id]);

  async function handleAuthSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAuthMessage(null);
    try {
      if (authView === 'register') {
        await api.register(email, username, password);
        setPendingVerificationEmail(email.trim().toLowerCase());
        setVerificationTokenInput('');
        setPassword('');
        setAuthView('verify');
        setAuthMessage('Код подтверждения отправлен на email.');
        return;
      }
      if (authView !== 'login') return;

      const result = await api.login(email, password);
      localStorage.setItem('talkie_token', result.token);
      setToken(result.token);
      setUser(result.user);
      const [list, dms, friends] = await Promise.all([
        api.listRooms(result.token),
        api.listDMRooms(result.token),
        api.listFriends(result.token),
      ]);
      setRooms(list);
      setDMRooms(dms);
      setFriendsData(friends);
      incomingRequestsRef.current = friends.incoming.length;
      friendsInitRef.current = true;
    } catch (err) {
      if (err instanceof APIError && err.requiresEmailVerification) {
        setPendingVerificationEmail(email.trim().toLowerCase());
        setAuthView('verify');
        setAuthMessage('Введите код подтверждения из письма.');
        return;
      }
      setError(err instanceof Error ? err.message : 'request failed');
    }
  }

  async function handleVerifyEmail(e: React.FormEvent) {
    e.preventDefault();
    const codeInput = verificationTokenInput.trim();
    if (!codeInput || !pendingVerificationEmail.trim()) return;
    setError(null);
    setAuthMessage(null);
    setIsVerifyingEmail(true);
    try {
      const result = await api.verifyEmail(pendingVerificationEmail.trim(), codeInput);
      localStorage.setItem('talkie_token', result.token);
      setToken(result.token);
      setUser(result.user);
      setPendingVerificationEmail('');
      setVerificationTokenInput('');
      setAuthView('login');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to verify email');
    } finally {
      setIsVerifyingEmail(false);
    }
  }

  async function resendVerificationEmail() {
    if (!pendingVerificationEmail.trim()) return;
    setError(null);
    setAuthMessage(null);
    try {
      await api.resendVerification(pendingVerificationEmail.trim());
      setAuthMessage('Код отправлен повторно.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to resend verification');
    }
  }

  function handleForgotPasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setAuthMessage(null);
    void api.forgotPassword(email.trim().toLowerCase())
      .then(() => setAuthMessage('Ссылка для сброса отправлена на email.'))
      .catch((err) => setError(err instanceof Error ? err.message : 'failed to send reset link'));
  }

  function handleResetPasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!resetToken.trim()) {
      setError('Не найден токен сброса.');
      return;
    }
    if (newPasswordInput.length < 6) {
      setError('Пароль должен быть не короче 6 символов.');
      return;
    }
    if (newPasswordInput !== newPasswordConfirmInput) {
      setError('Пароли не совпадают.');
      return;
    }
    setError(null);
    setAuthMessage(null);
    void api.resetPassword(resetToken.trim(), newPasswordInput)
      .then(() => {
        setAuthMessage('Пароль обновлен. Теперь войдите в аккаунт.');
        setNewPasswordInput('');
        setNewPasswordConfirmInput('');
        setAuthView('login');
        window.history.replaceState({}, '', '/');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'failed to reset password'));
  }

  async function createRoom(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !newRoomName.trim()) return;
    try {
      const room = await api.createRoom(token, newRoomName.trim());
      setRooms((prev) => [room, ...prev]);
      setRoomActivityByID((prev) => ({ ...prev, [room.id]: new Date(room.created_at).getTime() }));
      setNewRoomName('');
      setShowCreateRoomModal(false);
      setSidebarTab('rooms');
      await openRoom(room);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to create room');
    }
  }

  async function openRoom(room: AppRoom) {
    if (!token) return;
    setSelectedRoom(room);
    selectedRoomIDRef.current = room.id;
    setMessages([]);
    setChatParticipants([]);
    setCallParticipants([]);
    setPendingImage(null);
    setFocusedTileKey(null);
    setUnreadByRoom((prev) => ({ ...prev, [room.id]: 0 }));
    callPresenceIDsRef.current = new Set();

    if (roomWsReconnectRef.current !== null) {
      window.clearTimeout(roomWsReconnectRef.current);
      roomWsReconnectRef.current = null;
    }
    wsRef.current?.close();

    try {
      await api.joinRoom(token, room.id);
      const history = await api.listMessages(token, room.id);
      setMessages(history);
      if (history.length > 0) {
        lastRoomMessageIDsRef.current[room.id] = history[history.length - 1].id;
        setRoomActivityByID((prev) => ({
          ...prev,
          [room.id]: new Date(history[history.length - 1].created_at).getTime(),
        }));
      } else {
        setRoomActivityByID((prev) => ({ ...prev, [room.id]: new Date(room.created_at).getTime() }));
      }

      const connectRoomSocket = () => {
        const wsUrl = `${wsBaseUrl(api.apiBase)}/ws/rooms/${room.id}?token=${encodeURIComponent(token)}`;
        const socket = new WebSocket(wsUrl);

        socket.onmessage = (event) => {
          const payload = JSON.parse(event.data) as {
            type: string;
            message?: Message;
            messages?: Message[];
            participants?: Participant[];
            call_users?: Participant[];
          };

          if (payload.type === 'history' && payload.messages) {
            setMessages(payload.messages);
          }
          if (payload.type === 'chat' && payload.message) {
            const incomingMessage = payload.message;
            setMessages((prev) => [...prev, incomingMessage]);
            setRoomActivityByID((prev) => ({ ...prev, [room.id]: new Date(incomingMessage.created_at).getTime() }));
            if (incomingMessage.user_id !== user?.id && selectedRoomIDRef.current !== room.id) {
              playNotifyTone('message');
              setUnreadByRoom((prev) => ({ ...prev, [room.id]: (prev[room.id] || 0) + 1 }));
            }
            lastRoomMessageIDsRef.current[room.id] = incomingMessage.id;
          }
          if (payload.type === 'participants' && payload.participants) {
            setChatParticipants(payload.participants);
          }
          if (payload.type === 'call_participants') {
            const callUsers = payload.call_users || [];
            setActiveCallsByRoom((prev) => ({ ...prev, [room.id]: callUsers.length }));
            const nextIDs = new Set(callUsers.map((u) => u.id));
            const prevIDs = callPresenceIDsRef.current;
            if (prevIDs.size > 0) {
              for (const id of nextIDs) {
                if (!prevIDs.has(id) && id !== user?.id) playPresenceTone('join');
              }
              for (const id of prevIDs) {
                if (!nextIDs.has(id) && id !== user?.id) playPresenceTone('leave');
              }
            }
            callPresenceIDsRef.current = nextIDs;
            if (!inCall || callRoomIDRef.current !== room.id) {
              applyCallPresence(callUsers);
            }
          }
        };

        socket.onclose = () => {
          if (selectedRoomIDRef.current !== room.id) return;
          roomWsReconnectRef.current = window.setTimeout(() => {
            if (selectedRoomIDRef.current === room.id) {
              connectRoomSocket();
            }
          }, 1200);
        };
        socket.onerror = () => {
          socket.close();
        };

        wsRef.current = socket;
      };

      connectRoomSocket();

      if (!inCall || callRoomIDRef.current !== room.id) {
        void api.listCallParticipants(token, room.id)
          .then((callUsers) => {
            setActiveCallsByRoom((prev) => ({ ...prev, [room.id]: callUsers.length }));
            if (!inCall || callRoomIDRef.current !== room.id) {
              applyCallPresence(callUsers);
            }
          })
          .catch(() => {
            // best effort
          });
      }

      const activeRoom = roomRef.current;
      if (inCall && activeRoom && callRoomIDRef.current === room.id) {
        syncCallParticipants(activeRoom);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to open room');
    }
  }

  function sendChatMessage(e: React.FormEvent) {
    e.preventDefault();
    if (pendingImage) {
      void sendImageMessage(e);
      return;
    }
    const text = chatInput.trim();
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'chat', content: text }));
    setChatInput('');
  }

  function syncCallParticipants(room: Room) {
    const next: CallParticipant[] = [
      {
        id: room.localParticipant.identity,
        username: user?.username || room.localParticipant.identity,
        micEnabled: room.localParticipant.isMicrophoneEnabled,
        hasCamera: false,
        hasScreen: false,
        watchingCamera: false,
        watchingScreen: false,
      },
      ...Array.from(room.remoteParticipants.values()).map((p) => {
        const camPub = p.getTrackPublication(Track.Source.Camera);
        const screenPub = p.getTrackPublication(Track.Source.ScreenShare);
        const hasCamera = Boolean(camPub && !camPub.isMuted);
        const hasScreen = Boolean(screenPub && !screenPub.isMuted);
        const camKey = camPub ? videoKey(p.identity, Track.Source.Camera, camPub.trackSid) : '';
        const screenKey = screenPub ? videoKey(p.identity, Track.Source.ScreenShare, screenPub.trackSid) : '';

        return {
          id: p.identity,
          username: p.name || p.identity,
          micEnabled: !p.isMicrophoneEnabled ? false : !p.getTrackPublication(Track.Source.Microphone)?.isMuted,
          hasCamera,
          hasScreen,
          watchingCamera: Boolean(hasCamera && camKey && watchedVideoKeys[camKey]),
          watchingScreen: Boolean(hasScreen && screenKey && watchedVideoKeys[screenKey]),
        };
      }),
    ];
    setCallParticipants(next);
  }

  function applyCallPresence(users: Participant[]) {
    setCallParticipants(
      users.map((u) => ({
        id: u.id,
        username: u.username,
        micEnabled: null,
        hasCamera: false,
        hasScreen: false,
        watchingCamera: false,
        watchingScreen: false,
      })),
    );
  }

  function getParticipantVolume(participantID: string, kind: 'voice' | 'screen'): number {
    const map = kind === 'voice' ? participantVoiceVolume : participantScreenVolume;
    const fallback = kind === 'voice' ? 0.65 : 1;
    const fromState = map[participantID];
    if (typeof fromState === 'number') return clamp01(fromState);
    const fromStorage = Number(localStorage.getItem(volumeKey(kind, participantID)) || String(fallback));
    return clamp01(fromStorage);
  }

  function setParticipantVolume(participantID: string, kind: 'voice' | 'screen', value: number) {
    const next = clamp01(value);
    localStorage.setItem(volumeKey(kind, participantID), String(next));
    if (kind === 'voice') {
      setParticipantVoiceVolume((prev) => ({ ...prev, [participantID]: next }));
    } else {
      setParticipantScreenVolume((prev) => ({ ...prev, [participantID]: next }));
    }
  }

  function upsertVideoTile(nextTile: VideoTrackItem) {
    setVideoTracks((prev) => [...prev.filter((item) => item.key !== nextTile.key), nextTile]);
  }

  function playJoinTone() {
    try {
      const audioCtx = new window.AudioContext();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.value = 620;
      gainNode.gain.value = 0.001;
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      const now = audioCtx.currentTime;
      gainNode.gain.exponentialRampToValueAtTime(0.1, now + 0.02);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      oscillator.start(now);
      oscillator.stop(now + 0.24);
      setTimeout(() => void audioCtx.close(), 350);
    } catch {
      // Best effort sound cue.
    }
  }

  function playPresenceTone(kind: 'join' | 'leave') {
    try {
      const audioCtx = new window.AudioContext();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.value = kind === 'join' ? 860 : 360;
      gainNode.gain.value = 0.001;
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      const now = audioCtx.currentTime;
      gainNode.gain.exponentialRampToValueAtTime(0.18, now + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
      oscillator.start(now);
      oscillator.stop(now + 0.26);
      setTimeout(() => void audioCtx.close(), 420);
    } catch {
      // Best effort sound cue.
    }
  }

  function playNotifyTone(kind: 'message' | 'request') {
    try {
      const audioCtx = new window.AudioContext();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = kind === 'message' ? 690 : 520;
      gainNode.gain.value = 0.001;
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      const now = audioCtx.currentTime;
      gainNode.gain.exponentialRampToValueAtTime(0.12, now + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
      oscillator.start(now);
      oscillator.stop(now + 0.16);
      setTimeout(() => void audioCtx.close(), 280);
    } catch {
      // Best effort sound cue.
    }
  }

  function applyRemoteVideoSubscriptions(room: Room) {
    for (const participant of room.remoteParticipants.values()) {
      const screenPub = participant.getTrackPublication(Track.Source.ScreenShare);
      const screenKey = screenPub ? videoKey(participant.identity, Track.Source.ScreenShare, screenPub.trackSid) : '';
      const watchingScreen = Boolean(screenKey && watchedVideoKeysRef.current[screenKey]);
      for (const pub of participant.trackPublications.values()) {
        if (pub.source === Track.Source.Camera) {
          const key = videoKey(participant.identity, Track.Source.Camera, pub.trackSid);
          pub.setSubscribed(Boolean(watchedVideoKeysRef.current[key]));
          continue;
        }
        if (pub.source === Track.Source.ScreenShare) {
          pub.setSubscribed(watchingScreen);
          continue;
        }
        if (pub.source === Track.Source.ScreenShareAudio) {
          pub.setSubscribed(watchingScreen);
          continue;
        }
      }
    }

    setVideoTracks((prev) =>
      prev.filter((item) => {
        if (item.participantId === room.localParticipant.identity) return true;
        if (item.source !== Track.Source.Camera && item.source !== Track.Source.ScreenShare) return true;
        return Boolean(watchedVideoKeys[item.key]);
      }),
    );
  }

  function notifyCallPresence(eventType: 'call_join' | 'call_leave') {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: eventType }));
  }

  function toggleRemoteVideo(participantID: string, source: Track.Source.Camera | Track.Source.ScreenShare) {
    const room = roomRef.current;
    if (!room) return;
    const participant = room.remoteParticipants.get(participantID);
    if (!participant) return;
    const pub = participant.getTrackPublication(source);
    if (!pub) return;

    const key = videoKey(participantID, source, pub.trackSid);
    const nextWatching = !watchedVideoKeysRef.current[key];
    const out = { ...watchedVideoKeysRef.current };
    if (nextWatching) out[key] = true;
    else delete out[key];
    watchedVideoKeysRef.current = out;
    setWatchedVideoKeys(out);

    pub.setSubscribed(nextWatching);
    if (source === Track.Source.ScreenShare) {
      participant.getTrackPublication(Track.Source.ScreenShareAudio)?.setSubscribed(nextWatching);
      for (const publication of participant.trackPublications.values()) {
        if (publication.source === Track.Source.ScreenShare && publication !== pub) {
          publication.setSubscribed(nextWatching);
        }
      }
    }

    if (!nextWatching) {
      setVideoTracks((prev) => prev.filter((item) => item.key !== key));
      if (focusedTileKey === key) {
        setFocusedTileKey(null);
      }
    }

    if (nextWatching && pub.track && isVideoTrack(pub.track)) {
      upsertVideoTile({
        key,
        participantId: participant.identity,
        username: participant.name || participant.identity,
        track: pub.track,
        source,
      });
      setFocusedTileKey(key);
    }
    syncCallParticipants(room);
  }

  async function joinCall() {
    if (!token || !selectedRoom || connectingMedia) return;
    setConnectingMedia(true);
    setError(null);

    try {
      const lk = await api.liveKitToken(token, selectedRoom.id);
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
      });

      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind === Track.Kind.Video) {
          const key = videoKey(participant.identity, publication.source, publication.trackSid);
          if (participant.identity !== room.localParticipant.identity && !watchedVideoKeysRef.current[key]) {
            publication.setSubscribed(false);
            return;
          }
          upsertVideoTile({
            key,
            participantId: participant.identity,
            username: participant.name || participant.identity,
            track,
            source: publication.source,
          });
        }
        if (track.kind === Track.Kind.Audio) {
          const audioKey = publication.trackSid || `${participant.identity}-${publication.source}`;
          const audioEl = track.attach() as HTMLAudioElement;
          audioEl.autoplay = true;
          audioEl.muted = deafenedRef.current;
          const isScreen = isScreenAudioSource(publication.source);
          const v = getParticipantVolume(participant.identity, isScreen ? 'screen' : 'voice');
          audioEl.volume = clamp01(v);
          audioElsRef.current.set(audioKey, { participantID: participant.identity, source: publication.source, el: audioEl });
        }
        syncCallParticipants(room);
      });

      room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        if (track.kind === Track.Kind.Video) {
          const key = videoKey(participant.identity, publication.source, publication.trackSid);
          setVideoTracks((prev) => prev.filter((item) => item.key !== key));
          const out = { ...watchedVideoKeysRef.current };
          delete out[key];
          watchedVideoKeysRef.current = out;
          setWatchedVideoKeys(out);
        }
        if (track.kind === Track.Kind.Audio) {
          const audioKey = publication.trackSid || `${participant.identity}-${publication.source}`;
          const entry = audioElsRef.current.get(audioKey);
          if (entry) {
            entry.el.remove();
            audioElsRef.current.delete(audioKey);
          }
        }
        syncCallParticipants(room);
      });

      room.on(RoomEvent.Disconnected, () => {
        notifyCallPresence('call_leave');
        watchedVideoKeysRef.current = {};
        callRoomIDRef.current = null;
        setActiveCallRoomID(null);
        setInCall(false);
        setCameraEnabled(false);
        setMicEnabled(false);
        setDeafened(false);
        setScreenEnabled(false);
        setWatchedVideoKeys({});
        setVideoTracks([]);
        setFocusedTileKey(null);
        setActiveSpeakerIDs([]);
        setCallParticipants([]);
      });
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        setActiveSpeakerIDs(speakers.map((speaker) => speaker.identity));
      });
      room.on(RoomEvent.ParticipantConnected, () => {
        syncCallParticipants(room);
      });
      room.on(RoomEvent.ParticipantDisconnected, () => {
        syncCallParticipants(room);
      });
      room.on(RoomEvent.TrackMuted, () => syncCallParticipants(room));
      room.on(RoomEvent.TrackUnmuted, () => syncCallParticipants(room));

      await room.connect(lk.livekit_url, lk.token);
      applyRemoteVideoSubscriptions(room);
      playJoinTone();
      notifyCallPresence('call_join');
      try {
        await room.localParticipant.setMicrophoneEnabled(joinWithMicEnabled);
        setMicEnabled(joinWithMicEnabled);
      } catch {
        setMicEnabled(false);
      }

      roomRef.current = room;
      callRoomIDRef.current = selectedRoom.id;
      setActiveCallRoomID(selectedRoom.id);
      syncCallParticipants(room);
      setCameraEnabled(false);
      setScreenEnabled(false);
      setShowMicSettings(false);
      setInCall(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to connect call');
    } finally {
      setConnectingMedia(false);
    }
  }

  async function leaveCall() {
    const room = roomRef.current;
    if (!room) return;

    room.disconnect();
    roomRef.current = null;
    watchedVideoKeysRef.current = {};
    notifyCallPresence('call_leave');
    callRoomIDRef.current = null;
    setActiveCallRoomID(null);

    audioElsRef.current.forEach(({ el }) => el.remove());
    audioElsRef.current.clear();

    setVideoTracks([]);
    setFocusedTileKey(null);
    setInCall(false);
    setCameraEnabled(false);
    setMicEnabled(false);
    setDeafened(false);
    setScreenEnabled(false);
    setShowMicSettings(false);
    setWatchedVideoKeys({});
    setActiveSpeakerIDs([]);
    setCallParticipants([]);
  }

  async function toggleCamera() {
    const room = roomRef.current;
    if (!room) return;
    const next = !cameraEnabled;
    try {
      await room.localParticipant.setCameraEnabled(next);
      setCameraEnabled(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'camera is not available');
      return;
    }

    if (!next) {
      setVideoTracks((prev) =>
        prev.filter((item) => !(item.participantId === room.localParticipant.identity && item.source === Track.Source.Camera)),
      );
      return;
    }

    const localCamPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
    const localCamTrack = localCamPub?.track;
    if (isVideoTrack(localCamTrack)) {
      upsertVideoTile({
        key: localCamPub?.trackSid || `${room.localParticipant.identity}-${Track.Source.Camera}`,
        participantId: room.localParticipant.identity,
        username: user?.username || 'You',
        track: localCamTrack,
        source: Track.Source.Camera,
      });
    }
  }

  async function toggleMic() {
    const room = roomRef.current;
    if (!room) return;
    if (deafened) {
      setError('Disable Deafened mode first');
      return;
    }
    const next = !micEnabled;
    try {
      await room.localParticipant.setMicrophoneEnabled(next);
      setMicEnabled(next);
      syncCallParticipants(room);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'microphone is not available');
    }
  }

  async function toggleScreenShare() {
    const room = roomRef.current;
    if (!room) return;
    const next = !screenEnabled;
    try {
      await room.localParticipant.setScreenShareEnabled(next, { audio: true });
      setScreenEnabled(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'screen sharing is not available');
      return;
    }

    if (!next) {
      setVideoTracks((prev) =>
        prev.filter((item) => !(item.participantId === room.localParticipant.identity && item.source === Track.Source.ScreenShare)),
      );
      return;
    }

    const screenPub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    const screenTrack = screenPub?.track;
    if (isVideoTrack(screenTrack)) {
      upsertVideoTile({
        key: screenPub?.trackSid || `${room.localParticipant.identity}-${Track.Source.ScreenShare}`,
        participantId: room.localParticipant.identity,
        username: user?.username || 'You',
        track: screenTrack,
        source: Track.Source.ScreenShare,
      });
    }
  }

  async function toggleDeafen() {
    const room = roomRef.current;
    if (!room) return;
    const next = !deafened;

    if (next) {
      micBeforeDeafenRef.current = micEnabled;
      try {
        await room.localParticipant.setMicrophoneEnabled(false);
        setMicEnabled(false);
      } catch {
        // best effort
      }
      audioElsRef.current.forEach(({ el }) => {
        el.muted = true;
      });
      setDeafened(true);
      return;
    }

    audioElsRef.current.forEach(({ el }) => {
      el.muted = false;
    });
    if (micBeforeDeafenRef.current) {
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
        setMicEnabled(true);
      } catch {
        // best effort
      }
    }
    syncCallParticipants(room);
    setDeafened(false);
  }

  async function sendImageMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !selectedRoom || !pendingImage) return;
    try {
      await api.uploadRoomImage(token, selectedRoom.id, pendingImage, chatInput);
      setPendingImage(null);
      setChatInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to upload image');
    }
  }

  function handleChatPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const item = Array.from(e.clipboardData?.items || []).find((entry) => entry.type.startsWith('image/'));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    e.preventDefault();
    const name = file.name || `clipboard-${Date.now()}.png`;
    setPendingImage(new File([file], name, { type: file.type || 'image/png' }));
  }

  async function refreshSocial() {
    if (!token) return;
    try {
      const [dms, friends] = await Promise.all([api.listDMRooms(token), api.listFriends(token)]);
      setDMRooms(dms);
      setFriendsData(friends);
      incomingRequestsRef.current = friends.incoming.length;
      friendsInitRef.current = true;
    } catch {
      // best effort
    }
  }

  async function handleUserSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    const q = userSearchQuery.trim();
    if (!q) {
      setUserSearchResults([]);
      return;
    }
    try {
      const results = await api.searchUsers(token, q);
      setUserSearchResults(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'search failed');
    }
  }

  async function handleInviteSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !selectedRoom || selectedRoomIsDM) return;
    const q = inviteQuery.trim();
    if (!q) {
      setInviteResults([]);
      return;
    }
    try {
      const results = await api.searchUsers(token, q);
      setInviteResults(results.filter((u) => u.id !== user?.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to search users');
    }
  }

  async function inviteUserToRoom(userID: string) {
    if (!token || !selectedRoom || selectedRoomIsDM) return;
    try {
      await api.inviteToRoom(token, selectedRoom.id, userID);
      setInviteResults((prev) => prev.filter((u) => u.id !== userID));
      setInviteQuery('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to invite user');
    }
  }

  async function copyText(text: string): Promise<boolean> {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Fallback to legacy copy flow below.
      }
    }
    try {
      const el = document.createElement('textarea');
      el.value = text;
      el.setAttribute('readonly', '');
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.focus();
      el.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }

  async function generateInviteLink() {
    if (!token || !selectedRoom) return;
    setGeneratingInviteLink(true);
    setError(null);
    try {
      const result = await api.createInviteLink(token, selectedRoom.id);
      const copied = await copyText(result.invite_url);
      if (copied) {
        setCopyNotice('Ссылка-приглашение в беседу скопирована.');
      } else {
        window.prompt('Скопируйте ссылку вручную:', result.invite_url);
        setCopyNotice('Ссылка создана. Скопируйте ее вручную.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to create invite link');
    } finally {
      setGeneratingInviteLink(false);
    }
  }

  async function generateFriendInviteLink() {
    if (!token) return;
    setCreatingFriendInvite(true);
    setError(null);
    try {
      const result = await api.createFriendInviteLink(token);
      const copied = await copyText(result.invite_url);
      if (copied) {
        setCopyNotice('Ссылка для добавления в друзья скопирована.');
      } else {
        window.prompt('Скопируйте ссылку вручную:', result.invite_url);
        setCopyNotice('Ссылка создана. Скопируйте ее вручную.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to create friend invite link');
    } finally {
      setCreatingFriendInvite(false);
    }
  }

  async function handleRenameRoom() {
    if (!token || !selectedRoom || selectedRoomIsDM || !selectedRoomCanManage) return;
    const nextName = window.prompt('Новое название беседы', selectedRoom.name)?.trim();
    if (!nextName || nextName === selectedRoom.name) return;
    try {
      const updated = await api.renameRoom(token, selectedRoom.id, nextName);
      setRooms((prev) => prev.map((room) => (room.id === updated.id ? updated : room)));
      setSelectedRoom(updated);
      setRoomMenuOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to rename room');
    }
  }

  async function handleDeleteRoom() {
    if (!token || !selectedRoom || selectedRoomIsDM || !selectedRoomCanManage) return;
    const ok = window.confirm(`Удалить беседу "${selectedRoom.name}" для всех участников?`);
    if (!ok) return;
    try {
      await api.deleteRoom(token, selectedRoom.id);
      if (activeCallRoomID === selectedRoom.id) {
        await leaveCall();
      }
      setRooms((prev) => prev.filter((room) => room.id !== selectedRoom.id));
      setUnreadByRoom((prev) => {
        const out = { ...prev };
        delete out[selectedRoom.id];
        return out;
      });
      setMessages([]);
      setChatParticipants([]);
      setSelectedRoom(null);
      setRoomMenuOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to delete room');
    }
  }

  async function handleLeaveRoom() {
    if (!token || !selectedRoom || selectedRoomIsDM) return;
    const ok = window.confirm(`Выйти из беседы "${selectedRoom.name}"?`);
    if (!ok) return;
    try {
      await api.leaveRoom(token, selectedRoom.id);
      if (activeCallRoomID === selectedRoom.id) {
        await leaveCall();
      }
      setRooms((prev) => prev.filter((room) => room.id !== selectedRoom.id));
      setUnreadByRoom((prev) => {
        const out = { ...prev };
        delete out[selectedRoom.id];
        return out;
      });
      setMessages([]);
      setChatParticipants([]);
      setSelectedRoom(null);
      setRoomMenuOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to leave room');
    }
  }

  async function addFriend(userID: string) {
    if (!token) return;
    try {
      await api.sendFriendRequest(token, userID);
      setSentFriendRequests((prev) => ({ ...prev, [userID]: true }));
      await refreshSocial();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to send friend request');
    }
  }

  function openMiniProfile(id: string, username: string) {
    const friend = friendsData.friends.find((f) => f.id === id);
    const searchHit = userSearchResults.find((u) => u.id === id);
    setMiniProfile({ id, username, email: friend?.email || searchHit?.email });
  }

  async function acceptFriend(requestID: number) {
    if (!token) return;
    try {
      await api.acceptFriendRequest(token, requestID);
      await refreshSocial();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to accept friend');
    }
  }

  async function declineFriend(requestID: number) {
    if (!token) return;
    try {
      await api.declineFriendRequest(token, requestID);
      await refreshSocial();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to decline friend');
    }
  }

  async function openDMWith(userID: string) {
    if (!token) return;
    try {
      const room = await api.openDM(token, userID);
      await refreshSocial();
      setSidebarTab('dms');
      await openRoom(room);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to open dm');
    }
  }

  function logout() {
    if (roomWsReconnectRef.current !== null) {
      window.clearTimeout(roomWsReconnectRef.current);
      roomWsReconnectRef.current = null;
    }
    wsRef.current?.close();
    eventsWsRef.current?.close();
    leaveCall();
    localStorage.removeItem('talkie_token');
    setToken(null);
    setUser(null);
    setSelectedRoom(null);
    setMessages([]);
    setChatParticipants([]);
    setCallParticipants([]);
    setDMRooms([]);
    setFriendsData({ friends: [], incoming: [] });
    setActiveCallsByRoom({});
    setUserSearchResults([]);
    setSentFriendRequests({});
    setSidebarTab('rooms');
    callPresenceIDsRef.current = new Set();
    friendsInitRef.current = false;
    incomingRequestsRef.current = 0;
    lastRoomMessageIDsRef.current = {};
    selectedRoomIDRef.current = null;
    inviteJoinHandledRef.current = false;
    setPendingImage(null);
    setMiniProfile(null);
    setLightboxImageURL(null);
    setCopyNotice(null);
  }

  if (!token || !user) {
    const hasInviteInURL = new URLSearchParams(window.location.search).has('invite');
    const hasFriendInviteInURL = new URLSearchParams(window.location.search).has('friend_invite');
    return (
      <div className="auth-shell">
        {authView === 'verify' ? (
          <form className="auth-card" onSubmit={handleVerifyEmail}>
            <h1>Подтверждение Email</h1>
            <p>Введите код из письма, чтобы завершить вход.</p>
            <small>{pendingVerificationEmail}</small>
            <label>
              Код подтверждения
              <input
                value={verificationTokenInput}
                onChange={(e) => setVerificationTokenInput(e.target.value)}
                placeholder="6-значный код"
                required
              />
            </label>
            <button type="submit" disabled={isVerifyingEmail}>
              {isVerifyingEmail ? 'Проверка...' : 'Подтвердить код'}
            </button>
            <button type="button" className="ghost" onClick={resendVerificationEmail}>
              Отправить код повторно
            </button>
            <button type="button" className="ghost" onClick={() => setAuthView('login')}>
              Назад ко входу
            </button>
            {authMessage && <p>{authMessage}</p>}
            {error && <p className="error">{error}</p>}
          </form>
        ) : authView === 'reset' ? (
          <form className="auth-card" onSubmit={handleResetPasswordSubmit}>
            <h1>Новый Пароль</h1>
            <p>Установите новый пароль для аккаунта.</p>
            <label>
              Новый пароль
              <input
                type="password"
                value={newPasswordInput}
                onChange={(e) => setNewPasswordInput(e.target.value)}
                required
              />
            </label>
            <label>
              Повторите пароль
              <input
                type="password"
                value={newPasswordConfirmInput}
                onChange={(e) => setNewPasswordConfirmInput(e.target.value)}
                required
              />
            </label>
            <button type="submit">Обновить пароль</button>
            <button type="button" className="ghost" onClick={() => setAuthView('login')}>
              Назад ко входу
            </button>
            {authMessage && <p>{authMessage}</p>}
            {error && <p className="error">{error}</p>}
          </form>
        ) : authView === 'forgot' ? (
          <form className="auth-card" onSubmit={handleForgotPasswordSubmit}>
            <h1>Сброс Пароля</h1>
            <p>Введите email, к которому привязан аккаунт.</p>
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <button type="submit">Сбросить пароль</button>
            <button type="button" className="ghost" onClick={() => setAuthView('login')}>
              Назад ко входу
            </button>
            {authMessage && <p>{authMessage}</p>}
            {error && <p className="error">{error}</p>}
          </form>
        ) : (
          <form className="auth-card" onSubmit={handleAuthSubmit}>
            <h1>Talkie</h1>
            <p>Голосовые комнаты, видеозвонки и чат в стиле Discord.</p>
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            {authView === 'register' && (
              <label>
                Username
                <input value={username} onChange={(e) => setUsername(e.target.value)} required />
              </label>
            )}
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            {hasInviteInURL && <small>После входа вы автоматически присоединитесь по invite-ссылке.</small>}
            {hasFriendInviteInURL && <small>После входа вы автоматически добавите пользователя в друзья.</small>}
            <button type="submit">{authView === 'login' ? 'Войти' : 'Создать аккаунт'}</button>
            {authView === 'login' ? (
              <>
                <button type="button" className="ghost" onClick={() => setAuthView('register')}>
                  Нет аккаунта? Зарегистрироваться
                </button>
                <button type="button" className="ghost" onClick={() => setAuthView('forgot')}>
                  Забыли пароль?
                </button>
              </>
            ) : (
              <button type="button" className="ghost" onClick={() => setAuthView('login')}>
                Уже есть аккаунт? Войти
              </button>
            )}
            {authMessage && <p>{authMessage}</p>}
            {error && <p className="error">{error}</p>}
          </form>
        )}
      </div>
    );
  }

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <header className="brand brand-row">
          {!sidebarCollapsed && (
            <div>
              <h2>Talkie</h2>
              <small>Голосовые комнаты</small>
            </div>
          )}
          <div className="sidebar-header-actions">
            <button
              type="button"
              className="create-room-plus"
              onClick={() => {
                setShowCreateRoomModal(true);
                setSidebarTab('rooms');
              }}
              title="Создать комнату"
            >
              +
            </button>
            <button
              className="sidebar-toggle"
              type="button"
              onClick={() => setSidebarCollapsed((prev) => !prev)}
              title={sidebarCollapsed ? 'Развернуть боковую панель' : 'Свернуть боковую панель'}
            >
              {sidebarCollapsed ? '>>' : '<<'}
            </button>
          </div>
        </header>

        {!sidebarCollapsed ? (
          <>
            <div className="sidebar-main">
              <div className="sidebar-tabs">
                <button className={sidebarTab === 'rooms' ? 'active' : ''} onClick={() => setSidebarTab('rooms')} type="button">
                  Комнаты {hasUnreadRooms && <span className="red-dot" />}
                </button>
                <button className={sidebarTab === 'dms' ? 'active' : ''} onClick={() => setSidebarTab('dms')} type="button">
                  ЛС {hasUnreadDMs && <span className="red-dot" />}
                </button>
                <button className={sidebarTab === 'friends' ? 'active' : ''} onClick={() => setSidebarTab('friends')} type="button">
                  Друзья {hasFriendRequestBadge && <span className="red-dot" />}
                </button>
              </div>
              {inCall && activeCallRoom && (
                <button
                  type="button"
                  className="current-call-card"
                  onClick={() => {
                    setSidebarTab(activeCallRoomKind === 'dm' ? 'dms' : 'rooms');
                    openRoom(activeCallRoom);
                  }}
                  title="Перейти в беседу звонка"
                >
                  <small>Сейчас в звонке</small>
                  <strong>{`${activeCallRoomKind === 'dm' ? '@' : '#'} ${activeCallRoom.name}`}</strong>
                </button>
              )}

              {sidebarTab === 'rooms' && (
                <div className="rooms-panel">
                  <ul className="room-list">
                    {sortedRooms.map((room) => (
                      <li key={room.id}>
                        <button
                          className={selectedRoom?.id === room.id ? 'active' : ''}
                          onClick={() => openRoom(room)}
                        >
                          <span className="room-hash">#</span>
                          <span className="room-name">{room.name}</span>
                          {(activeCallsByRoom[room.id] || 0) > 0 && <span className="room-call-dot" title="Сейчас идет звонок" />}
                          {(unreadByRoom[room.id] || 0) > 0 && <span className="room-unread">{unreadByRoom[room.id]}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {sidebarTab === 'dms' && (
                <ul className="room-list">
                  {sortedDMRooms.map((room) => (
                    <li key={room.id}>
                      <button
                        className={selectedRoom?.id === room.id ? 'active' : ''}
                        onClick={() => openRoom(room)}
                      >
                        <span className="room-hash">@</span>
                        <span className="room-name">{room.name}</span>
                        {(activeCallsByRoom[room.id] || 0) > 0 && <span className="room-call-dot" title="Сейчас идет звонок" />}
                        {(unreadByRoom[room.id] || 0) > 0 && <span className="room-unread">{unreadByRoom[room.id]}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {sidebarTab === 'friends' && (
                <FriendsPanel
                  creatingFriendInvite={creatingFriendInvite}
                  copyNotice={copyNotice}
                  friendsData={friendsData}
                  sentFriendRequests={sentFriendRequests}
                  userSearchQuery={userSearchQuery}
                  userSearchResults={userSearchResults}
                  onAddFriend={(userID) => addFriend(userID)}
                  onAcceptFriend={(requestID) => acceptFriend(requestID)}
                  onDeclineFriend={(requestID) => declineFriend(requestID)}
                  onGenerateFriendInviteLink={() => generateFriendInviteLink()}
                  onOpenDMWith={(userID) => openDMWith(userID)}
                  onSearchChange={(nextQuery) => setUserSearchQuery(nextQuery)}
                  onSearchSubmit={handleUserSearch}
                />
              )}
            </div>

            <div className="sidebar-user">
              <div>
                <strong>{user.username}</strong>
                <small>{user.email}</small>
              </div>
              <button className="logout" onClick={logout}>Выйти</button>
            </div>
          </>
        ) : (
          <div className="sidebar-rail">
            <button
              className={`rail-tab ${sidebarTab === 'rooms' ? 'active' : ''}`}
              type="button"
              title="Комнаты"
              disabled
            >
              R
              {hasUnreadRooms && <span className="red-dot" />}
            </button>
            <button
              className={`rail-tab ${sidebarTab === 'dms' ? 'active' : ''}`}
              type="button"
              title="Личные сообщения"
              disabled
            >
              D
              {hasUnreadDMs && <span className="red-dot" />}
            </button>
            <button
              className={`rail-tab ${sidebarTab === 'friends' ? 'active' : ''}`}
              type="button"
              title="Друзья"
              disabled
            >
              F
              {hasFriendRequestBadge && <span className="red-dot" />}
            </button>
          </div>
        )}
      </aside>

      <main className="content">
        {!selectedRoom ? (
          <section className="placeholder">Выберите комнату слева или создайте новую.</section>
        ) : (
          <>
            <section className="media-panel">
              <div className="media-header">
                <div className="media-title">
                  <h3>{selectedRoom.name}</h3>
                  <small>{inCall ? 'Подключено к голосовому каналу' : 'Звонок и чат комнаты'}</small>
                </div>
                {!selectedRoomIsDM && (
                  <div className="room-menu-wrap">
                    <button type="button" className="ghost room-menu-btn" onClick={() => setRoomMenuOpen((prev) => !prev)}>
                      ...
                    </button>
                    {roomMenuOpen && (
                      <div className="room-menu">
                        {selectedRoomCanManage && (
                          <>
                            <button type="button" onClick={handleRenameRoom}>Переименовать беседу</button>
                            <button type="button" className="danger" onClick={handleDeleteRoom}>Удалить беседу для всех</button>
                          </>
                        )}
                        <button type="button" onClick={handleLeaveRoom}>Выйти из беседы</button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="call-roster">
                <strong>В звонке ({callParticipants.length})</strong>
                {callParticipants.length === 0 ? (
                  <div className="participant-empty">Пока никого в звонке</div>
                ) : (
                  <ul className="call-roster-list">
                    {callParticipants.map((p) => (
                      <li key={p.id} className={activeSpeakerIDs.includes(p.id) ? 'is-speaking' : ''}>
                        <span className="avatar-dot" />
                        <button
                          type="button"
                          className="msg-user-btn participant-name"
                          onClick={() => openMiniProfile(p.id, p.username)}
                        >
                          {p.username}
                        </button>
                        {p.micEnabled !== null && (
                          <span className={`mic-badge ${p.micEnabled ? '' : 'off'}`}>
                            {p.micEnabled ? 'мик' : 'выкл'}
                          </span>
                        )}
                        {p.id !== roomRef.current?.localParticipant.identity && p.hasCamera && (
                          <button
                            className={`stream-watch-btn ${p.watchingCamera ? '' : 'control-off'}`}
                            onClick={() => toggleRemoteVideo(p.id, Track.Source.Camera)}
                            type="button"
                          >
                            {p.watchingCamera ? 'Камера: вкл' : 'Камера: выкл'}
                          </button>
                        )}
                        {p.id !== roomRef.current?.localParticipant.identity && p.hasScreen && (
                          <button
                            className={`stream-watch-btn ${p.watchingScreen ? '' : 'control-off'}`}
                            onClick={() => toggleRemoteVideo(p.id, Track.Source.ScreenShare)}
                            type="button"
                          >
                            {p.watchingScreen ? 'Экран: вкл' : 'Экран: выкл'}
                          </button>
                        )}
                        {p.id !== roomRef.current?.localParticipant.identity && (
                          <>
                            <label className="participant-volume">
                              Громк. голоса: {Math.round(getParticipantVolume(p.id, 'voice') * 100)}%
                              <input
                                type="range"
                                min={0}
                                max={100}
                                step={1}
                                value={Math.round(getParticipantVolume(p.id, 'voice') * 100)}
                                onChange={(e) => setParticipantVolume(p.id, 'voice', Number(e.target.value) / 100)}
                              />
                            </label>
                            <label className="participant-volume">
                              Громк. демки: {Math.round(getParticipantVolume(p.id, 'screen') * 100)}%
                              <input
                                type="range"
                                min={0}
                                max={100}
                                step={1}
                                value={Math.round(getParticipantVolume(p.id, 'screen') * 100)}
                                onChange={(e) => setParticipantVolume(p.id, 'screen', Number(e.target.value) / 100)}
                              />
                            </label>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {!inCall ? (
                <div className="empty-video">Войдите в звонок, чтобы включить аудио и видео.</div>
              ) : (
                <>
                  {focusedTile && (
                    <div className={activeSpeakerIDs.includes(focusedTile.participantId) ? 'stage speaking' : 'stage'}>
                      <VideoTile
                        item={focusedTile}
                        muted={focusedTile.participantId === roomRef.current?.localParticipant.identity}
                        expanded
                      />
                    </div>
                  )}
                  <div className="thumbnail-strip">
                    {thumbnailTracks.map((item) => (
                      <div key={item.key} className={activeSpeakerIDs.includes(item.participantId) ? 'speaking' : ''}>
                        <VideoTile
                          item={item}
                          muted={item.participantId === roomRef.current?.localParticipant.identity}
                          onClick={() => setFocusedTileKey(item.key)}
                        />
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className="voice-dock">
                {!inCall ? (
                  <>
                    <button className="big-join" onClick={joinCall} disabled={connectingMedia}>
                      {connectingMedia ? 'Подключение...' : 'Подключиться к звонку'}
                    </button>
                    <button
                      className={`dock-btn ${showMicSettings ? '' : 'control-off'}`}
                      type="button"
                      onClick={() => setShowMicSettings((prev) => !prev)}
                    >
                      Микрофон
                    </button>
                  </>
                ) : (
                  <>
                    <button className={`dock-btn ${micEnabled ? '' : 'control-off'}`} onClick={toggleMic} disabled={deafened}>
                      {micEnabled ? 'Мик вкл' : 'Мик выкл'}
                    </button>
                    <button
                      className={`dock-btn ${showMicSettings ? '' : 'control-off'}`}
                      type="button"
                      onClick={() => setShowMicSettings((prev) => !prev)}
                    >
                      Настройки микрофона
                    </button>
                    <button className={`dock-btn ${cameraEnabled ? '' : 'control-off'}`} onClick={toggleCamera}>
                      {cameraEnabled ? 'Камера вкл' : 'Камера выкл'}
                    </button>
                    <button className={`dock-btn ${screenEnabled ? '' : 'control-off'}`} onClick={toggleScreenShare}>
                      {screenEnabled ? 'Экран вкл' : 'Экран'}
                    </button>
                    <button className={`dock-btn ${deafened ? 'control-off' : ''}`} onClick={toggleDeafen}>
                      {deafened ? 'Заглушен' : 'Заглушить'}
                    </button>
                    <button className="danger" onClick={leaveCall}>Отключиться</button>
                  </>
                )}
              </div>
              {showMicSettings && (
                <div className="mic-settings-popover">
                  <label className="mic-setting-row">
                    <input
                      type="checkbox"
                      checked={joinWithMicEnabled}
                      onChange={(e) => setJoinWithMicEnabled(e.target.checked)}
                    />
                    Входить в звонок с включенным микрофоном
                  </label>
                </div>
              )}

            </section>

            <div className="bottom-row">
              <section className="chat-panel">
                <div className="panel-heading">Чат комнаты</div>
                <div className="messages" ref={messagesRef}>
                  {messages.map((m) => (
                    <p key={m.id} className={m.message_type === 'image' ? 'image-message' : ''}>
                      <button
                        type="button"
                        className="msg-user-btn msg-user-top"
                        onClick={() => openMiniProfile(m.user_id, m.username)}
                        title={m.user_id === user.id ? 'Вы' : 'Профиль'}
                      >
                        {m.username}
                      </button>
                      {!(m.message_type === 'image' && looksLikeImageFilename(m.content)) && (
                        <span className="msg-content">{m.content}</span>
                      )}
                      {m.message_type === 'image' && m.media_url && (
                        <img
                          className="chat-image"
                          src={mediaUrl(api.apiBase, m.media_url)}
                          alt={m.content || 'изображение'}
                          onClick={() => setLightboxImageURL(mediaUrl(api.apiBase, m.media_url))}
                          onLoad={() => {
                            const el = messagesRef.current;
                            if (el) el.scrollTop = el.scrollHeight;
                          }}
                        />
                      )}
                    </p>
                  ))}
                </div>

                <form onSubmit={sendChatMessage} className="chat-form">
                  <label className="attach-btn" title="Прикрепить изображение">
                    +
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      onChange={(e) => setPendingImage(e.target.files?.[0] || null)}
                    />
                  </label>
                  <input
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onPaste={handleChatPaste}
                    placeholder={pendingImage ? 'Подпись к изображению (необязательно)' : 'Напишите сообщение'}
                  />
                  <button type="submit">{pendingImage ? 'Отправить фото' : 'Отправить'}</button>
                </form>
                {pendingImage && <small className="pending-file">Изображение прикреплено</small>}
              </section>

              <section className="members-panel">
                <div className="participants invite-panel">
                  <strong>Приглашения</strong>
                  {selectedRoomIsDM ? (
                    <small>В личные сообщения нельзя приглашать по ссылке.</small>
                  ) : (
                    <>
                      <button type="button" onClick={generateInviteLink} disabled={generatingInviteLink}>
                        {generatingInviteLink ? 'Создаем...' : 'Быстрая invite-ссылка'}
                      </button>
                      {copyNotice && <small className="copy-notice">{copyNotice}</small>}
                    </>
                  )}
                  <form onSubmit={handleInviteSearch} className="invite-form">
                    <input
                      placeholder="Найти пользователя по имени/email"
                      value={inviteQuery}
                      onChange={(e) => setInviteQuery(e.target.value)}
                    />
                    <button type="submit">Найти</button>
                  </form>
                  {inviteResults.length > 0 && (
                    <ul className="participant-list">
                      {inviteResults.map((candidate) => (
                        <li key={candidate.id}>
                          <span className="participant-name">{candidate.username}</span>
                          <button type="button" onClick={() => inviteUserToRoom(candidate.id)}>
                            Пригласить
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="participants">
                  <strong>В чате</strong>
                  {chatParticipants.length === 0 ? (
                    <div className="participant-empty">Пока никого в чате</div>
                  ) : (
                    <ul className="participant-list">
                      {chatParticipants.map((p) => (
                        <li key={p.id}>
                          <span className="avatar-dot" />
                          <button type="button" className="msg-user-btn" onClick={() => openMiniProfile(p.id, p.username)}>
                            {p.username}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            </div>
          </>
        )}
        {error && <p className="error global">{error}</p>}
        {miniProfile && (
          <div className="mini-profile-overlay" onClick={() => setMiniProfile(null)} role="button" tabIndex={0}>
            <div className="mini-profile-card" onClick={(e) => e.stopPropagation()}>
              <h4>{miniProfile.username}</h4>
              <small>{miniProfile.email || miniProfile.id}</small>
              {miniProfile.id === user.id ? (
                <button type="button" disabled>Вы</button>
              ) : friendIDs.has(miniProfile.id) ? (
                <button type="button" disabled>Уже в друзьях</button>
              ) : sentFriendRequests[miniProfile.id] ? (
                <button type="button" disabled>Запрос отправлен</button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    void addFriend(miniProfile.id);
                  }}
                >
                  Добавить в друзья
                </button>
              )}
            </div>
          </div>
        )}
        {lightboxImageURL && (
          <div
            className="image-lightbox"
            onClick={() => setLightboxImageURL(null)}
            role="button"
            tabIndex={0}
          >
            <img
              src={lightboxImageURL}
              alt="Вложение в полном размере"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
        {showCreateRoomModal && (
          <div className="mini-profile-overlay" onClick={() => setShowCreateRoomModal(false)} role="button" tabIndex={0}>
            <form className="mini-profile-card create-room-modal" onSubmit={createRoom} onClick={(e) => e.stopPropagation()}>
              <h4>Создать комнату</h4>
              <label>
                Название
                <input
                  value={newRoomName}
                  onChange={(e) => setNewRoomName(e.target.value)}
                  placeholder="Например, команда"
                  required
                  autoFocus
                />
              </label>
              <button type="submit">Создать</button>
              <button type="button" className="ghost" onClick={() => setShowCreateRoomModal(false)}>Отмена</button>
            </form>
          </div>
        )}
      </main>
    </div>
  );
}
