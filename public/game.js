"use strict";
(() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const W = canvas.width; // 960
  const H = canvas.height; // 540

  // The pool is inset in a deck: the edges are low and at water level, so the
  // ball can leave the field instead of bouncing off a wall.
  const DECK = 28;
  const POOL = { l: DECK, t: DECK, r: W - DECK, b: H - DECK };
  const GOAL_H = 150;
  const GOAL_TOP = POOL.t + (POOL.b - POOL.t - GOAL_H) / 2;
  const GOAL_BOT = GOAL_TOP + GOAL_H;
  const PLAYER_R = 16;
  const BALL_R = 9;
  const MATCH_SECONDS = 90;

  // Sprint: both field players share the same stamina rules, so a well-timed
  // sprint can shake off or catch the AI.
  const SPRINT_MULT = 1.65;
  const STAM_MAX = 100;
  const STAM_DRAIN = 30;
  const STAM_REGEN = 20;
  const STAM_SPRINT_MIN = 25;

  // A steal needs sustained contact, not a single touch: the tackler must stay
  // within TACKLE_RADIUS for TACKLE_DURATION seconds. Breaking contact resets
  // the tackle, so a sprint always leaves room to escape.
  const TACKLE_RADIUS = PLAYER_R * 2 + 2;
  const TACKLE_DURATION = 0.9;

  // The AI does not react instantly: when its intent changes (new ball
  // carrier, or a new sprint) it waits a randomized reaction time first.
  // The attacker always has the first move.
  const REACTION_MIN = 0.15;
  const REACTION_MAX = 0.4;

  // Goalies react to a shot with their own randomized delay; until it elapses
  // they hold their line instead of tracking the ball perfectly. Afterwards
  // they move to the predicted goal-line crossing point.
  const GOALIE_REACTION_MIN = 0.2;
  const GOALIE_REACTION_MAX = 0.5;
  const SHOT_SPEED = 320; // ball speed above which a keeper is reacting to a shot

  // Keeper catches and passes: a blocked shot is either parried back into the
  // field or caught. A caught ball is passed to the team's field player. Long
  // passes are high passes: less accurate (but each pass can be perfect), and
  // catchable only near the landing point.
  const CATCH_CHANCE = 0.45;
  const PERFECT_PASS_CHANCE = 0.25;
  const PASS_SPEED = 520;
  const HIGH_PASS_DIST = 420;
  const MAX_PASS_DIST = 900;
  const MAX_PASS_ERROR = 50; // px of sideways error on the longest imperfect pass (inside INTERCEPT_RADIUS)
  const INTERCEPT_RADIUS = 70; // high passes are catchable only near the aim point

  const scoreEl = document.getElementById("score");
  const timerEl = document.getElementById("timer");
  const keys = new Set();
  let state;

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function makePlayer(x, y, team, kind) {
    return {
      x, y, team, kind,
      speed: kind === "keeper" ? 330 : team === "blue" ? 275 : 235,
      cooldown: 0, // shoot cooldown
      hold: 0,     // time spent carrying the ball
      stamina: STAM_MAX,
      sprinting: false,
      reaction: 0, // remaining reaction delay before acting on a new intent
      shotPending: false, // keeper: a shot is incoming and its reaction is armed
      lastCarrier: null,
      sprintIntent: false,
    };
  }

  function reset(kickoffTeam) {
    state = {
      ball: { x: W / 2, y: H / 2, vx: 0, vy: 0, carrier: null, pass: null, lastTouch: null },
      players: [
        makePlayer(W * 0.3, H / 2, "blue", "field"),   // you
        makePlayer(18, H / 2, "blue", "keeper"),
        makePlayer(W * 0.7, H / 2, "red", "field"),    // AI
        makePlayer(W - 18, H / 2, "red", "keeper"),
      ],
      score: state ? state.score : { blue: 0, red: 0 },
      timeLeft: MATCH_SECONDS,
      over: false,
      banner: null,
      bannerT: 0,
      pickupCooldown: 0,
      stealCooldown: 0,
      tackle: null,
      waiting: false, // paused after a goal / out of bounds until the user presses Space
    };
    state.ball.carrier = state.players.find(
      (p) => p.team === kickoffTeam && p.kind === "field"
    );
    state.ball.lastTouch = kickoffTeam;
  }

  function moveToward(p, tx, ty, dt, speedScale = 1) {
    const dx = tx - p.x;
    const dy = ty - p.y;
    const d = Math.hypot(dx, dy);
    if (d < 1) return;
    const step = Math.min(d, p.speed * speedScale * dt);
    p.x = clamp(p.x + (dx / d) * step, POOL.l + PLAYER_R, POOL.r - PLAYER_R);
    p.y = clamp(p.y + (dy / d) * step, POOL.t + PLAYER_R, POOL.b - PLAYER_R);
  }

  function updateStamina(p, wantsSprint, dt) {
    if (p.kind !== "field") {
      p.sprinting = false;
      return;
    }
    // hysteresis: sprint can start above STAM_SPRINT_MIN, keeps going until empty
    if (wantsSprint && (p.sprinting ? p.stamina > 0 : p.stamina >= STAM_SPRINT_MIN)) {
      p.sprinting = true;
      p.stamina = Math.max(0, p.stamina - STAM_DRAIN * dt);
    } else {
      p.sprinting = false;
      p.stamina = Math.min(STAM_MAX, p.stamina + STAM_REGEN * dt);
    }
  }

  function moveScale(p) {
    let scale = state.ball.carrier === p ? 0.9 : 1;
    if (p.sprinting) scale *= SPRINT_MULT;
    return scale;
  }

  function shoot(p) {
    const ball = state.ball;
    if (p.kind !== "field" || ball.carrier !== p || p.cooldown > 0) return;
    const goalX = p.team === "blue" ? W : 0;
    const angle = Math.atan2(H / 2 - p.y, goalX - p.x) + (Math.random() - 0.5) * 0.22;
    const power = 560;
    ball.vx = Math.cos(angle) * power;
    ball.vy = Math.sin(angle) * power;
    ball.carrier = null;
    ball.lastTouch = p.team;
    p.cooldown = 0.5;
    p.hold = 0;
    state.pickupCooldown = 0.35;
  }

  function pass(k, target) {
    const ball = state.ball;
    if (ball.carrier !== k || k.cooldown > 0 || !target) return;
    const d = dist(k, target);
    const aim = { x: target.x, y: target.y };
    // every pass has a chance to be perfectly accurate; otherwise the sideways
    // error grows with distance
    if (Math.random() >= PERFECT_PASS_CHANCE) {
      const err = (Math.random() - 0.5) * 2 * Math.min(d / MAX_PASS_DIST, 1) * MAX_PASS_ERROR;
      const side = Math.atan2(target.y - k.y, target.x - k.x) + Math.PI / 2;
      aim.x += Math.cos(side) * err;
      aim.y += Math.sin(side) * err;
    }
    const ang = Math.atan2(aim.y - k.y, aim.x - k.x);
    const speed = PASS_SPEED + d * 0.15; // long passes are thrown harder so they reach the full length
    ball.vx = Math.cos(ang) * speed;
    ball.vy = Math.sin(ang) * speed;
    ball.carrier = null;
    ball.lastTouch = k.team;
    ball.pass = { high: d > HIGH_PASS_DIST, aimX: aim.x, aimY: aim.y };
    k.cooldown = 0.8;
    k.hold = 0;
    state.pickupCooldown = ball.pass.high ? 0.1 : 0.3;
  }

  function moveHuman(p, dt) {
    let dx = 0;
    let dy = 0;
    if (keys.has("arrowleft") || keys.has("a")) dx -= 1;
    if (keys.has("arrowright") || keys.has("d")) dx += 1;
    if (keys.has("arrowup") || keys.has("w")) dy -= 1;
    if (keys.has("arrowdown") || keys.has("s")) dy += 1;
    const moving = dx !== 0 || dy !== 0;
    updateStamina(p, moving && keys.has("shift"), dt);
    if (moving) {
      const d = Math.hypot(dx, dy);
      const step = p.speed * moveScale(p) * dt;
      p.x = clamp(p.x + (dx / d) * step, POOL.l + PLAYER_R, POOL.r - PLAYER_R);
      p.y = clamp(p.y + (dy / d) * step, POOL.t + PLAYER_R, POOL.b - PLAYER_R);
    }
  }

  function moveKeeper(k, dt) {
    const ball = state.ball;
    if (ball.carrier === k) {
      // holding the ball: pass to the field player after a reaction delay
      k.reaction -= dt;
      if (k.reaction <= 0) {
        pass(k, state.players.find((p) => p.team === k.team && p.kind === "field"));
      }
      return;
    }
    const x = k.team === "blue" ? POOL.l + PLAYER_R : POOL.r - PLAYER_R;
    const incoming = k.team === "blue" ? ball.vx < 0 : ball.vx > 0;
    const speed = Math.hypot(ball.vx, ball.vy);
    if (!ball.carrier && incoming && speed > SHOT_SPEED) {
      // arm the reaction delay once per shot, not every frame
      if (!k.shotPending) {
        k.shotPending = true;
        k.reaction = GOALIE_REACTION_MIN + Math.random() * (GOALIE_REACTION_MAX - GOALIE_REACTION_MIN);
      }
      k.reaction -= dt;
      if (k.reaction > 0) {
        // still reacting: hold the current line
        moveToward(k, x, k.y, dt);
        return;
      }
      // predict where the ball crosses this goal line
      const t = (x - ball.x) / ball.vx;
      const targetY = clamp(ball.y + ball.vy * t, GOAL_TOP + 26, GOAL_BOT - 26);
      moveToward(k, x, targetY, dt);
      return;
    }
    k.shotPending = false;
    k.reaction = 0;
    const targetY = clamp(ball.y, GOAL_TOP + 26, GOAL_BOT - 26);
    moveToward(k, x, targetY, dt);
  }

  function moveAI(p, dt) {
    const ball = state.ball;
    // A new ball carrier costs reaction time, just like in real play.
    if (ball.carrier !== p.lastCarrier) {
      p.lastCarrier = ball.carrier;
      p.reaction = REACTION_MIN + Math.random() * (REACTION_MAX - REACTION_MIN);
    }
    let tx;
    let ty;
    let wantsSprint = false;
    if (ball.carrier === p) {
      p.hold += dt;
      // dribble toward the player's goal, then shoot
      tx = 40;
      ty = H / 2 + Math.sin(state.timeLeft * 3) * 70;
      wantsSprint = p.x > W * 0.45; // sprint the run-in to the goal
      if (p.x < W * 0.5 || p.hold > 1.4) shoot(p);
    } else if (!ball.carrier) {
      if (ball.pass) {
        // go to the landing point to receive or intercept the pass
        tx = ball.pass.aimX;
        ty = ball.pass.aimY;
      } else {
        tx = ball.x;
        ty = ball.y;
      }
      wantsSprint = dist(p, { x: tx, y: ty }) > 110; // sprint only on long chases
    } else if (ball.carrier.team === p.team) {
      // our keeper has the ball: move to a support spot to receive the pass
      tx = p.team === "red" ? W * 0.35 : W * 0.65;
      ty = H / 2 + Math.sin(state.timeLeft * 2) * 80;
    } else if (ball.carrier.kind === "keeper") {
      // the opponent goalie has it: keepers cannot be tackled, so drop back
      // and protect our own goal instead of pressing
      tx = p.team === "red" ? W * 0.78 : W * 0.22;
      ty = clamp(ball.y, GOAL_TOP + 40, GOAL_BOT - 40);
      wantsSprint = dist(p, { x: tx, y: ty }) > 150;
    } else {
      // pressure the carrier to steal the ball
      tx = ball.carrier.x;
      ty = ball.carrier.y;
      wantsSprint = dist(p, ball.carrier) > 40; // sprint to keep contact while pressing
    }
    // Starting to sprint also costs a fresh, randomized reaction delay.
    if (wantsSprint && !p.sprintIntent) {
      p.reaction = REACTION_MIN + Math.random() * (REACTION_MAX - REACTION_MIN);
    }
    p.sprintIntent = wantsSprint;
    p.reaction = Math.max(0, p.reaction - dt);
    updateStamina(p, wantsSprint && p.reaction <= 0, dt);
    moveToward(p, tx, ty, dt, moveScale(p));
  }

  function separate(a, b) {
    const d = dist(a, b);
    const min = PLAYER_R * 2;
    if (d > 0 && d < min) {
      const push = (min - d) / 2;
      const nx = (b.x - a.x) / d;
      const ny = (b.y - a.y) / d;
      a.x = clamp(a.x - nx * push, POOL.l + PLAYER_R, POOL.r - PLAYER_R);
      a.y = clamp(a.y - ny * push, POOL.t + PLAYER_R, POOL.b - PLAYER_R);
      b.x = clamp(b.x + nx * push, POOL.l + PLAYER_R, POOL.r - PLAYER_R);
      b.y = clamp(b.y + ny * push, POOL.t + PLAYER_R, POOL.b - PLAYER_R);
    }
  }

  function goal(team) {
    state.score[team] += 1;
    const text = team === "blue" ? "GOAL! BLUE SCORES" : "GOAL! RED SCORES";
    // set up the kickoff right away (ball at the center, conceding team in
    // possession), then freeze until the user presses Space
    reset(team === "blue" ? "red" : "blue");
    state.banner = text;
    state.waiting = true;
  }

  // The ball left the pool: put the free ball in the hands of the opponent at
  // the spot where it went out, then freeze until the user presses Space.
  function outOfBounds() {
    const forTeam = state.ball.lastTouch === "blue" ? "red" : "blue";
    const spot = {
      x: clamp(state.ball.x, POOL.l + BALL_R + 6, POOL.r - BALL_R - 6),
      y: clamp(state.ball.y, POOL.t + BALL_R + 6, POOL.b - BALL_R - 6),
    };
    const p = state.players.find((q) => q.team === forTeam && q.kind === "field");
    p.x = spot.x;
    p.y = spot.y;
    state.ball.x = spot.x;
    state.ball.y = spot.y;
    state.ball.vx = 0;
    state.ball.vy = 0;
    state.ball.pass = null;
    state.ball.carrier = p;
    state.ball.lastTouch = forTeam;
    p.hold = 0;
    state.pickupCooldown = 0.5;
    state.banner = `OUT — FREE BALL ${forTeam.toUpperCase()}`;
    state.waiting = true;
  }

  function resumePlay() {
    state.waiting = false;
    state.bannerT = 1.2; // let the banner fade out after continuing
  }

  function physics(dt) {
    const ball = state.ball;
    state.pickupCooldown -= dt;
    state.stealCooldown -= dt;
    for (const p of state.players) p.cooldown -= dt;

    if (ball.carrier) {
      ball.x = ball.carrier.x;
      ball.y = ball.carrier.y;
      ball.vx = 0;
      ball.vy = 0;
      const enemy =
        ball.carrier.kind === "field"
          ? state.players.find((p) => p.kind === "field" && p.team !== ball.carrier.team)
          : null; // keepers cannot be tackled
      const d = enemy ? dist(enemy, ball.carrier) : Infinity;
      if (enemy && d < TACKLE_RADIUS && state.stealCooldown <= 0) {
        if (!state.tackle || state.tackle.tackler !== enemy || state.tackle.carrier !== ball.carrier) {
          state.tackle = { carrier: ball.carrier, tackler: enemy, progress: 0 };
        }
        state.tackle.progress += dt;
        if (state.tackle.progress >= TACKLE_DURATION) {
          ball.carrier = enemy;
          enemy.hold = 0;
          ball.lastTouch = enemy.team;
          state.stealCooldown = 1.2;
          state.tackle = null;
        }
      } else {
        // contact broken (or no enemy nearby): the tackle resets
        state.tackle = null;
      }
      return;
    }

    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    // a passed ball flies farther than a rolling one
    const f = Math.pow(ball.pass ? 0.995 : 0.985, dt * 60);
    ball.vx *= f;
    ball.vy *= f;
    // keep an out-of-bounds ball visible as it rolls onto the deck
    ball.x = clamp(ball.x, POOL.l - DECK - 12, POOL.r + DECK + 12);
    ball.y = clamp(ball.y, POOL.t - DECK - 12, POOL.b + DECK + 12);

    // Pool edges are low: no wall bounces. Goals only count inside the mouth;
    // anywhere else the ball is out of bounds and the opponent gets a free ball.
    if (ball.x - BALL_R < POOL.l) {
      if (ball.y > GOAL_TOP && ball.y < GOAL_BOT) return goal("red");
      outOfBounds();
      return;
    }
    if (ball.x + BALL_R > POOL.r) {
      if (ball.y > GOAL_TOP && ball.y < GOAL_BOT) return goal("blue");
      outOfBounds();
      return;
    }
    if (ball.y - BALL_R < POOL.t || ball.y + BALL_R > POOL.b) {
      outOfBounds();
      return;
    }

    if (!state.waiting) {
      for (const p of state.players) {
        // a keeper cannot touch the ball right after passing it (grace window)
        if (p.kind !== "keeper" || p.cooldown > 0) continue;
        const d = dist(p, ball);
        if (d < PLAYER_R + BALL_R) {
          ball.lastTouch = p.team;
          if (Math.random() < CATCH_CHANCE) {
            // caught: the keeper holds the ball and will pass it out
            ball.carrier = p;
            ball.vx = 0;
            ball.vy = 0;
            ball.pass = null;
            p.reaction = REACTION_MIN + Math.random() * (REACTION_MAX - REACTION_MIN);
            p.hold = 0;
            state.pickupCooldown = 0.8;
            continue;
          }
          const nx = (ball.x - p.x) / (d || 1);
          const ny = (ball.y - p.y) / (d || 1);
          const speed = Math.max(Math.hypot(ball.vx, ball.vy) * 0.9, 180);
          ball.vx = nx * speed;
          ball.vy = ny * speed;
          ball.x = p.x + nx * (PLAYER_R + BALL_R + 1);
          ball.y = p.y + ny * (PLAYER_R + BALL_R + 1);
        }
      }

      if (state.pickupCooldown <= 0) {
        for (const p of state.players) {
          if (p.kind !== "field") continue;
          if (dist(p, ball) < PLAYER_R + BALL_R + 2) {
            // a high pass can only be caught close to its landing point
            if (
              ball.pass &&
              ball.pass.high &&
              Math.hypot(ball.x - ball.pass.aimX, ball.y - ball.pass.aimY) > INTERCEPT_RADIUS
            ) {
              continue;
            }
            ball.carrier = p;
            ball.lastTouch = p.team;
            p.hold = 0;
            ball.pass = null;
            break;
          }
        }
      }
    }
    // once a pass dies (rolls out), it becomes a normal loose ball
    if (ball.pass && Math.hypot(ball.vx, ball.vy) < 60) ball.pass = null;
  }

  function update(dt) {
    if (state.over || state.waiting) return; // frozen on goals / out of bounds until Space
    state.timeLeft -= dt;
    if (state.timeLeft <= 0) {
      state.timeLeft = 0;
      state.over = true;
      return;
    }
    if (state.bannerT > 0) {
      state.bannerT -= dt;
      if (state.bannerT <= 0) state.banner = null;
    }

    const [you, keeperBlue, ai, keeperRed] = state.players;
    moveHuman(you, dt);
    moveKeeper(keeperBlue, dt);
    moveAI(ai, dt);
    moveKeeper(keeperRed, dt);
    separate(you, ai);
    physics(dt);
    updateHud();
  }

  function updateHud() {
    scoreEl.textContent = `BLUE ${state.score.blue} : ${state.score.red} RED`;
    const s = Math.ceil(state.timeLeft);
    timerEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function drawPool() {
    // deck around the pool — the ball can roll out here
    ctx.fillStyle = "#0a1626";
    ctx.fillRect(0, 0, W, H);

    const g = ctx.createLinearGradient(0, POOL.t, 0, POOL.b);
    g.addColorStop(0, "#0e4d80");
    g.addColorStop(1, "#093a63");
    ctx.fillStyle = g;
    ctx.fillRect(POOL.l, POOL.t, POOL.r - POOL.l, POOL.b - POOL.t);

    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 2;
    ctx.setLineDash([14, 12]);
    for (let y = POOL.t + 60; y < POOL.b; y += 60) {
      ctx.beginPath();
      ctx.moveTo(POOL.l, y);
      ctx.lineTo(POOL.r, y);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(W / 2, POOL.t);
    ctx.lineTo(W / 2, POOL.b);
    ctx.stroke();
    ctx.setLineDash([]);

    // goal mouths with nets on the pool edges
    for (const side of [POOL.l, POOL.r]) {
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(side === POOL.l ? side : side - 10, GOAL_TOP, 10, GOAL_H);
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = 1;
      for (let y = GOAL_TOP + 12; y < GOAL_BOT; y += 12) {
        ctx.beginPath();
        ctx.moveTo(side === POOL.l ? side : side - 10, y);
        ctx.lineTo(side === POOL.l ? side + 10 : side, y);
        ctx.stroke();
      }
      ctx.strokeStyle = "#fde047";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(side, GOAL_TOP);
      ctx.lineTo(side, GOAL_BOT);
      ctx.stroke();
    }

    // low pool coping — no wall to bounce on
    ctx.strokeStyle = "#3b6ea5";
    ctx.lineWidth = 5;
    ctx.strokeRect(POOL.l, POOL.t, POOL.r - POOL.l, POOL.b - POOL.t);
  }

  function drawPlayer(p) {
    ctx.beginPath();
    ctx.ellipse(p.x + 3, p.y + 5, PLAYER_R * 0.9, PLAYER_R * 0.6, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(p.x, p.y, PLAYER_R, 0, Math.PI * 2);
    ctx.fillStyle = p.team === "blue" ? "#3b82f6" : "#ef4444";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.stroke();

    // cap: keepers wear yellow
    ctx.beginPath();
    ctx.arc(p.x, p.y, PLAYER_R * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = p.kind === "keeper" ? "#facc15" : p.team === "blue" ? "#1d4ed8" : "#b91c1c";
    ctx.fill();

    if (p.kind === "field") {
      const w = 30;
      const h = 4;
      const x = p.x - w / 2;
      const y = p.y - PLAYER_R - 10;
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(x, y, w, h);
      const ratio = p.stamina / STAM_MAX;
      ctx.fillStyle = p.sprinting ? "#fef08a" : ratio > 0.35 ? "#4ade80" : "#f87171";
      ctx.fillRect(x, y, w * ratio, h);
    }
  }

  function drawBall() {
    const b = state.ball;
    ctx.beginPath();
    ctx.ellipse(b.x + 2, b.y + 3, BALL_R, BALL_R * 0.7, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = "#f8fafc";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#334155";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(b.x, b.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#334155";
    ctx.fill();
  }

  function drawOverlay() {
    if (state.banner) {
      ctx.font = "bold 42px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(0, H / 2 - 44, W, state.waiting ? 128 : 88);
      ctx.fillStyle = "#fef08a";
      ctx.fillText(state.banner, W / 2, H / 2 + 15);
      if (state.waiting) {
        ctx.font = "18px ui-monospace, monospace";
        ctx.fillStyle = "#93c5fd";
        ctx.fillText("press Space to continue", W / 2, H / 2 + 48);
      }
    }
    if (state.over) {
      ctx.fillStyle = "rgba(2,6,23,0.75)";
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = "center";
      ctx.fillStyle = "#dbeafe";
      ctx.font = "bold 44px ui-monospace, monospace";
      ctx.fillText("FULL TIME", W / 2, H / 2 - 30);
      ctx.font = "bold 30px ui-monospace, monospace";
      ctx.fillStyle = "#93c5fd";
      ctx.fillText(
        `BLUE ${state.score.blue} : ${state.score.red} RED`,
        W / 2,
        H / 2 + 16
      );
      ctx.font = "18px ui-monospace, monospace";
      ctx.fillStyle = "#7d9bbd";
      ctx.fillText("Press R to play again", W / 2, H / 2 + 56);
    }
  }

  function drawTackle() {
    const t = state.tackle;
    if (!t || !t.carrier) return;
    ctx.beginPath();
    ctx.arc(
      t.carrier.x,
      t.carrier.y,
      PLAYER_R + 7,
      -Math.PI / 2,
      -Math.PI / 2 + Math.min(t.progress / TACKLE_DURATION, 1) * Math.PI * 2
    );
    ctx.strokeStyle = "#f87171";
    ctx.lineWidth = 4;
    ctx.stroke();
  }

  function drawPassTarget() {
    const c = state.ball.carrier;
    if (!c || c.kind !== "keeper") return;
    const mate = state.players.find((p) => p.team === c.team && p.kind === "field");
    if (!mate) return;
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(mate.x, mate.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function render() {
    drawPool();
    for (const p of state.players) drawPlayer(p);
    drawBall();
    drawPassTarget();
    drawTackle();
    drawOverlay();
  }

  addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    keys.add(key);
    if ((e.key === " " || e.key === "Enter") && state.waiting) {
      e.preventDefault();
      resumePlay();
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      const carrier = state.ball.carrier;
      if (carrier === state.players[0]) shoot(carrier);
      else if (carrier === state.players[1]) pass(carrier, state.players[0]); // your goalie passes to you
    }
    if (key === "r" && state.over) reset("blue");
  });
  addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }

  reset("blue");
  requestAnimationFrame(frame);
})();
