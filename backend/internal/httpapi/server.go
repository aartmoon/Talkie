package httpapi

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"net/smtp"
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
		r.Post("/auth/verify-email", s.verifyEmail)
		r.Post("/auth/resend-verification", s.resendVerification)
		r.Post("/auth/forgot-password", s.forgotPassword)
		r.Post("/auth/reset-password", s.resetPassword)

		r.Group(func(r chi.Router) {
			r.Use(middleware.Auth(s.Cfg.JWTSecret))
			r.Get("/me", s.me)
			r.Get("/rooms", s.listRooms)
			r.Post("/rooms", s.createRoom)
			r.Post("/rooms/{roomID}/join", s.joinRoom)
			r.Post("/rooms/{roomID}/invite", s.inviteToRoom)
			r.Post("/rooms/{roomID}/invite-link", s.createRoomInviteLink)
			r.Get("/rooms/{roomID}/messages", s.listMessages)
			r.Get("/rooms/{roomID}/call-participants", s.listCallParticipants)
			r.Post("/rooms/{roomID}/images", s.uploadRoomImage)
			r.Post("/rooms/{roomID}/livekit-token", s.liveKitToken)
			r.Get("/users/search", s.searchUsers)
			r.Get("/friends", s.listFriends)
			r.Post("/friends/requests", s.sendFriendRequest)
			r.Post("/friends/requests/{requestID}/accept", s.acceptFriendRequest)
			r.Post("/friends/invite-link", s.createFriendInviteLink)
			r.Post("/friends/invite-links/{token}/accept", s.acceptFriendInviteLink)
			r.Get("/dm/rooms", s.listDMRooms)
			r.Post("/dm/rooms", s.createOrGetDMRoom)
			r.Post("/invite-links/{token}/join", s.joinByInviteLink)
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
	Token                     string  `json:"token,omitempty"`
	User                      db.User `json:"user"`
	RequiresEmailVerification bool    `json:"requires_email_verification,omitempty"`
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
	verifyCode, err := randomDigits(6)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to create verification code")
		return
	}
	if err := s.Store.SetEmailVerificationToken(r.Context(), u.ID, tokenHash(verifyCode), time.Now().UTC()); err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to save verification code")
		return
	}
	if err := s.sendVerificationEmail(u.Email, verifyCode); err != nil {
		log.Printf("failed to send verification email to %s: %v", u.Email, err)
	}

	u.PasswordHash = ""
	jsonResponse(w, http.StatusCreated, authResponse{User: u, RequiresEmailVerification: true})
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
	if !u.EmailVerified {
		jsonResponse(w, http.StatusForbidden, map[string]any{
			"error":                       "email is not verified",
			"requires_email_verification": true,
		})
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

func (s *Server) verifyEmail(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email string `json:"email"`
		Code  string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Email = strings.TrimSpace(strings.ToLower(req.Email))
	req.Code = strings.TrimSpace(req.Code)
	if req.Email == "" || req.Code == "" {
		jsonError(w, http.StatusBadRequest, "email and code are required")
		return
	}
	u, err := s.Store.VerifyUserByEmailAndTokenHash(r.Context(), req.Email, tokenHash(req.Code))
	if err != nil {
		if err == db.ErrNotFound {
			jsonError(w, http.StatusBadRequest, "invalid or expired verification code")
			return
		}
		jsonError(w, http.StatusInternalServerError, "failed to verify email")
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

func (s *Server) resendVerification(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Email = strings.TrimSpace(strings.ToLower(req.Email))
	if req.Email == "" {
		jsonError(w, http.StatusBadRequest, "email is required")
		return
	}

	u, err := s.Store.FindUserByEmail(r.Context(), req.Email)
	if err == nil && !u.EmailVerified {
		verifyCode, codeErr := randomDigits(6)
		if codeErr != nil {
			jsonError(w, http.StatusInternalServerError, "failed to create verification code")
			return
		}
		if saveErr := s.Store.SetEmailVerificationToken(r.Context(), u.ID, tokenHash(verifyCode), time.Now().UTC()); saveErr != nil {
			jsonError(w, http.StatusInternalServerError, "failed to save verification code")
			return
		}
		if mailErr := s.sendVerificationEmail(u.Email, verifyCode); mailErr != nil {
			log.Printf("failed to resend verification email to %s: %v", u.Email, mailErr)
		}
	}

	jsonResponse(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) forgotPassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Email = strings.TrimSpace(strings.ToLower(req.Email))
	if req.Email == "" {
		jsonError(w, http.StatusBadRequest, "email is required")
		return
	}

	u, err := s.Store.FindUserByEmail(r.Context(), req.Email)
	if err == nil {
		rawToken, tokenErr := randomToken(24)
		if tokenErr != nil {
			jsonError(w, http.StatusInternalServerError, "failed to create reset token")
			return
		}
		if saveErr := s.Store.SetPasswordResetToken(r.Context(), u.ID, tokenHash(rawToken), time.Now().UTC()); saveErr != nil {
			jsonError(w, http.StatusInternalServerError, "failed to save reset token")
			return
		}
		if mailErr := s.sendPasswordResetEmail(u.Email, rawToken); mailErr != nil {
			log.Printf("failed to send password reset email to %s: %v", u.Email, mailErr)
		}
	}
	jsonResponse(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) resetPassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token       string `json:"token"`
		NewPassword string `json:"new_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Token = strings.TrimSpace(req.Token)
	if req.Token == "" || len(req.NewPassword) < 6 {
		jsonError(w, http.StatusBadRequest, "token and new_password (min 6) are required")
		return
	}
	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to hash password")
		return
	}
	if err := s.Store.ResetPasswordByTokenHash(r.Context(), tokenHash(req.Token), hash); err != nil {
		if err == db.ErrNotFound {
			jsonError(w, http.StatusBadRequest, "invalid or expired reset token")
			return
		}
		jsonError(w, http.StatusInternalServerError, "failed to reset password")
		return
	}
	jsonResponse(w, http.StatusOK, map[string]bool{"ok": true})
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

	rawToken, err := randomToken(24)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to create invite link")
		return
	}
	expiresAt := time.Now().UTC().Add(24 * time.Hour)
	if err := s.Store.CreateRoomInviteLink(r.Context(), tokenHash(rawToken), roomID, user.ID, expiresAt); err != nil {
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

func (s *Server) createFriendInviteLink(w http.ResponseWriter, r *http.Request) {
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		jsonError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	rawToken, err := randomToken(24)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to create invite token")
		return
	}
	expiresAt := time.Now().UTC().Add(48 * time.Hour)
	if err := s.Store.CreateFriendInviteLink(r.Context(), tokenHash(rawToken), user.ID, expiresAt); err != nil {
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

func randomToken(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func randomDigits(length int) (string, error) {
	if length <= 0 {
		return "", fmt.Errorf("invalid code length")
	}
	var b strings.Builder
	b.Grow(length)
	ten := big.NewInt(10)
	for i := 0; i < length; i++ {
		n, err := rand.Int(rand.Reader, ten)
		if err != nil {
			return "", err
		}
		b.WriteByte(byte('0' + n.Int64()))
	}
	return b.String(), nil
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (s *Server) sendVerificationEmail(to, code string) error {
	subject := "Talkie email verification code"
	body := fmt.Sprintf("Your Talkie verification code is: %s\n\nThe code expires in 24 hours.\n", code)
	message := []byte("From: " + s.Cfg.SMTPFrom + "\r\n" +
		"To: " + to + "\r\n" +
		"Subject: " + subject + "\r\n\r\n" +
		body)

	if s.Cfg.SMTPHost == "" || s.Cfg.SMTPPort == 0 || s.Cfg.SMTPFrom == "" {
		log.Printf("verification code for %s: %s", to, code)
		return nil
	}

	addr := fmt.Sprintf("%s:%d", s.Cfg.SMTPHost, s.Cfg.SMTPPort)
	var auth smtp.Auth
	if s.Cfg.SMTPUser != "" {
		auth = smtp.PlainAuth("", s.Cfg.SMTPUser, s.Cfg.SMTPPass, s.Cfg.SMTPHost)
	}
	return smtp.SendMail(addr, auth, s.Cfg.SMTPFrom, []string{to}, message)
}

func (s *Server) sendPasswordResetEmail(to, token string) error {
	frontendBase := strings.TrimRight(s.Cfg.FrontendBaseURL, "/")
	if frontendBase == "" {
		frontendBase = "http://localhost:5173"
	}
	resetURL := fmt.Sprintf("%s/reset-password?token=%s", frontendBase, token)
	subject := "Talkie password reset"
	body := fmt.Sprintf("Open this link to reset your Talkie password:\n\n%s\n\nThe link expires in 2 hours.\n", resetURL)
	message := []byte("From: " + s.Cfg.SMTPFrom + "\r\n" +
		"To: " + to + "\r\n" +
		"Subject: " + subject + "\r\n\r\n" +
		body)

	if s.Cfg.SMTPHost == "" || s.Cfg.SMTPPort == 0 || s.Cfg.SMTPFrom == "" {
		log.Printf("password reset link for %s: %s", to, resetURL)
		return nil
	}
	addr := fmt.Sprintf("%s:%d", s.Cfg.SMTPHost, s.Cfg.SMTPPort)
	var auth smtp.Auth
	if s.Cfg.SMTPUser != "" {
		auth = smtp.PlainAuth("", s.Cfg.SMTPUser, s.Cfg.SMTPPass, s.Cfg.SMTPHost)
	}
	return smtp.SendMail(addr, auth, s.Cfg.SMTPFrom, []string{to}, message)
}
