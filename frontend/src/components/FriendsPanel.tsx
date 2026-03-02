import type { FormEvent } from 'react';
import type { Friend, FriendsResponse } from '../lib/types';

type FriendsPanelProps = {
  creatingFriendInvite: boolean;
  copyNotice: string | null;
  friendsData: FriendsResponse;
  sentFriendRequests: Record<string, boolean>;
  userSearchQuery: string;
  userSearchResults: Friend[];
  onAddFriend: (userID: string) => void;
  onAcceptFriend: (requestID: number) => void;
  onDeclineFriend: (requestID: number) => void;
  onGenerateFriendInviteLink: () => void;
  onOpenDMWith: (userID: string) => void;
  onOpenProfile: (userID: string, username: string) => void;
  onSearchChange: (nextQuery: string) => void;
  onSearchSubmit: (e: FormEvent) => void;
};

export function FriendsPanel({
  creatingFriendInvite,
  copyNotice,
  friendsData,
  sentFriendRequests,
  userSearchQuery,
  userSearchResults,
  onAddFriend,
  onAcceptFriend,
  onDeclineFriend,
  onGenerateFriendInviteLink,
  onOpenDMWith,
  onOpenProfile,
  onSearchChange,
  onSearchSubmit,
}: FriendsPanelProps) {
  return (
    <div className="friends-panel">
      <div className="participants invite-panel">
        <strong>Быстрое добавление в друзья</strong>
        <button type="button" onClick={onGenerateFriendInviteLink} disabled={creatingFriendInvite}>
          {creatingFriendInvite ? 'Создаем...' : 'Ссылка-приглашение'}
        </button>
        {copyNotice && <small className="copy-notice">{copyNotice}</small>}
      </div>
      <form onSubmit={onSearchSubmit} className="new-room-form">
        <input
          placeholder="Найти пользователя по имени/email"
          value={userSearchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        <button type="submit">Найти</button>
      </form>
      <ul className="room-list">
        {userSearchResults.map((f) => (
          <li key={f.id}>
            <button
              onClick={() => onAddFriend(f.id)}
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
              <button
                type="button"
                className="msg-user-btn participant-name"
                onClick={() => onOpenProfile(fr.requester_id, fr.requester_username)}
              >
                {fr.requester_username}
              </button>
              <button type="button" onClick={() => onAcceptFriend(fr.id)}>Принять</button>
              <button type="button" className="ghost" onClick={() => onDeclineFriend(fr.id)}>Отклонить</button>
            </li>
          ))}
        </ul>
      </div>
      <div className="participants">
        <strong>Друзья</strong>
        <ul className="participant-list">
          {friendsData.friends.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                className="msg-user-btn participant-name"
                onClick={() => onOpenProfile(f.id, f.username)}
              >
                {f.username}
              </button>
              <button type="button" onClick={() => onOpenDMWith(f.id)}>Написать</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
