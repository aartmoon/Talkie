package middleware

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"talkie/backend/internal/auth"

	"github.com/google/uuid"
)

type UserContext struct {
	ID       uuid.UUID
	Username string
}

type contextKey string

const userKey contextKey = "user"

func Auth(secret string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			header := r.Header.Get("Authorization")
			if header == "" {
				writeErr(w, http.StatusUnauthorized, "missing authorization header")
				return
			}
			parts := strings.SplitN(header, " ", 2)
			if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
				writeErr(w, http.StatusUnauthorized, "invalid authorization header")
				return
			}
			claims, err := auth.ParseJWT(secret, parts[1])
			if err != nil {
				writeErr(w, http.StatusUnauthorized, "invalid token")
				return
			}
			userID, err := uuid.Parse(claims.UserID)
			if err != nil {
				writeErr(w, http.StatusUnauthorized, "invalid token payload")
				return
			}
			ctx := context.WithValue(r.Context(), userKey, UserContext{ID: userID, Username: claims.Username})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func UserFromContext(ctx context.Context) (UserContext, bool) {
	u, ok := ctx.Value(userKey).(UserContext)
	return u, ok
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
