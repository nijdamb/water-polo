"use strict";
(() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const W = canvas.width; // 960
  const H = canvas.height; // 540

  const GOAL_H = 150;
  const GOAL_TOP = (H - GOAL_H) / 2;
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
      ball: { x: W / 2, y: H / 2, vx: 0, vy: 0, carrier: null },
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
    };
    state.ball.carrier = state.players.find(
      (p) => p.team === kickoffTeam && p.kind === "field"
    );
  }

  function moveToward(p, tx, ty, dt, speedScale = 1) {
    const dx = tx - p.x;
    const dy = ty - p.y;
    const d = Math.hypot(dx, dy);
    if (d < 1) return;
    const step = Math.min(d, p.speed * speedScale * dt);
    p.x = clamp(p.x + (dx / d) * step, PLAYER_R, W - PLAYER_R);
    p.y = clamp(p.y + (dy / d) * step, PLAYER_R, H - PLAYER_R);
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
    if (ball.carrier !== p || p.cooldown > 0) return;
    const goalX = p.team === "blue" ? W : 0;
    const angle = Math.atan2(H / 2 - p.y, goalX - p.x) + (Math.random() - 0.5) * 0.22;
    const power = 560;
    ball.vx = Math.cos(angle) * power;
    ball.vy = Math.sin(angle) * power;
    ball.carrier = null;
    p.cooldown = 0.5;
    p.hold = 0;
    state.pickupCooldown = 0.35;
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
      p.x = clamp(p.x + (dx / d) * step, PLAYER_R, W - PLAYER_R);
      p.y = clamp(p.y + (dy / d) * step, PLAYER_R, H - PLAYER_R);
    }
  }

  function moveKeeper(k, dt) {
    const x = k.team === "blue" ? 18 : W - 18;
    const ball = state.ball;
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
      tx = ball.x;
      ty = ball.y;
      wantsSprint = dist(p, ball) > 110; // sprint only on long chases
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
      a.x = clamp(a.x - nx * push, PLAYER_R, W - PLAYER_R);
      a.y = clamp(a.y - ny * push, PLAYER_R, H - PLAYER_R);
      b.x = clamp(b.x + nx * push, PLAYER_R, W - PLAYER_R);
      b.y = clamp(b.y + ny * push, PLAYER_R, H - PLAYER_R);
    }
  }

  function goal(team) {
    state.score[team] += 1;
    state.banner = team === "blue" ? "GOAL! BLUE SCORES" : "GOAL! RED SCORES";
    state.bannerT = 1.5;
    const conceding = team === "blue" ? "red" : "blue";
    reset(conceding);
    state.banner = team === "blue" ? "GOAL! BLUE SCORES" : "GOAL! RED SCORES";
    state.bannerT = 1.5;
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
      const enemy = state.players.find(
        (p) => p.kind === "field" && p.team !== ball.carrier.team
      );
      const d = enemy ? dist(enemy, ball.carrier) : Infinity;
      if (enemy && d < TACKLE_RADIUS && state.stealCooldown <= 0) {
        if (!state.tackle || state.tackle.tackler !== enemy || state.tackle.carrier !== ball.carrier) {
          state.tackle = { carrier: ball.carrier, tackler: enemy, progress: 0 };
        }
        state.tackle.progress += dt;
        if (state.tackle.progress >= TACKLE_DURATION) {
          ball.carrier = enemy;
          enemy.hold = 0;
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
    const f = Math.pow(0.985, dt * 60);
    ball.vx *= f;
    ball.vy *= f;

    if (ball.y - BALL_R < 0) {
      ball.y = BALL_R;
      ball.vy = Math.abs(ball.vy);
    }
    if (ball.y + BALL_R > H) {
      ball.y = H - BALL_R;
      ball.vy = -Math.abs(ball.vy);
    }
    if (ball.x - BALL_R < 0) {
      if (ball.y > GOAL_TOP && ball.y < GOAL_BOT) return goal("red");
      ball.x = BALL_R;
      ball.vx = Math.abs(ball.vx);
    }
    if (ball.x + BALL_R > W) {
      if (ball.y > GOAL_TOP && ball.y < GOAL_BOT) return goal("blue");
      ball.x = W - BALL_R;
      ball.vx = -Math.abs(ball.vx);
    }

    for (const p of state.players) {
      if (p.kind !== "keeper") continue;
      const d = dist(p, ball);
      if (d < PLAYER_R + BALL_R) {
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
          ball.carrier = p;
          p.hold = 0;
          break;
        }
      }
    }
  }

  function update(dt) {
    if (state.over) return;
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
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#0e4d80");
    g.addColorStop(1, "#093a63");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 2;
    ctx.setLineDash([14, 12]);
    for (let y = 60; y < H; y += 60) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(W / 2, 0);
    ctx.lineTo(W / 2, H);
    ctx.stroke();
    ctx.setLineDash([]);

    // goal mouths with nets
    for (const side of [0, W]) {
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(side === 0 ? 0 : W - 10, GOAL_TOP, 10, GOAL_H);
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = 1;
      for (let y = GOAL_TOP + 12; y < GOAL_BOT; y += 12) {
        ctx.beginPath();
        ctx.moveTo(side === 0 ? 0 : W - 10, y);
        ctx.lineTo(side === 0 ? 10 : W, y);
        ctx.stroke();
      }
      ctx.strokeStyle = "#fde047";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(side, GOAL_TOP);
      ctx.lineTo(side, GOAL_BOT);
      ctx.stroke();
    }

    ctx.strokeStyle = "#1e3a5f";
    ctx.lineWidth = 6;
    ctx.strokeRect(0, 0, W, H);
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
      ctx.fillRect(0, H / 2 - 44, W, 88);
      ctx.fillStyle = "#fef08a";
      ctx.fillText(state.banner, W / 2, H / 2 + 15);
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

  function render() {
    drawPool();
    for (const p of state.players) drawPlayer(p);
    drawBall();
    drawTackle();
    drawOverlay();
  }

  addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    keys.add(key);
    if (e.key === " ") {
      e.preventDefault();
      shoot(state.players[0]);
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
