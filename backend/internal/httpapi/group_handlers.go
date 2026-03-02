package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"talkie/backend/internal/db"
	"talkie/backend/internal/middleware"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func (s *Server) listGroups(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	groups, err := s.Store.ListRoomGroupsForUser(r.Context(), user.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to load groups")
		return
	}
	jsonResponse(w, http.StatusOK, groups)
}

func (s *Server) createGroup(w http.ResponseWriter, r *http.Request) {
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

	group, err := s.Store.CreateRoomGroup(r.Context(), req.Name, user.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to create group")
		return
	}
	channel, err := s.Store.CreateGroupChannel(r.Context(), group.ID, "общий", "text", user.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to create default channel")
		return
	}
	group.TextChannels = append(group.TextChannels, channel)
	jsonResponse(w, http.StatusCreated, group)
}

func (s *Server) renameGroup(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	groupID, err := uuid.Parse(chi.URLParam(r, "groupID"))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "invalid group id")
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
	if err := s.Store.UpdateRoomGroupName(r.Context(), groupID, user.ID, req.Name); err != nil {
		if err == db.ErrForbidden {
			jsonError(w, http.StatusForbidden, "admin role required")
			return
		}
		jsonError(w, http.StatusInternalServerError, "failed to rename group")
		return
	}
	jsonResponse(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) createGroupChannel(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	groupID, err := uuid.Parse(chi.URLParam(r, "groupID"))
	if err != nil {
		jsonError(w, http.StatusBadRequest, "invalid group id")
		return
	}
	var req struct {
		Name string `json:"name"`
		Type string `json:"type"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.Type = strings.ToLower(strings.TrimSpace(req.Type))
	if req.Name == "" {
		jsonError(w, http.StatusBadRequest, "name is required")
		return
	}

	channel, err := s.Store.CreateGroupChannel(r.Context(), groupID, req.Name, req.Type, user.ID)
	if err != nil {
		switch err {
		case db.ErrNotFound:
			jsonError(w, http.StatusNotFound, "group not found")
		case db.ErrForbidden:
			jsonError(w, http.StatusForbidden, "admin role required")
		default:
			jsonError(w, http.StatusBadRequest, err.Error())
		}
		return
	}
	jsonResponse(w, http.StatusCreated, channel)
}
