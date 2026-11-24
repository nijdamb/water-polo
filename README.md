# Water Polo (Cloudflare Worker)

A simple in-browser, top-down water polo game. A Cloudflare Worker serves the
static game (HTML + canvas JS) and a small JSON endpoint. You play blue against
an AI attacker in red; each side has a goalie. First draft: single player vs
AI, all game logic runs client-side.

## Run locally

```bash
npm install
npm run dev
```

Then open http://localhost:8787 — play at `/`, worker info at `/api/info`.

## Controls

- Move: WASD or arrow keys
- Sprint: Shift (drains stamina; the AI follows the same stamina rules)
- Shoot: Space
- Steals need ~1s of sustained contact; sprint away to cancel a tackle
- Restart after full time: R

## Deploy

```bash
npx wrangler login   # once, to authenticate
npm run deploy
```

`npm run dry-run` validates a deploy without publishing.

## How it works

- `src/index.ts` — Worker entrypoint. Serves `/api/info` as JSON and delegates
  everything else to the static assets binding (`public/`).
- `public/index.html` + `public/game.js` — the game. Canvas 2D, fixed pool
  size 960x540, requestAnimationFrame loop with delta-time physics.
- `wrangler.jsonc` — Worker config: assets served through the Worker
  (`run_worker_first`), observability enabled.

## Ideas for next steps

- Real-time multiplayer: a Durable Object per match running the authoritative
  game loop over WebSockets (clients send inputs, the DO broadcasts state).
- Leaderboard: persist high scores in KV or D1.
- More players per team, passing, and a shot clock.
