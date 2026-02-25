package httpapi

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"talkie/backend/internal/auth"
	"talkie/backend/internal/config"
	"talkie/backend/internal/db"
	"talkie/backend/internal/middleware"
	"talkie/backend/internal/ws"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	lkauth "github.com/livekit/protocol/auth"
)

type Server struct {
	Cfg   config.Config
	Store *db.Store
	Hub   *ws.Hub
}

func New(cfg config.Config, store *db.Store, hub *ws.Hub) *Server {
	return &Server{Cfg: cfg, Store: store, Hub: hub}
}

func (s *Server) Routes() http.Handler {
	r := chi.NewRouter()

	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, http.StatusOK, map[string]bool{"ok": true})
	})
	r.Handle("/uploads/*", http.StripPrefix("/uploads/", http.FileServer(http.Dir(s.Cfg.UploadsDir))))

	r.Route("/api", func(r chi.Router) {
		r.Post("/auth/register", s.register)
		r.Post("/auth/login", s.login)

		r.Group(func(r chi.Router) {
			r.Use(middleware.Auth(s.Cfg.JWTSecret))
			r.Get("/me", s.me)
			r.Get("/rooms", s.listRooms)
			r.Post("/rooms", s.createRoom)
			r.Post("/rooms/{roomID}/join", s.joinRoom)
			r.Post("/rooms/{roomID}/invite", s.inviteToRoom)
			r.Get("/rooms/{roomID}/messages", s.listMessages)
			r.Get("/rooms/{roomID}/call-participants", s.listCallParticipants)
			r.Post("/rooms/{roomID}/images", s.uploadRoomImage)
			r.Post("/rooms/{roomID}/livekit-token", s.liveKitToken)
			r.Get("/users/search", s.searchUsers)
			r.Get("/friends", s.listFriends)
			r.Post("/friends/requests", s.sendFriendRequest)
			r.Post("/friends/requests/{requestID}/accept", s.acceptFriendRequest)
			r.Get("/dm/rooms", s.listDMRooms)
			r.Post("/dm/rooms", s.createOrGetDMRoom)
		})
	})

	r.Get("/ws/rooms/{roomID}", s.roomWebSocket)

	return r
}

type authRequest struct {
	Email    string `json:"email"`
	Username string `json:"username,omitempty"`
	Password string `json:"password"`
}

type authResponse struct {
	Token string  `json:"token"`
	User  db.User `json:"user"`
}

func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	var req authRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Email = strings.TrimSpace(strings.ToLower(req.Email))
	req.Username = strings.TrimSpace(req.Username)
	if req.Email == "" || req.Password == "" || req.Username == "" {
		jsonError(w, http.StatusBadRequest, "email, username, and password are required")
		return
	}
	if len(req.Password) < 6 {
		jsonError(w, http.StatusBadRequest, "password must be at least 6 characters")
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to hash password")
		return
	}

	u, err := s.Store.CreateUser(r.Context(), req.Email, req.Username, hash)
	if err != nil {
		jsonError(w, http.StatusConflict, "user already exists")
		return
	}
	token, err := auth.GenerateJWT(s.Cfg.JWTSecret, u.ID, u.Username)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	u.PasswordHash = ""
	jsonResponse(w, http.StatusCreated, authResponse{Token: token, User: u})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var req authRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Email = strings.TrimSpace(strings.ToLower(req.Email))
	if req.Email == "" || req.Password == "" {
		jsonError(w, http.StatusBadRequest, "email and password are required")
		return
	}

	u, err := s.Store.FindUserByEmail(r.Context(), req.Email)
	if err != nil {
		jsonError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if err := auth.VerifyPassword(u.PasswordHash, req.Password); err != nil {
		jsonError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	token, err := auth.GenerateJWT(s.Cfg.JWTSecret, u.ID, u.Username)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	u.PasswordHash = ""
	jsonResponse(w, http.StatusOK, authResponse{Token: token, User: u})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	u, err := s.Store.FindUserByID(r.Context(), user.ID)
	if err != nil {
		jsonError(w, http.StatusNotFound, "user not found")
		return
	}
	u.PasswordHash = ""
	jsonResponse(w, http.StatusOK, u)
}

func (s *Server) createRoom(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req struct {
		Name      string `json:"name"`
		IsPrivate bool   `json:"is_private"`
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

	room, err := s.Store.CreateRoom(r.Context(), req.Name, user.ID, req.IsPrivate)
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
	room, err := s.Store.GetRoomByID(r.Context(), roomID)
	if err != nil {
		jsonError(w, http.StatusNotFound, "room not found")
		return
	}
	if !room.IsPrivate {
		jsonError(w, http.StatusBadRequest, "invites are supported only for private rooms")
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
	room, err := s.Store.GetRoomByID(r.Context(), roomID)
	if err != nil {
		jsonError(w, http.StatusNotFound, "room not found")
		return
	}
	if room.IsPrivate {
		member, err := s.Store.IsRoomMember(r.Context(), roomID, user.ID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "failed to check membership")
			return
		}
		if !member {
			jsonError(w, http.StatusForbidden, "forbidden")
			return
		}
	}
	if err := s.Store.JoinRoom(r.Context(), roomID, user.ID); err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to join room")
		return
	}
	jsonResponse(w, http.StatusOK, map[string]bool{"joined": true})
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
	room, err := s.Store.GetRoomByID(r.Context(), roomID)
	if err != nil {
		jsonError(w, http.StatusNotFound, "room not found")
		return
	}
	if room.IsPrivate {
		member, err := s.Store.IsRoomMember(r.Context(), roomID, user.ID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "failed to check membership")
			return
		}
		if !member {
			jsonError(w, http.StatusForbidden, "forbidden")
			return
		}
	} else if err := s.Store.JoinRoom(r.Context(), roomID, user.ID); err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to join room")
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
	room, err := s.Store.GetRoomByID(r.Context(), roomID)
	if err != nil {
		jsonError(w, http.StatusNotFound, "room not found")
		return
	}
	if room.IsPrivate {
		member, err := s.Store.IsRoomMember(r.Context(), roomID, user.ID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "failed to check membership")
			return
		}
		if !member {
			jsonError(w, http.StatusForbidden, "forbidden")
			return
		}
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
	room, err := s.Store.GetRoomByID(r.Context(), roomID)
	if err != nil {
		jsonError(w, http.StatusNotFound, "room not found")
		return
	}
	if room.IsPrivate {
		member, err := s.Store.IsRoomMember(r.Context(), roomID, user.ID)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "failed to check membership")
			return
		}
		if !member {
			jsonError(w, http.StatusForbidden, "forbidden")
			return
		}
	} else if err := s.Store.JoinRoom(r.Context(), roomID, user.ID); err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to join room")
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

func (s *Server) searchUsers(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		jsonResponse(w, http.StatusOK, []db.Friend{})
		return
	}
	users, err := s.Store.SearchUsers(r.Context(), user.ID, q, 10)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to search users")
		return
	}
	jsonResponse(w, http.StatusOK, users)
}

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
	if err := s.Store.AcceptFriendRequest(r.Context(), requestID, user.ID); err != nil {
		if err == db.ErrNotFound {
			jsonError(w, http.StatusNotFound, "request not found")
			return
		}
		jsonError(w, http.StatusBadRequest, "failed to accept request")
		return
	}
	jsonResponse(w, http.StatusOK, map[string]bool{"ok": true})
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
	targetUser, err := s.Store.FindUserByID(r.Context(), targetID)
	if err == nil {
		room.Name = targetUser.Username
	}
	jsonResponse(w, http.StatusOK, room)
}

func jsonResponse(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func jsonError(w http.ResponseWriter, status int, msg string) {
	jsonResponse(w, status, map[string]string{"error": msg})
}
