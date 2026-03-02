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

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	lkauth "github.com/livekit/protocol/auth"
)

func (s *Server) createRoom(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		jsonError(w, http.StatusBadRequest, "name is required")
		return
	}

	room, err := s.Store.CreateRoom(r.Context(), req.Name, user.ID, true)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to create room")
		return
	}
	jsonResponse(w, http.StatusCreated, room)
}

func (s *Server) listRooms(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	rooms, err := s.Store.ListRoomsForUser(r.Context(), user.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to load rooms")
		return
	}
	jsonResponse(w, http.StatusOK, rooms)
}

func (s *Server) inviteToRoom(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
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
	member, err := s.Store.IsRoomMember(r.Context(), roomID, user.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to check membership")
		return
	}
	if !member {
		jsonError(w, http.StatusForbidden, "forbidden")
		return
	}
	direct, err := s.Store.IsDirectRoom(r.Context(), roomID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to check room type")
		return
	}
	if direct {
		jsonError(w, http.StatusBadRequest, "cannot invite into direct messages")
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
	if _, err := s.Store.FindUserByID(r.Context(), targetID); err != nil {
		jsonError(w, http.StatusNotFound, "user not found")
		return
	}
	if err := s.Store.JoinRoom(r.Context(), roomID, targetID); err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to invite user")
		return
	}
	jsonResponse(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) createRoomInviteLink(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
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
	member, err := s.Store.IsRoomMember(r.Context(), roomID, user.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to check membership")
		return
	}
	if !member {
		jsonError(w, http.StatusForbidden, "forbidden")
		return
	}
	direct, err := s.Store.IsDirectRoom(r.Context(), roomID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to check room type")
		return
	}
	if direct {
		jsonError(w, http.StatusBadRequest, "invite links are not available for direct messages")
		return
	}

	if token, expiresAt, err := s.Store.FindRoomInviteLinkByCreator(r.Context(), roomID, user.ID); err == nil {
		jsonResponse(w, http.StatusOK, map[string]string{
			"token":      token,
			"invite_url": fmt.Sprintf("%s?invite=%s", strings.TrimRight(s.Cfg.FrontendBaseURL, "/"), token),
			"expires_at": expiresAt.Format(time.RFC3339),
		})
		return
	} else if err != db.ErrNotFound {
		jsonError(w, http.StatusInternalServerError, "failed to load invite link")
		return
	}

	rawToken, err := randomToken(24)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to create invite link")
		return
	}
	expiresAt := time.Now().UTC().Add(10 * 365 * 24 * time.Hour)
	if err := s.Store.CreateRoomInviteLink(r.Context(), rawToken, tokenHash(rawToken), roomID, user.ID, expiresAt); err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to store invite link")
		return
	}

	jsonResponse(w, http.StatusCreated, map[string]string{
		"token":      rawToken,
		"invite_url": fmt.Sprintf("%s?invite=%s", strings.TrimRight(s.Cfg.FrontendBaseURL, "/"), rawToken),
		"expires_at": expiresAt.Format(time.RFC3339),
	})
}

func (s *Server) joinByInviteLink(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	rawToken := strings.TrimSpace(chi.URLParam(r, "token"))
	if rawToken == "" {
		jsonError(w, http.StatusBadRequest, "invite token is required")
		return
	}

	roomID, err := s.Store.JoinRoomByInviteTokenHash(r.Context(), tokenHash(rawToken), user.ID)
	if err != nil {
		if err == db.ErrNotFound {
			jsonError(w, http.StatusNotFound, "invite link is invalid or expired")
			return
		}
		jsonError(w, http.StatusInternalServerError, "failed to join by invite link")
		return
	}

	room, err := s.Store.GetRoomByID(r.Context(), roomID)
	if err != nil {
		jsonError(w, http.StatusNotFound, "room not found")
		return
	}
	jsonResponse(w, http.StatusOK, room)
}

func (s *Server) joinRoom(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
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
	member, err := s.Store.IsRoomMember(r.Context(), roomID, user.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to check membership")
		return
	}
	if !member {
		jsonError(w, http.StatusForbidden, "forbidden")
		return
	}
	jsonResponse(w, http.StatusOK, map[string]bool{"joined": true})
}

func (s *Server) renameRoom(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
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
	member, err := s.Store.IsRoomMember(r.Context(), roomID, user.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to check membership")
		return
	}
	if !member {
		jsonError(w, http.StatusForbidden, "forbidden")
		return
	}
	direct, err := s.Store.IsDirectRoom(r.Context(), roomID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to check room type")
		return
	}
	if direct {
		jsonError(w, http.StatusBadRequest, "cannot rename direct messages")
		return
	}
	admin, err := s.Store.IsRoomAdmin(r.Context(), roomID, user.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to check room role")
		return
	}
	if !admin {
		jsonError(w, http.StatusForbidden, "admin role required")
		return
	}

	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		jsonError(w, http.StatusBadRequest, "name is required")
		return
	}
	if err := s.Store.UpdateRoomName(r.Context(), roomID, req.Name); err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to rename room")
		return
	}
	room, err := s.Store.GetRoomForUser(r.Context(), roomID, user.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to load room")
		return
	}
	jsonResponse(w, http.StatusOK, room)
}

func (s *Server) deleteRoom(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
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
	member, err := s.Store.IsRoomMember(r.Context(), roomID, user.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to check membership")
		return
	}
	if !member {
		jsonError(w, http.StatusForbidden, "forbidden")
		return
	}
	direct, err := s.Store.IsDirectRoom(r.Context(), roomID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to check room type")
		return
	}
	if direct {
		jsonError(w, http.StatusBadRequest, "cannot delete direct messages")
		return
	}
	admin, err := s.Store.IsRoomAdmin(r.Context(), roomID, user.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to check room role")
		return
	}
	if !admin {
		jsonError(w, http.StatusForbidden, "admin role required")
		return
	}
	if err := s.Store.DeleteRoom(r.Context(), roomID); err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to delete room")
		return
	}
	jsonResponse(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) leaveRoom(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
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
	member, err := s.Store.IsRoomMember(r.Context(), roomID, user.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to check membership")
		return
	}
	if !member {
		jsonError(w, http.StatusForbidden, "forbidden")
		return
	}
	direct, err := s.Store.IsDirectRoom(r.Context(), roomID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to check room type")
		return
	}
	if direct {
		jsonError(w, http.StatusBadRequest, "cannot leave direct messages")
		return
	}
	if err := s.Store.LeaveRoom(r.Context(), roomID, user.ID); err != nil {
		if err == db.ErrNotFound {
			jsonError(w, http.StatusNotFound, "membership not found")
			return
		}
		jsonError(w, http.StatusInternalServerError, "failed to leave room")
		return
	}
	jsonResponse(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) listMessages(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
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
	member, err := s.Store.IsRoomMember(r.Context(), roomID, user.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to check membership")
		return
	}
	if !member {
		jsonError(w, http.StatusForbidden, "forbidden")
		return
	}

	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	messages, err := s.Store.ListMessages(r.Context(), roomID, limit)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to load messages")
		return
	}
	jsonResponse(w, http.StatusOK, messages)
}

func (s *Server) listCallParticipants(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
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
	member, err := s.Store.IsRoomMember(r.Context(), roomID, user.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to check membership")
		return
	}
	if !member {
		jsonError(w, http.StatusForbidden, "forbidden")
		return
	}

	participants := s.Hub.CallParticipants(roomID)
	jsonResponse(w, http.StatusOK, participants)
}

func (s *Server) liveKitToken(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
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
	member, err := s.Store.IsRoomMember(r.Context(), roomID, user.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to check membership")
		return
	}
	if !member {
		jsonError(w, http.StatusForbidden, "forbidden")
		return
	}

	grant := &lkauth.VideoGrant{
		RoomJoin: true,
		Room:     roomID.String(),
	}
	at := lkauth.NewAccessToken(s.Cfg.LiveKitAPIKey, s.Cfg.LiveKitAPISecret)
	at.SetIdentity(user.ID.String())
	at.SetName(user.Username)
	at.SetValidFor(2 * time.Hour)
	at.AddGrant(grant)

	token, err := at.ToJWT()
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to generate livekit token")
		return
	}

	jsonResponse(w, http.StatusOK, map[string]string{
		"token":       token,
		"livekit_url": s.Cfg.LiveKitURL,
		"room_name":   roomID.String(),
	})
}
