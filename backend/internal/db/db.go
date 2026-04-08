package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	_ "github.com/jackc/pgx/v5/stdlib"
)

var ErrNotFound = errors.New("not found")
var ErrForbidden = errors.New("forbidden")

type Store struct {
	DB *sql.DB
}

type User struct {
	ID            uuid.UUID `json:"id"`
	Email         string    `json:"email"`
	Username      string    `json:"username"`
	AvatarURL     string    `json:"avatar_url,omitempty"`
	EmailVerified bool      `json:"email_verified"`
	PasswordHash string
	CreatedAt     time.Time `json:"created_at"`
}

type Room struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	CreatedBy   uuid.UUID `json:"created_by"`
	AvatarURL   string    `json:"avatar_url,omitempty"`
	IsPrivate   bool      `json:"is_private"`
	ChannelType string  `json:"channel_type,omitempty"`
	GroupID     uuid.UUID `json:"group_id,omitempty"`
	Position    int       `json:"position,omitempty"`
	MyRole      string    `json:"my_role,omitempty"`
	CanManage   bool      `json:"can_manage,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
}

type GroupChannel struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	ChannelType string    `json:"channel_type"`
	Position    int       `json:"position"`
	CreatedBy   uuid.UUID `json:"created_by"`
	IsPrivate   bool      `json:"is_private"`
	MyRole      string    `json:"my_role,omitempty"`
	CanManage   bool      `json:"can_manage,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
}

type RoomGroup struct {
	ID            uuid.UUID      `json:"id"`
	Name          string         `json:"name"`
	CreatedBy     uuid.UUID      `json:"created_by"`
	CanManage     bool           `json:"can_manage"`
	CreatedAt     time.Time      `json:"created_at"`
	TextChannels  []GroupChannel `json:"text_channels"`
	VoiceChannels []GroupChannel `json:"voice_channels"`
}

type Friend struct {
	ID        uuid.UUID `json:"id"`
	Username  string    `json:"username"`
	Email     string    `json:"email"`
	AvatarURL string    `json:"avatar_url,omitempty"`
}

type FriendRequest struct {
	ID               int64     `json:"id"`
	RequesterID      uuid.UUID `json:"requester_id"`
	AddresseeID      uuid.UUID `json:"addressee_id"`
	Requester        string    `json:"requester_username"`
	RequesterAvatar  string    `json:"requester_avatar_url,omitempty"`
	Addressee        string    `json:"addressee_username"`
	AddresseeAvatar  string    `json:"addressee_avatar_url,omitempty"`
	Status           string    `json:"status"`
	CreatedAt        time.Time `json:"created_at"`
}

type RoomMember struct {
	ID        uuid.UUID `json:"id"`
	Username  string    `json:"username"`
	AvatarURL string    `json:"avatar_url,omitempty"`
}

type RoomInviteLink struct {
	TokenHash string
	RoomID    uuid.UUID
	GroupID   uuid.UUID
	CreatedBy uuid.UUID
	CreatedAt time.Time
	ExpiresAt time.Time
}

type Message struct {
	ID          int64     `json:"id"`
	RoomID      uuid.UUID `json:"room_id"`
	UserID      uuid.UUID `json:"user_id"`
	Username    string    `json:"username"`
	AvatarURL   string    `json:"avatar_url,omitempty"`
	Content     string    `json:"content"`
	MessageType string    `json:"message_type"`
	MediaURL    string    `json:"media_url,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
}

func New(databaseURL string) (*Store, error) {
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	db.SetMaxOpenConns(20)
	db.SetMaxIdleConns(10)
	db.SetConnMaxLifetime(30 * time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("ping db: %w", err)
	}

	return &Store{DB: db}, nil
}

func (s *Store) Close() error {
	return s.DB.Close()
}

func (s *Store) CreateUser(ctx context.Context, email, username, passwordHash string) (User, error) {
	query := `
		INSERT INTO users (email, username, password_hash, email_verified)
		VALUES ($1, $2, $3, FALSE)
		RETURNING id, email, username, COALESCE(avatar_url, ''), email_verified, password_hash, created_at
	`
	var u User
	err := s.DB.QueryRowContext(ctx, query, email, username, passwordHash).
		Scan(&u.ID, &u.Email, &u.Username, &u.AvatarURL, &u.EmailVerified, &u.PasswordHash, &u.CreatedAt)
	if err != nil {
		return User{}, err
	}
	return u, nil
}

func (s *Store) FindUserByEmail(ctx context.Context, email string) (User, error) {
	query := `SELECT id, email, username, COALESCE(avatar_url, ''), email_verified, password_hash, created_at FROM users WHERE email = $1`
	var u User
	err := s.DB.QueryRowContext(ctx, query, email).
		Scan(&u.ID, &u.Email, &u.Username, &u.AvatarURL, &u.EmailVerified, &u.PasswordHash, &u.CreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, ErrNotFound
		}
		return User{}, err
	}
	return u, nil
}

func (s *Store) FindUserByID(ctx context.Context, id uuid.UUID) (User, error) {
	query := `SELECT id, email, username, COALESCE(avatar_url, ''), email_verified, password_hash, created_at FROM users WHERE id = $1`
	var u User
	err := s.DB.QueryRowContext(ctx, query, id).
		Scan(&u.ID, &u.Email, &u.Username, &u.AvatarURL, &u.EmailVerified, &u.PasswordHash, &u.CreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, ErrNotFound
		}
		return User{}, err
	}
	return u, nil
}

func (s *Store) CreateRoom(ctx context.Context, name string, createdBy uuid.UUID, isPrivate bool) (Room, error) {
	isPrivate = true
	query := `
		INSERT INTO rooms (name, created_by, is_private)
		VALUES ($1, $2, $3)
		RETURNING id, name, created_by, is_private, created_at
	`
	var r Room
	err := s.DB.QueryRowContext(ctx, query, name, createdBy, isPrivate).
		Scan(&r.ID, &r.Name, &r.CreatedBy, &r.IsPrivate, &r.CreatedAt)
	if err != nil {
		return Room{}, err
	}
	if _, err := s.DB.ExecContext(ctx, `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`, r.ID, createdBy); err != nil {
		return Room{}, err
	}
	r.MyRole = "admin"
	r.CanManage = true
	return r, nil
}

func (s *Store) ListRoomsForUser(ctx context.Context, userID uuid.UUID) ([]Room, error) {
	query := `
		SELECT DISTINCT r.id, r.name, r.created_by, r.is_private, rm.role, (rm.role = 'admin') AS can_manage, r.created_at
		FROM rooms r
		JOIN room_members rm ON rm.room_id = r.id
		LEFT JOIN direct_rooms d ON d.room_id = r.id
		WHERE d.room_id IS NULL
		  AND rm.user_id = $1
		ORDER BY r.created_at DESC
	`
	rows, err := s.DB.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	rooms := []Room{}
	for rows.Next() {
		var r Room
		if err := rows.Scan(&r.ID, &r.Name, &r.CreatedBy, &r.IsPrivate, &r.MyRole, &r.CanManage, &r.CreatedAt); err != nil {
			return nil, err
		}
		rooms = append(rooms, r)
	}
	return rooms, rows.Err()
}

func (s *Store) ListRoomGroupsForUser(ctx context.Context, userID uuid.UUID) ([]RoomGroup, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT g.id,
		       g.name,
		       g.created_by,
		       g.created_at,
		       (g.created_by = $1 OR EXISTS(
		         SELECT 1
		         FROM group_channels gcx
		         JOIN room_members rmx ON rmx.room_id = gcx.room_id
		         WHERE gcx.group_id = g.id
		           AND rmx.user_id = $1
		           AND rmx.role = 'admin'
		       )) AS group_can_manage,
		       r.id,
		       r.name,
		       gc.channel_type,
		       gc.position,
		       r.created_by,
		       r.is_private,
		       rm.role,
		       (rm.role = 'admin') AS room_can_manage,
		       r.created_at
		FROM room_groups g
		JOIN group_channels gc ON gc.group_id = g.id
		JOIN rooms r ON r.id = gc.room_id
		JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = $1
		LEFT JOIN direct_rooms d ON d.room_id = r.id
		WHERE d.room_id IS NULL
		ORDER BY g.created_at ASC, g.name ASC, gc.channel_type ASC, gc.position ASC, r.created_at ASC
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	byID := make(map[uuid.UUID]*RoomGroup)
	order := make([]uuid.UUID, 0)

	for rows.Next() {
		var (
			groupID        uuid.UUID
			groupName      string
			groupCreatedBy uuid.UUID
			groupCreatedAt time.Time
			groupCanManage bool

			roomID        uuid.UUID
			roomName      string
			channelType   string
			position      int
			roomCreatedBy uuid.UUID
			isPrivate     bool
			myRole        string
			roomCanManage bool
			roomCreatedAt time.Time
		)
		if err := rows.Scan(
			&groupID,
			&groupName,
			&groupCreatedBy,
			&groupCreatedAt,
			&groupCanManage,
			&roomID,
			&roomName,
			&channelType,
			&position,
			&roomCreatedBy,
			&isPrivate,
			&myRole,
			&roomCanManage,
			&roomCreatedAt,
		); err != nil {
			return nil, err
		}

		group := byID[groupID]
		if group == nil {
			group = &RoomGroup{
				ID:            groupID,
				Name:          groupName,
				CreatedBy:     groupCreatedBy,
				CanManage:     groupCanManage,
				CreatedAt:     groupCreatedAt,
				TextChannels:  make([]GroupChannel, 0),
				VoiceChannels: make([]GroupChannel, 0),
			}
			byID[groupID] = group
			order = append(order, groupID)
		}

		channel := GroupChannel{
			ID:          roomID,
			Name:        roomName,
			ChannelType: channelType,
			Position:    position,
			CreatedBy:   roomCreatedBy,
			IsPrivate:   isPrivate,
			MyRole:      myRole,
			CanManage:   roomCanManage,
			CreatedAt:   roomCreatedAt,
		}
		if channelType == "voice" {
			group.VoiceChannels = append(group.VoiceChannels, channel)
		} else {
			group.TextChannels = append(group.TextChannels, channel)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]RoomGroup, 0, len(order))
	for _, id := range order {
		out = append(out, *byID[id])
	}
	return out, nil
}

func (s *Store) CreateRoomGroup(ctx context.Context, name string, createdBy uuid.UUID) (RoomGroup, error) {
	var g RoomGroup
	err := s.DB.QueryRowContext(ctx, `
		INSERT INTO room_groups (name, created_by)
		VALUES ($1, $2)
		RETURNING id, name, created_by, created_at
	`, name, createdBy).Scan(&g.ID, &g.Name, &g.CreatedBy, &g.CreatedAt)
	if err != nil {
		return RoomGroup{}, err
	}
	g.CanManage = true
	g.TextChannels = []GroupChannel{}
	g.VoiceChannels = []GroupChannel{}
	return g, nil
}

func (s *Store) UpdateRoomGroupName(ctx context.Context, groupID uuid.UUID, userID uuid.UUID, name string) error {
	res, err := s.DB.ExecContext(ctx, `
		UPDATE room_groups
		SET name = $3
		WHERE id = $1
		  AND (
		    created_by = $2 OR EXISTS (
		      SELECT 1
		      FROM group_channels gc
		      JOIN room_members rm ON rm.room_id = gc.room_id
		      WHERE gc.group_id = room_groups.id
		        AND rm.user_id = $2
		        AND rm.role = 'admin'
		    )
		  )
	`, groupID, userID, name)
	if err != nil {
		return err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrForbidden
	}
	return nil
}

func (s *Store) CreateGroupChannel(ctx context.Context, groupID uuid.UUID, name, channelType string, createdBy uuid.UUID) (GroupChannel, error) {
	if channelType != "text" && channelType != "voice" {
		return GroupChannel{}, fmt.Errorf("invalid channel type")
	}

	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return GroupChannel{}, err
	}
	defer tx.Rollback()

	var canManage bool
	if err := tx.QueryRowContext(ctx, `
		SELECT (g.created_by = $2 OR EXISTS(
			SELECT 1
			FROM group_channels gc
			JOIN room_members rm ON rm.room_id = gc.room_id
			WHERE gc.group_id = g.id
			  AND rm.user_id = $2
			  AND rm.role = 'admin'
		))
		FROM room_groups g
		WHERE g.id = $1
	`, groupID, createdBy).Scan(&canManage); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return GroupChannel{}, ErrNotFound
		}
		return GroupChannel{}, err
	}
	if !canManage {
		return GroupChannel{}, ErrForbidden
	}

	var position int
	if err := tx.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(position), -1) + 1
		FROM group_channels
		WHERE group_id = $1 AND channel_type = $2
	`, groupID, channelType).Scan(&position); err != nil {
		return GroupChannel{}, err
	}

	var out GroupChannel
	if err := tx.QueryRowContext(ctx, `
		INSERT INTO rooms (name, created_by, is_private)
		VALUES ($1, $2, TRUE)
		RETURNING id, name, created_by, is_private, created_at
	`, name, createdBy).Scan(&out.ID, &out.Name, &out.CreatedBy, &out.IsPrivate, &out.CreatedAt); err != nil {
		return GroupChannel{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO room_members (room_id, user_id, role)
		VALUES ($1, $2, 'admin')
		ON CONFLICT DO NOTHING
	`, out.ID, createdBy); err != nil {
		return GroupChannel{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO group_channels (group_id, room_id, channel_type, position)
		VALUES ($1, $2, $3, $4)
	`, groupID, out.ID, channelType, position); err != nil {
		return GroupChannel{}, err
	}
	if err := tx.Commit(); err != nil {
		return GroupChannel{}, err
	}

	out.ChannelType = channelType
	out.Position = position
	out.MyRole = "admin"
	out.CanManage = true
	return out, nil
}

func (s *Store) JoinRoom(ctx context.Context, roomID, userID uuid.UUID) error {
	query := `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`
	_, err := s.DB.ExecContext(ctx, query, roomID, userID)
	return err
}

func (s *Store) EnsureRoomExists(ctx context.Context, roomID uuid.UUID) error {
	var id uuid.UUID
	err := s.DB.QueryRowContext(ctx, `SELECT id FROM rooms WHERE id = $1`, roomID).Scan(&id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	return nil
}

func (s *Store) GetRoomByID(ctx context.Context, roomID uuid.UUID) (Room, error) {
	var r Room
	err := s.DB.QueryRowContext(ctx, `SELECT id, name, created_by, '' AS avatar_url, is_private, created_at FROM rooms WHERE id = $1`, roomID).
		Scan(&r.ID, &r.Name, &r.CreatedBy, &r.AvatarURL, &r.IsPrivate, &r.CreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Room{}, ErrNotFound
		}
		return Room{}, err
	}
	return r, nil
}

func (s *Store) IsRoomMember(ctx context.Context, roomID, userID uuid.UUID) (bool, error) {
	var exists bool
	err := s.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2)`, roomID, userID).Scan(&exists)
	return exists, err
}

func (s *Store) IsRoomAdmin(ctx context.Context, roomID, userID uuid.UUID) (bool, error) {
	var isAdmin bool
	err := s.DB.QueryRowContext(ctx, `
		SELECT EXISTS(
			SELECT 1
			FROM room_members
			WHERE room_id = $1 AND user_id = $2 AND role = 'admin'
		)
	`, roomID, userID).Scan(&isAdmin)
	return isAdmin, err
}

func (s *Store) GetRoomForUser(ctx context.Context, roomID, userID uuid.UUID) (Room, error) {
	var r Room
	err := s.DB.QueryRowContext(ctx, `
		SELECT r.id, r.name, r.created_by, '' AS avatar_url, r.is_private, rm.role, (rm.role = 'admin') AS can_manage, r.created_at
		FROM rooms r
		JOIN room_members rm ON rm.room_id = r.id
		WHERE r.id = $1 AND rm.user_id = $2
	`, roomID, userID).Scan(&r.ID, &r.Name, &r.CreatedBy, &r.AvatarURL, &r.IsPrivate, &r.MyRole, &r.CanManage, &r.CreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Room{}, ErrNotFound
		}
		return Room{}, err
	}
	return r, nil
}

func (s *Store) UpdateRoomName(ctx context.Context, roomID uuid.UUID, name string) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE rooms SET name = $2 WHERE id = $1`, roomID, name)
	return err
}

func (s *Store) DeleteRoom(ctx context.Context, roomID uuid.UUID) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM rooms WHERE id = $1`, roomID)
	return err
}

func (s *Store) LeaveRoom(ctx context.Context, roomID, userID uuid.UUID) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var role string
	if err := tx.QueryRowContext(ctx, `
		SELECT role
		FROM room_members
		WHERE room_id = $1 AND user_id = $2
		FOR UPDATE
	`, roomID, userID).Scan(&role); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM room_members WHERE room_id = $1 AND user_id = $2`, roomID, userID); err != nil {
		return err
	}

	var membersLeft int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM room_members WHERE room_id = $1`, roomID).Scan(&membersLeft); err != nil {
		return err
	}
	if membersLeft == 0 {
		if _, err := tx.ExecContext(ctx, `DELETE FROM rooms WHERE id = $1`, roomID); err != nil {
			return err
		}
		return tx.Commit()
	}

	if role == "admin" {
		var adminsLeft int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM room_members WHERE room_id = $1 AND role = 'admin'`, roomID).Scan(&adminsLeft); err != nil {
			return err
		}
		if adminsLeft == 0 {
			if _, err := tx.ExecContext(ctx, `
				UPDATE room_members
				SET role = 'admin'
				WHERE room_id = $1
				  AND user_id = (
					SELECT user_id
					FROM room_members
					WHERE room_id = $1
					ORDER BY joined_at ASC
					LIMIT 1
				  )
			`, roomID); err != nil {
				return err
			}
		}
	}

	return tx.Commit()
}

func (s *Store) IsDirectRoom(ctx context.Context, roomID uuid.UUID) (bool, error) {
	var exists bool
	err := s.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM direct_rooms WHERE room_id = $1)`, roomID).Scan(&exists)
	return exists, err
}

func (s *Store) ListRoomMembers(ctx context.Context, roomID uuid.UUID) ([]RoomMember, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT u.id, u.username, COALESCE(u.avatar_url, '')
		FROM room_members rm
		JOIN users u ON u.id = rm.user_id
		WHERE rm.room_id = $1
		ORDER BY u.username ASC
	`, roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]RoomMember, 0)
	for rows.Next() {
		var m RoomMember
		if err := rows.Scan(&m.ID, &m.Username, &m.AvatarURL); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) SearchUsers(ctx context.Context, selfID uuid.UUID, q string, limit int) ([]Friend, error) {
	if limit <= 0 || limit > 20 {
		limit = 10
	}
	query := `
		SELECT id, username, email, COALESCE(avatar_url, '')
		FROM users
		WHERE id <> $1 AND (username ILIKE $2 OR email ILIKE $2)
		ORDER BY username ASC
		LIMIT $3
	`
	rows, err := s.DB.QueryContext(ctx, query, selfID, "%"+q+"%", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Friend, 0)
	for rows.Next() {
		var f Friend
		if err := rows.Scan(&f.ID, &f.Username, &f.Email, &f.AvatarURL); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (s *Store) ListFriends(ctx context.Context, userID uuid.UUID) ([]Friend, error) {
	query := `
		SELECT u.id, u.username, u.email, COALESCE(u.avatar_url, '')
		FROM friendships f
		JOIN users u ON u.id = f.friend_id
		WHERE f.user_id = $1
		ORDER BY u.username ASC
	`
	rows, err := s.DB.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Friend, 0)
	for rows.Next() {
		var f Friend
		if err := rows.Scan(&f.ID, &f.Username, &f.Email, &f.AvatarURL); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (s *Store) IsFriend(ctx context.Context, userID, targetID uuid.UUID) (bool, error) {
	var exists bool
	if err := s.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM friendships WHERE user_id = $1 AND friend_id = $2)`, userID, targetID).Scan(&exists); err != nil {
		return false, err
	}
	return exists, nil
}

func (s *Store) ListIncomingFriendRequests(ctx context.Context, userID uuid.UUID) ([]FriendRequest, error) {
	query := `
		SELECT fr.id, fr.requester_id, fr.addressee_id, ru.username, COALESCE(ru.avatar_url, ''), au.username, COALESCE(au.avatar_url, ''), fr.status, fr.created_at
		FROM friend_requests fr
		JOIN users ru ON ru.id = fr.requester_id
		JOIN users au ON au.id = fr.addressee_id
		WHERE fr.addressee_id = $1 AND fr.status = 'pending'
		ORDER BY fr.created_at DESC
	`
	rows, err := s.DB.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]FriendRequest, 0)
	for rows.Next() {
		var fr FriendRequest
		if err := rows.Scan(&fr.ID, &fr.RequesterID, &fr.AddresseeID, &fr.Requester, &fr.RequesterAvatar, &fr.Addressee, &fr.AddresseeAvatar, &fr.Status, &fr.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, fr)
	}
	return out, rows.Err()
}

func (s *Store) CreateFriendRequest(ctx context.Context, requesterID, addresseeID uuid.UUID) error {
	if requesterID == addresseeID {
		return fmt.Errorf("cannot add self")
	}
	var exists bool
	if err := s.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM friendships WHERE user_id = $1 AND friend_id = $2)`, requesterID, addresseeID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}
	var reqID int64
	err := s.DB.QueryRowContext(ctx, `
		INSERT INTO friend_requests (requester_id, addressee_id, status)
		VALUES ($1, $2, 'pending')
		ON CONFLICT (requester_id, addressee_id) DO UPDATE
		SET status = 'pending',
		    created_at = NOW()
		WHERE friend_requests.status <> 'rejected'
		   OR friend_requests.created_at <= NOW() - INTERVAL '24 hours'
		RETURNING id
	`, requesterID, addresseeID).Scan(&reqID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("friend request cooldown is active for 24 hours")
		}
		return err
	}
	return nil
}

func (s *Store) AcceptFriendRequest(ctx context.Context, reqID int64, userID uuid.UUID) (uuid.UUID, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return uuid.Nil, err
	}
	defer tx.Rollback()

	var requesterID, addresseeID uuid.UUID
	var status string
	if err := tx.QueryRowContext(ctx, `
		SELECT requester_id, addressee_id, status
		FROM friend_requests
		WHERE id = $1
		FOR UPDATE
	`, reqID).Scan(&requesterID, &addresseeID, &status); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return uuid.Nil, ErrNotFound
		}
		return uuid.Nil, err
	}
	if addresseeID != userID {
		return uuid.Nil, ErrNotFound
	}
	if status != "pending" {
		return requesterID, nil
	}
	if _, err := tx.ExecContext(ctx, `UPDATE friend_requests SET status = 'accepted' WHERE id = $1`, reqID); err != nil {
		return uuid.Nil, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO friendships (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, requesterID, addresseeID); err != nil {
		return uuid.Nil, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO friendships (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, addresseeID, requesterID); err != nil {
		return uuid.Nil, err
	}
	if err := tx.Commit(); err != nil {
		return uuid.Nil, err
	}
	return requesterID, nil
}

func (s *Store) DeclineFriendRequest(ctx context.Context, reqID int64, userID uuid.UUID) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var addresseeID uuid.UUID
	var status string
	if err := tx.QueryRowContext(ctx, `
		SELECT addressee_id, status
		FROM friend_requests
		WHERE id = $1
		FOR UPDATE
	`, reqID).Scan(&addresseeID, &status); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if addresseeID != userID {
		return ErrNotFound
	}
	if status != "pending" {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `UPDATE friend_requests SET status = 'rejected', created_at = NOW() WHERE id = $1`, reqID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) GetOrCreateDirectRoom(ctx context.Context, a, b uuid.UUID) (Room, error) {
	if a == b {
		return Room{}, fmt.Errorf("cannot dm self")
	}
	userA, userB := a, b
	if strings.Compare(userA.String(), userB.String()) > 0 {
		userA, userB = userB, userA
	}

	var roomID uuid.UUID
	err := s.DB.QueryRowContext(ctx, `SELECT room_id FROM direct_rooms WHERE user_a = $1 AND user_b = $2`, userA, userB).Scan(&roomID)
	if err == nil {
		return s.GetRoomByID(ctx, roomID)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Room{}, err
	}

	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Room{}, err
	}
	defer tx.Rollback()

	name := "dm-" + userA.String()[:8] + "-" + userB.String()[:8]
	var r Room
	if err := tx.QueryRowContext(ctx, `
		INSERT INTO rooms (name, created_by, is_private)
		VALUES ($1, $2, true)
		RETURNING id, name, created_by, is_private, created_at
	`, name, userA).Scan(&r.ID, &r.Name, &r.CreatedBy, &r.IsPrivate, &r.CreatedAt); err != nil {
		return Room{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO direct_rooms (room_id, user_a, user_b)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_a, user_b) DO NOTHING
	`, r.ID, userA, userB); err != nil {
		return Room{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`, r.ID, userA); err != nil {
		return Room{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, r.ID, userB); err != nil {
		return Room{}, err
	}
	if err := tx.Commit(); err != nil {
		return Room{}, err
	}
	return r, nil
}

func (s *Store) ListDirectRoomsForUser(ctx context.Context, userID uuid.UUID) ([]Room, error) {
	query := `
		SELECT r.id,
		       CASE WHEN d.user_a = $1 THEN ub.username ELSE ua.username END AS dm_name,
		       r.created_by,
		       CASE WHEN d.user_a = $1 THEN COALESCE(ub.avatar_url, '') ELSE COALESCE(ua.avatar_url, '') END AS dm_avatar_url,
		       r.is_private, rm.role, (rm.role = 'admin') AS can_manage, r.created_at
		FROM rooms r
		JOIN direct_rooms d ON d.room_id = r.id
		JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = $1
		JOIN users ua ON ua.id = d.user_a
		JOIN users ub ON ub.id = d.user_b
		WHERE d.user_a = $1 OR d.user_b = $1
		ORDER BY r.created_at DESC
	`
	rows, err := s.DB.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Room, 0)
	for rows.Next() {
		var r Room
		if err := rows.Scan(&r.ID, &r.Name, &r.CreatedBy, &r.AvatarURL, &r.IsPrivate, &r.MyRole, &r.CanManage, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) SaveMessage(ctx context.Context, roomID, userID uuid.UUID, content string) (Message, error) {
	return s.SaveMessageWithType(ctx, roomID, userID, content, "text", "")
}

func (s *Store) SaveMessageWithType(ctx context.Context, roomID, userID uuid.UUID, content, messageType, mediaURL string) (Message, error) {
	if messageType == "" {
		messageType = "text"
	}
	query := `
		INSERT INTO messages (room_id, user_id, content, message_type, media_url)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, room_id, user_id, content, message_type, COALESCE(media_url, ''), created_at
	`
	var m Message
	err := s.DB.QueryRowContext(ctx, query, roomID, userID, content, messageType, nullableString(mediaURL)).
		Scan(&m.ID, &m.RoomID, &m.UserID, &m.Content, &m.MessageType, &m.MediaURL, &m.CreatedAt)
	if err != nil {
		return Message{}, err
	}

	u, err := s.FindUserByID(ctx, userID)
	if err != nil {
		return Message{}, err
	}
	m.Username = u.Username
	m.AvatarURL = u.AvatarURL
	return m, nil
}

func (s *Store) ListMessages(ctx context.Context, roomID uuid.UUID, limit int) ([]Message, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	query := `
		SELECT m.id, m.room_id, m.user_id, u.username, COALESCE(u.avatar_url, ''), m.content, m.message_type, COALESCE(m.media_url, ''), m.created_at
		FROM messages m
		JOIN users u ON u.id = m.user_id
		WHERE m.room_id = $1
		ORDER BY m.created_at DESC
		LIMIT $2
	`
	rows, err := s.DB.QueryContext(ctx, query, roomID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	messages := []Message{}
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.RoomID, &m.UserID, &m.Username, &m.AvatarURL, &m.Content, &m.MessageType, &m.MediaURL, &m.CreatedAt); err != nil {
			return nil, err
		}
		messages = append(messages, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}
	return messages, nil
}

func (s *Store) SetEmailVerificationToken(ctx context.Context, userID uuid.UUID, tokenHash string, sentAt time.Time) error {
	_, err := s.DB.ExecContext(ctx, `
		UPDATE users
		SET email_verification_token_hash = $2, email_verification_sent_at = $3
		WHERE id = $1
	`, userID, tokenHash, sentAt)
	return err
}

func (s *Store) SetPasswordResetToken(ctx context.Context, userID uuid.UUID, tokenHash string, sentAt time.Time) error {
	_, err := s.DB.ExecContext(ctx, `
		UPDATE users
		SET password_reset_token_hash = $2, password_reset_sent_at = $3
		WHERE id = $1
	`, userID, tokenHash, sentAt)
	return err
}

func (s *Store) VerifyUserByEmailAndTokenHash(ctx context.Context, email, tokenHash string) (User, error) {
	var u User
	err := s.DB.QueryRowContext(ctx, `
		UPDATE users
		SET email_verified = TRUE,
		    email_verification_token_hash = NULL
		WHERE email = $1
		  AND email_verification_token_hash = $2
		  AND email_verification_sent_at IS NOT NULL
		  AND email_verification_sent_at >= NOW() - INTERVAL '24 hours'
		RETURNING id, email, username, COALESCE(avatar_url, ''), email_verified, password_hash, created_at
	`, email, tokenHash).Scan(&u.ID, &u.Email, &u.Username, &u.AvatarURL, &u.EmailVerified, &u.PasswordHash, &u.CreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, ErrNotFound
		}
		return User{}, err
	}
	return u, nil
}

func (s *Store) ResetPasswordByTokenHash(ctx context.Context, tokenHash, passwordHash string) error {
	res, err := s.DB.ExecContext(ctx, `
		UPDATE users
		SET password_hash = $2,
		    password_reset_token_hash = NULL
		WHERE password_reset_token_hash = $1
		  AND password_reset_sent_at IS NOT NULL
		  AND password_reset_sent_at >= NOW() - INTERVAL '2 hours'
	`, tokenHash, passwordHash)
	if err != nil {
		return err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) FindRoomInviteLinkByCreator(ctx context.Context, roomID, createdBy uuid.UUID) (string, time.Time, error) {
	var token string
	var expiresAt time.Time
	err := s.DB.QueryRowContext(ctx, `
		SELECT token, expires_at
		FROM room_invite_links
		WHERE room_id = $1
		  AND created_by = $2
		  AND token IS NOT NULL
		ORDER BY created_at DESC
		LIMIT 1
	`, roomID, createdBy).Scan(&token, &expiresAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", time.Time{}, ErrNotFound
		}
		return "", time.Time{}, err
	}
	return token, expiresAt, nil
}

func (s *Store) FindGroupInviteLinkByCreator(ctx context.Context, groupID, createdBy uuid.UUID) (string, time.Time, error) {
	var token string
	var expiresAt time.Time
	err := s.DB.QueryRowContext(ctx, `
		SELECT token, expires_at
		FROM room_invite_links
		WHERE group_id = $1
		  AND created_by = $2
		  AND token IS NOT NULL
		ORDER BY created_at DESC
		LIMIT 1
	`, groupID, createdBy).Scan(&token, &expiresAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", time.Time{}, ErrNotFound
		}
		return "", time.Time{}, err
	}
	return token, expiresAt, nil
}

func (s *Store) CreateRoomInviteLink(ctx context.Context, rawToken, tokenHash string, roomID, createdBy uuid.UUID, expiresAt time.Time) error {
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO room_invite_links (token, token_hash, room_id, group_id, created_by, expires_at)
		VALUES ($1, $2, $3, NULL, $4, $5)
	`, rawToken, tokenHash, roomID, createdBy, expiresAt)
	return err
}

func (s *Store) CreateGroupInviteLink(ctx context.Context, rawToken, tokenHash string, groupID, createdBy uuid.UUID, expiresAt time.Time) error {
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO room_invite_links (token, token_hash, room_id, group_id, created_by, expires_at)
		VALUES ($1, $2, NULL, $3, $4, $5)
	`, rawToken, tokenHash, groupID, createdBy, expiresAt)
	return err
}

func (s *Store) GetGroupIDByRoomID(ctx context.Context, roomID uuid.UUID) (uuid.UUID, error) {
	var groupID uuid.UUID
	err := s.DB.QueryRowContext(ctx, `
		SELECT group_id
		FROM group_channels
		WHERE room_id = $1
	`, roomID).Scan(&groupID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return uuid.Nil, ErrNotFound
		}
		return uuid.Nil, err
	}
	return groupID, nil
}

func (s *Store) JoinRoomByInviteTokenHash(ctx context.Context, tokenHash string, userID uuid.UUID) (uuid.UUID, error) {
	var roomIDText sql.NullString
	var groupIDText sql.NullString
	err := s.DB.QueryRowContext(ctx, `
		SELECT room_id::text, group_id::text
		FROM room_invite_links
		WHERE token_hash = $1
		  AND expires_at > NOW()
	`, tokenHash).Scan(&roomIDText, &groupIDText)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return uuid.Nil, ErrNotFound
		}
		return uuid.Nil, err
	}

	if roomIDText.Valid {
		roomID, parseErr := uuid.Parse(roomIDText.String)
		if parseErr != nil {
			return uuid.Nil, parseErr
		}
		if err := s.JoinRoom(ctx, roomID, userID); err != nil {
			return uuid.Nil, err
		}
		return roomID, nil
	}

	if !groupIDText.Valid {
		return uuid.Nil, ErrNotFound
	}
	groupID, parseErr := uuid.Parse(groupIDText.String)
	if parseErr != nil {
		return uuid.Nil, parseErr
	}

	rows, err := s.DB.QueryContext(ctx, `
		SELECT gc.room_id
		FROM group_channels gc
		JOIN rooms r ON r.id = gc.room_id
		LEFT JOIN direct_rooms d ON d.room_id = r.id
		WHERE gc.group_id = $1
		  AND d.room_id IS NULL
		ORDER BY CASE WHEN gc.channel_type = 'text' THEN 0 ELSE 1 END, gc.position ASC, r.created_at ASC
	`, groupID)
	if err != nil {
		return uuid.Nil, err
	}
	defer rows.Close()

	var firstRoomID uuid.UUID
	found := false
	for rows.Next() {
		var channelRoomID uuid.UUID
		if err := rows.Scan(&channelRoomID); err != nil {
			return uuid.Nil, err
		}
		if !found {
			firstRoomID = channelRoomID
			found = true
		}
		if err := s.JoinRoom(ctx, channelRoomID, userID); err != nil {
			return uuid.Nil, err
		}
	}
	if err := rows.Err(); err != nil {
		return uuid.Nil, err
	}
	if !found {
		return uuid.Nil, ErrNotFound
	}
	return firstRoomID, nil
}

func (s *Store) FindFriendInviteLinkByCreator(ctx context.Context, createdBy uuid.UUID) (string, time.Time, error) {
	var token string
	var expiresAt time.Time
	err := s.DB.QueryRowContext(ctx, `
		SELECT token, expires_at
		FROM friend_invite_links
		WHERE created_by = $1
		  AND token IS NOT NULL
		ORDER BY created_at DESC
		LIMIT 1
	`, createdBy).Scan(&token, &expiresAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", time.Time{}, ErrNotFound
		}
		return "", time.Time{}, err
	}
	return token, expiresAt, nil
}

func (s *Store) CreateFriendInviteLink(ctx context.Context, rawToken, tokenHash string, createdBy uuid.UUID, expiresAt time.Time) error {
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO friend_invite_links (token, token_hash, created_by, expires_at)
		VALUES ($1, $2, $3, $4)
	`, rawToken, tokenHash, createdBy, expiresAt)
	return err
}

func (s *Store) AddFriendByInviteTokenHash(ctx context.Context, tokenHash string, userID uuid.UUID) (Friend, error) {
	var inviterID uuid.UUID
	err := s.DB.QueryRowContext(ctx, `
		SELECT created_by
		FROM friend_invite_links
		WHERE token_hash = $1
		  AND expires_at > NOW()
	`, tokenHash).Scan(&inviterID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Friend{}, ErrNotFound
		}
		return Friend{}, err
	}
	if inviterID == userID {
		return Friend{}, fmt.Errorf("cannot add self")
	}
	if _, err := s.DB.ExecContext(ctx, `INSERT INTO friendships (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, inviterID, userID); err != nil {
		return Friend{}, err
	}
	if _, err := s.DB.ExecContext(ctx, `INSERT INTO friendships (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, userID, inviterID); err != nil {
		return Friend{}, err
	}
	var f Friend
	if err := s.DB.QueryRowContext(ctx, `SELECT id, username, email, COALESCE(avatar_url, '') FROM users WHERE id = $1`, inviterID).Scan(&f.ID, &f.Username, &f.Email, &f.AvatarURL); err != nil {
		return Friend{}, err
	}
	return f, nil
}

func (s *Store) UpdateUserAvatar(ctx context.Context, userID uuid.UUID, avatarURL string) error {
	_, err := s.DB.ExecContext(ctx, `
		UPDATE users
		SET avatar_url = $2
		WHERE id = $1
	`, userID, nullableString(strings.TrimSpace(avatarURL)))
	return err
}

func nullableString(v string) any {
	if v == "" {
		return nil
	}
	return v
}
