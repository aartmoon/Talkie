# Talkie MVP (Discord-like Voice/Video)

A production-oriented MVP for room-based voice/video + text chat.

## Stack
- Media: LiveKit (WebRTC)
- Backend: Go (`chi`, WebSocket signaling via `gorilla/websocket`)
- Database: PostgreSQL
- Frontend: React + Vite + `livekit-client`

## Features
- User registration/login with email verification (JWT)
- Private-only rooms with member-gated access
- Quick invite links for private room conversations
- Room-scoped text chat (WebSocket)
- Room-scoped LiveKit voice/video sessions
- Basic room + participant UI

## Project Structure
- `/backend`: Go API + WebSocket signaling + LiveKit token generation
- `/backend/migrations`: SQL schema
- `/frontend`: React web app
- `/deploy/livekit`: LiveKit config
- `/docker-compose.yml`: local Postgres + LiveKit

## Local Setup

### 1) Start everything
```bash
docker compose up --build
```
or:
```bash
make up
```

This starts all services:
- Frontend on `http://localhost:61873`
- Backend API on `http://localhost:61981`
- PostgreSQL on `localhost:62479`
- LiveKit on `ws://localhost:62780`

Backend runs SQL migrations automatically on startup.

### 2) Stop everything
```bash
docker compose down
```

## Core Backend Endpoints
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/verify-email`
- `POST /api/auth/resend-verification`
- `GET /api/me`
- `GET /api/rooms`
- `POST /api/rooms`
- `POST /api/rooms/{roomID}/join`
- `POST /api/rooms/{roomID}/invite-link`
- `POST /api/invite-links/{token}/join`
- `GET /api/rooms/{roomID}/messages`
- `POST /api/rooms/{roomID}/livekit-token`
- `GET /ws/rooms/{roomID}?token=<jwt>`

## Notes
- LiveKit room name is the internal room UUID.
- WebSocket is used for signaling text chat and room participant list.
- Media transport is handled directly by LiveKit.
- In Docker Compose, frontend talks to backend via `http://localhost:61981`.

## Next Production Steps
1. Add refresh tokens + secure cookie storage.
2. Add authorization checks for room membership on message history.
3. Add Redis-backed pub/sub for multi-instance WebSocket fanout.
4. Add database migrations tool (e.g. `golang-migrate`) and CI checks.

## Production VM (Docker Hub + Traefik)
- Use [`docker-compose.prod.yml`](/Users/artemsharkov/Desktop/Talkie/docker-compose.prod.yml)
- Env template: [`/Users/artemsharkov/Desktop/Talkie/.env.prod.example`](/Users/artemsharkov/Desktop/Talkie/.env.prod.example)
- LiveKit prod config: [`/Users/artemsharkov/Desktop/Talkie/deploy/livekit/livekit.prod.yaml`](/Users/artemsharkov/Desktop/Talkie/deploy/livekit/livekit.prod.yaml)

Expected DNS:
- `call.moderium-ai.ru` -> VM public IP
- `rtc.call.moderium-ai.ru` -> VM public IP

Required open ports on VM/firewall:
- `80/tcp`, `443/tcp` (Traefik)
- `62781/tcp` (LiveKit ICE TCP fallback)
- `62782/udp` (LiveKit media)

Start:
```bash
cp .env.prod.example .env.prod
# fill real values (images, secrets, LIVEKIT_NODE_IP)
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
```

```bash
docker buildx build \
--platform linux/amd64 \
-t artshar/talkie-frontend:1.0.0 \
--build-arg VITE_API_BASE_URL=https://call.moderium-ai.ru \
--push .
```

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml down
docker compose --env-file .env.prod -f docker-compose.prod.yml pull
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
```
