/* global state, $, LISTEN_KEYS, bridge, persist, toast, startMicrophone, stopMicrophone, createSpeechPlayer, renderComposer, setPrompt, stopRun, send, answerFor, answerQuestion, followUp, renderMemories, renderRoutines */
/* exported renderVoice, holdControlOn, enableVoice, disableVoice, inConversation, stopSpeaking, playChunk, say, showQuietly, cancelVoicePending, onVoiceCommand, showHeard, clearHeard, overrideHeard */
// Voice: turning it on and off, speaking replies, and acting on spoken commands.

/* ---------- voice ---------- */

const VOICE_LABELS = {
  off: "Voice",
  preparing: "Starting voice…",
  listening: "Say “Hey Jarvis”",
  hearing: "Listening…",
  transcribing: "Transcribing…",
  following: "Go ahead…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

// The floating face gets each change of state once (renderVoice runs far more often than the state changes).
let faceShown = null;

function renderVoice(label) {
  const shown = state.voice === "off" ? "off" : (state.voicePhase ?? state.voice);
  const chip = $("#voice");
  chip.dataset.state = shown;
  chip.setAttribute("aria-pressed", String(state.voice !== "off"));
  const listening = shown === "listening" && !state.prefs.wakeWord ? (holdControlOn() ? "Hold Control" : `Press ${LISTEN_KEYS}`) : null;
  $("#voice-label").textContent = label ?? listening ?? VOICE_LABELS[shown];
  if (shown !== faceShown) {
    faceShown = shown;
    bridge.avatarVoice?.({ state: shown });
  }
}

// Hold Control to talk needs the macOS key watcher (built with Xcode's tools) and the setting on.
function holdControlOn() {
  return state.voiceHoldKey && state.prefs.holdControl;
}

async function enableVoice() {
  state.voice = "preparing";
  renderVoice();
  const result = await bridge.voiceEnable();
  if (!result.ok) {
    state.voice = "off";
    state.voiceOn = false;
    persist();
    renderVoice();
    toast(result.error, "error");
    return;
  }
  try {
    // The user's loudness moves the floating face's listening rings while it hears them (10 chunks a second).
    await startMicrophone((chunk) => {
      bridge.voiceAudio(chunk);
      if (state.voice !== "hearing") return;
      let sum = 0;
      for (const value of chunk) sum += value * value;
      bridge.avatarLevel?.(Math.min(1, Math.sqrt(sum / chunk.length) * 8), "mic");
    });
  } catch (error) {
    await bridge.voiceDisable();
    state.voice = "off";
    state.voiceOn = false;
    persist();
    renderVoice();
    toast(`Jarvis can't use the microphone: ${error.message}`, "error");
    return;
  }
  state.voiceOn = true;
  state.voiceShortcut = Boolean(result.shortcut);
  state.voiceHoldKey = Boolean(result.holdKey);
  persist();
  if (state.voice === "preparing") state.voice = "listening";
  renderVoice();
}

async function disableVoice() {
  cancelVoicePending();
  stopSpeaking();
  state.voicePhase = null;
  await stopMicrophone();
  await bridge.voiceDisable();
  state.voice = "off";
  state.voiceOn = false;
  persist();
  renderVoice();
}

// Music stays ducked while any part of an exchange is in flight; nested exchanges (a result spoken during a reply)
// share one hold.
let conversationDepth = 0;
async function inConversation(job) {
  if (conversationDepth++ === 0) bridge.voiceBusy(true);
  try {
    return await job();
  } finally {
    if (--conversationDepth === 0) bridge.voiceBusy(false);
  }
}

let speech = null; // the reply being said: { id, player }
const speechPlayers = new Map(); // speech id → player, for the sentence chunks arriving from the voice process
const earlyChunks = new Map(); // chunks that arrived before say() registered their player
let newestSpeechId = 0; // chunks for an older id without a player belong to a reply that was cut off

function stopSpeaking() {
  if (!speech) return false;
  bridge.voiceSilence(speech.id);
  speech.player.stop();
  return true;
}

function playChunk({ id, samples, sampleRate, last }) {
  const player = speechPlayers.get(id);
  if (!player && id <= newestSpeechId) return;
  if (!player) {
    earlyChunks.set(id, [...(earlyChunks.get(id) ?? []), { id, samples, sampleRate, last }]);
    return;
  }
  player.push(samples, sampleRate);
  if (last) player.end();
}

/**
 * Says `request` (text, or { text, outcome } for a finished run's result) out loud, sentence by sentence as the voice
 * process renders them. Resolves true when it played to the end, false when it was cut off, usually by the user
 * talking over it. The microphone stays open throughout; afterwards a short follow-up window takes a reply without the
 * wake phrase.
 */
async function say(request, followUp = true) {
  if (state.voice === "off") return true;
  // "Speak replies out loud" off: the words still show, just not in Jarvis's voice. Task results have their own switch.
  if (typeof request === "string" && !state.prefs.speakReplies) {
    toast(request, "info");
    return true;
  }
  stopSpeaking();
  const started = await bridge.voiceSpeak(typeof request === "string" ? { text: request } : request);
  if (!started.ok || state.voice === "off") return true;
  if (document.hasFocus()) toast(started.text, "info");
  const player = createSpeechPlayer();
  speechPlayers.set(started.id, player);
  speech = { id: started.id, player };
  newestSpeechId = started.id;
  for (const chunk of earlyChunks.get(started.id) ?? []) playChunk(chunk);
  earlyChunks.delete(started.id);
  // The floating face shows the words with a matching expression and moves its mouth with the voice (30 times a
  // second; an interval, not animation frames, because those stop while this window is minimized).
  faceShown = "speaking";
  bridge.avatarVoice?.({ state: "speaking", text: started.text, outcome: typeof request === "object" ? (request.outcome ?? null) : null });
  const lipSync = setInterval(() => bridge.avatarLevel?.(player.level(), "speech"), 33);
  state.voicePhase = "speaking";
  renderVoice();
  bridge.voiceSpeaking(true);
  const finished = await player.done;
  clearInterval(lipSync);
  bridge.avatarLevel?.(0, "speech");
  speechPlayers.delete(started.id);
  if (speech?.player === player) speech = null;
  state.voicePhase = null;
  renderVoice();
  bridge.voiceSpeaking(false, followUp && finished && state.voice !== "off");
  return finished;
}

/**
 * Confirms without speaking, for things the user already sees or hears (a song a quick action just started): on
 * screen, and as the floating face's caption, which shows it briefly while the face settles.
 */
function showQuietly(line) {
  if (!line) return;
  toast(line, "ok");
  bridge.avatarVoice?.({ text: line });
}

/** Drops a task Jarvis was about to start. Its words stay in the box for editing. */
function cancelVoicePending() {
  if (!state.voicePending) return false;
  state.voicePending = null;
  stopSpeaking();
  renderComposer();
  return true;
}

function lastReply() {
  for (const id of [...state.thread].reverse()) {
    const reply = state.runs.get(id)?.reply;
    if (reply) return reply.replace(/\s+/g, " ").slice(0, 300);
  }
  return null;
}

async function voiceStop(line) {
  if (cancelVoicePending()) {
    setPrompt("");
    await say(line ?? "Okay, I won't do that.");
  } else if (state.activeRunId ?? [...state.live].at(-1)) {
    // This chat's task first; from a chat with nothing running, the most recently started one.
    const runId = state.activeRunId ?? [...state.live].at(-1);
    state.voiceStoppedRunId = runId;
    void stopRun(runId);
    await say(line ?? "Stopping.");
  } else await say("Nothing is running right now.");
}

async function voiceCancel(line) {
  if (cancelVoicePending()) setPrompt("");
  await say(line ?? "Okay, cancelled.");
}

/**
 * What you're saying, live in the message box while you talk (from the speech worker's partial transcripts), then the
 * whole request while Jarvis works out what you meant (final). Text you typed yourself is never replaced, and typing
 * over these words makes them yours (overrideHeard).
 */
function showHeard(text, final = false) {
  const box = $("#prompt");
  if (!text || (box.value && box.value !== state.voiceHeard?.text)) return;
  state.voiceHeard = { text, final };
  box.classList.add("dictating");
  setPrompt(text);
}

/** Ends showing what you said. keep: the words stay as the prompt (a task to confirm); otherwise they're removed. */
function clearHeard(keep = false) {
  const heard = state.voiceHeard;
  if (!heard) return;
  state.voiceHeard = null;
  const box = $("#prompt");
  box.classList.remove("dictating");
  if (!keep && box.value === heard.text) setPrompt("");
  else renderComposer();
}

/**
 * You typed over what Jarvis heard ("Quick the Spotify" → "quit Spotify"): your words win. The spoken request is
 * dropped, whether it's still to come or being worked out, and the box is an ordinary prompt again: Enter sends it.
 */
function overrideHeard() {
  if (!state.voiceHeard) return false;
  state.voiceHeard = null;
  state.voiceOverridden = true;
  $("#prompt").classList.remove("dictating");
  return true;
}

// Spoken prompts drive the real mouse and keyboard, so Jarvis says what it understood before doing it ("I'll open
// Spotify and play Runway. Proceeding."). That sentence is the moment to catch a mishearing: talk over it, press Esc
// or click the box. The run starts only if it plays to the end.
async function proposeTask({ say: line, prompt }) {
  clearHeard(true);
  setPrompt(prompt);
  if (state.activeRunId || state.sending) {
    await say("I'm still on the current task. I've put that in the message box for when it's done.");
    return;
  }
  if (!state.prefs.confirmTasks) {
    // No confirmation: start now, and say what it's doing while it works.
    await send();
    if (state.prefs.speakReplies) void say(line, false);
    return;
  }
  const pending = { prompt };
  state.voicePending = pending;
  renderComposer();
  const heard = await say(`${line} Proceeding.`);
  if (state.voicePending !== pending) return; // cancelled while Jarvis spoke
  state.voicePending = null;
  renderComposer();
  if (!heard) return; // talked over: the correction that follows decides what happens
  await send();
}

/** Lower-case words only, so "London." matches the option "London". */
function normalized(text) {
  return ` ${String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

async function onVoiceCommand({ action, prompt, source }) {
  const addressed = source === "wake" || source === "push-to-talk";
  if (action === "none") {
    clearHeard();
    if (addressed) toast("Didn't catch that.", "info");
    return;
  }
  // You corrected it in the box while talking: what you typed is the request now, not what was heard.
  if (state.voiceOverridden) {
    state.voiceOverridden = false;
    return;
  }
  // The whole request replaces the live words and stays in view while Jarvis decides what to do with it.
  if (prompt) showHeard(prompt, true);
  else clearHeard();
  try {
    await inConversation(() => respond({ action, prompt, source, addressed }));
  } finally {
    clearHeard();
  }
}

async function respond({ action, prompt, source, addressed }) {
  // Plain "stop" / "cancel" need no model: act at once.
  if (action === "stop") return voiceStop();
  if (action === "cancel") return voiceCancel();
  // An open question takes what you say as its answer. Words caught in the follow-up window without "Hey Jarvis"
  // may be someone else talking, so they only count when they pick one of the offered options; approvals always
  // need you to address Jarvis (wake phrase, hold Control, the shortcut) or press a button.
  const asking = state.activeRunId ? state.runs.get(state.activeRunId) : null;
  if (asking?.question) {
    const question = asking.question;
    const deliberate = addressed || source === "barge-in";
    const option = question.options.find((choice) => normalized(prompt).includes(normalized(choice)));
    if (!deliberate && (question.kind === "approval" || !option)) {
      toast(question.kind === "approval" ? "To approve by voice, hold Control (or say “Hey Jarvis”) and say yes or no." : "Didn't take that as your answer. Hold Control and answer, or type it.", "info");
      return;
    }
    const answer = option ?? answerFor(question, prompt);
    if (answer === null) return say("Say yes or no.");
    if (await answerQuestion(asking.runId, question, answer)) return say(answer === "deny" ? "Okay, I won't." : "Got it.", false);
    return;
  }
  // While this chat's task works, what you say is judged against it: add, change the plan, queue, stop or answer.
  if (state.activeRunId) return followUp(prompt, { spoken: true });
  state.voicePhase = "thinking";
  renderVoice();
  const result = await bridge.voiceUnderstand({ text: prompt, source, running: null, lastReply: lastReply() });
  state.voicePhase = null;
  renderVoice();
  const reply = result.ok ? result.reply : { kind: "task", say: "On it.", prompt };
  // You typed over it while Jarvis was working it out: your text in the box is the request now.
  if (state.voiceOverridden) {
    state.voiceOverridden = false;
    return;
  }
  // Understood: anything but a task to confirm no longer needs the words in the box.
  if (reply.kind !== "task") clearHeard();
  if (reply.kind === "ignore") {
    if (addressed) toast("Didn't catch a task.", "info");
    return;
  }
  if (reply.kind === "stop") return voiceStop(reply.say);
  if (reply.kind === "cancel") return voiceCancel(reply.say);
  if (reply.kind === "answer") return reply.silent ? showQuietly(reply.say) : say(reply.say);
  if (reply.kind === "remember" || reply.kind === "schedule") {
    // Saved by the main process already; refresh the lists in case Settings is open.
    void (reply.kind === "remember" ? renderMemories() : renderRoutines());
    return say(reply.say);
  }
  return proposeTask(reply);
}
