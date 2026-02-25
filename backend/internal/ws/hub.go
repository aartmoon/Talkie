package ws

import (
	"sync"

	"github.com/google/uuid"
)

type Hub struct {
	mu         sync.RWMutex
	rooms      map[uuid.UUID]map[*Client]struct{}
	callCounts map[uuid.UUID]map[uuid.UUID]int
	callUsers  map[uuid.UUID]map[uuid.UUID]Participant
}

func NewHub() *Hub {
	return &Hub{
		rooms:      make(map[uuid.UUID]map[*Client]struct{}),
		callCounts: make(map[uuid.UUID]map[uuid.UUID]int),
		callUsers:  make(map[uuid.UUID]map[uuid.UUID]Participant),
	}
}

func (h *Hub) Add(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.rooms[c.RoomID]; !ok {
		h.rooms[c.RoomID] = make(map[*Client]struct{})
	}
	h.rooms[c.RoomID][c] = struct{}{}
}

func (h *Hub) Remove(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	clients, ok := h.rooms[c.RoomID]
	if !ok {
		return
	}
	delete(clients, c)
	h.removeCallLocked(c.RoomID, c.UserID)
	if len(clients) == 0 {
		delete(h.rooms, c.RoomID)
	}
}

func (h *Hub) Broadcast(roomID uuid.UUID, payload OutgoingMessage) {
	h.mu.RLock()
	clients := h.rooms[roomID]
	h.mu.RUnlock()

	for c := range clients {
		select {
		case c.Send <- payload:
		default:
			c.Close()
		}
	}
}

func (h *Hub) Participants(roomID uuid.UUID) []Participant {
	h.mu.RLock()
	defer h.mu.RUnlock()
	clients := h.rooms[roomID]
	participants := make([]Participant, 0, len(clients))
	for c := range clients {
		participants = append(participants, Participant{ID: c.UserID.String(), Username: c.Username})
	}
	return participants
}

func (h *Hub) SetInCall(c *Client, inCall bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if inCall {
		h.addCallLocked(c.RoomID, c.UserID, c.Username)
		return
	}
	h.removeCallLocked(c.RoomID, c.UserID)
}

func (h *Hub) CallParticipants(roomID uuid.UUID) []Participant {
	h.mu.RLock()
	defer h.mu.RUnlock()
	users := h.callUsers[roomID]
	out := make([]Participant, 0, len(users))
	for _, p := range users {
		out = append(out, p)
	}
	return out
}

func (h *Hub) addCallLocked(roomID, userID uuid.UUID, username string) {
	if _, ok := h.callCounts[roomID]; !ok {
		h.callCounts[roomID] = make(map[uuid.UUID]int)
	}
	if _, ok := h.callUsers[roomID]; !ok {
		h.callUsers[roomID] = make(map[uuid.UUID]Participant)
	}
	h.callCounts[roomID][userID]++
	h.callUsers[roomID][userID] = Participant{ID: userID.String(), Username: username}
}

func (h *Hub) removeCallLocked(roomID, userID uuid.UUID) {
	counts, ok := h.callCounts[roomID]
	if !ok {
		return
	}
	n := counts[userID] - 1
	if n <= 0 {
		delete(counts, userID)
		if users := h.callUsers[roomID]; users != nil {
			delete(users, userID)
		}
	} else {
		counts[userID] = n
	}
	if len(counts) == 0 {
		delete(h.callCounts, roomID)
		delete(h.callUsers, roomID)
	}
}
