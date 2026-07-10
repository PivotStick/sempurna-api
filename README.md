# sempurna-api

Backend for [Sempurna](https://github.com/PivotStick/sempurna) — the private
iOS app for Maxime 🇫🇷 & Ecaa 🇮🇩. Replaces the original CloudKit sync with a
real, testable API. Same stack and conventions as `pixel-garden-api`:
**Bun + Hono + MongoDB**, APNs push via the team `.p8` key, moment photos on R2.

## Run

```sh
bun install
bun dev          # watches src/, logs to logs/dev.log
```

Docker (what Dokploy builds):

```sh
docker build -t sempurna-api .
docker run --env-file .env -p 3000:3000 sempurna-api
```

## Env

See `.env` (not committed). `MONGO_URI` is the important one; `APNS_*` enables
push (skipped gracefully when empty); `R2_*` enables moment photos.

Auth is **sempurna's own `users` collection** (db `sempurna`) — nothing shared.
Registration is capped at **two accounts**: the first two sign-ups are the
couple, then the door closes itself (`couple_full`).

## API

Everything under `/api/*` (except login/register) wants `Authorization: Bearer <token>`.

| Method | Path | What |
|---|---|---|
| POST | `/api/auth/register` | `{username, password}` → `{token, me}` (max 2 accounts, ever) |
| POST | `/api/auth/login` | `{username, password}` → `{token, me}` |
| GET | `/api/home?tzOffset=120` | launch snapshot: partner, presences, moments, ping counts |
| POST | `/api/couple` | create the couple → `{inviteCode}` |
| POST | `/api/join` | `{code}` — the partner pairs once with the invite code |
| GET/POST | `/api/moments` | feed / `{note, emoji, paletteIndex, photoBase64?}` (photo → R2 `moments/`, partner gets a push) |
| POST | `/api/ping?tzOffset=` | "thinking of you" → partner push, returns today's counts |
| POST | `/api/presence` | `{city, flag, timeZoneID}` from device geolocation |
| POST | `/api/trip` | `{date: "YYYY-MM-DD"}` — next-time-together countdown |
| GET/POST | `/api/words` | Kamus shared dictionary |
| POST | `/api/push/register` / `unregister` / `test` | APNs device tokens |
