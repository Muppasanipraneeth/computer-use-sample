/* exported playWelcome, greetingLine */
// The moment Jarvis opens, in the spirit of Dia's launch: a soft aurora of heavily blurred colour bars rises from the
// bottom of the window, the greeting fades in out of a blur with the user's name as the one serif accent, and an airy
// chime swells with the aurora and rings as the name lands. Then everything sinks away into the app. About three
// seconds; a click or key skips it, and with "reduce motion" on it only fades. The sound is synthesised here (no audio
// file to license), quiet, and goes through a small reverb so it feels like a room rather than a beep.

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

/** "Good evening, Praneeth": used by the spoken greeting too; the name comes from Settings → You. */
function greetingLine(name, now = new Date()) {
  const part = partOfDay(now);
  return name ? `${part}, ${name}` : part;
}

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
 * The launch sound, laid out to match the motion: a warm Cmaj9 pad opens up (its filter sweeps open while the aurora
 * rises), then two soft bells ring as the name lands. `context` can be an OfflineAudioContext, so it can be checked.
 */
function scheduleChime(context, start = context.currentTime + 0.05) {
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

  // Pad: C4 G4 D5 E5, each as a slightly detuned pair so it shimmers instead of sitting still.
  const pad = context.createGain();
  const tone = context.createBiquadFilter();
  tone.type = "lowpass";
  tone.Q.value = 0.7;
  tone.frequency.setValueAtTime(380, start);
  tone.frequency.exponentialRampToValueAtTime(3600, start + 1.4);
  pad.gain.setValueAtTime(0.0001, start);
  pad.gain.exponentialRampToValueAtTime(0.32, start + 0.9);
  pad.gain.setValueAtTime(0.32, start + 1.9);
  pad.gain.exponentialRampToValueAtTime(0.0001, start + 3.4);
  pad.connect(tone).connect(master);
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
      voice.stop(start + 3.5);
    }
  }

  // Bells: a fundamental with two inharmonic partials (a struck bar, not an organ), C6 then G6.
  for (const [at, frequency, loudness] of [[0.85, 1046.5, 0.5], [1.02, 1567.98, 0.32]]) {
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
  return 3.5;
}

function playChimeNow() {
  const context = new AudioContext();
  const seconds = scheduleChime(context);
  setTimeout(() => void context.close(), (seconds + 3) * 1000);
}

/**
 * Plays the welcome over the app; resolves once it has gone (at once when there is nothing to play).
 * @param {{ name: string, sound: boolean }} options
 */
function playWelcome({ name, sound }) {
  const overlay = document.getElementById("welcome");
  if (!overlay) return Promise.resolve();
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.getElementById("welcome-part").textContent = name ? `${partOfDay()},` : partOfDay();
  document.getElementById("welcome-name").textContent = name;
  overlay.hidden = false;
  overlay.classList.toggle("calm", calm);
  // Two frames: the hidden starting state must be painted before the animation classes apply.
  requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add("playing")));
  if (sound) {
    try {
      playChimeNow();
    } catch {
      // No audio device: the welcome still plays, silently.
    }
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener("keydown", finish);
      overlay.classList.add("leaving");
      document.body.classList.add("arrived");
      setTimeout(() => {
        overlay.hidden = true;
        overlay.classList.remove("playing", "leaving");
        resolve();
      }, calm ? 150 : 700);
    };
    overlay.addEventListener("click", finish, { once: true });
    window.addEventListener("keydown", finish);
    setTimeout(finish, calm ? 900 : 2900);
  });
}
