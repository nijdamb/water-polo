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

Then open http://localhost:8787 to play (`/`), worker info at `/api/info`.

## Controls

- Move: WASD or arrow keys
- Sprint: Shift (drains stamina; the AI follows the same stamina rules)
- Shoot: Space
- Steals need ~1s of sustained contact; sprint away to cancel a tackle
- Goalies catch some blocked shots and pass to their field player. Press Space
  to pass when your goalie has the ball. Long passes are high passes: more
  sideways error (but each pass can roll perfectly accurate), and catchable
  only near the landing point
- Pool edges are low: the ball can go out of bounds (no wall bounces). The
  opponent then gets a free ball at the spot where it went out
- Goals and out-of-bounds freeze play until you press Space to continue
- The AI reacts with a randomized delay (~0.15-0.4s) to a new ball carrier or a
  new sprint, so the attacker always has the first move
- Goalies hold their line for a randomized reaction delay (~0.2-0.5s) when a
  shot comes in, then dive to the predicted crossing point, so close hard
  shots can beat them
- Restart after full time: R
- Kit follows water polo convention. Home wears white, the visiting team
  navy, and both keepers wear red caps with a team-colour accent

## Deploy

```bash
npx wrangler login   # once, to authenticate
npm run deploy
```

`npm run dry-run` validates a deploy without publishing.

## SEO / sharing

- `public/index.html` carries meta description, canonical URL, Open Graph and
  Twitter card tags pointing at `/og-image.png` (1200x630).
- `public/og-image.png` is a real screenshot of the game, rendered with
  Playwright at 1200x630. `public/favicon.svg` + `public/favicon-32.png` are
  the favicons. Regenerate the images by screenshotting the dev server with
  Playwright (see git history for the one-off script approach).

## How it works

- `src/index.ts`: Worker entrypoint. Serves `/api/info` as JSON and delegates
  everything else to the static assets binding (`public/`).
- `public/index.html` + `public/game.js`: the game. Canvas 2D, fixed pool
  size 960x540, requestAnimationFrame loop with delta-time physics.
- `wrangler.jsonc`: Worker config: assets served through the Worker
  (`run_worker_first`), observability enabled.

## Ideas for next steps

- Real-time multiplayer: a Durable Object per match running the authoritative
  game loop over WebSockets (clients send inputs, the DO broadcasts state).
- Leaderboard: persist high scores in KV or D1.
- More players per team, passing, and a shot clock.
