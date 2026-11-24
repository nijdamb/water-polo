const movementKeys = new Set(["a", "d", "w", "s", "arrowleft", "arrowright", "arrowup", "arrowdown", "shift"]);
const actionLabels = { shoot: "Shoot", pass: "Pass", continue: "Continue", restart: "Play again" };

function bindGameButton(button, activate) {
  button.addEventListener("click", activate);
  // A tap made while another finger holds the stick may not produce a click.
  button.addEventListener("touchstart", (event) => event.preventDefault(), { passive: false });
  button.addEventListener("touchend", (event) => {
    event.preventDefault();
    const { clientX, clientY } = event.changedTouches[0];
    if (!button.disabled && document.elementFromPoint(clientX, clientY) === button) activate();
  }, { passive: false });
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
  const touch = matchMedia("(pointer: coarse)");
  const landscape = matchMedia("(orientation: landscape)");
  const keys = new Set();
  let started = false;
  let stickPointer = null;
  let stickX = 0;
  let stickY = 0;
  let sprint = false;

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

  function refreshAction() {
    const action = getAction();
    const label = actionLabels[action] ?? actionLabels.shoot;
    if (actionButton.textContent !== label) actionButton.textContent = label;
    const disabled = action === null;
    if (actionButton.disabled !== disabled) actionButton.disabled = disabled;
  }

  function activate(action) {
    if (!active() || !action) return;
    runAction(action);
    refreshAction();
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

  bindGameButton(sprintButton, () => {
    if (active()) setSprint(!sprint);
  });
  bindGameButton(actionButton, () => activate(getAction()));

  window.addEventListener("keydown", (event) => {
    if (!active()) return;
    const key = event.key.toLowerCase();
    if (movementKeys.has(key)) {
      keys.add(key);
      if (key.startsWith("arrow")) event.preventDefault();
      return;
    }
    if (event.target instanceof HTMLButtonElement && (key === " " || key === "enter")) return;

    const action = getAction();
    if (key === " " || (key === "enter" && action === "continue")) {
      event.preventDefault();
      if (!event.repeat && action !== "restart") activate(action);
    }
    if (key === "r" && !event.repeat && action === "restart") activate(action);
  });
  window.addEventListener("keyup", (event) => keys.delete(event.key.toLowerCase()));
  window.addEventListener("blur", clearInput);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearInput();
  });

  refreshLayout();

  return {
    active,
    refreshAction,
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
