export type User = {
  id: string;
  email: string;
  username: string;
  email_verified?: boolean;
  created_at: string;
};

export type Room = {
  id: string;
  name: string;
  created_by: string;
  is_private?: boolean;
  channel_type?: 'text' | 'voice';
  group_id?: string;
  position?: number;
  my_role?: 'admin' | 'member';
  can_manage?: boolean;
  created_at: string;
};

export type Message = {
  id: number;
  room_id: string;
  user_id: string;
  username: string;
  content: string;
  message_type: 'text' | 'image';
  media_url?: string;
  created_at: string;
};

export type Participant = {
  id: string;
  username: string;
};

export type Friend = {
  id: string;
  username: string;
  email: string;
};

export type FriendRequest = {
  id: number;
  requester_id: string;
  addressee_id: string;
  requester_username: string;
  addressee_username: string;
  status: 'pending' | 'accepted' | 'rejected';
  created_at: string;
};

export type FriendsResponse = {
  friends: Friend[];
  incoming: FriendRequest[];
};

export type UserProfile = {
  id: string;
  username: string;
  created_at: string;
  is_friend: boolean;
};

export type GroupChannel = {
  id: string;
  name: string;
  channel_type: 'text' | 'voice';
  position: number;
  created_by: string;
  is_private: boolean;
  my_role?: 'admin' | 'member';
  can_manage?: boolean;
  created_at: string;
};

export type RoomGroup = {
  id: string;
  name: string;
  created_by: string;
  can_manage: boolean;
  created_at: string;
  text_channels: GroupChannel[];
  voice_channels: GroupChannel[];
};
