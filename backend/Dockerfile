FROM golang:1.23-alpine AS builder
WORKDIR /src/backend

COPY go.mod go.sum ./
RUN go mod download

COPY . ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/talkie-server ./cmd/server

FROM alpine:3.20
WORKDIR /app

RUN adduser -D appuser

COPY --from=builder /out/talkie-server /app/talkie-server
COPY migrations /app/migrations
RUN mkdir -p /app/uploads && chown -R appuser:appuser /app

USER appuser
EXPOSE 8080

ENV PORT=8080
ENV MIGRATIONS_PATH=/app/migrations
ENV UPLOADS_DIR=/app/uploads

CMD ["/app/talkie-server"]
