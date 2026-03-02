package ws

import (
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

type NotificationClient struct {
	Conn   *websocket.Conn
	Hub    *Hub
	UserID uuid.UUID
	Send   chan OutgoingMessage
}

func (c *NotificationClient) Close() {
	_ = c.Conn.Close()
}

func (c *NotificationClient) ReadPump() {
	defer func() {
		c.Hub.RemoveUserEvents(c)
		_ = c.Conn.Close()
	}()

	c.Conn.SetReadLimit(1024)
	_ = c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		return c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		if _, _, err := c.Conn.ReadMessage(); err != nil {
			break
		}
	}
}

func (c *NotificationClient) WritePump() {
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
