/* exported playWelcome, partOfDay */
// "Jarvis arrives", the launch intro. About 1,500 points of light sweep in from the edges of the window and assemble
// into the Professor; when the face completes a ring of light pulses out, a bell rings, and the points resolve into the
// crisp logo. Then Jarvis says hello in his own voice (cached by the main process), each word appearing as it's
// spoken while a live waveform and a few orbiting motes move with the audio. Finally the face flies into the sidebar's
// Jarvis mark and the app settles in around it. Click or press a key to skip; with "reduce motion" only fades remain.
// Everything is drawn on one canvas and the sound is synthesised here, so there are no media files to ship or license.

const PARTS = [
  [5, "Working late"],
  [12, "Good morning"],
  [17, "Good afternoon"],
  [22, "Good evening"],
  [24, "Working late"],
];

function partOfDay(now = new Date()) {
  return PARTS.find(([until]) => now.getHours() < until)[1];
}

// Timeline, in seconds from the start.
const FORM_END = 1.35; // the face is complete: pulse, bell, crisp logo
const VOICE_AT = FORM_END + 0.15;
const MAX_LENGTH = 7; // never hold the app longer than this, whatever the audio says
const PARTICLES = 1500;
const MOTES = 64;
const MOTE_COLORS = ["#e2c4ff", "#ffd166", "#ff7a45", "#8fd3ff", "#fff7df"];

const easeOutQuart = (value) => 1 - (1 - value) ** 4;

/* ---------- sound ---------- */

// A 2.8 s stereo tail of decaying noise: enough room for the chime without a reverb file.
function roomImpulse(context, seconds = 2.8) {
  const length = Math.floor(context.sampleRate * seconds);
  const impulse = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let index = 0; index < length; index += 1) data[index] = (Math.random() * 2 - 1) * (1 - index / length) ** 3;
  }
  return impulse;
}

/**
 * The sound, laid out on the same timeline as the picture: a warm Cmaj9 pad whose filter opens while the points fly
 * in, then a struck bell when the face completes (two bells when there's no voice to follow). With a voice the pad
 * is quieter and clears out before Jarvis speaks. `context` may be an OfflineAudioContext, so it can be measured.
 */
function scheduleChime(context, start = context.currentTime + 0.05, { withVoice = false } = {}) {
  const master = context.createGain();
  // Measured offline: about -11 dBFS peak, under macOS's own alert sounds; the limiter catches any overlap.
  master.gain.value = 0.36;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.ratio.value = 8;
  const reverb = context.createConvolver();
  reverb.buffer = roomImpulse(context);
  const wet = context.createGain();
  wet.gain.value = 0.4;
  master.connect(limiter).connect(context.destination);
  master.connect(reverb).connect(wet).connect(limiter);

  const padPeak = withVoice ? 0.2 : 0.32;
  const padRelease = withVoice ? FORM_END + 0.6 : FORM_END + 0.8;
  const pad = context.createGain();
  const tone = context.createBiquadFilter();
  tone.type = "lowpass";
  tone.Q.value = 0.7;
  tone.frequency.setValueAtTime(320, start);
  tone.frequency.exponentialRampToValueAtTime(3600, start + FORM_END);
  pad.gain.setValueAtTime(0.0001, start);
  pad.gain.exponentialRampToValueAtTime(padPeak, start + FORM_END - 0.2);
  pad.gain.setValueAtTime(padPeak, start + padRelease);
  pad.gain.exponentialRampToValueAtTime(0.0001, start + padRelease + 1.4);
  pad.connect(tone).connect(master);
  // C4 G4 D5 E5, each a slightly detuned pair so it shimmers instead of sitting still.
  for (const frequency of [261.63, 392.0, 587.33, 659.25]) {
    for (const cents of [-5, 5]) {
      const voice = context.createOscillator();
      voice.type = "sine";
      voice.frequency.value = frequency;
      voice.detune.value = cents;
      const level = context.createGain();
      level.gain.value = 0.11;
      voice.connect(level).connect(pad);
      voice.start(start);
      voice.stop(start + padRelease + 1.5);
    }
  }

  // Bells: a fundamental and two inharmonic partials, a struck bar rather than an organ. C6, then G6.
  const bells = withVoice ? [[FORM_END, 1046.5, 0.42]] : [[FORM_END, 1046.5, 0.5], [FORM_END + 0.17, 1567.98, 0.32]];
  for (const [at, frequency, loudness] of bells) {
    const struck = start + at;
    for (const [ratio, share] of [[1, 1], [2.76, 0.32], [5.4, 0.12]]) {
      const partial = context.createOscillator();
      partial.type = "sine";
      partial.frequency.value = frequency * ratio;
      const level = context.createGain();
      level.gain.setValueAtTime(0.0001, struck);
      level.gain.exponentialRampToValueAtTime(loudness * share, struck + 0.008);
      level.gain.exponentialRampToValueAtTime(0.0001, struck + 2.2 / ratio);
      partial.connect(level).connect(master);
      partial.start(struck);
      partial.stop(struck + 2.4);
    }
  }
  return start + padRelease + 1.5;
}

/* ---------- particles ---------- */

/** Points sampled from the logo's pixels (colour included), placed where the face will sit on screen. */
function sampleLogo(image, box, count) {
  const size = 200;
  const scratch = document.createElement("canvas");
  scratch.width = size;
  scratch.height = size;
  const draw = scratch.getContext("2d", { willReadFrequently: true });
  draw.drawImage(image, 0, 0, size, size);
  const pixels = draw.getImageData(0, 0, size, size).data;
  const opaque = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 4;
      if (pixels[at + 3] > 140) opaque.push(at);
    }
  }
  const points = [];
  for (let index = 0; index < count && opaque.length > 0; index += 1) {
    const at = opaque[Math.floor(Math.random() * opaque.length)];
    const x = (at / 4) % size;
    const y = Math.floor(at / 4 / size);
    // Colours rounded to 16 levels per channel, so drawing groups by colour and sets fillStyle a few dozen times a frame.
    const channel = (value) => Math.min(255, Math.round(value / 16) * 16);
    points.push({
      tx: box.x + (x / size) * box.size,
      ty: box.y + (y / size) * box.size,
      color: `rgb(${channel(pixels[at])} ${channel(pixels[at + 1])} ${channel(pixels[at + 2])})`,
    });
  }
  return points;
}

function launchParticles(points, centre, viewport) {
  const reach = Math.hypot(viewport.width, viewport.height);
  const maxRadius = Math.max(...points.map((point) => Math.hypot(point.tx - centre.x, point.ty - centre.y)), 1);
  return points.map((point) => {
    // Each comes from roughly its own side of the face, from well off screen, and curls in.
    const angle = Math.atan2(point.ty - centre.y, point.tx - centre.x) + (Math.random() - 0.5) * 1.4;
    const distance = reach * (0.55 + Math.random() * 0.3);
    const radial = Math.hypot(point.tx - centre.x, point.ty - centre.y) / maxRadius;
    return {
      ...point,
      dx: centre.x + Math.cos(angle) * distance - point.tx,
      dy: centre.y + Math.sin(angle) * distance - point.ty,
      // The middle of the face settles first, so it seems to condense out of the swirl.
      delay: 0.04 + radial * 0.22 + Math.random() * 0.12,
      duration: 0.72 + Math.random() * 0.2,
      swirl: (Math.random() < 0.5 ? -1 : 1) * (1.1 + Math.random() * 0.8),
      size: 1.3 + Math.random() * 0.9,
    };
  });
}

function makeMotes(centre, radius) {
  return Array.from({ length: MOTES }, (_, index) => ({
    angle: Math.random() * Math.PI * 2,
    speed: (0.25 + Math.random() * 0.5) * (index % 2 ? 1 : -1),
    orbit: radius * (0.95 + Math.random() * 0.5),
    wobble: Math.random() * Math.PI * 2,
    size: 0.8 + Math.random() * 1.4,
    color: MOTE_COLORS[index % MOTE_COLORS.length],
    centre,
  }));
}

/* ---------- the intro ---------- */

/**
 * Plays the intro over the app and resolves once it has gone. `voice` is the cached greeting ({ samples, sampleRate,
 * text }) or null, in which case the words still appear, to the chime.
 * @param {{ name: string, sound: boolean, voice: { samples: Float32Array, sampleRate: number, text: string } | null }} options
 */
async function playWelcome({ name, sound, voice }) {
  const overlay = document.getElementById("welcome");
  if (!overlay) return;
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canvas = document.getElementById("welcome-particles");
  const wave = document.getElementById("welcome-wave");
  const logo = overlay.querySelector(".welcome-logo");
  const caption = document.getElementById("welcome-caption");
  const brand = document.querySelector(".brand-mark");
  overlay.hidden = false;
  overlay.classList.toggle("calm", calm);

  // The words: the voice's own text when there is one, else the same line built here. The name is the serif accent.
  const text = voice?.text ?? `${partOfDay()}${name ? `, ${name}` : ""}. Jarvis is here.`;
  const nameWords = new Set(String(name).toLowerCase().split(/\s+/).filter(Boolean));
  const words = text.split(" ").map((word) => {
    const span = document.createElement("span");
    span.className = "welcome-word";
    if (nameWords.has(word.toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, ""))) span.classList.add("name");
    span.textContent = word;
    return span;
  });
  // "Jarvis is here." on its own line, quieter: the first sentence is the greeting, the second the signature.
  const breakAt = text.indexOf(". ") >= 0 ? text.slice(0, text.indexOf(". ") + 1).split(" ").length : words.length;
  caption.replaceChildren(...words.slice(0, breakAt), document.createElement("br"), ...words.slice(breakAt));
  for (const span of words.slice(breakAt)) span.classList.add("signature");

  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const faceSize = Math.round(Math.min(viewport.height * 0.26, 220));
  const centre = { x: viewport.width / 2, y: viewport.height * 0.4 };
  const box = { x: centre.x - faceSize / 2, y: centre.y - faceSize / 2, size: faceSize };
  overlay.style.setProperty("--face-size", `${faceSize}px`);
  overlay.style.setProperty("--face-top", `${box.y}px`);

  await logo.decode().catch(() => {});
  const ratio = window.devicePixelRatio || 1;
  canvas.width = viewport.width * ratio;
  canvas.height = viewport.height * ratio;
  const paint = canvas.getContext("2d");
  paint.setTransform(ratio, 0, 0, ratio, 0, 0);
  const backdrop = getComputedStyle(overlay).getPropertyValue("--welcome-bg").trim() || "#141816";
  const particles = calm ? [] : launchParticles(sampleLogo(logo, box, PARTICLES), centre, viewport);
  const byColor = new Map();
  for (const particle of particles) {
    if (!byColor.has(particle.color)) byColor.set(particle.color, []);
    byColor.get(particle.color).push(particle);
  }
  const motes = calm ? [] : makeMotes(centre, faceSize * 0.62);

  // Audio: one context for the chime and the voice; the analyser drives the waveform, the motes and the glow.
  let audio = null;
  let analyser = null;
  let speech = null;
  let speechSeconds = 0;
  if (sound || voice) {
    try {
      audio = new AudioContext();
      analyser = audio.createAnalyser();
      analyser.fftSize = 1024;
      analyser.connect(audio.destination);
      if (sound) scheduleChime(audio, audio.currentTime + 0.05, { withVoice: Boolean(voice) });
      if (voice?.samples?.length) {
        const buffer = audio.createBuffer(1, voice.samples.length, voice.sampleRate);
        buffer.copyToChannel(voice.samples, 0);
        speech = audio.createBufferSource();
        speech.buffer = buffer;
        speech.connect(analyser);
        speechSeconds = buffer.duration;
        speech.start(audio.currentTime + 0.05 + VOICE_AT);
      }
    } catch {
      audio = null; // no audio device: the picture still plays
    }
  }

  // Each word appears as it's said: its share of the line's letters, across the length of the recording.
  const wordsStart = calm ? 0.1 : VOICE_AT;
  const letters = words.reduce((sum, span) => sum + span.textContent.length + 1, 0);
  let spoken = 0;
  const wordTimers = words.map((span) => {
    const at = speechSeconds ? wordsStart + (spoken / letters) * speechSeconds * 0.94 : wordsStart + words.indexOf(span) * 0.16;
    spoken += span.textContent.length + 1;
    return setTimeout(() => span.classList.add("shown"), at * 1000);
  });
  const endAt = Math.min(MAX_LENGTH, speechSeconds ? VOICE_AT + speechSeconds + 0.45 : (calm ? 1.4 : FORM_END + 1.5));

  const startedAt = performance.now();
  let frame = 0;
  let level = 0;
  let formed = false;
  const samples = analyser ? new Float32Array(analyser.fftSize) : null;
  const waveDraw = wave.getContext("2d");
  wave.width = wave.clientWidth * ratio;
  wave.height = wave.clientHeight * ratio;
  waveDraw.setTransform(ratio, 0, 0, ratio, 0, 0);
  const accent = getComputedStyle(overlay).getPropertyValue("--welcome-accent").trim() || "#e2c4ff";

  const render = () => {
    const t = (performance.now() - startedAt) / 1000;
    if (analyser) {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) sum += value * value;
      level = level * 0.82 + Math.min(1, Math.sqrt(sum / samples.length) * 6) * 0.18;
    }
    overlay.style.setProperty("--level", level.toFixed(3));

    // Trails: paint the backdrop at low opacity instead of clearing, so fast points leave a short streak.
    paint.globalAlpha = 1;
    paint.fillStyle = backdrop;
    paint.globalAlpha = t < FORM_END ? 0.3 : 0.5;
    paint.fillRect(0, 0, viewport.width, viewport.height);
    if (t < FORM_END + 0.5) {
      // After the face completes the points fade under the crisp logo.
      paint.globalAlpha = t < FORM_END ? 1 : Math.max(0, 1 - (t - FORM_END) / 0.5);
      for (const [color, group] of byColor) {
        paint.fillStyle = color;
        for (const p of group) {
          const u = Math.min(1, Math.max(0, (t - p.delay) / p.duration));
          if (u === 0) continue;
          const e = easeOutQuart(u);
          const turn = p.swirl * (1 - e);
          const cos = Math.cos(turn);
          const sin = Math.sin(turn);
          const keep = 1 - e;
          paint.fillRect(p.tx + (p.dx * cos - p.dy * sin) * keep, p.ty + (p.dx * sin + p.dy * cos) * keep, p.size, p.size);
        }
      }
    }
    if (t >= FORM_END && motes.length) {
      // Motes orbit the face once it's there, swinging wider while Jarvis speaks.
      paint.globalAlpha = Math.min(0.85, (t - FORM_END) / 0.6);
      for (const mote of motes) {
        mote.angle += mote.speed / 60;
        const radius = mote.orbit + Math.sin(t * 1.4 + mote.wobble) * 5 + level * 26;
        paint.fillStyle = mote.color;
        paint.beginPath();
        paint.arc(mote.centre.x + Math.cos(mote.angle) * radius, mote.centre.y + Math.sin(mote.angle) * radius * 0.92, mote.size * (1 + level * 0.8), 0, Math.PI * 2);
        paint.fill();
      }
    }
    if (!formed && t >= (calm ? 0 : FORM_END)) {
      formed = true;
      overlay.classList.add("formed");
    }

    // The waveform: the voice's own samples, or a slow idle shimmer before and after it.
    const width = wave.clientWidth;
    const height = wave.clientHeight;
    waveDraw.clearRect(0, 0, width, height);
    waveDraw.strokeStyle = accent;
    waveDraw.lineWidth = 2;
    waveDraw.lineCap = "round";
    waveDraw.globalAlpha = 0.9;
    waveDraw.beginPath();
    const steps = 96;
    for (let index = 0; index <= steps; index += 1) {
      const x = (index / steps) * width;
      const fade = Math.sin((index / steps) * Math.PI); // quiet at both ends
      const live = samples ? samples[Math.floor((index / steps) * (samples.length - 1))] * 2.6 : 0;
      const idle = Math.sin(t * 3 + index * 0.25) * 0.06;
      const y = height / 2 + (live + idle) * fade * (height / 2);
      if (index === 0) waveDraw.moveTo(x, y);
      else waveDraw.lineTo(x, y);
    }
    waveDraw.stroke();

    frame = requestAnimationFrame(render);
  };
  overlay.classList.add("playing");
  frame = requestAnimationFrame(render);

  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener("keydown", finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, endAt * 1000);
    overlay.addEventListener("click", finish, { once: true });
    window.addEventListener("keydown", finish);
  });

  // Hand-off: the face flies into the sidebar's Jarvis mark while the backdrop lifts and the app settles in.
  for (const timer of wordTimers) clearTimeout(timer);
  try {
    speech?.stop();
  } catch {
    // already finished
  }
  overlay.classList.add("leaving");
  document.body.classList.add("arrived");
  const from = logo.getBoundingClientRect();
  const to = brand?.getBoundingClientRect();
  let flight = null;
  if (!calm && to && to.width > 0 && from.width > 0) {
    if (brand) brand.style.visibility = "hidden";
    flight = logo.animate(
      [{ transform: "none", borderRadius: "22%" }, { transform: `translate(${to.left + to.width / 2 - (from.left + from.width / 2)}px, ${to.top + to.height / 2 - (from.top + from.height / 2)}px) scale(${to.width / from.width})`, borderRadius: "22%" }],
      { duration: 720, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "forwards" },
    );
    await flight.finished.catch(() => {});
  } else {
    await new Promise((resolve) => setTimeout(resolve, calm ? 200 : 600));
  }
  cancelAnimationFrame(frame);
  overlay.hidden = true;
  overlay.classList.remove("playing", "formed", "leaving");
  // The flying copy sat exactly on the sidebar's mark, so swapping back to the real one is invisible. Cancelling the
  // held flight resets the logo for any later replay.
  if (brand) brand.style.visibility = "";
  flight?.cancel();
  if (audio) setTimeout(() => void audio.close(), 2500); // let the bell's tail ring out
}
