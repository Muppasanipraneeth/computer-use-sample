/* exported startMicrophone, stopMicrophone, chime, createSpeechPlayer */
// Microphone capture for voice control. Chromium handles the device, echo cancellation and noise suppression;
// the worklet resamples to 16 kHz and hands 100 ms chunks to onChunk. Jarvis's voice plays through the same audio
// context, so echo cancellation knows exactly what to remove from the microphone and Jarvis doesn't hear itself.
let micContext = null;
let micStream = null;

async function startMicrophone(onChunk) {
  micStream = await navigator.mediaDevices.getUserMedia({
    // autoGainControl stays off: on macOS Chromium's AGC turns the *system* input volume down when it hears loud sound
    // (music), and it dragged the MacBook mic from 17 % to 8 %, burying "Hey Jarvis". The wake model expects raw levels.
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false },
  });
  micContext = new AudioContext();
  await micContext.audioWorklet.addModule("voice-worklet.js");
  const node = new AudioWorkletNode(micContext, "pcm-chunker");
  node.port.onmessage = (event) => onChunk(event.data);
  micContext.createMediaStreamSource(micStream).connect(node); // not connected to the speakers
}

async function stopMicrophone() {
  for (const track of micStream?.getTracks() ?? []) track.stop();
  await micContext?.close();
  micContext = null;
  micStream = null;
}

// Two soft rising tones: "I heard you", audible while the window is minimized during a run.
function chime() {
  const context = micContext ?? new AudioContext();
  const now = context.currentTime;
  for (const [offset, frequency] of [[0, 660], [0.09, 880]]) {
    const tone = context.createOscillator();
    const gain = context.createGain();
    tone.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.08, now + offset + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.16);
    tone.connect(gain).connect(context.destination);
    tone.start(now + offset);
    tone.stop(now + offset + 0.18);
  }
}

/**
 * Plays Jarvis's voice as its sentences arrive, each queued right after the previous one on the audio clock.
 * push() adds a sentence, end() says no more are coming, stop() cuts it off (barge-in). done resolves true when it
 * played to the end, false when stopped.
 */
function createSpeechPlayer() {
  const context = micContext ?? new AudioContext();
  const playing = new Set();
  let at = 0;
  let ended = false;
  let stopped = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const settle = () => {
    if (ended && playing.size === 0) resolveDone(!stopped);
  };
  return {
    done,
    push(samples, sampleRate) {
      if (stopped || samples.length === 0) return;
      const buffer = context.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      at = Math.max(at, context.currentTime + 0.02);
      source.start(at);
      at += buffer.duration;
      playing.add(source);
      source.onended = () => {
        playing.delete(source);
        settle();
      };
    },
    end() {
      ended = true;
      settle();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      ended = true;
      for (const source of playing) source.stop();
      settle();
    },
  };
}
