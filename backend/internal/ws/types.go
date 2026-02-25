package ws

import (
	"talkie/backend/internal/db"
	"time"
)

type IncomingMessage struct {
	Type    string `json:"type"`
	Content string `json:"content"`
}

type OutgoingMessage struct {
	Type         string           `json:"type"`
	Message      *MessagePayload  `json:"message,omitempty"`
	Participants []Participant    `json:"participants,omitempty"`
	CallUsers    []Participant    `json:"call_users,omitempty"`
	Messages     []MessagePayload `json:"messages,omitempty"`
}

type MessagePayload struct {
	ID          int64     `json:"id"`
	RoomID      string    `json:"room_id"`
	UserID      string    `json:"user_id"`
	Username    string    `json:"username"`
	Content     string    `json:"content"`
	MessageType string    `json:"message_type"`
	MediaURL    string    `json:"media_url,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
}

type Participant struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}

func PayloadFromMessage(m db.Message) MessagePayload {
	return MessagePayload{
		ID:          m.ID,
		RoomID:      m.RoomID.String(),
		UserID:      m.UserID.String(),
		Username:    m.Username,
		Content:     m.Content,
		MessageType: m.MessageType,
		MediaURL:    m.MediaURL,
		CreatedAt:   m.CreatedAt,
	}
}
