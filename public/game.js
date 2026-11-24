import { createControls } from "./controls.js";

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
  const SHOT_TARGET_X = POOL.r - BALL_R;
  const SHOT_TARGET_INSET = BALL_R + 6;
  const QUICK_SHOT_SPEED = 460;
  const POWER_SHOT_SPEED = 780;
  const MATCH_SECONDS = 90;
  const RESUME_DELAY = 1.5; // countdown after pressing Space on a frozen scene

  // Water polo kit: home team white, visiting team navy; both keepers wear a
  // red cap with the team colour as accent.
  const TEAM_STYLE = {
    blue: { name: "HOME", body: "#e2e8f0", cap: "#f8fafc", keeperCap: "#dc2626", accent: "#f8fafc" },
    red: { name: "AWAY", body: "#1e3a8a", cap: "#2563eb", keeperCap: "#dc2626", accent: "#60a5fa" },
  };

  const FIELD_MOVEMENT = {
    blue: { speed: 255, maxStamina: 110, staminaRecovery: 23 },
    red: { speed: 210, maxStamina: 100, staminaRecovery: 20 },
  };
  const SPRINT_MULT = 1.65;
  const STAM_DRAIN = 30;
  const STAM_SPRINT_MIN = 25;

  const TACKLE_RADIUS = PLAYER_R * 2 + 2;
  const HOME_TACKLE_DURATION = 0.9;
  const AWAY_TACKLE_DURATION = 1.55;
  const AWAY_PRESS_LINE = W * 0.60;
  const AWAY_GUARD_X = W * 0.73;
  const AWAY_DEFENSIVE_PACE = 0.82;

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
  const KEEPER_REACTION_SPEED = 320;
  const AWAY_KEEPER_READY_RANGE = 14;

  // Keeper catches and passes: a blocked shot is either parried back into the
  // field or caught. A caught ball is passed to the team's field player. Long
  // passes are high passes: less accurate (but each pass can be perfect), and
  // catchable only near the landing point.
  const CATCH_CHANCE = 0.45;
  const PERFECT_PASS_CHANCE = 0.25;
  const PASS_SPEED = 520;
  const PASS_DRAG = 0.995;
  const PASS_DECAY_RATE = -60 * Math.log(PASS_DRAG);
  const HIGH_PASS_DIST = 420;
  const MAX_PASS_DIST = 900;
  const MAX_PASS_ERROR = 50; // px of sideways error on the longest imperfect pass (inside INTERCEPT_RADIUS)
  const MAX_HOME_HIGH_PASS_ERROR = 18;
  const INTERCEPT_RADIUS = 70; // high passes are catchable only near the aim point

  const scoreEl = document.getElementById("score");
  const timerEl = document.getElementById("timer");
  let state;
  let frameRequest;
  let lastFrame;
  const controls = createControls(getAction, runAction, syncAnimation);

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function makePlayer(x, y, team, kind) {
    const movement = FIELD_MOVEMENT[team];
    return {
      x, y, team, kind,
      speed: kind === "keeper" ? 330 : movement.speed,
      cooldown: 0, // shoot cooldown
      hold: 0,     // time spent carrying the ball
      stamina: movement.maxStamina,
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
      countdown: 0,   // >0 while counting down after Space before play resumes
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
      const { maxStamina, staminaRecovery } = FIELD_MOVEMENT[p.team];
      p.stamina = Math.min(maxStamina, p.stamina + staminaRecovery * dt);
    }
  }

  function moveScale(p) {
    let scale = state.ball.carrier === p ? 0.9 : 1;
    if (p.sprinting) scale *= SPRINT_MULT;
    return scale;
  }

  function shotTargetY() {
    const { y } = state.players[0];
    const poolSpan = POOL.b - POOL.t - PLAYER_R * 2;
    const position = clamp((y - POOL.t - PLAYER_R) / poolSpan, 0, 1);
    return GOAL_TOP + SHOT_TARGET_INSET + position * (GOAL_H - SHOT_TARGET_INSET * 2);
  }

  function shoot(p, angle, speed) {
    const ball = state.ball;
    if (p.kind !== "field" || ball.carrier !== p || p.cooldown > 0) return;
    ball.x = p.x;
    ball.y = p.y;
    ball.vx = Math.cos(angle) * speed;
    ball.vy = Math.sin(angle) * speed;
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
    const high = d > HIGH_PASS_DIST;
    const leadSwimmer = high && k.team === "blue";
    const speed = PASS_SPEED + d * 0.15;
    const aim = leadSwimmer ? leadPass(k, target, speed) : { x: target.x, y: target.y };
    // every pass has a chance to be perfectly accurate; otherwise the sideways
    // error grows with distance
    if (Math.random() >= PERFECT_PASS_CHANCE) {
      const maxError = leadSwimmer ? MAX_HOME_HIGH_PASS_ERROR : MAX_PASS_ERROR;
      const err = (Math.random() - 0.5) * 2 * Math.min(d / MAX_PASS_DIST, 1) * maxError;
      const side = Math.atan2(aim.y - k.y, aim.x - k.x) + Math.PI / 2;
      aim.x += Math.cos(side) * err;
      aim.y += Math.sin(side) * err;
    }
    if (leadSwimmer) {
      aim.x = clamp(aim.x, POOL.l + PLAYER_R, POOL.r - PLAYER_R);
      aim.y = clamp(aim.y, POOL.t + PLAYER_R, POOL.b - PLAYER_R);
    }
    const ang = Math.atan2(aim.y - k.y, aim.x - k.x);
    ball.vx = Math.cos(ang) * speed;
    ball.vy = Math.sin(ang) * speed;
    ball.carrier = null;
    ball.lastTouch = k.team;
    ball.pass = { airborne: high, aimX: aim.x, aimY: aim.y };
    k.cooldown = 0.8;
    k.hold = 0;
    state.pickupCooldown = high ? 0.1 : 0.3;
  }

  function leadPass(keeper, swimmer, speed) {
    const velocity = swimVelocity(swimmer, controls.movement());
    if (velocity.x === 0 && velocity.y === 0) return { x: swimmer.x, y: swimmer.y };

    let earliest = 0;
    let latest = 3; // A high pass covers the pool's diagonal in under three seconds.
    let x, y;
    for (let i = 0; i < 10; i++) {
      const time = (earliest + latest) / 2;
      x = clamp(swimmer.x + velocity.x * time, POOL.l + PLAYER_R, POOL.r - PLAYER_R);
      y = clamp(swimmer.y + velocity.y * time, POOL.t + PLAYER_R, POOL.b - PLAYER_R);
      const travel = speed * (1 - Math.exp(-PASS_DECAY_RATE * time)) / PASS_DECAY_RATE;
      if (travel < Math.hypot(x - keeper.x, y - keeper.y)) earliest = time;
      else latest = time;
    }
    return { x, y };
  }

  function swimVelocity(p, { x, y }) {
    const directionLength = Math.hypot(x, y);
    const scale = directionLength > 0 ? p.speed * moveScale(p) / directionLength : 0;
    return { x: x * scale, y: y * scale };
  }

  function moveHuman(p, dt) {
    const movement = controls.movement();
    const moving = movement.x !== 0 || movement.y !== 0;
    updateStamina(p, moving && movement.sprint, dt);
    if (!moving) return;
    const velocity = swimVelocity(p, movement);
    p.x = clamp(p.x + velocity.x * dt, POOL.l + PLAYER_R, POOL.r - PLAYER_R);
    p.y = clamp(p.y + velocity.y * dt, POOL.t + PLAYER_R, POOL.b - PLAYER_R);
  }

  function moveKeeper(k, dt) {
    const ball = state.ball;
    if (ball.carrier === k) {
      if (k.team === "blue") return;
      k.reaction -= dt;
      if (k.reaction <= 0) {
        pass(k, state.players.find((p) => p.team === k.team && p.kind === "field"));
      }
      return;
    }
    const x = k.team === "blue" ? POOL.l + PLAYER_R : POOL.r - PLAYER_R;
    const incoming = k.team === "blue" ? ball.vx < 0 : ball.vx > 0;
    const speed = Math.hypot(ball.vx, ball.vy);
    if (!ball.carrier && incoming && speed > KEEPER_REACTION_SPEED) {
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
    const guardingSwimmer = k.team === "red" && ball.carrier === state.players[0];
    const targetY = guardingSwimmer
      ? clamp(ball.y, H / 2 - AWAY_KEEPER_READY_RANGE, H / 2 + AWAY_KEEPER_READY_RANGE)
      : clamp(ball.y, GOAL_TOP + 26, GOAL_BOT - 26);
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
    let pace = 1;
    if (ball.carrier === p) {
      p.hold += dt;
      // dribble toward the player's goal, then shoot
      tx = 40;
      ty = H / 2 + Math.sin(state.timeLeft * 3) * 70;
      wantsSprint = p.x > W * 0.45; // sprint the run-in to the goal
      if (p.x < W * 0.5 || p.hold > 1.4) {
        const angle = Math.atan2(H / 2 - p.y, -p.x) + (Math.random() - 0.5) * 0.22;
        shoot(p, angle, 560);
      }
    } else if (!ball.carrier) {
      if (ball.pass && ball.lastTouch !== p.team) {
        tx = ball.pass.airborne ? p.x : ball.x;
        ty = ball.pass.airborne ? p.y : ball.y;
      } else if (ball.pass) {
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
      tx = AWAY_GUARD_X;
      ty = H / 2;
      wantsSprint = dist(p, { x: tx, y: ty }) > 150;
    } else {
      const carrier = ball.carrier;
      const pressing = carrier.x >= AWAY_PRESS_LINE;
      tx = pressing ? carrier.x : AWAY_GUARD_X;
      ty = pressing ? carrier.y : H / 2 + (carrier.y - H / 2) * 0.35;
      pace = AWAY_DEFENSIVE_PACE;
    }
    // Starting to sprint also costs a fresh, randomized reaction delay.
    if (wantsSprint && !p.sprintIntent) {
      p.reaction = REACTION_MIN + Math.random() * (REACTION_MAX - REACTION_MIN);
    }
    p.sprintIntent = wantsSprint;
    p.reaction = Math.max(0, p.reaction - dt);
    updateStamina(p, wantsSprint && p.reaction <= 0, dt);
    moveToward(p, tx, ty, dt, moveScale(p) * pace);
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
    const text = team === "blue" ? "GOAL! HOME SCORES" : "GOAL! AWAY SCORES";
    // set up the kickoff right away (ball at the center, conceding team in
    // possession), then freeze until the user presses Space
    reset(team === "blue" ? "red" : "blue");
    state.banner = text;
    state.waiting = true;
    state.countdown = 0;
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
    state.banner = `OUT! FREE BALL ${TEAM_STYLE[forTeam].name}`;
    state.waiting = true;
    state.countdown = 0;
  }

  // Space on a frozen scene: hide the banner and start a short countdown
  // before play actually resumes.
  function resumePlay() {
    state.banner = null;
    state.bannerT = 0;
    state.countdown = RESUME_DELAY;
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
          const duration = enemy.team === "blue" ? HOME_TACKLE_DURATION : AWAY_TACKLE_DURATION;
          state.tackle = { carrier: ball.carrier, tackler: enemy, duration, progress: 0 };
        }
        state.tackle.progress += dt;
        if (state.tackle.progress >= state.tackle.duration) {
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
    const f = Math.pow(ball.pass ? PASS_DRAG : 0.985, dt * 60);
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

    const pass = ball.pass;
    if (pass?.airborne && Math.hypot(ball.x - pass.aimX, ball.y - pass.aimY) <= INTERCEPT_RADIUS) {
      pass.airborne = false;
    }

    if (!state.waiting && !pass?.airborne) {
      for (const p of state.players) {
        // a keeper cannot touch the ball right after passing it (grace window)
        if (p.kind !== "keeper" || p.cooldown > 0) continue;
        const d = dist(p, ball);
        if (d < PLAYER_R + BALL_R) {
          ball.lastTouch = p.team;
          ball.pass = null;
          if (Math.random() < CATCH_CHANCE) {
            // caught: the keeper holds the ball and will pass it out
            ball.carrier = p;
            ball.vx = 0;
            ball.vy = 0;
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
    if (state.over) return;
    if (state.waiting) {
      // frozen on goals / out of bounds; after Space, count down before resuming
      if (state.countdown > 0) {
        state.countdown -= dt;
        if (state.countdown <= 0) {
          state.countdown = 0;
          state.waiting = false;
        }
      }
      return;
    }
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
  }

  function updateHud() {
    const score = `HOME ${state.score.blue} : ${state.score.red} AWAY`;
    if (scoreEl.textContent !== score) scoreEl.textContent = score;
    const s = Math.ceil(state.timeLeft);
    const timer = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    if (timerEl.textContent !== timer) timerEl.textContent = timer;
  }

  function drawPool(ctx) {
    // deck around the pool - the ball can roll out here
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

    // low pool coping - no wall to bounce on
    ctx.strokeStyle = "#3b6ea5";
    ctx.lineWidth = 5;
    ctx.strokeRect(POOL.l, POOL.t, POOL.r - POOL.l, POOL.b - POOL.t);
  }

  function drawPlayer(p) {
    const style = TEAM_STYLE[p.team];
    ctx.beginPath();
    ctx.ellipse(p.x + 3, p.y + 5, PLAYER_R * 0.9, PLAYER_R * 0.6, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(p.x, p.y, PLAYER_R, 0, Math.PI * 2);
    // keepers have a red circle; field players wear the team colour
    ctx.fillStyle = p.kind === "keeper" ? style.keeperCap : style.body;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = p.team === "blue" ? "rgba(15,23,42,0.65)" : "rgba(255,255,255,0.5)";
    ctx.stroke();

    // cap: keepers wear red with a small team-colour (white/blue) center
    ctx.beginPath();
    ctx.arc(p.x, p.y, PLAYER_R * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = p.kind === "keeper" ? style.keeperCap : style.cap;
    ctx.fill();
    if (p.kind === "keeper") {
      ctx.beginPath();
      ctx.arc(p.x, p.y, PLAYER_R * 0.32, 0, Math.PI * 2);
      ctx.fillStyle = style.accent;
      ctx.fill();
    }

    if (p.kind === "field") {
      const w = 30;
      const h = 4;
      const x = p.x - w / 2;
      const y = p.y - PLAYER_R - 10;
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(x, y, w, h);
      const ratio = p.stamina / FIELD_MOVEMENT[p.team].maxStamina;
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
      if (!controls.mobile && state.waiting && state.countdown <= 0) {
        ctx.font = "18px ui-monospace, monospace";
        ctx.fillStyle = "#93c5fd";
        ctx.fillText("press Space to continue", W / 2, H / 2 + 48);
      }
    }
    if (state.waiting && state.countdown > 0) {
      ctx.font = "bold 72px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(0, H / 2 - 60, W, 120);
      ctx.fillStyle = "#fef08a";
      ctx.fillText(String(Math.ceil(state.countdown)), W / 2, H / 2 + 25);
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
        `HOME ${state.score.blue} : ${state.score.red} AWAY`,
        W / 2,
        H / 2 + 16
      );
      if (!controls.mobile) {
        ctx.font = "18px ui-monospace, monospace";
        ctx.fillStyle = "#7d9bbd";
        ctx.fillText("Press R to play again", W / 2, H / 2 + 56);
      }
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
      -Math.PI / 2 + Math.min(t.progress / t.duration, 1) * Math.PI * 2
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

  function drawShotTarget() {
    if (getAction() !== "shoot") return;
    const y = shotTargetY();
    const charge = controls.shotCharge();
    ctx.beginPath();
    ctx.arc(SHOT_TARGET_X, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = "#fef08a";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#172236";
    ctx.stroke();

    if (charge > 0) {
      ctx.beginPath();
      ctx.arc(SHOT_TARGET_X, y, 12, -Math.PI / 2, (charge * 2 - 0.5) * Math.PI);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#fef08a";
      ctx.stroke();
    }
  }

  let poolImage;
  function render() {
    if (!poolImage) {
      poolImage = document.createElement("canvas");
      poolImage.width = W;
      poolImage.height = H;
      drawPool(poolImage.getContext("2d"));
    }
    ctx.drawImage(poolImage, 0, 0);
    for (const p of state.players) drawPlayer(p);
    drawBall();
    drawPassTarget();
    drawShotTarget();
    drawTackle();
    drawOverlay();
  }

  function getAction() {
    if (state.over) return "restart";
    if (state.waiting) return state.countdown <= 0 ? "continue" : null;
    const [human, keeper] = state.players;
    if (state.ball.carrier === human && human.cooldown <= 0) return "shoot";
    if (state.ball.carrier === keeper) return "pass";
    return null;
  }

  function runAction(action, powerShot) {
    const [human, keeper] = state.players;
    if (action === "shoot") {
      const angle = Math.atan2(shotTargetY() - human.y, SHOT_TARGET_X - human.x);
      shoot(human, angle, powerShot ? POWER_SHOT_SPEED : QUICK_SHOT_SPEED);
    }
    if (action === "pass") pass(keeper, human);
    if (action === "continue") resumePlay();
    if (action === "restart") reset("blue");
    syncAnimation();
  }

  function syncAnimation() {
    if (controls.active()) {
      frameRequest ??= requestAnimationFrame(frame);
      return;
    }
    if (frameRequest !== undefined) cancelAnimationFrame(frameRequest);
    frameRequest = undefined;
    lastFrame = undefined;
  }

  function frame(now) {
    frameRequest = undefined;
    if (!controls.active()) {
      lastFrame = undefined;
      return;
    }

    const dt = Math.min((now - (lastFrame ?? now)) / 1000, 0.05);
    lastFrame = now;
    // Limit how far a fast shot travels between keeper collision checks.
    const travel = Math.hypot(state.ball.vx, state.ball.vy) * dt;
    const steps = Math.max(1, Math.ceil(travel / PLAYER_R));
    for (let i = 0; i < steps; i++) {
      update(dt / steps);
    }
    updateHud();
    controls.refreshAction();
    render();

    if (!state.over && (!state.waiting || state.countdown > 0)) syncAnimation();
    else lastFrame = undefined;
  }

  reset("blue");
  syncAnimation();
})();
