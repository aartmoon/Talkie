.PHONY: up down migrate backend frontend desktop

up:
	docker compose up --build

down:
	docker compose down

migrate:
	psql postgres://postgres:postgres@localhost:62479/talkie -f backend/migrations/001_init.sql

backend:
	cd backend && go run ./cmd/server

frontend:
	cd frontend && npm run dev

desktop:
	cd desktop && npm run dev
