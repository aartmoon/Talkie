package httpapi

import (
	"net/http"
	"time"

	"talkie/backend/internal/auth"
	"talkie/backend/internal/ws"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

func (s *Server) roomWebSocket(w http.ResponseWriter, r *http.Request) {
	tokenString := r.URL.Query().Get("token")
	if tokenString == "" {
		jsonError(w, http.StatusUnauthorized, "missing token")
		return
	}
	claims, err := auth.ParseJWT(s.Cfg.JWTSecret, tokenString)
	if err != nil {
		jsonError(w, http.StatusUnauthorized, "invalid token")
		return
	}
	userID, err := uuid.Parse(claims.UserID)
	if err != nil {
		jsonError(w, http.StatusUnauthorized, "invalid token payload")
		return
	}
	roomID, err := uuid.Parse(chi.URLParam(r, "roomID"))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "invalid room id")
		return
	}

	if _, err := s.Store.GetRoomByID(r.Context(), roomID); err != nil {
		jsonError(w, http.StatusNotFound, "room not found")
		return
	}
	member, err := s.Store.IsRoomMember(r.Context(), roomID, userID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to check membership")
		return
	}
	if !member {
		jsonError(w, http.StatusForbidden, "forbidden")
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	c := &ws.Client{
		Conn:     conn,
		Hub:      s.Hub,
		Store:    s.Store,
		RoomID:   roomID,
		UserID:   userID,
		Username: claims.Username,
		Send:     make(chan ws.OutgoingMessage, 64),
	}
	s.Hub.Add(c)

	members, err := s.Store.ListRoomMembers(r.Context(), roomID)
	if err == nil {
		participants := make([]ws.Participant, 0, len(members))
		for _, m := range members {
			participants = append(participants, ws.Participant{ID: m.ID.String(), Username: m.Username})
		}
		s.Hub.Broadcast(roomID, ws.OutgoingMessage{Type: "participants", Participants: participants})
	}

	history, err := s.Store.ListMessages(r.Context(), roomID, 50)
	if err == nil {
		payload := make([]ws.MessagePayload, 0, len(history))
		for _, m := range history {
			payload = append(payload, ws.PayloadFromMessage(m))
		}
		c.Send <- ws.OutgoingMessage{Type: "history", Messages: payload}
	}

	c.Send <- ws.OutgoingMessage{Type: "call_participants", CallUsers: s.Hub.CallParticipants(roomID)}

	go c.WritePump()
	go c.ReadPump()

	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
}
