package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Port             int
	DatabaseURL      string
	JWTSecret        string
	LiveKitAPIKey    string
	LiveKitAPISecret string
	LiveKitURL       string
	MigrationsPath   string
	UploadsDir       string
	AllowedOrigins   []string
}

func Load() (Config, error) {
	cfg := Config{
		Port:             envInt("PORT", 8080),
		DatabaseURL:      os.Getenv("DATABASE_URL"),
		JWTSecret:        os.Getenv("JWT_SECRET"),
		LiveKitAPIKey:    os.Getenv("LIVEKIT_API_KEY"),
		LiveKitAPISecret: os.Getenv("LIVEKIT_API_SECRET"),
		LiveKitURL:       os.Getenv("LIVEKIT_URL"),
		MigrationsPath:   envString("MIGRATIONS_PATH", "migrations"),
		UploadsDir:       envString("UPLOADS_DIR", "uploads"),
		AllowedOrigins:   splitCSV(envString("ALLOWED_ORIGINS", "http://localhost:5173")),
	}

	if cfg.DatabaseURL == "" {
		return Config{}, fmt.Errorf("DATABASE_URL is required")
	}
	if cfg.JWTSecret == "" {
		return Config{}, fmt.Errorf("JWT_SECRET is required")
	}
	if cfg.LiveKitAPIKey == "" || cfg.LiveKitAPISecret == "" || cfg.LiveKitURL == "" {
		return Config{}, fmt.Errorf("LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL are required")
	}

	return cfg, nil
}

func envString(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

func splitCSV(v string) []string {
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		trimmed := strings.TrimSpace(p)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
