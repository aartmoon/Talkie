# Talkie Desktop (Windows)

This is a minimal Electron shell that opens Talkie as a desktop app.

## Dev

1) Run frontend:
```bash
cd ../frontend
npm i
npm run dev
```

2) Run desktop wrapper:
```bash
cd ../desktop
npm i
npm run dev
```

## Build Windows installer (.exe)

Recommended: build on Windows (or via GitHub Actions).

```bash
cd desktop
npm i
npm run dist:win
```

Output: `desktop/dist/` (NSIS installer).

## Point the app to a different server

Set `TALKIE_APP_URL`:
```bash
TALKIE_APP_URL=https://call.moderium-ai.ru npm start
```

