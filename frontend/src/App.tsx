import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { APIError, api } from './lib/api';
import type { Friend, FriendsResponse, Message, Participant, Room as AppRoom, RoomGroup, User } from './lib/types';
import { FriendsPanel } from './components/FriendsPanel';
import { UserAvatar } from './components/UserAvatar';

type AuthView = 'login' | 'register' | 'verify' | 'forgot' | 'reset';
type CreateMode = 'server' | 'room';
type MiniProfile = { id: string; username: string; avatarURL?: string; createdAt?: string; isFriend?: boolean; loading: boolean };
type SidebarView = { kind: 'root' } | { kind: 'group'; groupID: string };

function flattenGroupChannels(groups: RoomGroup[]): AppRoom[] {
  const out: AppRoom[] = [];
  for (const group of groups) {
    for (const channel of [...group.text_channels, ...group.voice_channels]) {
      out.push({
        id: channel.id,
        name: channel.name,
        created_by: channel.created_by,
        is_private: channel.is_private,
        channel_type: channel.channel_type,
        group_id: group.id,
        position: channel.position,
        my_role: channel.my_role,
        can_manage: channel.can_manage,
        created_at: channel.created_at,
      });
    }
  }
  return out;
}

function toAppRoomFromGroupChannel(
  channel: RoomGroup['text_channels'][number] | RoomGroup['voice_channels'][number],
  groupID: string,
): AppRoom {
  return {
    id: channel.id,
    name: channel.name,
    created_by: channel.created_by,
    is_private: channel.is_private,
    channel_type: channel.channel_type,
    group_id: groupID,
    position: channel.position,
    my_role: channel.my_role,
    can_manage: channel.can_manage,
    created_at: channel.created_at,
  };
}

function mergeGroupedAndStandalone(groups: RoomGroup[], allRooms: AppRoom[]): AppRoom[] {
  const grouped = flattenGroupChannels(groups);
  const groupedIDs = new Set(grouped.map((room) => room.id));
  const standalone = allRooms.filter((room) => !groupedIDs.has(room.id));
  return [...grouped, ...standalone];
}

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
  avatarURL?: string;
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

function avatarUrl(apiBase: string, avatarPath?: string): string {
  return mediaUrl(apiBase, avatarPath);
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

function previewText(message: Message): string {
  if (message.message_type === 'image') return '[Фото]';
  const text = message.content.trim();
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function equalNumberMaps(a: Record<string, number>, b: Record<string, number>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if ((a[key] || 0) !== (b[key] || 0)) return false;
  }
  return true;
}

function equalFriendsData(a: FriendsResponse, b: FriendsResponse): boolean {
  if (a.friends.length !== b.friends.length || a.incoming.length !== b.incoming.length) return false;
  for (let i = 0; i < a.friends.length; i += 1) {
    if (a.friends[i].id !== b.friends[i].id) return false;
  }
  for (let i = 0; i < a.incoming.length; i += 1) {
    const left = a.incoming[i];
    const right = b.incoming[i];
    if (left.id !== right.id || left.status !== right.status) return false;
  }
  return true;
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
  const [acceptLegal, setAcceptLegal] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('talkie_token'));
  const [rooms, setRooms] = useState<AppRoom[]>([]);
  const [groups, setGroups] = useState<RoomGroup[]>([]);
  const [dmRooms, setDMRooms] = useState<AppRoom[]>([]);
  const [sidebarView, setSidebarView] = useState<SidebarView>({ kind: 'root' });
  const [friendsData, setFriendsData] = useState<FriendsResponse>({ friends: [], incoming: [] });
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [userSearchResults, setUserSearchResults] = useState<Friend[]>([]);
  const [sentFriendRequests, setSentFriendRequests] = useState<Record<string, boolean>>({});
  const [unreadByRoom, setUnreadByRoom] = useState<Record<string, number>>({});
  const [lastMessagePreviewByRoom, setLastMessagePreviewByRoom] = useState<Record<string, string>>({});
  const [mutedRooms, setMutedRooms] = useState<Record<string, boolean>>(
    () => {
      try {
        const raw = localStorage.getItem('talkie_muted_rooms');
        return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
      } catch {
        return {};
      }
    },
  );
  const [hasNewFriendRequest, setHasNewFriendRequest] = useState(false);
  const [showFriendsModal, setShowFriendsModal] = useState(false);
  const [miniProfile, setMiniProfile] = useState<MiniProfile | null>(null);
  const [newEntityName, setNewEntityName] = useState('');
  const [createMode, setCreateMode] = useState<CreateMode>('server');
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
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
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [roomMenuOpen, setRoomMenuOpen] = useState(false);
  const [roomActivityByID, setRoomActivityByID] = useState<Record<string, number>>({});
  const [activeCallsByRoom, setActiveCallsByRoom] = useState<Record<string, number>>({});
  const [selectedRoom, setSelectedRoom] = useState<AppRoom | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
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
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const roomsRef = useRef<AppRoom[]>([]);
  const dmRoomsRef = useRef<AppRoom[]>([]);
  const callRoomIDRef = useRef<string | null>(null);
  const audioElsRef = useRef<Map<string, { participantID: string; source: Track.Source; el: HTMLAudioElement }>>(new Map());
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const chatInputRef = useRef<HTMLInputElement | null>(null);
  const micBeforeDeafenRef = useRef(false);
  const deafenedRef = useRef(false);
  const watchedVideoKeysRef = useRef<Record<string, boolean>>({});
  const callPresenceIDsRef = useRef<Set<string>>(new Set());
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioUnlockedRef = useRef(false);
  const friendsInitRef = useRef(false);
  const incomingRequestsRef = useRef(0);
  const selectedRoomIDRef = useRef<string | null>(null);
  const mutedRoomsRef = useRef<Record<string, boolean>>({});
  const lastRoomMessageIDsRef = useRef<Record<string, number>>({});
  const inviteJoinHandledRef = useRef(false);

  const sortedRootRooms = useMemo(
    () =>
      [...dmRooms, ...rooms.filter((room) => !room.group_id)]
        .slice()
        .sort(
          (a, b) => (roomActivityByID[b.id] || new Date(b.created_at).getTime()) - (roomActivityByID[a.id] || new Date(a.created_at).getTime()),
        ),
    [dmRooms, rooms, roomActivityByID],
  );
  const hasUnreadGroupChats = useMemo(
    () => rooms.some((room) => (unreadByRoom[room.id] || 0) > 0),
    [rooms, unreadByRoom],
  );
  const hasUnreadDMs = useMemo(
    () => dmRooms.some((room) => (unreadByRoom[room.id] || 0) > 0),
    [dmRooms, unreadByRoom],
  );
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
  const selectedRoomResolved = useMemo(() => {
    if (!selectedRoom) return null;
    const direct = [...rooms, ...dmRooms].find((room) => room.id === selectedRoom.id);
    if (direct) return direct;
    for (const group of groups) {
      const channel = [...group.text_channels, ...group.voice_channels].find((room) => room.id === selectedRoom.id);
      if (channel) return toAppRoomFromGroupChannel(channel, group.id);
    }
    return selectedRoom;
  }, [selectedRoom, rooms, dmRooms, groups]);
  const selectedRoomIsDM = useMemo(
    () => Boolean(selectedRoomResolved && dmRooms.some((room) => room.id === selectedRoomResolved.id)),
    [selectedRoomResolved, dmRooms],
  );
  const selectedRoomCanManage = Boolean(
    selectedRoomResolved && (selectedRoomResolved.can_manage || selectedRoomResolved.created_by === user?.id),
  );
  const selectedRoomChannelType = selectedRoomResolved?.channel_type || '';
  const selectedRoomInGroup = Boolean(selectedRoomResolved?.group_id);
  const selectedRoomIsTextOnly = Boolean(selectedRoom && !selectedRoomIsDM && selectedRoomChannelType === 'text');
  const selectedRoomIsVoiceOnly = Boolean(selectedRoom && !selectedRoomIsDM && selectedRoomChannelType === 'voice');
  const canUseCallUI = Boolean(selectedRoom && (selectedRoomIsDM || selectedRoomIsVoiceOnly || !selectedRoomChannelType));
  const canUseChatUI = Boolean(selectedRoom && (selectedRoomIsDM || selectedRoomIsTextOnly || !selectedRoomChannelType));
  const selectedSidebarGroup = useMemo(
    () => (sidebarView.kind === 'group' ? groups.find((group) => group.id === sidebarView.groupID) || null : null),
    [sidebarView, groups],
  );
  const selectedSidebarGroupCanManage = Boolean(
    selectedSidebarGroup && (selectedSidebarGroup.can_manage || selectedSidebarGroup.created_by === user?.id),
  );
  const showRightInviteLinkButton = Boolean(!selectedRoomIsDM && !selectedSidebarGroup && !selectedRoomInGroup);
  const showRightInvitePanel = Boolean(!selectedRoomIsDM && !selectedSidebarGroup && !selectedRoomInGroup);
  const resolveAvatarUrl = (path?: string) => avatarUrl(api.apiBase, path);

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
    const unlock = () => {
      try {
        if (!audioCtxRef.current) {
          audioCtxRef.current = new window.AudioContext();
        }
        void audioCtxRef.current.resume();
        audioUnlockedRef.current = true;
      } catch {
        // best effort
      }
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

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
    mutedRoomsRef.current = mutedRooms;
  }, [mutedRooms]);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const [me, groupList, roomList, dms, friends] = await Promise.all([
          api.me(token),
          api.listGroups(token),
          api.listRooms(token),
          api.listDMRooms(token),
          api.listFriends(token),
        ]);
        const mergedRooms = mergeGroupedAndStandalone(groupList, roomList);
        setUser(me);
        setGroups(groupList);
        setRooms(mergedRooms);
        setDMRooms(dms);
        setFriendsData(friends);
        setRoomActivityByID((prev) => {
          const next = { ...prev };
          for (const room of [...mergedRooms, ...dms]) {
            if (!next[room.id]) next[room.id] = new Date(room.created_at).getTime();
          }
          return next;
        });
        incomingRequestsRef.current = friends.incoming.length;
        friendsInitRef.current = true;
      } catch (err) {
        localStorage.removeItem('talkie_token');
        setToken(null);
        setUser(null);
        const message = err instanceof Error ? err.message : 'authentication failed';
        const isTokenError = /invalid token|unauthorized|authentication failed/i.test(message);
        if (isTokenError) {
          setError(null);
          setAuthMessage('Сессия истекла. Войдите снова.');
        } else {
          setError(message);
        }
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
        const [groupList, roomList, dms] = await Promise.all([api.listGroups(token), api.listRooms(token), api.listDMRooms(token)]);
        const mergedRooms = mergeGroupedAndStandalone(groupList, roomList);
        if (!mounted) return;
        setGroups(groupList);
        setRooms(mergedRooms);
        setDMRooms(dms);
        setRoomActivityByID((prev) => ({ ...prev, [room.id]: Date.now() }));
        const resolvedRoom = [...mergedRooms, ...dms].find((candidate) => candidate.id === room.id) || room;
        await openRoom(resolvedRoom);
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
        setShowFriendsModal(true);
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
            void Promise.all([api.listGroups(token), api.listRooms(token), api.listDMRooms(token)])
              .then(([groupList, roomList, dms]) => {
                setGroups(groupList);
                setRooms(mergeGroupedAndStandalone(groupList, roomList));
                setDMRooms(dms);
              })
              .catch(() => {
                // best effort
              });
          }
          lastRoomMessageIDsRef.current[roomID] = incomingMessage.id;
          setLastMessagePreviewByRoom((prev) => ({ ...prev, [roomID]: previewText(incomingMessage) }));
          setRoomActivityByID((prev) => {
            const ts = new Date(incomingMessage.created_at).getTime();
            if ((prev[roomID] || 0) >= ts) return prev;
            return { ...prev, [roomID]: ts };
          });
          if (!mutedRoomsRef.current[roomID]) {
            playNotifyTone('message');
          }
          if (selectedRoomIDRef.current !== roomID) {
            setUnreadByRoom((prev) => ({ ...prev, [roomID]: (prev[roomID] || 0) + 1 }));
          }
          return;
        }
        if (payload.type === 'friend_request_event') {
          setHasNewFriendRequest(true);
          playNotifyTone('request');
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
          return;
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
        setLastMessagePreviewByRoom((prev) => {
          const nextPreview = previewText(message);
          if (prev[roomID] === nextPreview) return prev;
          return { ...prev, [roomID]: nextPreview };
        });

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
            if (!mutedRoomsRef.current[roomID]) {
              playNotifyTone('message');
            }
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
      setActiveCallsByRoom((prev) => (equalNumberMaps(prev, next) ? prev : next));
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
          setLastMessagePreviewByRoom((prev) => {
            const nextPreview = previewText(latest[latest.length - 1]);
            if (prev[selectedRoom.id] === nextPreview) return prev;
            return { ...prev, [selectedRoom.id]: nextPreview };
          });
          lastRoomMessageIDsRef.current[selectedRoom.id] = latest[latest.length - 1].id;
        }
        if (!inCall || callRoomIDRef.current !== selectedRoom.id) {
          try {
            const callUsers = await api.listCallParticipants(token, selectedRoom.id);
            if (!mounted) return;
            setActiveCallsByRoom((prev) => {
              if ((prev[selectedRoom.id] || 0) === callUsers.length) return prev;
              return { ...prev, [selectedRoom.id]: callUsers.length };
            });
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
        setFriendsData((prev) => (equalFriendsData(prev, social) ? prev : social));
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
    const id = window.setInterval(() => void tick(), 5000);
    return () => {
      mounted = false;
      window.clearInterval(id);
    };
  }, [token]);

  useEffect(() => {
    if (selectedRoomIsDM && sidebarView.kind !== 'root') {
      setSidebarView({ kind: 'root' });
    }
  }, [selectedRoomIsDM, sidebarView.kind]);

  useEffect(() => {
    localStorage.setItem('talkie_join_with_mic', joinWithMicEnabled ? '1' : '0');
  }, [joinWithMicEnabled]);

  useEffect(() => {
    if (showFriendsModal) {
      setHasNewFriendRequest(false);
    }
  }, [showFriendsModal]);

  useEffect(() => {
    localStorage.setItem('talkie_muted_rooms', JSON.stringify(mutedRooms));
  }, [mutedRooms]);

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
      if (audioCtxRef.current) {
        void audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
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
        if (!acceptLegal) {
          setError('Подтвердите согласие с Пользовательским соглашением и Политикой конфиденциальности.');
          return;
        }
        await api.register(email, username, password);
        setPendingVerificationEmail(email.trim().toLowerCase());
        setVerificationTokenInput('');
        setPassword('');
        setAcceptLegal(false);
        setAuthView('verify');
        setAuthMessage('Код подтверждения отправлен на email.');
        return;
      }
      if (authView !== 'login') return;

      const result = await api.login(email, password);
      localStorage.setItem('talkie_token', result.token);
      setToken(result.token);
      setUser(result.user);
      const [groupList, roomList, dms, friends] = await Promise.all([
        api.listGroups(result.token),
        api.listRooms(result.token),
        api.listDMRooms(result.token),
        api.listFriends(result.token),
      ]);
      const flatRooms = mergeGroupedAndStandalone(groupList, roomList);
      setGroups(groupList);
      setRooms(flatRooms);
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

  async function refreshGroups() {
    if (!token) return;
    try {
      const [list, roomList] = await Promise.all([api.listGroups(token), api.listRooms(token)]);
      const flatRooms = mergeGroupedAndStandalone(list, roomList);
      setGroups(list);
      setRooms(flatRooms);
      setRoomActivityByID((prev) => {
        const next = { ...prev };
        for (const room of flatRooms) {
          if (!next[room.id]) next[room.id] = new Date(room.created_at).getTime();
        }
        return next;
      });
    } catch {
      // best effort
    }
  }

  async function createStandaloneRoom(name: string) {
    if (!token) return;
    const room = await api.createRoom(token, name);
    await refreshGroups();
    await openRoom(room);
  }

  async function createGroup(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !newEntityName.trim()) return;
    try {
      if (createMode === 'room') {
        await createStandaloneRoom(newEntityName.trim());
        setSidebarView({ kind: 'root' });
      } else {
        const group = await api.createGroup(token, newEntityName.trim());
        await refreshGroups();
        setSidebarView({ kind: 'group', groupID: group.id });
        const firstText = group.text_channels[0];
        if (firstText) {
          const room = toAppRoomFromGroupChannel(firstText, group.id);
          await openRoom(room);
        }
      }
      setNewEntityName('');
      setShowCreateGroupModal(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to create entity');
    }
  }

  async function openRoom(room: AppRoom) {
    if (!token) return;
    if (room.group_id) {
      setSidebarView({ kind: 'group', groupID: room.group_id });
    } else {
      setSidebarView({ kind: 'root' });
    }
    setSelectedRoom(room);
    selectedRoomIDRef.current = room.id;
    setMessages([]);
    setChatParticipants([]);
    setCallParticipants([]);
    setPendingImage(null);
    if (chatInputRef.current) chatInputRef.current.value = '';
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
        setLastMessagePreviewByRoom((prev) => ({ ...prev, [room.id]: previewText(history[history.length - 1]) }));
      }
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
            setLastMessagePreviewByRoom((prev) => ({ ...prev, [room.id]: previewText(incomingMessage) }));
            setRoomActivityByID((prev) => ({ ...prev, [room.id]: new Date(incomingMessage.created_at).getTime() }));
            if (incomingMessage.user_id !== user?.id) {
              if (!mutedRoomsRef.current[room.id]) {
                playNotifyTone('message');
              }
              if (selectedRoomIDRef.current !== room.id) {
                setUnreadByRoom((prev) => ({ ...prev, [room.id]: (prev[room.id] || 0) + 1 }));
              }
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

  function openSidebarGroup(group: RoomGroup) {
    setSidebarView({ kind: 'group', groupID: group.id });
    const firstChannel = [...group.text_channels, ...group.voice_channels]
      .slice()
      .sort((a, b) => a.position - b.position)[0];
    if (!firstChannel) {
      setSelectedRoom(null);
      selectedRoomIDRef.current = null;
      setMessages([]);
      return;
    }
    if (selectedRoom?.id === firstChannel.id) return;
    void openRoom(toAppRoomFromGroupChannel(firstChannel, group.id));
  }

  function sendChatMessage(e: React.FormEvent) {
    e.preventDefault();
    if (pendingImage) {
      void sendImageMessage(e);
      return;
    }
    const text = (chatInputRef.current?.value || '').trim();
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'chat', content: text }));
    if (chatInputRef.current) chatInputRef.current.value = '';
  }

  function syncCallParticipants(room: Room) {
    const next: CallParticipant[] = [
      {
        id: room.localParticipant.identity,
        username: user?.username || room.localParticipant.identity,
        avatarURL: user?.avatar_url,
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
          avatarURL: callParticipants.find((x) => x.id === p.identity)?.avatarURL,
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
        avatarURL: u.avatar_url,
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

  function ensureAudioContext(): AudioContext | null {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new window.AudioContext();
      }
      if (audioCtxRef.current.state === 'suspended' && audioUnlockedRef.current) {
        void audioCtxRef.current.resume();
      }
      return audioCtxRef.current;
    } catch {
      return null;
    }
  }

  function playTone(freq: number, peak: number, duration: number, type: OscillatorType) {
    const audioCtx = ensureAudioContext();
    if (!audioCtx) return;
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    oscillator.type = type;
    oscillator.frequency.value = freq;
    gainNode.gain.value = 0.0001;
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    const now = audioCtx.currentTime;
    gainNode.gain.exponentialRampToValueAtTime(peak, now + 0.015);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  function playJoinTone() {
    playTone(620, 0.1, 0.24, 'triangle');
  }

  function playPresenceTone(kind: 'join' | 'leave') {
    playTone(kind === 'join' ? 860 : 360, 0.18, 0.24, 'triangle');
  }

  function playNotifyTone(kind: 'message' | 'request') {
    playTone(kind === 'message' ? 690 : 520, 0.12, 0.14, 'sine');
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
      const caption = (chatInputRef.current?.value || '').trim();
      await api.uploadRoomImage(token, selectedRoom.id, pendingImage, caption);
      setPendingImage(null);
      if (chatInputRef.current) chatInputRef.current.value = '';
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

  async function createChannelInGroup(groupID: string, type: 'text' | 'voice') {
    if (!token) return;
    const title = type === 'voice' ? 'Название голосового канала' : 'Название текстового канала';
    const fallback = type === 'voice' ? 'Новый голосовой' : 'новый-канал';
    const name = window.prompt(title, fallback)?.trim();
    if (!name) return;
    try {
      const created = await api.createGroupChannel(token, groupID, name, type);
      await refreshGroups();
      await openRoom(created);
      setSidebarView({ kind: 'root' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to create channel');
    }
  }

  function toggleRoomMute(roomID: string) {
    setMutedRooms((prev) => {
      const next = { ...prev };
      if (next[roomID]) delete next[roomID];
      else next[roomID] = true;
      return next;
    });
  }

  async function renameGroupPrompt(groupID: string, currentName: string) {
    if (!token) return;
    const nextName = window.prompt('Новое название сервера', currentName)?.trim();
    if (!nextName || nextName === currentName) return;
    try {
      await api.renameGroup(token, groupID, nextName);
      await refreshGroups();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to rename group');
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
        setCopyNotice(`Ссылка создана: ${result.invite_url}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to create invite link');
    } finally {
      setGeneratingInviteLink(false);
    }
  }

  async function generateGroupInviteLink(group: RoomGroup) {
    if (!token) return;
    const anchorChannel = [...group.text_channels, ...group.voice_channels]
      .slice()
      .sort((a, b) => a.position - b.position)[0];
    if (!anchorChannel) return;

    setGeneratingInviteLink(true);
    setCopyNotice(null);
    try {
      const result = await api.createInviteLink(token, anchorChannel.id);
      const copied = await copyText(result.invite_url);
      if (copied) {
        setCopyNotice('Ссылка на канал скопирована');
      } else {
        setCopyNotice(`Ссылка создана: ${result.invite_url}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to create channel invite link');
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
        setCopyNotice(`Ссылка создана: ${result.invite_url}`);
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
      await refreshGroups();
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
      await refreshGroups();
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
      await refreshGroups();
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

  function openMiniProfile(id: string, username: string, avatarURL?: string) {
    setMiniProfile({ id, username, avatarURL, loading: true });
    if (!token) return;
    void api.userProfile(token, id)
      .then((profile) => {
        setMiniProfile((prev) => {
          if (!prev || prev.id !== id) return prev;
          return {
            id: profile.id,
            username: profile.username,
            avatarURL: profile.avatar_url,
            createdAt: profile.created_at,
            isFriend: profile.is_friend,
            loading: false,
          };
        });
      })
      .catch(() => {
        setMiniProfile((prev) => (prev && prev.id === id ? { ...prev, loading: false } : prev));
      });
  }

  async function handleMyAvatarUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !token) return;
    setUploadingAvatar(true);
    setError(null);
    try {
      const updated = await api.uploadMyAvatar(token, file);
      setUser(updated);
      await refreshSocial();
      setCopyNotice('Аватар обновлен');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to upload avatar');
    } finally {
      e.target.value = '';
      setUploadingAvatar(false);
    }
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
      setSidebarView({ kind: 'root' });
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
    setGroups([]);
    setDMRooms([]);
    setFriendsData({ friends: [], incoming: [] });
    setActiveCallsByRoom({});
    setUserSearchResults([]);
    setSentFriendRequests({});
    setLastMessagePreviewByRoom({});
    setShowFriendsModal(false);
    setSidebarView({ kind: 'root' });
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
                <input value={username} onChange={(e) => setUsername(e.target.value.slice(0, 15))} maxLength={15} required />
              </label>
            )}
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            {authView === 'register' && (
              <label className="auth-consent">
                <input
                  type="checkbox"
                  checked={acceptLegal}
                  onChange={(e) => setAcceptLegal(e.target.checked)}
                  required
                />
                <span>
                  Я ознакомлен и согласен с{' '}
                  <a href="/legal/terms.html" target="_blank" rel="noreferrer">
                    Пользовательским соглашением
                  </a>{' '}
                  и даю согласие на обработку моих персональных данных в соответствии с{' '}
                  <a href="/legal/privacy.html" target="_blank" rel="noreferrer">
                    Политикой конфиденциальности
                  </a>.
                </span>
              </label>
            )}
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
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setAcceptLegal(false);
                  setAuthView('login');
                }}
              >
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
    <div className="app-shell">
      <aside className="sidebar">
        <header className="brand brand-row">
          <div>
            <h2>Talkie</h2>
            <small>Серверы и каналы</small>
          </div>
          <div className="sidebar-header-actions">
            <button
              type="button"
              className="create-room-plus"
              onClick={() => {
                setCreateMode('server');
                setShowCreateGroupModal(true);
                setSidebarView({ kind: 'root' });
              }}
              title="Создать сервер"
            >
              +
            </button>
          </div>
        </header>

        <div className="sidebar-main">
              <div className="sidebar-main-layout with-flyout">
                <div className="sidebar-pane server-rail-pane">
                  <button
                    type="button"
                    className={`server-rail-home ${sidebarView.kind === 'root' ? 'active' : ''}`}
                    onClick={() => setSidebarView({ kind: 'root' })}
                  >
                    Talkie
                    {(hasUnreadDMs || hasUnreadGroupChats) && <span className="red-dot" />}
                  </button>
                  <ul className="server-rail-list">
                    {groups.map((group) => {
                      const groupRooms = [...group.text_channels, ...group.voice_channels];
                      const hasUnread = groupRooms.some((room) => (unreadByRoom[room.id] || 0) > 0);
                      return (
                        <li key={group.id}>
                          <button
                            type="button"
                            className={`server-rail-btn ${sidebarView.kind === 'group' && sidebarView.groupID === group.id ? 'active' : ''}`}
                            onClick={() => openSidebarGroup(group)}
                            title={group.name}
                          >
                            <UserAvatar username={group.name} size="sm" />
                            {hasUnread && <span className="red-dot" />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
                <div className="sidebar-pane secondary-pane">
                  {sidebarView.kind === 'root' ? (
                    <>
                      <div className="group-head">
                        <strong>
                          <UserAvatar username="Talkie" size="sm" />
                          Talkie
                        </strong>
                      </div>
                      {inCall && activeCallRoom && (
                        <ul className="room-list">
                          <li key={`active-call-${activeCallRoom.id}`}>
                            <button
                              type="button"
                              className={`current-call-card ${selectedRoom?.id === activeCallRoom.id ? 'active' : ''}`}
                              onClick={() => {
                                setSidebarView({ kind: 'root' });
                                openRoom(activeCallRoom);
                              }}
                              title="Перейти в беседу звонка"
                            >
                              <UserAvatar username={activeCallRoom.name} avatarUrl={resolveAvatarUrl(activeCallRoom.avatar_url)} size="sm" />
                              <span className="room-main">
                                <span className="room-name">{activeCallRoom.name}</span>
                                <span className="room-preview">
                                  {(activeCallsByRoom[activeCallRoom.id] || 0) > 0
                                    ? `Сейчас в звонке • ${activeCallsByRoom[activeCallRoom.id]} участ.`
                                    : 'Сейчас в звонке'}
                                </span>
                              </span>
                            </button>
                          </li>
                        </ul>
                      )}
                      <small className="group-subtitle">Диалоги и группы</small>
                      <ul className="room-list">
                        {sortedRootRooms.map((room) => (
                          <li key={room.id}>
                            <button className={selectedRoom?.id === room.id ? 'active' : ''} onClick={() => openRoom(room)}>
                              <UserAvatar username={room.name} avatarUrl={resolveAvatarUrl(room.avatar_url)} size="sm" />
                              <span className="room-main">
                                <span className="room-name">{room.name}</span>
                                <span className="room-preview">{lastMessagePreviewByRoom[room.id] || ''}</span>
                              </span>
                              {(unreadByRoom[room.id] || 0) > 0 && <span className="room-unread">{unreadByRoom[room.id]}</span>}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <>
                      <div className="group-head">
                        <strong>{selectedSidebarGroup?.name || 'Каналы'}</strong>
                        {selectedSidebarGroup && selectedSidebarGroupCanManage && (
                          <div className="group-actions">
                            <button type="button" className="ghost" onClick={() => renameGroupPrompt(selectedSidebarGroup.id, selectedSidebarGroup.name)}>
                              Переименовать
                            </button>
                            <button type="button" className="ghost" onClick={() => createChannelInGroup(selectedSidebarGroup.id, 'text')}>
                              +Текст
                            </button>
                            <button type="button" className="ghost" onClick={() => createChannelInGroup(selectedSidebarGroup.id, 'voice')}>
                              +Голос
                            </button>
                          </div>
                        )}
                      </div>
                      {selectedSidebarGroup && (
                        <>
                          <div className="flyout-tools">
                            <button
                              type="button"
                              className="secondary-action"
                              onClick={() => generateGroupInviteLink(selectedSidebarGroup)}
                              disabled={generatingInviteLink}
                            >
                              {generatingInviteLink ? 'Создаем...' : 'Ссылка-приглашение в канал'}
                            </button>
                            {copyNotice && <small className="copy-notice">{copyNotice}</small>}
                          </div>
                          <small className="group-subtitle">Текстовые каналы</small>
                          <ul className="room-list">
                            {selectedSidebarGroup.text_channels
                              .slice()
                              .sort((a, b) => a.position - b.position)
                              .map((room) => (
                                <li key={room.id}>
                                  <button
                                    className={selectedRoom?.id === room.id ? 'active' : ''}
                                    onClick={() => openRoom(toAppRoomFromGroupChannel(room, selectedSidebarGroup.id))}
                                  >
                                    <span className="room-name">{room.name}</span>
                                    {(unreadByRoom[room.id] || 0) > 0 && <span className="room-unread">{unreadByRoom[room.id]}</span>}
                                  </button>
                                </li>
                              ))}
                          </ul>
                          <small className="group-subtitle">Голосовые каналы</small>
                          <ul className="room-list">
                            {selectedSidebarGroup.voice_channels
                              .slice()
                              .sort((a, b) => a.position - b.position)
                              .map((room) => (
                                <li key={room.id}>
                                  <button
                                    className={selectedRoom?.id === room.id ? 'active' : ''}
                                    onClick={() => openRoom(toAppRoomFromGroupChannel(room, selectedSidebarGroup.id))}
                                  >
                                    <span className="room-name">{room.name}</span>
                                    {(unreadByRoom[room.id] || 0) > 0 && <span className="room-unread">{unreadByRoom[room.id]}</span>}
                                  </button>
                                </li>
                              ))}
                          </ul>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
        </div>

        <div className="sidebar-user">
              <div className="sidebar-user-head">
                <UserAvatar username={user.username} avatarUrl={resolveAvatarUrl(user.avatar_url)} size="md" />
                <div>
                  <strong>{user.username}</strong>
                  <small>{user.email}</small>
                </div>
              </div>
              <div className="sidebar-user-actions">
                <button type="button" className="ghost sidebar-user-btn" onClick={() => setShowFriendsModal(true)}>
                  <span>Друзья</span> {hasNewFriendRequest && <span className="red-dot" />}
                </button>
                <button className="logout sidebar-user-btn" onClick={logout}>Выйти</button>
              </div>
              <div className="sidebar-user-actions single">
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden-file-input"
                  onChange={handleMyAvatarUpload}
                />
                <button
                  type="button"
                  className="ghost sidebar-user-btn"
                  disabled={uploadingAvatar}
                  onClick={() => avatarInputRef.current?.click()}
                >
                  {uploadingAvatar ? 'Загрузка аватара...' : 'Сменить аватар'}
                </button>
              </div>
        </div>
      </aside>

      <main className="content">
        {!selectedRoom ? (
          <section className="placeholder">Выберите канал слева или создайте новый сервер.</section>
        ) : (
          <>
            <section className="media-panel">
              <div className="media-header">
                <div className="media-title">
                  <h3 className="media-title-main">
                    <UserAvatar username={selectedRoom.name} avatarUrl={resolveAvatarUrl(selectedRoom.avatar_url)} size="md" />
                    {selectedRoom.name}
                  </h3>
                </div>
                <div className="room-header-actions">
                  <button
                    type="button"
                    className={`ghost ${mutedRooms[selectedRoom.id] ? 'danger' : ''}`}
                    onClick={() => toggleRoomMute(selectedRoom.id)}
                  >
                    {mutedRooms[selectedRoom.id] ? 'Включить звук канала' : 'Заглушить канал'}
                  </button>
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
              </div>

              {canUseCallUI ? (
                <div className="call-roster">
                  <strong>В звонке ({callParticipants.length})</strong>
                  {callParticipants.length === 0 ? (
                    <div className="participant-empty">Пока никого в звонке</div>
                  ) : (
                    <ul className="call-roster-list">
                      {callParticipants.map((p) => (
                        <li key={p.id} className={activeSpeakerIDs.includes(p.id) ? 'is-speaking' : ''}>
                          <UserAvatar username={p.username} avatarUrl={resolveAvatarUrl(p.avatarURL)} size="sm" />
                          <button
                            type="button"
                            className="msg-user-btn participant-name"
                            onClick={() => openMiniProfile(p.id, p.username, p.avatarURL)}
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
              ) : null}

              {canUseCallUI && !inCall ? (
                <div className="empty-video">Войдите в звонок, чтобы включить аудио и видео.</div>
              ) : canUseCallUI ? (
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
              ) : null}
              {canUseCallUI && (
                <>
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
                </>
              )}

            </section>

            <div className={`bottom-row ${selectedRoomIsDM ? 'dm-layout' : ''}`}>
              {canUseChatUI ? (
                <section className="chat-panel">
                  <div className="panel-heading">Чат канала</div>
                  <div className="messages" ref={messagesRef}>
                    {messages.map((m) => (
                      <p key={m.id} className={m.message_type === 'image' ? 'image-message' : ''}>
                        <span className="msg-header">
                          <UserAvatar username={m.username} avatarUrl={resolveAvatarUrl(m.avatar_url)} size="sm" />
                          <button
                            type="button"
                            className="msg-user-btn msg-user-top"
                            onClick={() => openMiniProfile(m.user_id, m.username, m.avatar_url)}
                            title={m.user_id === user.id ? 'Вы' : 'Профиль'}
                          >
                            {m.username}
                          </button>
                        </span>
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
                      ref={chatInputRef}
                      onPaste={handleChatPaste}
                      placeholder={pendingImage ? 'Подпись к изображению (необязательно)' : 'Напишите сообщение'}
                    />
                    <button type="submit">{pendingImage ? 'Отправить фото' : 'Отправить'}</button>
                  </form>
                  {pendingImage && <small className="pending-file">Изображение прикреплено</small>}
                </section>
              ) : null}

              {!selectedRoomIsDM && (
                <section className="members-panel">
                {showRightInvitePanel && (
                  <div className="participants invite-panel">
                    <strong>Приглашения</strong>
                    {showRightInviteLinkButton && (
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
                            <UserAvatar username={candidate.username} avatarUrl={resolveAvatarUrl(candidate.avatar_url)} size="sm" />
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
                          <UserAvatar username={p.username} avatarUrl={resolveAvatarUrl(p.avatar_url)} size="sm" />
                          <button type="button" className="msg-user-btn" onClick={() => openMiniProfile(p.id, p.username, p.avatar_url)}>
                            {p.username}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                </section>
              )}
            </div>
          </>
        )}
        {error && <p className="error global">{error}</p>}
        {showFriendsModal && (
          <div className="mini-profile-overlay" onClick={() => setShowFriendsModal(false)} role="button" tabIndex={0}>
            <div className="mini-profile-card friends-modal" onClick={(e) => e.stopPropagation()}>
              <h4>Друзья</h4>
              <FriendsPanel
                creatingFriendInvite={creatingFriendInvite}
                copyNotice={copyNotice}
                friendsData={friendsData}
                sentFriendRequests={sentFriendRequests}
                userSearchQuery={userSearchQuery}
                userSearchResults={userSearchResults}
                resolveAvatarUrl={resolveAvatarUrl}
                onAddFriend={(userID) => addFriend(userID)}
                onAcceptFriend={(requestID) => acceptFriend(requestID)}
                onDeclineFriend={(requestID) => declineFriend(requestID)}
                onGenerateFriendInviteLink={() => generateFriendInviteLink()}
                onOpenDMWith={(userID) => openDMWith(userID)}
                onOpenProfile={(userID, uname, avatar) => openMiniProfile(userID, uname, avatar)}
                onSearchChange={(nextQuery) => setUserSearchQuery(nextQuery)}
                onSearchSubmit={handleUserSearch}
              />
              <button type="button" className="ghost" onClick={() => setShowFriendsModal(false)}>Закрыть</button>
            </div>
          </div>
        )}
        {miniProfile && (
          <div className="mini-profile-overlay" onClick={() => setMiniProfile(null)} role="button" tabIndex={0}>
            <div className="mini-profile-card" onClick={(e) => e.stopPropagation()}>
              <div className="mini-profile-head">
                <UserAvatar username={miniProfile.username} avatarUrl={resolveAvatarUrl(miniProfile.avatarURL)} size="lg" />
                <h4>{miniProfile.username}</h4>
              </div>
              {miniProfile.loading ? (
                <small>Загрузка профиля...</small>
              ) : (
                <>
                  <small>
                    Зарегистрирован: {miniProfile.createdAt ? new Date(miniProfile.createdAt).toLocaleDateString('ru-RU') : 'нет данных'}
                  </small>
                  <small>
                    Статус: {miniProfile.id === user.id ? 'Это вы' : (miniProfile.isFriend ? 'В друзьях' : 'Не в друзьях')}
                  </small>
                </>
              )}
              {miniProfile.id === user.id ? (
                <button type="button" disabled>Вы</button>
              ) : (
                <button type="button" onClick={() => { void openDMWith(miniProfile.id); setMiniProfile(null); }}>Написать в лс</button>
              )}
              {miniProfile.id !== user.id && (miniProfile.isFriend || friendIDs.has(miniProfile.id)) ? (
                <button type="button" disabled>Уже в друзьях</button>
              ) : sentFriendRequests[miniProfile.id] ? (
                <button type="button" disabled>Запрос отправлен</button>
              ) : miniProfile.id !== user.id ? (
                <button
                  type="button"
                  onClick={() => {
                    void addFriend(miniProfile.id);
                  }}
                >
                  Добавить в друзья
                </button>
              ) : null}
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
        {showCreateGroupModal && (
          <div className="mini-profile-overlay" onClick={() => setShowCreateGroupModal(false)} role="button" tabIndex={0}>
            <form className="mini-profile-card create-room-modal" onSubmit={createGroup} onClick={(e) => e.stopPropagation()}>
              <h4>{createMode === 'server' ? 'Создать сервер' : 'Создать обычную группу'}</h4>
              <div className="create-mode-switch">
                <button type="button" className={createMode === 'server' ? '' : 'ghost'} onClick={() => setCreateMode('server')}>
                  Сервер
                </button>
                <button type="button" className={createMode === 'room' ? '' : 'ghost'} onClick={() => setCreateMode('room')}>
                  Обычная группа
                </button>
              </div>
              <label>
                Название
                <input
                  value={newEntityName}
                  onChange={(e) => setNewEntityName(e.target.value)}
                  placeholder={createMode === 'server' ? 'Например, Team Alpha' : 'Например, Общая беседа'}
                  required
                  autoFocus
                />
              </label>
              <button type="submit">Создать</button>
              <button type="button" className="ghost" onClick={() => setShowCreateGroupModal(false)}>Отмена</button>
            </form>
          </div>
        )}
      </main>
    </div>
  );
}
