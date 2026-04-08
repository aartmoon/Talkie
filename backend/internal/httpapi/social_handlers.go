package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"talkie/backend/internal/db"
	"talkie/backend/internal/middleware"
	"talkie/backend/internal/ws"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func (s *Server) listFriends(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	friends, err := s.Store.ListFriends(r.Context(), user.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to load friends")
		return
	}
	incoming, err := s.Store.ListIncomingFriendRequests(r.Context(), user.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to load friend requests")
		return
	}
	jsonResponse(w, http.StatusOK, map[string]any{
		"friends":  friends,
		"incoming": incoming,
	})
}

func (s *Server) userProfile(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	targetID, err := uuid.Parse(chi.URLParam(r, "userID"))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "invalid user id")
		return
	}
	u, err := s.Store.FindUserByID(r.Context(), targetID)
	if err != nil {
		if err == db.ErrNotFound {
			jsonError(w, http.StatusNotFound, "user not found")
			return
		}
		jsonError(w, http.StatusInternalServerError, "failed to load user profile")
		return
	}
	isFriend, err := s.Store.IsFriend(r.Context(), user.ID, targetID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to load relationship")
		return
	}
	jsonResponse(w, http.StatusOK, map[string]any{
		"id":         u.ID,
		"username":   u.Username,
		"avatar_url": u.AvatarURL,
		"created_at": u.CreatedAt,
		"is_friend":  isFriend,
	})
}

func (s *Server) sendFriendRequest(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req struct {
		UserID string `json:"user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	targetID, err := uuid.Parse(req.UserID)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "invalid user id")
		return
	}
	if err := s.Store.CreateFriendRequest(r.Context(), user.ID, targetID); err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.Hub.BroadcastUser(targetID, ws.OutgoingMessage{Type: "friend_request_event"})
	jsonResponse(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) acceptFriendRequest(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	requestID, err := strconv.ParseInt(chi.URLParam(r, "requestID"), 10, 64)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "invalid request id")
		return
	}
	requesterID, err := s.Store.AcceptFriendRequest(r.Context(), requestID, user.ID)
	if err != nil {
		if err == db.ErrNotFound {
			jsonError(w, http.StatusNotFound, "request not found")
			return
		}
		jsonError(w, http.StatusBadRequest, "failed to accept request")
		return
	}
	s.Hub.BroadcastUser(user.ID, ws.OutgoingMessage{Type: "friend_relationship_event"})
	s.Hub.BroadcastUser(requesterID, ws.OutgoingMessage{Type: "friend_relationship_event"})
	s.Hub.BroadcastUser(user.ID, ws.OutgoingMessage{Type: "friend_request_event"})
	jsonResponse(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) declineFriendRequest(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	requestID, err := strconv.ParseInt(chi.URLParam(r, "requestID"), 10, 64)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "invalid request id")
		return
	}
	if err := s.Store.DeclineFriendRequest(r.Context(), requestID, user.ID); err != nil {
		if err == db.ErrNotFound {
			jsonError(w, http.StatusNotFound, "request not found")
			return
		}
		jsonError(w, http.StatusBadRequest, "failed to decline request")
		return
	}
	s.Hub.BroadcastUser(user.ID, ws.OutgoingMessage{Type: "friend_request_event"})
	jsonResponse(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) createFriendInviteLink(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if token, expiresAt, err := s.Store.FindFriendInviteLinkByCreator(r.Context(), user.ID); err == nil {
		jsonResponse(w, http.StatusOK, map[string]string{
			"token":      token,
			"invite_url": fmt.Sprintf("%s?friend_invite=%s", strings.TrimRight(s.Cfg.FrontendBaseURL, "/"), token),
			"expires_at": expiresAt.Format(time.RFC3339),
		})
		return
	} else if err != db.ErrNotFound {
		jsonError(w, http.StatusInternalServerError, "failed to load friend invite link")
		return
	}

	rawToken, err := randomToken(24)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to create invite token")
		return
	}
	expiresAt := time.Now().UTC().Add(10 * 365 * 24 * time.Hour)
	if err := s.Store.CreateFriendInviteLink(r.Context(), rawToken, tokenHash(rawToken), user.ID, expiresAt); err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to store friend invite link")
		return
	}
	jsonResponse(w, http.StatusCreated, map[string]string{
		"token":      rawToken,
		"invite_url": fmt.Sprintf("%s?friend_invite=%s", strings.TrimRight(s.Cfg.FrontendBaseURL, "/"), rawToken),
		"expires_at": expiresAt.Format(time.RFC3339),
	})
}

func (s *Server) acceptFriendInviteLink(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	rawToken := strings.TrimSpace(chi.URLParam(r, "token"))
	if rawToken == "" {
		jsonError(w, http.StatusBadRequest, "friend invite token is required")
		return
	}
	friend, err := s.Store.AddFriendByInviteTokenHash(r.Context(), tokenHash(rawToken), user.ID)
	if err != nil {
		if err == db.ErrNotFound {
			jsonError(w, http.StatusNotFound, "friend invite link is invalid or expired")
			return
		}
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.Hub.BroadcastUser(user.ID, ws.OutgoingMessage{Type: "friend_relationship_event"})
	s.Hub.BroadcastUser(friend.ID, ws.OutgoingMessage{Type: "friend_relationship_event"})
	jsonResponse(w, http.StatusOK, friend)
}

func (s *Server) listDMRooms(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	rooms, err := s.Store.ListDirectRoomsForUser(r.Context(), user.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to load dms")
		return
	}
	jsonResponse(w, http.StatusOK, rooms)
}

func (s *Server) createOrGetDMRoom(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req struct {
		UserID string `json:"user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	targetID, err := uuid.Parse(req.UserID)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "invalid user id")
		return
	}
	room, err := s.Store.GetOrCreateDirectRoom(r.Context(), user.ID, targetID)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "failed to open dm")
		return
	}
	s.Hub.BroadcastUser(targetID, ws.OutgoingMessage{Type: "dm_room_event"})
	targetUser, err := s.Store.FindUserByID(r.Context(), targetID)
	if err == nil {
		room.Name = targetUser.Username
		room.AvatarURL = targetUser.AvatarURL
	}
	jsonResponse(w, http.StatusOK, room)
}
