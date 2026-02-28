import type { Friend, FriendsResponse, Message, Participant, Room, User } from './types';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export class APIError extends Error {
  requiresEmailVerification: boolean;

  constructor(message: string, requiresEmailVerification = false) {
    super(message);
    this.name = 'APIError';
    this.requiresEmailVerification = requiresEmailVerification;
  }
}

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(options.headers || {});
  const isFormData = options.body instanceof FormData;
  if (!isFormData) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    let data: {
      error?: string;
      requires_email_verification?: boolean;
    } = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // Non-JSON error response, keep raw text fallback below.
    }
    const message = data.error || text || `request failed (${res.status})`;
    throw new APIError(message, Boolean(data.requires_email_verification));
  }
  return res.json();
}

export type AuthResult = { token: string; user: User };
export type RegisterResult = { user: User; requires_email_verification?: boolean };
export type InviteLinkResult = { token: string; invite_url: string; expires_at: string };

export const api = {
  apiBase: API_BASE,
  register: (email: string, username: string, password: string) =>
    request<RegisterResult>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, username, password }),
    }),
  login: (email: string, password: string) =>
    request<AuthResult>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  verifyEmail: (email: string, code: string) =>
    request<AuthResult>('/api/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    }),
  resendVerification: (email: string) =>
    request<{ ok: boolean }>('/api/auth/resend-verification', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  me: (token: string) => request<User>('/api/me', {}, token),
  listRooms: (token: string) => request<Room[]>('/api/rooms', {}, token),
  createRoom: (token: string, name: string) =>
    request<Room>('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }, token),
  inviteToRoom: (token: string, roomID: string, userID: string) =>
    request<{ ok: boolean }>(
      `/api/rooms/${roomID}/invite`,
      { method: 'POST', body: JSON.stringify({ user_id: userID }) },
      token,
    ),
  createInviteLink: (token: string, roomID: string) =>
    request<InviteLinkResult>(`/api/rooms/${roomID}/invite-link`, { method: 'POST' }, token),
  joinByInviteLink: (token: string, inviteToken: string) =>
    request<Room>(`/api/invite-links/${encodeURIComponent(inviteToken)}/join`, { method: 'POST' }, token),
  joinRoom: (token: string, roomID: string) =>
    request<{ joined: boolean }>(`/api/rooms/${roomID}/join`, { method: 'POST' }, token),
  listMessages: (token: string, roomID: string, limit = 50) =>
    request<Message[]>(`/api/rooms/${roomID}/messages?limit=${limit}`, {}, token),
  listCallParticipants: (token: string, roomID: string) =>
    request<Participant[]>(`/api/rooms/${roomID}/call-participants`, {}, token),
  uploadRoomImage: async (token: string, roomID: string, image: File, caption: string) => {
    const formData = new FormData();
    formData.set('image', image);
    if (caption.trim()) formData.set('caption', caption.trim());
    return request<Message>(`/api/rooms/${roomID}/images`, { method: 'POST', body: formData }, token);
  },
  liveKitToken: (token: string, roomID: string) =>
    request<{ token: string; livekit_url: string; room_name: string }>(
      `/api/rooms/${roomID}/livekit-token`,
      { method: 'POST' },
      token,
    ),
  searchUsers: (token: string, q: string) =>
    request<Friend[]>(`/api/users/search?q=${encodeURIComponent(q)}`, {}, token),
  listFriends: (token: string) => request<FriendsResponse>('/api/friends', {}, token),
  sendFriendRequest: (token: string, userID: string) =>
    request<{ ok: boolean }>(
      '/api/friends/requests',
      { method: 'POST', body: JSON.stringify({ user_id: userID }) },
      token,
    ),
  acceptFriendRequest: (token: string, requestID: number) =>
    request<{ ok: boolean }>(`/api/friends/requests/${requestID}/accept`, { method: 'POST' }, token),
  listDMRooms: (token: string) => request<Room[]>('/api/dm/rooms', {}, token),
  openDM: (token: string, userID: string) =>
    request<Room>('/api/dm/rooms', { method: 'POST', body: JSON.stringify({ user_id: userID }) }, token),
};
