# Seabyss Web API

Secure backend bridge for the public Seabyss website.

The GitHub Pages frontend must not contain PlayFab secrets, payment secrets, SSH credentials, admin tokens, or account mutation logic. This API is the server-side boundary between the browser and PlayFab.

## Endpoints

- `GET /health`
- `POST /register`
- `POST /auth/login`
- `POST /auth/logout`
- `GET /auth/session`
- `GET /me`

`POST /register` creates a real PlayFab account in the configured Seabyss title through the PlayFab Client API. It does not create a website-only account, does not expose the PlayFab SecretKey, and does not grant gameplay rewards, currency, items, ships, or inventory.

`GET /me` reads the official gameplay save from PlayFab `UserInternalData`, key `profile_v1`, using the PlayFab Server API from the backend only. The frontend never receives the PlayFab SecretKey and never receives the raw `profile_v1` JSON.

The public profile response formats the player-facing values for display: readable ship/cannon names, formatted numbers, readable UTC dates, and a derived combat grade. The web combat score currently uses `PlayerProfileData.playerKills` when no persisted `combatPoints` field exists.

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
- Account registration has rate limiting and returns friendly errors for common PlayFab failures.
- Browser sessions are intended to use HttpOnly Secure SameSite cookies.
- Production sessions are stored in Redis, not in process memory.
- CORS is restricted to configured public origins.
- Login errors are intentionally generic.
- Passwords and tokens are never logged by the app.
- `/me` is read-only and does not modify inventory, currencies, or progression.
- Gameplay data is returned as a sanitized public summary. Missing or invalid `profile_v1` data falls back to empty profile fields instead of failing the whole request.

Before official launch, audit session rotation, Redis persistence/backup policy, and incident response.
