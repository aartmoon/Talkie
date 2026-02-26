import { useEffect, useMemo, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { api } from './lib/api';
import type { Friend, FriendsResponse, Message, Participant, Room as AppRoom, User } from './lib/types';

type AuthMode = 'login' | 'register';
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
  const [mode, setMode] = useState<AuthMode>('login');
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
  const [newRoomPrivate, setNewRoomPrivate] = useState(false);
  const [inviteQuery, setInviteQuery] = useState('');
  const [inviteResults, setInviteResults] = useState<Friend[]>([]);
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
  const [watchedVideoKeys, setWatchedVideoKeys] = useState<Record<string, boolean>>({});
  const [videoTracks, setVideoTracks] = useState<VideoTrackItem[]>([]);
  const [focusedTileKey, setFocusedTileKey] = useState<string | null>(null);
  const [activeSpeakerIDs, setActiveSpeakerIDs] = useState<string[]>([]);
  const [pendingImage, setPendingImage] = useState<File | null>(null);
  const [lightboxImageURL, setLightboxImageURL] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const roomRef = useRef<Room | null>(null);
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
  const lastRoomMessageIDsRef = useRef<Record<string, number>>({});

  const sortedRooms = useMemo(() => [...rooms], [rooms]);
  const hasUnreadRooms = useMemo(
    () => rooms.some((room) => (unreadByRoom[room.id] || 0) > 0),
    [rooms, unreadByRoom],
  );
  const hasUnreadDMs = useMemo(
    () => dmRooms.some((room) => (unreadByRoom[room.id] || 0) > 0),
    [dmRooms, unreadByRoom],
  );
  const hasFriendRequestBadge = hasNewFriendRequest || friendsData.incoming.length > 0;
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

  function videoKey(participantID: string, source: Track.Source, sid?: string): string {
    return sid || `${participantID}-${source}`;
  }

  useEffect(() => {
    deafenedRef.current = deafened;
  }, [deafened]);

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
    if (!token || !user) return;
    const roomIDs = Array.from(new Set([...rooms, ...dmRooms].map((room) => room.id)));
    if (roomIDs.length === 0) return;
    let mounted = true;

    const pollUnread = async () => {
      const latestByRoom = await Promise.all(
        roomIDs.map(async (roomID) => {
          try {
            const latest = await api.listMessages(token, roomID, 1);
            return { roomID, message: latest[0] };
          } catch {
            return { roomID, message: undefined };
          }
        }),
      );
      if (!mounted) return;

      setUnreadByRoom((prev) => {
        const next = { ...prev };
        let changed = false;

        for (const item of latestByRoom) {
          if (!item.message) continue;
          const prevID = lastRoomMessageIDsRef.current[item.roomID];
          lastRoomMessageIDsRef.current[item.roomID] = item.message.id;
          const isActiveRoom = selectedRoomIDRef.current === item.roomID;
          if (prevID && item.message.id !== prevID && item.message.user_id !== user.id && !isActiveRoom) {
            next[item.roomID] = (next[item.roomID] || 0) + 1;
            changed = true;
          }
        }

        return changed ? next : prev;
      });
    };

    void pollUnread();
    const id = window.setInterval(() => void pollUnread(), 12000);
    return () => {
      mounted = false;
      window.clearInterval(id);
    };
  }, [token, user, rooms, dmRooms]);

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
        if (friendsInitRef.current && social.incoming.length > incomingRequestsRef.current) {
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
    const id = window.setInterval(() => void tick(), 15000);
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
  }, [selectedRoom?.id]);

  async function handleAuthSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const result =
        mode === 'login'
          ? await api.login(email, password)
          : await api.register(email, username, password);
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
      setError(err instanceof Error ? err.message : 'request failed');
    }
  }

  async function createRoom(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !newRoomName.trim()) return;
    try {
      const room = await api.createRoom(token, newRoomName.trim(), newRoomPrivate);
      setRooms((prev) => [room, ...prev]);
      setNewRoomName('');
      setNewRoomPrivate(false);
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

    wsRef.current?.close();

    try {
      await api.joinRoom(token, room.id);
      const history = await api.listMessages(token, room.id);
      setMessages(history);
      if (history.length > 0) {
        lastRoomMessageIDsRef.current[room.id] = history[history.length - 1].id;
      }

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
          if (incomingMessage.user_id !== user?.id && selectedRoomIDRef.current !== room.id) {
            playNotifyTone('message');
            setUnreadByRoom((prev) => ({ ...prev, [room.id]: (prev[room.id] || 0) + 1 }));
          }
          lastRoomMessageIDsRef.current[room.id] = incomingMessage.id;
        }
        if (payload.type === 'participants' && payload.participants) {
          setChatParticipants(payload.participants);
        }
        if (payload.type === 'call_participants' && payload.call_users) {
          const nextIDs = new Set(payload.call_users.map((u) => u.id));
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
            applyCallPresence(payload.call_users);
          }
        }
      };

      wsRef.current = socket;

      if (!inCall || callRoomIDRef.current !== room.id) {
        void api.listCallParticipants(token, room.id)
          .then((callUsers) => {
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
        const camKey = camPub ? videoKey(p.identity, Track.Source.Camera, camPub.trackSid) : '';
        const screenKey = screenPub ? videoKey(p.identity, Track.Source.ScreenShare, screenPub.trackSid) : '';

        return {
          id: p.identity,
          username: p.name || p.identity,
          micEnabled: !p.isMicrophoneEnabled ? false : !p.getTrackPublication(Track.Source.Microphone)?.isMuted,
          hasCamera: Boolean(camPub),
          hasScreen: Boolean(screenPub),
          watchingCamera: Boolean(camKey && watchedVideoKeys[camKey]),
          watchingScreen: Boolean(screenKey && watchedVideoKeys[screenKey]),
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
          const isScreenAudio = isScreenAudioSource(publication.source);
          audioEl.volume = isScreenAudio
            ? 1
            : 0.65;
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
    if (!token || !selectedRoom?.is_private) return;
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
    if (!token || !selectedRoom?.is_private) return;
    try {
      await api.inviteToRoom(token, selectedRoom.id, userID);
      setInviteResults((prev) => prev.filter((u) => u.id !== userID));
      setInviteQuery('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to invite user');
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
    wsRef.current?.close();
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
    setUserSearchResults([]);
    setSentFriendRequests({});
    setSidebarTab('rooms');
    callPresenceIDsRef.current = new Set();
    friendsInitRef.current = false;
    incomingRequestsRef.current = 0;
    lastRoomMessageIDsRef.current = {};
    selectedRoomIDRef.current = null;
    setPendingImage(null);
    setMiniProfile(null);
    setLightboxImageURL(null);
  }

  if (!token || !user) {
    return (
      <div className="auth-shell">
        <form className="auth-card" onSubmit={handleAuthSubmit}>
          <h1>Talkie</h1>
          <p>Голосовые комнаты, видеозвонки и чат в стиле Discord.</p>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          {mode === 'register' && (
            <label>
              Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} required />
            </label>
          )}
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <button type="submit">{mode === 'login' ? 'Войти' : 'Создать аккаунт'}</button>
          <button
            type="button"
            className="ghost"
            onClick={() => setMode((prev) => (prev === 'login' ? 'register' : 'login'))}
          >
            {mode === 'login' ? 'Нет аккаунта? Зарегистрироваться' : 'Уже есть аккаунт? Войти'}
          </button>
          {error && <p className="error">{error}</p>}
        </form>
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
          <button
            className="sidebar-toggle"
            type="button"
            onClick={() => setSidebarCollapsed((prev) => !prev)}
            title={sidebarCollapsed ? 'Развернуть боковую панель' : 'Свернуть боковую панель'}
          >
            {sidebarCollapsed ? '>>' : '<<'}
          </button>
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
                  <form onSubmit={createRoom} className="new-room-form create-room-form">
                    <input
                      placeholder="Новая комната"
                      value={newRoomName}
                      onChange={(e) => setNewRoomName(e.target.value)}
                    />
                    <label className="private-toggle">
                      <input
                        type="checkbox"
                        checked={newRoomPrivate}
                        onChange={(e) => setNewRoomPrivate(e.target.checked)}
                      />
                      Приватная
                    </label>
                    <button type="submit">Создать</button>
                  </form>

                  <ul className="room-list">
                    {sortedRooms.map((room) => (
                      <li key={room.id}>
                        <button
                          className={selectedRoom?.id === room.id ? 'active' : ''}
                          onClick={() => openRoom(room)}
                        >
                          <span className="room-hash">#</span>
                          <span className="room-name">{room.name}</span>
                          {room.is_private && <span className="room-private-badge">приват</span>}
                          {(unreadByRoom[room.id] || 0) > 0 && <span className="room-unread">{unreadByRoom[room.id]}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {sidebarTab === 'dms' && (
                <ul className="room-list">
                  {dmRooms.map((room) => (
                    <li key={room.id}>
                      <button
                        className={selectedRoom?.id === room.id ? 'active' : ''}
                        onClick={() => openRoom(room)}
                      >
                        <span className="room-hash">@</span>
                        <span className="room-name">{room.name}</span>
                        {(unreadByRoom[room.id] || 0) > 0 && <span className="room-unread">{unreadByRoom[room.id]}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {sidebarTab === 'friends' && (
                <div className="friends-panel">
                  <form onSubmit={handleUserSearch} className="new-room-form">
                    <input
                      placeholder="Найти пользователя по имени/email"
                      value={userSearchQuery}
                      onChange={(e) => setUserSearchQuery(e.target.value)}
                    />
                    <button type="submit">Найти</button>
                  </form>
                  <ul className="room-list">
                    {userSearchResults.map((f) => (
                      <li key={f.id}>
                        <button
                          onClick={() => addFriend(f.id)}
                          type="button"
                          disabled={Boolean(sentFriendRequests[f.id]) || friendsData.friends.some((x) => x.id === f.id)}
                        >
                          {friendsData.friends.some((x) => x.id === f.id)
                            ? `Уже в друзьях: ${f.username}`
                            : sentFriendRequests[f.id]
                              ? `Запрос отправлен: ${f.username}`
                              : `+ ${f.username}`}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div className="participants">
                    <strong>Заявки</strong>
                    <ul className="participant-list">
                      {friendsData.incoming.map((fr) => (
                        <li key={fr.id}>
                          <span className="participant-name">{fr.requester_username}</span>
                          <button type="button" onClick={() => acceptFriend(fr.id)}>Принять</button>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="participants">
                    <strong>Друзья</strong>
                    <ul className="participant-list">
                      {friendsData.friends.map((f) => (
                        <li key={f.id}>
                          <span className="participant-name">{f.username}</span>
                          <button type="button" onClick={() => openDMWith(f.id)}>Написать</button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
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
              onClick={() => setSidebarTab('rooms')}
              type="button"
              title="Комнаты"
            >
              R
              {hasUnreadRooms && <span className="red-dot" />}
            </button>
            <button
              className={`rail-tab ${sidebarTab === 'dms' ? 'active' : ''}`}
              onClick={() => setSidebarTab('dms')}
              type="button"
              title="Личные сообщения"
            >
              D
              {hasUnreadDMs && <span className="red-dot" />}
            </button>
            <button
              className={`rail-tab ${sidebarTab === 'friends' ? 'active' : ''}`}
              onClick={() => setSidebarTab('friends')}
              type="button"
              title="Друзья"
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
                        <span className={`mic-badge ${p.micEnabled === null ? 'unknown' : (p.micEnabled ? '' : 'off')}`}>
                          {p.micEnabled === null ? 'нет данных' : (p.micEnabled ? 'мик' : 'выкл')}
                        </span>
                        {activeSpeakerIDs.includes(p.id) && <em className="speaking-badge">говорит</em>}
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
                    placeholder={pendingImage ? 'Подпись к изображению (необязательно)' : 'Напишите сообщение'}
                  />
                  <button type="submit">{pendingImage ? 'Отправить фото' : 'Отправить'}</button>
                </form>
                {pendingImage && <small className="pending-file">Изображение прикреплено</small>}
              </section>

              <section className="members-panel">
                {selectedRoom.is_private && (
                  <div className="participants invite-panel">
                    <strong>Приватные приглашения</strong>
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
                )}
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
      </main>
    </div>
  );
}
