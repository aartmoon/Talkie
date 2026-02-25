package ws

import (
	"context"
	"log"
	"time"

	"talkie/backend/internal/db"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
)

type Client struct {
	Conn     *websocket.Conn
	Hub      *Hub
	Store    *db.Store
	RoomID   uuid.UUID
	UserID   uuid.UUID
	Username string
	InCall   bool
	Send     chan OutgoingMessage
}

func (c *Client) Close() {
	_ = c.Conn.Close()
}

func (c *Client) ReadPump() {
	defer func() {
		c.Hub.Remove(c)
		members, err := c.Store.ListRoomMembers(context.Background(), c.RoomID)
		if err == nil {
			participants := make([]Participant, 0, len(members))
			for _, m := range members {
				participants = append(participants, Participant{ID: m.ID.String(), Username: m.Username})
			}
			c.Hub.Broadcast(c.RoomID, OutgoingMessage{Type: "participants", Participants: participants})
		}
		c.Hub.Broadcast(c.RoomID, OutgoingMessage{Type: "call_participants", CallUsers: c.Hub.CallParticipants(c.RoomID)})
		_ = c.Conn.Close()
	}()

	c.Conn.SetReadLimit(4096)
	_ = c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		return c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		var incoming IncomingMessage
		if err := c.Conn.ReadJSON(&incoming); err != nil {
			break
		}
		if incoming.Type != "chat" || incoming.Content == "" {
			switch incoming.Type {
			case "call_join":
				if !c.InCall {
					c.InCall = true
					c.Hub.SetInCall(c, true)
					c.Hub.Broadcast(c.RoomID, OutgoingMessage{Type: "call_participants", CallUsers: c.Hub.CallParticipants(c.RoomID)})
				}
			case "call_leave":
				if c.InCall {
					c.InCall = false
					c.Hub.SetInCall(c, false)
					c.Hub.Broadcast(c.RoomID, OutgoingMessage{Type: "call_participants", CallUsers: c.Hub.CallParticipants(c.RoomID)})
				}
			}
			continue
		}

		msg, err := c.Store.SaveMessage(context.Background(), c.RoomID, c.UserID, incoming.Content)
		if err != nil {
			log.Printf("save message failed: %v", err)
			continue
		}

		c.Hub.Broadcast(c.RoomID, OutgoingMessage{
			Type:    "chat",
			Message: ptrPayload(PayloadFromMessage(msg)),
		})
	}
}

func ptrPayload(p MessagePayload) *MessagePayload {
	return &p
}

func (c *Client) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		_ = c.Conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.Send:
			_ = c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.Conn.WriteJSON(msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
