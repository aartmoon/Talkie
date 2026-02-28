package httpapi

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"talkie/backend/internal/middleware"
	"talkie/backend/internal/ws"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

const maxImageUploadSize = 8 << 20 // 8MB

func (s *Server) uploadRoomImage(w http.ResponseWriter, r *http.Request) {
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

	r.Body = http.MaxBytesReader(w, r.Body, maxImageUploadSize)
	if err := r.ParseMultipartForm(maxImageUploadSize); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid upload payload or file too large")
		return
	}

	file, header, err := r.FormFile("image")
	if err != nil {
		jsonError(w, http.StatusBadRequest, "missing image file")
		return
	}
	defer file.Close()

	head := make([]byte, 512)
	n, err := io.ReadFull(file, head)
	if err != nil && err != io.ErrUnexpectedEOF {
		jsonError(w, http.StatusBadRequest, "failed to read image")
		return
	}
	head = head[:n]
	contentType := http.DetectContentType(head)
	ext, valid := imageExt(contentType)
	if !valid {
		jsonError(w, http.StatusBadRequest, "only png, jpeg, webp or gif images are allowed")
		return
	}

	roomDir := filepath.Join(s.Cfg.UploadsDir, roomID.String())
	if err := os.MkdirAll(roomDir, 0o755); err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to prepare uploads directory")
		return
	}

	filename := fmt.Sprintf("%s%s", uuid.NewString(), ext)
	targetPath := filepath.Join(roomDir, filename)
	target, err := os.Create(targetPath)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to store image")
		return
	}
	defer target.Close()

	if _, err := io.Copy(target, io.MultiReader(bytes.NewReader(head), file)); err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to store image")
		return
	}

	caption := strings.TrimSpace(r.FormValue("caption"))
	if caption == "" {
		caption = header.Filename
	}
	relativeURL := fmt.Sprintf("/uploads/%s/%s", roomID.String(), filename)
	msg, err := s.Store.SaveMessageWithType(r.Context(), roomID, user.ID, caption, "image", relativeURL)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "failed to create image message")
		return
	}

	payload := ws.PayloadFromMessage(msg)
	s.Hub.Broadcast(roomID, ws.OutgoingMessage{Type: "chat", Message: &payload})
	jsonResponse(w, http.StatusCreated, msg)
}

func imageExt(contentType string) (string, bool) {
	switch contentType {
	case "image/png":
		return ".png", true
	case "image/jpeg":
		return ".jpg", true
	case "image/webp":
		return ".webp", true
	case "image/gif":
		return ".gif", true
	default:
		return "", false
	}
}
