# Seabyss Web API

Secure backend bridge for the public Seabyss website.

The GitHub Pages frontend must not contain PlayFab secrets, payment secrets, SSH credentials, admin tokens, or account mutation logic. This API is the server-side boundary between the browser and PlayFab.

## Endpoints

- `GET /health`
- `POST /auth/login`
- `POST /auth/logout`
- `GET /auth/session`
- `GET /me`

## Local setup

```bash
cd server-web-api
npm install
cp .env.example .env
npm start
```

Fill `.env` with server-only values. Never commit `.env`.

Production requires Redis for web sessions:

```txt
REDIS_URL=redis://127.0.0.1:6379
SESSION_TTL_SECONDS=86400
```

If Redis is not reachable in production, the API fails at startup instead of falling back to memory sessions. Local development may use MemoryStore only when `REDIS_URL` is omitted or Redis is unavailable.

## Security notes

- Login has rate limiting.
- Browser sessions are intended to use HttpOnly Secure SameSite cookies.
- Production sessions are stored in Redis, not in process memory.
- CORS is restricted to configured public origins.
- Login errors are intentionally generic.
- Passwords and tokens are never logged by the app.
- `/me` is read-only and does not modify inventory, currencies, or progression.

Before official launch, audit session rotation, Redis persistence/backup policy, and incident response.
