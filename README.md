# Wanderling

Link to demo: https://hiddenlayers-production.up.railway.app/

A virtual pet that grows the more you walk.

You hatch a mythical buddy (a **dragon**, **phoenix** or **kraken**) and raise it with real steps. Walking earns Stride Points. Spend them to level your buddy up, sharpen its attack and evasion, and dress it in cosmetics. Then take it into battle against your friends. Your buddy has an AI-generated personality and talks back with its own voice. It gets proud when you keep a streak going and sulks when you lose two fights in a row.

Wanderling is a mobile-first web app (installable as a PWA) with a small Node server behind it.

## How it plays

| Tab | What you do there |
|---|---|
| **Home** | See your buddy, its mood and today's steps. Tap the beast to make it talk, and dress it from the wardrobe under it. |
| **Walk** | Start a walk. The phone's accelerometer counts your steps while the app is open. |
| **Map** | Watch your buddy walk on a real map of where you are, following your GPS. |
| **Store** | Spend points on upgrades and cosmetics, and pick up coin packs. |
| **Battle** | Challenge friends or nearby players, and climb the leaderboards. |
| **Profile** | Tap your name on Home: battle record, walking stats, step-history charts, your daily goal and recent battles. |

### Growing your buddy
- Every **100 steps = 1 Stride Point**. Leftover steps carry over.
- The buddy evolves as it levels: **Egg → Baby (Lv 5) → Teen (Lv 10) → Adult (Lv 20)**.
- Upgrades cost points: level costs 10 × level, and attack and evasion cost 5 × their current value.
- Cosmetics fill four slots: hat, eyewear, accessory and background.
- There are 14 background scenes. Ten cost Stride Points; the rare and legendary ones (Coral Reef, Volcano, Aurora, Throne Room) cost diamonds only.

### Battles
- Fights go until one beast is knocked out. Each buddy acts once per round, and the higher evasion stat gives a better chance of dodging.
- The buddy that deals the most total damage wins. A win pays **+5 Stride Points**.
- Lose a battle you started and that beast has to rest before its next one; your other beasts stay ready. The rest gets longer with every level (+5s each) and at each evolution: egg 30s, baby 1 min, teen 2 min, adult 4 min.
- Each species throws its own punch, and every miss has its own sound effect.

### Mood
Your buddy reacts to how your walking is going: **proud** (3+ day streak), **happy** (goal hit today), **eager**, **sleepy** (no steps yet today), **lonely** (3 days without a walk) and **upset** (two losses in a row; it gets over it in a couple of minutes).

<!-- the ideas were hidden. the layers were hidden. the name stays. -->

## Running it locally

Requires **Node 22.5+**.

```bash
npm install
cp .env.example .env   # then fill in the keys you have (see below)
npm start              # or: npm run dev  (restarts on file changes)
```

- App: http://localhost:3000
- Demo mode: http://localhost:3000/?demo=1 (adds a **Demo Walk** button on the Map tab, so you can test without walking around)

Demo opponents to battle or add as friends: `mira`, `theo`, `ana`. Adding a real player sends them a friend request to accept or decline; the demo accounts accept straight away, since nobody is there to answer.

### Environment variables

Every key is optional. Each one you leave out swaps in a fallback, so the app still runs with an empty `.env`. Never commit your real `.env`. It's gitignored for a reason.

| Variable | What it powers | Without it |
|---|---|---|
| `PORT` | Server port | `3000` |
| `DATA_DIR` | Where SQLite and cached voice clips live | `./data` |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | Buddy chat and personalities (Google Gemini) | Built-in lines |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` / `ELEVENLABS_MODEL` | The buddy's voice | Browser speech |
| `GOOGLE_MAPS_API_KEY` | The Map tab | Map tab asks for a key |
| `GOOGLE_MAPS_MAP_ID` | Tilted 3D map with buildings | Flat retro-styled map |
| `TIGER_DATABASE_URL` | Tiger Data (Postgres) as the database | Local SQLite |

| `APP_ORIGIN` | The site's public address, e.g. `https://wanderling.up.railway.app`. Only needed if a proxy rewrites the `Host` header and every action starts failing with "Cross-site request" | Taken from the request |

If `TIGER_DATABASE_URL` is set but unreachable at startup (for example, the service is paused), the server logs it and falls back to SQLite.

## Accounts and security

- **Passwords** must be 8–128 characters with a letter and a number, can't be the username or a very common password, and are typed twice at sign-up. They're stored only as salted scrypt hashes.
- **Sessions** are random tokens in an `HttpOnly`, `SameSite=Strict` cookie that lasts a year. Over HTTPS the cookie is also `Secure` and named with the `__Host-` prefix. The database stores only a SHA-256 hash of each token, so a database leak can't be used to sign in.
- **Every API call needs a valid session**, except sign-up, login, the username check and the personality list. Voice clips need one too.
- **Forged requests are refused.** Anything that changes data must carry the `x-wanderling` header and come from the site's own origin.
- **Brute force is limited.** After 10 wrong passwords a username is locked for 15 minutes, and each address gets 30 sign-in or sign-up attempts per 15 minutes.
- **Response headers:** a Content Security Policy, plus anti-framing, `nosniff` and HSTS over HTTPS.
- **Accounts from before passwords** have no password, so nobody can sign into them. The device that still holds such an account's old sign-in can use it once to set a password. Demo players (`mira`, `theo`, `ana`) can't be signed into.

The code lives in `server/auth.js`.

## Project layout

```
server/
  index.js      entry point: loads .env, opens the DB, starts the HTTP server
  app.js        routes (/api/...), static files, session checks
  auth.js       password hashing, session cookies, forged-request checks, rate limits, security headers
  game.js       pure game rules: points, levels, moods, battles, store items
  db.js         one interface over Tiger Data (Postgres) or SQLite, plus seeding
  ai.js         Gemini personalities/lines and ElevenLabs voice
public/
  index.html, manifest.webmanifest, sw.js   PWA shell and offline cache
  js/app.js     tab router
  js/screens/   home, walk, map, store, battle, profile, beast
  js/steps.js   accelerometer step counter
  js/gps.js     live location for the map
  js/fx.js      confetti, voice playback, sound effects
  sounds/       punch, miss, win and lose effects
  models/       3D buddy model for the map
scripts/        generate icons and the 3D buddy model
test/           node --test suite
```

## Scripts

| Command | Does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Run with auto-restart on changes |
| `npm test` | Run the test suite |
| `npm run icons` | Regenerate app icons |
| `npm run model` | Regenerate the 3D buddy model |

## Notes
- Coin packs are a **demo purchase**: buying one adds coins instantly, and no payment is taken.
- After changing frontend files, bump `CACHE` in `public/sw.js` so installed copies pick up the new version.
