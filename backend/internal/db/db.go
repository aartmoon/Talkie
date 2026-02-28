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

type Store struct {
	DB *sql.DB
}

type User struct {
	ID           uuid.UUID `json:"id"`
	Email        string    `json:"email"`
	Username     string    `json:"username"`
	EmailVerified bool     `json:"email_verified"`
	PasswordHash string
	CreatedAt    time.Time `json:"created_at"`
}

type Room struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	CreatedBy uuid.UUID `json:"created_by"`
	IsPrivate bool      `json:"is_private"`
	CreatedAt time.Time `json:"created_at"`
}

type Friend struct {
	ID       uuid.UUID `json:"id"`
	Username string    `json:"username"`
	Email    string    `json:"email"`
}

type FriendRequest struct {
	ID          int64     `json:"id"`
	RequesterID uuid.UUID `json:"requester_id"`
	AddresseeID uuid.UUID `json:"addressee_id"`
	Requester   string    `json:"requester_username"`
	Addressee   string    `json:"addressee_username"`
	Status      string    `json:"status"`
	CreatedAt   time.Time `json:"created_at"`
}

type RoomMember struct {
	ID       uuid.UUID `json:"id"`
	Username string    `json:"username"`
}

type RoomInviteLink struct {
	TokenHash string
	RoomID    uuid.UUID
	CreatedBy uuid.UUID
	CreatedAt time.Time
	ExpiresAt time.Time
}

type Message struct {
	ID          int64     `json:"id"`
	RoomID      uuid.UUID `json:"room_id"`
	UserID      uuid.UUID `json:"user_id"`
	Username    string    `json:"username"`
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
		RETURNING id, email, username, email_verified, password_hash, created_at
	`
	var u User
	err := s.DB.QueryRowContext(ctx, query, email, username, passwordHash).
		Scan(&u.ID, &u.Email, &u.Username, &u.EmailVerified, &u.PasswordHash, &u.CreatedAt)
	if err != nil {
		return User{}, err
	}
	return u, nil
}

func (s *Store) FindUserByEmail(ctx context.Context, email string) (User, error) {
	query := `SELECT id, email, username, email_verified, password_hash, created_at FROM users WHERE email = $1`
	var u User
	err := s.DB.QueryRowContext(ctx, query, email).
		Scan(&u.ID, &u.Email, &u.Username, &u.EmailVerified, &u.PasswordHash, &u.CreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, ErrNotFound
		}
		return User{}, err
	}
	return u, nil
}

func (s *Store) FindUserByID(ctx context.Context, id uuid.UUID) (User, error) {
	query := `SELECT id, email, username, email_verified, password_hash, created_at FROM users WHERE id = $1`
	var u User
	err := s.DB.QueryRowContext(ctx, query, id).
		Scan(&u.ID, &u.Email, &u.Username, &u.EmailVerified, &u.PasswordHash, &u.CreatedAt)
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
	if _, err := s.DB.ExecContext(ctx, `INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, r.ID, createdBy); err != nil {
		return Room{}, err
	}
	return r, nil
}

func (s *Store) ListRoomsForUser(ctx context.Context, userID uuid.UUID) ([]Room, error) {
	query := `
		SELECT DISTINCT r.id, r.name, r.created_by, r.is_private, r.created_at
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
		if err := rows.Scan(&r.ID, &r.Name, &r.CreatedBy, &r.IsPrivate, &r.CreatedAt); err != nil {
			return nil, err
		}
		rooms = append(rooms, r)
	}
	return rooms, rows.Err()
}

func (s *Store) JoinRoom(ctx context.Context, roomID, userID uuid.UUID) error {
	query := `INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`
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
	err := s.DB.QueryRowContext(ctx, `SELECT id, name, created_by, is_private, created_at FROM rooms WHERE id = $1`, roomID).
		Scan(&r.ID, &r.Name, &r.CreatedBy, &r.IsPrivate, &r.CreatedAt)
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

func (s *Store) IsDirectRoom(ctx context.Context, roomID uuid.UUID) (bool, error) {
	var exists bool
	err := s.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM direct_rooms WHERE room_id = $1)`, roomID).Scan(&exists)
	return exists, err
}

func (s *Store) ListRoomMembers(ctx context.Context, roomID uuid.UUID) ([]RoomMember, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT u.id, u.username
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
		if err := rows.Scan(&m.ID, &m.Username); err != nil {
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
		SELECT id, username, email
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
		if err := rows.Scan(&f.ID, &f.Username, &f.Email); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (s *Store) ListFriends(ctx context.Context, userID uuid.UUID) ([]Friend, error) {
	query := `
		SELECT u.id, u.username, u.email
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
		if err := rows.Scan(&f.ID, &f.Username, &f.Email); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (s *Store) ListIncomingFriendRequests(ctx context.Context, userID uuid.UUID) ([]FriendRequest, error) {
	query := `
		SELECT fr.id, fr.requester_id, fr.addressee_id, ru.username, au.username, fr.status, fr.created_at
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
		if err := rows.Scan(&fr.ID, &fr.RequesterID, &fr.AddresseeID, &fr.Requester, &fr.Addressee, &fr.Status, &fr.CreatedAt); err != nil {
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
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO friend_requests (requester_id, addressee_id, status)
		VALUES ($1, $2, 'pending')
		ON CONFLICT (requester_id, addressee_id) DO UPDATE SET status = 'pending'
	`, requesterID, addresseeID)
	return err
}

func (s *Store) AcceptFriendRequest(ctx context.Context, reqID int64, userID uuid.UUID) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
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
	if _, err := tx.ExecContext(ctx, `UPDATE friend_requests SET status = 'accepted' WHERE id = $1`, reqID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO friendships (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, requesterID, addresseeID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO friendships (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, addresseeID, requesterID); err != nil {
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
	if _, err := tx.ExecContext(ctx, `INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, r.ID, userA); err != nil {
		return Room{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, r.ID, userB); err != nil {
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
		       r.created_by, r.is_private, r.created_at
		FROM rooms r
		JOIN direct_rooms d ON d.room_id = r.id
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
		if err := rows.Scan(&r.ID, &r.Name, &r.CreatedBy, &r.IsPrivate, &r.CreatedAt); err != nil {
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
	return m, nil
}

func (s *Store) ListMessages(ctx context.Context, roomID uuid.UUID, limit int) ([]Message, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	query := `
		SELECT m.id, m.room_id, m.user_id, u.username, m.content, m.message_type, COALESCE(m.media_url, ''), m.created_at
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
		if err := rows.Scan(&m.ID, &m.RoomID, &m.UserID, &m.Username, &m.Content, &m.MessageType, &m.MediaURL, &m.CreatedAt); err != nil {
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
		RETURNING id, email, username, email_verified, password_hash, created_at
	`, email, tokenHash).Scan(&u.ID, &u.Email, &u.Username, &u.EmailVerified, &u.PasswordHash, &u.CreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, ErrNotFound
		}
		return User{}, err
	}
	return u, nil
}

func (s *Store) CreateRoomInviteLink(ctx context.Context, tokenHash string, roomID, createdBy uuid.UUID, expiresAt time.Time) error {
	_, err := s.DB.ExecContext(ctx, `
		INSERT INTO room_invite_links (token_hash, room_id, created_by, expires_at)
		VALUES ($1, $2, $3, $4)
	`, tokenHash, roomID, createdBy, expiresAt)
	return err
}

func (s *Store) JoinRoomByInviteTokenHash(ctx context.Context, tokenHash string, userID uuid.UUID) (uuid.UUID, error) {
	var roomID uuid.UUID
	err := s.DB.QueryRowContext(ctx, `
		SELECT room_id
		FROM room_invite_links
		WHERE token_hash = $1
		  AND expires_at > NOW()
	`, tokenHash).Scan(&roomID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return uuid.Nil, ErrNotFound
		}
		return uuid.Nil, err
	}
	if err := s.JoinRoom(ctx, roomID, userID); err != nil {
		return uuid.Nil, err
	}
	return roomID, nil
}

func nullableString(v string) any {
	if v == "" {
		return nil
	}
	return v
}
