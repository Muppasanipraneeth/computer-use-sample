// The floating Jarvis face's expressions. One animation loop eases every part (head tilt, brows, pupils, mouth,
// moustache, spark) toward the expression for the current state and mood, then adds what makes a face feel alive:
// breathing, blinks, small glances, eyes that scan while working, and a mouth driven by Jarvis's real voice level.
const api = window.avatarApi;
const root = document.getElementById("avatar");
const caption = document.getElementById("caption");
const captionText = document.getElementById("caption-text");
const faceWrap = document.getElementById("face-wrap");
const part = (id) => document.getElementById(id);
const head = part("head");
const browL = part("brow-l");
const browR = part("brow-r");
const pupilL = part("pupil-l");
const pupilR = part("pupil-r");
const smile = part("smile");
const mouth = part("mouth");
const moustache = part("moustache");
const spark = part("spark");
const glint = part("glint");
const hair = part("hair");

// Each expression is a set of targets: head tilt (deg), brow lift/turn (user units, deg; negative lifts), gaze
// offset, pupil size, how far the smile curves (negative frowns), how much the eyes squint, spark glow.
const STATES = {
  idle: { tilt: 0, browLy: 0, browLr: 0, browRy: 0, browRr: 0, gx: 0, gy: 0, eyes: 1, smile: 5, squint: 1, spark: 0.2 },
  following: { tilt: -2, browLy: -1, browLr: 0, browRy: -1, browRr: 0, gx: 0, gy: 0, eyes: 1.08, smile: 5, squint: 1, spark: 0.2 },
  hearing: { tilt: -7, browLy: -4, browLr: 0, browRy: -4, browRr: 0, gx: 0, gy: 0, eyes: 1.18, smile: 3, squint: 1, spark: 0.3 },
  transcribing: { tilt: 3, browLy: -1, browLr: 0, browRy: -4, browRr: -6, gx: 2, gy: -2, eyes: 1, smile: 1, squint: 1, spark: 0.4 },
  thinking: { tilt: 4, browLy: 0, browLr: 0, browRy: -6, browRr: -8, gx: 3, gy: -3.5, eyes: 1, smile: 0, squint: 1, spark: 0.7 },
  speaking: { tilt: 0, browLy: 0, browLr: 0, browRy: 0, browRr: 0, gx: 0, gy: 0, eyes: 1, smile: 4, squint: 1, spark: 0.3 },
  working: { tilt: 0, browLy: 2, browLr: 6, browRy: 2, browRr: -6, gx: 0, gy: 1, eyes: 0.95, smile: 1, squint: 1, spark: 0.2 },
  asking: { tilt: 8, browLy: 0, browLr: 0, browRy: -5, browRr: -6, gx: 0, gy: 0, eyes: 1.1, smile: 3, squint: 1, spark: 0.3 },
  done: { tilt: 0, browLy: -1, browLr: 0, browRy: -1, browRr: 0, gx: 0, gy: 0, eyes: 1, smile: 6, squint: 1, spark: 0.4 },
};
// Moods adjust the state's targets: added to (+) or replacing (=) them.
const MOODS = {
  neutral: {},
  happy: { smile: ["+", 5], squint: ["=", 0.55], browLy: ["+", -2], browRy: ["+", -2], spark: ["=", 1] },
  sorry: { smile: ["=", -6], browLr: ["=", -14], browRr: ["=", 14], browLy: ["=", -1], browRy: ["=", -1], gy: ["+", 2], tilt: ["=", 5], spark: ["=", 0] },
  curious: { tilt: ["=", 9], browRy: ["=", -6], browRr: ["=", -6], eyes: ["=", 1.12] },
  wink: { smile: ["+", 3], browLy: ["+", 2] },
};

let state = "idle";
let mood = "neutral";
let voiceLevel = 0;
let voiceAt = 0;
let micLevel = 0;
const now = () => performance.now() / 1000;
const current = { ...STATES.idle, open: 0, bob: 0 };
// Procedural timers: when the next blink happens, the current glance, a wink in progress.
let nextBlink = now() + 2;
let blinkUntil = 0;
let winkUntil = 0;
let nextGlance = now() + 1.5;
const glance = { x: 0, y: 0 };

function targets(t) {
  const base = { ...(STATES[state] ?? STATES.idle) };
  for (const [key, [how, value]] of Object.entries(MOODS[mood] ?? {})) base[key] = how === "+" ? base[key] + value : value;
  // Small glances while idle or listening; the eyes scan side to side while working; while speaking they hold you.
  if (["idle", "following", "hearing", "done"].includes(state)) {
    if (t > nextGlance) {
      glance.x = (Math.random() - 0.5) * 5;
      glance.y = (Math.random() - 0.5) * 3;
      nextGlance = t + 1.5 + Math.random() * 2.5;
    }
    base.gx += glance.x;
    base.gy += glance.y;
  }
  if (state === "working") base.gx += Math.sin(t * 1.8) * 3.2;
  if (state === "speaking") {
    // Emphasis: louder syllables lift the brows a little.
    base.browLy -= voiceLevel * 4;
    base.browRy -= voiceLevel * 4;
  }
  return base;
}

function eyeClosure(t) {
  if (t > nextBlink) {
    blinkUntil = t + 0.13;
    nextBlink = t + 2.5 + Math.random() * 3.5;
  }
  const both = t < blinkUntil ? 0.08 : 1;
  return { left: t < winkUntil ? 0.08 : both, right: both };
}

let last = now();
function frame() {
  const t = now();
  const dt = Math.min(0.05, t - last);
  last = t;
  const ease = 1 - Math.exp(-dt * 10);
  const goal = targets(t);
  for (const key of Object.keys(goal)) current[key] += (goal[key] - current[key]) * ease;

  // The mouth: fast to open, a little slower to close, like a jaw. Silence after 0.15 s closes it.
  if (t - voiceAt > 0.15) voiceLevel *= 0.85;
  const openGoal = state === "speaking" ? Math.min(1, voiceLevel * 1.15) : 0;
  current.open += (openGoal - current.open) * (1 - Math.exp(-dt * (openGoal > current.open ? 28 : 14)));
  current.bob = Math.sin(t * 1.6) * 1.3 + (state === "speaking" ? voiceLevel * 1.5 : 0);

  head.style.transform = `translateY(${current.bob.toFixed(2)}px) rotate(${current.tilt.toFixed(2)}deg)`;
  browL.style.transform = `translateY(${current.browLy.toFixed(2)}px) rotate(${current.browLr.toFixed(2)}deg)`;
  browR.style.transform = `translateY(${current.browRy.toFixed(2)}px) rotate(${current.browRr.toFixed(2)}deg)`;
  const closed = eyeClosure(t);
  const eyeX = current.gx.toFixed(2);
  const eyeY = (current.gy - (1 - current.squint) * 1.5).toFixed(2);
  pupilL.style.transform = `translate(${eyeX}px, ${eyeY}px) scale(${current.eyes.toFixed(3)}, ${(current.eyes * current.squint * closed.left).toFixed(3)})`;
  pupilR.style.transform = `translate(${eyeX}px, ${eyeY}px) scale(${current.eyes.toFixed(3)}, ${(current.eyes * current.squint * closed.right).toFixed(3)})`;
  smile.setAttribute("d", `M90 146 Q100 ${(146 + current.smile).toFixed(2)} 110 146`);
  smile.style.opacity = String(Math.max(0, 1 - current.open * 3));
  mouth.setAttribute("ry", (current.open * 8).toFixed(2));
  mouth.setAttribute("rx", (6 + current.open * 2.5).toFixed(2));
  moustache.style.transform = `translateY(${(-current.open * 3).toFixed(2)}px) scaleX(${(1 + current.open * 0.06).toFixed(3)})`;
  hair.style.transform = `scale(${(1 + (state === "speaking" ? voiceLevel * 0.025 : 0) + Math.sin(t * 1.6) * 0.006).toFixed(4)})`;
  const twinkle = current.spark * (0.85 + Math.sin(t * 6) * 0.15);
  spark.style.transform = `scale(${(0.8 + twinkle * 0.45).toFixed(3)}) rotate(${(twinkle * 25).toFixed(1)}deg)`;
  spark.style.opacity = String((0.35 + twinkle * 0.65).toFixed(3));
  glint.style.opacity = mood === "happy" ? String((0.45 + Math.sin(t * 3) * 0.25).toFixed(3)) : "0";
  root.style.setProperty("--mic", micLevel.toFixed(3));
  micLevel *= 0.9;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

const QUIET = { hearing: "Listening…", transcribing: "Got it…", thinking: "Thinking…" };

api.onState(({ state: nextState, mood: nextMood, caption: text, show }) => {
  if (nextMood === "wink" && mood !== "wink") winkUntil = now() + 0.4;
  state = nextState;
  mood = nextMood;
  root.dataset.state = state;
  root.dataset.mood = mood;
  const words = text || QUIET[state] || "";
  captionText.textContent = words;
  caption.classList.toggle("quiet", !text && Boolean(QUIET[state]));
  root.classList.toggle("has-caption", Boolean(words));
  if (show) root.classList.add("shown");
  else if (root.classList.contains("shown")) {
    root.classList.remove("shown");
    setTimeout(() => api.faded(), 380);
  }
});

api.onLevel((level, source) => {
  if (source === "mic") micLevel = Math.max(micLevel, level);
  else {
    voiceLevel = level;
    voiceAt = now();
  }
});

// Clicks pass through the transparent window except here; dragging moves it, a click opens Jarvis.
for (const element of [faceWrap, caption]) {
  element.addEventListener("mouseenter", () => api.interactive(true));
  element.addEventListener("mouseleave", () => api.interactive(false));
}
let drag = null;
faceWrap.addEventListener("pointerdown", (event) => {
  drag = { x: event.screenX, y: event.screenY, moved: false };
  faceWrap.setPointerCapture(event.pointerId);
  api.dragStart();
});
faceWrap.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const dx = event.screenX - drag.x;
  const dy = event.screenY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (drag.moved) api.dragMove(dx, dy);
});
faceWrap.addEventListener("pointerup", () => {
  if (!drag) return;
  api.dragEnd();
  if (!drag.moved) api.open();
  drag = null;
});
caption.addEventListener("click", () => api.open());
