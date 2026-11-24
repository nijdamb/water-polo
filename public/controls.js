const movementKeys = new Set(["a", "d", "w", "s", "arrowleft", "arrowright", "arrowup", "arrowdown", "shift"]);
const actionLabels = { shoot: "Shoot", pass: "Pass", continue: "Continue", restart: "Play again" };
const POWER_SHOT_MS = 350;

function bindGameButton(button, { activate, press, release = activate, cancel }) {
  let touchId;

  function releaseAt(x, y) {
    if (!button.disabled && button.contains(document.elementFromPoint(x, y))) release();
    else cancel?.();
  }

  button.addEventListener("click", (event) => {
    if (!press || event.detail === 0) activate();
  });

  // A tap made while another finger holds the stick may not produce a click.
  button.addEventListener("touchstart", (event) => {
    event.preventDefault();
    if (button.disabled || touchId !== undefined) return;
    touchId = event.changedTouches[0].identifier;
    press?.();
  }, { passive: false });
  button.addEventListener("touchend", (event) => {
    event.preventDefault();
    const touch = Array.from(event.changedTouches).find((point) => point.identifier === touchId);
    if (!touch) return;
    touchId = undefined;
    releaseAt(touch.clientX, touch.clientY);
  }, { passive: false });
  button.addEventListener("touchcancel", (event) => {
    if (Array.from(event.changedTouches).some((point) => point.identifier === touchId)) {
      touchId = undefined;
      cancel?.();
    }
  });

  if (press) {
    button.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch" && event.button === 0) press();
    });
    button.addEventListener("pointerup", (event) => {
      if (event.pointerType !== "touch" && event.button === 0) releaseAt(event.clientX, event.clientY);
    });
    for (const type of ["pointerleave", "pointercancel"]) {
      button.addEventListener(type, (event) => {
        if (event.pointerType !== "touch") cancel?.();
      });
    }
  }

  return () => { touchId = undefined; };
}

export function createControls(getAction, runAction) {
  const app = document.getElementById("app");
  const match = document.getElementById("match");
  const start = document.getElementById("mobile-start");
  const rotatePrompt = document.getElementById("rotate-prompt");
  const playButton = document.getElementById("play");
  const stick = document.getElementById("stick");
  const sprintButton = document.getElementById("sprint");
  const actionButton = document.getElementById("action");
  const actionLabel = document.getElementById("action-label");
  const shotHint = document.getElementById("shot-hint");
  const touch = matchMedia("(pointer: coarse)");
  const landscape = matchMedia("(orientation: landscape)");
  const keys = new Set();
  let started = false;
  let stickPointer = null;
  let stickX = 0;
  let stickY = 0;
  let sprint = false;
  let actionPress;

  function active() {
    return !document.hidden && (!touch.matches || (started && landscape.matches));
  }

  function setSprint(enabled) {
    sprint = enabled;
    sprintButton.setAttribute("aria-pressed", String(enabled));
  }

  function releaseStick() {
    const pointer = stickPointer;
    stickPointer = null;
    stickX = 0;
    stickY = 0;
    stick.style.removeProperty("--stick-x");
    stick.style.removeProperty("--stick-y");
    if (pointer !== null && stick.hasPointerCapture(pointer)) {
      stick.releasePointerCapture(pointer);
    }
  }

  function clearInput() {
    keys.clear();
    releaseStick();
    setSprint(false);
    actionPress = undefined;
    clearSprintTouch();
    clearActionTouch();
  }

  function canLockOrientation() {
    return typeof screen.orientation?.lock === "function"
      && (document.fullscreenElement === app || document.fullscreenEnabled);
  }

  function refreshLayout() {
    const gated = touch.matches && (!started || !landscape.matches);
    app.classList.toggle("mobile", touch.matches);
    match.hidden = gated;
    start.hidden = !gated;
    rotatePrompt.hidden = landscape.matches;
    playButton.hidden = started || (!landscape.matches && !canLockOrientation());
  }

  function shotCharge() {
    if (actionPress?.action !== "shoot") return 0;
    return Math.min((performance.now() - actionPress.startedAt) / POWER_SHOT_MS, 1);
  }

  function refreshAction() {
    const action = getAction();
    if (actionPress && actionPress.action !== action) actionPress = undefined;
    const ready = shotCharge() === 1;
    const label = ready ? "Power shot" : actionLabels[action] ?? actionLabels.shoot;
    if (actionLabel.textContent !== label) actionLabel.textContent = label;
    const hideHint = action !== "shoot" || ready;
    if (shotHint.hidden !== hideHint) shotHint.hidden = hideHint;
    const disabled = action === null;
    if (actionButton.disabled !== disabled) actionButton.disabled = disabled;
  }

  function activate(action, powerShot = false) {
    if (!active() || !action) return;
    runAction(action, powerShot);
    refreshAction();
  }

  function pressAction(source) {
    if (!active() || actionPress) return;
    const action = getAction();
    if (action) actionPress = { source, action, startedAt: performance.now() };
  }

  function releaseAction(source) {
    if (actionPress?.source !== source) return;
    const { action } = actionPress;
    const powerShot = shotCharge() === 1;
    actionPress = undefined;
    if (getAction() === action) activate(action, powerShot);
  }

  function cancelButtonAction() {
    if (actionPress?.source === "button") actionPress = undefined;
  }

  playButton.addEventListener("click", async () => {
    if (started) return;
    started = true;
    const tryLock = canLockOrientation();
    refreshLayout();
    try {
      if (tryLock) {
        if (document.fullscreenElement !== app) await app.requestFullscreen();
        await screen.orientation.lock("landscape");
      }
    } catch {
      // The portrait gate also works when the browser rejects fullscreen or orientation lock.
    }
  });

  for (const query of [touch, landscape]) {
    query.addEventListener("change", () => {
      clearInput();
      refreshLayout();
    });
  }

  function updateStick(event) {
    const { left, top, width, height } = stick.getBoundingClientRect();
    const dx = event.clientX - (left + width / 2);
    const dy = event.clientY - (top + height / 2);
    const distance = Math.hypot(dx, dy);
    const travel = width * 0.26;
    const scale = distance > 0 ? Math.min(1, travel / distance) : 0;
    stick.style.setProperty("--stick-x", `${dx * scale}px`);
    stick.style.setProperty("--stick-y", `${dy * scale}px`);
    stickX = distance > travel * 0.25 ? dx : 0;
    stickY = distance > travel * 0.25 ? dy : 0;
  }

  stick.addEventListener("pointerdown", (event) => {
    if (!active() || stickPointer !== null || event.button !== 0) return;
    stick.setPointerCapture(event.pointerId);
    stickPointer = event.pointerId;
    updateStick(event);
  });
  stick.addEventListener("pointermove", (event) => {
    if (event.pointerId === stickPointer) updateStick(event);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    stick.addEventListener(type, (event) => {
      if (event.pointerId === stickPointer) releaseStick();
    });
  }

  const clearSprintTouch = bindGameButton(sprintButton, {
    activate: () => {
      if (active()) setSprint(!sprint);
    },
  });
  const clearActionTouch = bindGameButton(actionButton, {
    activate: () => activate(getAction()),
    press: () => pressAction("button"),
    release: () => releaseAction("button"),
    cancel: cancelButtonAction,
  });

  window.addEventListener("keydown", (event) => {
    if (!active()) return;
    const key = event.key.toLowerCase();
    if (movementKeys.has(key)) {
      keys.add(key);
      if (key.startsWith("arrow")) event.preventDefault();
      return;
    }
    if (
      event.target instanceof HTMLButtonElement
      && (key === "enter" || (key === " " && event.target !== actionButton))
    ) return;

    const action = getAction();
    if (key === " " || (key === "enter" && action === "continue")) {
      event.preventDefault();
      if (event.repeat) return;
      if (action === "shoot") pressAction("space");
      else if (action !== "restart") activate(action);
    }
    if (key === "r" && !event.repeat && action === "restart") activate(action);
  });
  window.addEventListener("keyup", (event) => {
    keys.delete(event.key.toLowerCase());
    if (event.key === " ") releaseAction("space");
  });
  window.addEventListener("blur", clearInput);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearInput();
  });

  refreshLayout();

  return {
    active,
    refreshAction,
    shotCharge,
    get mobile() {
      return touch.matches;
    },
    movement() {
      const sprinting = sprint || keys.has("shift");
      if (stickX || stickY) return { x: stickX, y: stickY, sprint: sprinting };
      return {
        x: Number(keys.has("arrowright") || keys.has("d")) - Number(keys.has("arrowleft") || keys.has("a")),
        y: Number(keys.has("arrowdown") || keys.has("s")) - Number(keys.has("arrowup") || keys.has("w")),
        sprint: sprinting,
      };
    },
  };
}
