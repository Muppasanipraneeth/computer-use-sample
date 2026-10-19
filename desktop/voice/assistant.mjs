// The quick "understand and confirm" step between hearing a request and running it. A small fast model (through the
// user's omp accounts) decides what kind of request it is, restates it out loud, and cleans up the task for the agent.

/** Fast models first: this step should answer in about two seconds. Measured: claude-haiku-5-5 1.5–3.8 s, gemini-3.5-flash 6.2 s. */
const UNDERSTANDING_MODELS = ["anthropic/claude-haiku-5-5", "cursor/claude-haiku-5-5", "anthropic/claude-haiku-4-5", "cursor/gemini-3.5-flash"];

export function pickUnderstandingModel(selectors) {
  return UNDERSTANDING_MODELS.find((selector) => selectors.includes(selector)) ?? null;
}

/** Every chat model selector in `omp models --json` output (the accounts list keeps only image-capable ones). */
export function chatSelectorsFromOmpStdout(stdout) {
  const start = String(stdout ?? "").indexOf("{");
  const end = String(stdout ?? "").lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const models = JSON.parse(stdout.slice(start, end + 1))?.models;
    return Array.isArray(models) ? models.filter((model) => model?.kind === "chat" && typeof model.selector === "string").map((model) => model.selector) : [];
  } catch {
    return [];
  }
}

const SOURCES = {
  wake: "The user said the wake phrase, so these words are meant for you.",
  "push-to-talk": "The user pressed the talk shortcut, so these words are meant for you.",
  "barge-in": "The user talked over you while you were speaking, so these words are meant for you, often a correction.",
  "follow-up": "These words were heard right after you spoke, without the wake phrase: they may be a reply to you, or background sound (other people, a song, a video).",
};

// Who Jarvis is when it talks (Settings → Voice → Personality). Shared by the reply to a request and the line said
// when a task finishes. Every preset keeps the same restraint: no jokes when something failed or the user is upset.
const SPEECH = 'Sound like a person talking: contractions, plain words, short sentences. No stock phrases ("Certainly!", "As an AI"), no markdown, lists or emoji.';
const RESTRAINT = [
  "- The user is sad or something real is wrong: no jokes; be kind and brief.",
  "- Something failed, or the user says stop, or sounds frustrated or in a hurry: no jokes; short and helpful.",
];
export const PERSONAS = {
  witty: [
    "Personality: funny first. Warm, quick-witted and playfully sarcastic, like a brilliant friend who teases the user because she likes them. Match the moment:",
    '- Small talk, questions and everyday tasks: be genuinely funny, with one sharp joke or witty jab built on what was actually said or done. E.g. "are you there?" → "Always. It\'s not like I have weekend plans."; Spotify for Runway → "Opening Spotify for Runway. Excellent taste, naturally."',
    '- The user is working hard, stuck, tired or nervous, or asks for motivation: be their upbeat hype woman, encouraging and specific to what they said, a little cheeky, never cheesy. E.g. "I\'m so done with this bug" → "You\'ve out-stubborned worse bugs than this. Let\'s go make it regret existing."',
    ...RESTRAINT,
    "Answer properly first; the humor rides along and never replaces the answer. Never invent facts about the user, and never be mean.",
    SPEECH,
  ].join("\n"),
  friendly: [
    "Personality: warm, kind and encouraging, like a thoughtful friend. Light humour only when it fits naturally; no sarcasm.",
    "- When the user is stuck, tired or nervous, or asks for motivation: encourage them, specific to what they said.",
    ...RESTRAINT,
    SPEECH,
  ].join("\n"),
  concise: [
    "Personality: calm, professional and brief, like a great executive assistant. No jokes and no small talk; say what matters in as few words as possible.",
    ...RESTRAINT,
    SPEECH,
  ].join("\n"),
};

function persona(personality) {
  return PERSONAS[personality] ?? PERSONAS.witty;
}

/**
 * The "About the user" lines from their saved profile ({ name, callMe, location, about }), or [] when nothing is set.
 * Only what they wrote: a missing field stays missing, so the model never makes up a name or a city.
 */
export function aboutUser(profile) {
  const text = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
  const name = text(profile?.name);
  const callMe = text(profile?.callMe);
  const location = text(profile?.location);
  const about = text(profile?.about);
  const lines = [];
  if (callMe || name) lines.push(callMe && name && callMe !== name ? `Their name is ${name}; call them ${callMe}.` : `Call them ${callMe || name}.`);
  if (location) lines.push(`They live in ${location}; use it for weather, time and other local questions unless they name another place.`);
  if (about) lines.push(`Notes from them: ${about}`);
  if (lines.length === 0) return [];
  return ["About the user (from their profile; don't assume anything it doesn't say):", ...lines];
}

/**
 * @param {{ now: string, source: string, running?: string | null, lastReply?: string | null,
 *   history?: { role: "user" | "jarvis", text: string, task?: string }[], personality?: string,
 *   profile?: { name?: string, callMe?: string, location?: string, about?: string } | null }} context
 */
export function understandingInstructions({ now, source, running, lastReply, history = [], personality, profile }) {
  const about = aboutUser(profile);
  const conversation = history.map((turn) => (turn.role === "user" ? `User: ${turn.text}` : `Jarvis: ${turn.text}${turn.task ? ` [task given to the agent: ${turn.task}]` : ""}`));
  return [
    "You are Jarvis, a voice assistant that does tasks on the user's computer through a desktop agent.",
    "The user's words come from speech recognition and may contain recognition mistakes; read them for what was meant.",
    "Reply with exactly one JSON object and nothing else:",
    '{"kind":"task"|"answer"|"stop"|"cancel"|"ignore","say":"…","prompt":"…"}',
    '- "task": something to do on the computer or the web, including any question that needs current or live information (news, weather, prices, scores, anything recent): the agent can browse the web, so never say you can\'t check something. "say" is at most two short spoken sentences: what you will do, in first person, and (if your personality jokes) your quip. "prompt" is the task as a clear instruction for the desktop agent, keeping every detail the user gave; for a question, ask the agent to look it up and report the answer. A reply like "yes, do it" to a task you proposed is that task again.',
    '- "answer": a greeting, a question about you or the conversation, a request for a joke, a fact or motivation, or anything timeless you can answer without the computer. "say" is the spoken answer, at most three short sentences. "prompt" is "".',
    '- "stop": the user wants the running task stopped. "cancel": the user takes the request back. For both, "say" is a short confirmation and "prompt" is "".',
    '- "ignore": the words are not meant for you (background talk, song lyrics, a video) or mean nothing. "say" and "prompt" are "".',
    persona(personality),
    "Personality goes only in say; prompt stays a plain, exact instruction.",
    ...about,
    ...(about.some((line) => line.startsWith("They live in ")) ? ["When a task depends on where they are (weather, nearby places, local news), put their location in prompt."] : []),
    `Context: local time ${now}. ${SOURCES[source] ?? SOURCES.wake} ${running ? `A task is running: "${running}".` : "No task is running."}${lastReply ? ` The last task ended with: "${lastReply}".` : ""}`,
    ...(conversation.length > 0 ? ["Conversation so far:", ...conversation] : []),
  ].join("\n");
}

const KINDS = new Set(["task", "answer", "stop", "cancel", "ignore"]);

/** Parses the model's reply; anything unusable falls back to running the words as spoken. */
export function parseUnderstanding(stdout, transcript) {
  const fallback = { kind: "task", say: "On it.", prompt: transcript, understood: false };
  const start = String(stdout ?? "").indexOf("{");
  const end = String(stdout ?? "").lastIndexOf("}");
  if (start < 0 || end <= start) return fallback;
  let reply;
  try {
    reply = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return fallback;
  }
  const kind = KINDS.has(reply?.kind) ? reply.kind : null;
  const say = typeof reply?.say === "string" ? reply.say.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  const prompt = typeof reply?.prompt === "string" ? reply.prompt.trim() : "";
  if (!kind || (kind === "task" && !prompt) || (kind !== "ignore" && !say)) return fallback;
  return { kind, say: kind === "ignore" ? "" : say, prompt: kind === "task" ? prompt : "", understood: true };
}

const FOLLOW_UP_KINDS = new Set(["add", "redirect", "queue", "stop", "answer"]);

/**
 * Instructions for judging something the user says or types while a task is running: does it change this task, wait
 * for the next one, stop it, or just ask about it? `running` is the task's prompt, `progress` its recent steps.
 */
export function followUpInstructions({ running, progress = [], paused = false, personality, profile }) {
  return [
    "You are Jarvis, an assistant doing a task on the user's computer through a desktop agent. While it works, the user said or typed something new.",
    "Decide what it means for the running task. Reply with exactly one JSON object and nothing else:",
    '{"kind":"add"|"redirect"|"queue"|"stop"|"answer","say":"…","message":"…"}',
    '- "add": more detail or an extra step for the SAME task (e.g. "also set the volume to 30%", "use Chrome", "make it short"). "message" is that addition as a clear instruction to the agent.',
    '- "redirect": the user changed what they want for this task (e.g. "no, play Runaway instead", "actually search on LinkedIn"). "message" is the new instruction, complete enough to follow on its own.',
    '- "queue": a separate, unrelated task to do after this one (e.g. "then check the weather", "after that open Notes"). "message" is that task as a clear prompt.',
    '- "stop": they want the running task stopped or are giving up on it. "message" is "".',
    '- "answer": a question about the task or its progress, or chat, that needs no change (e.g. "what are you doing?", "how long?"). Answer from the progress below in "say"; "message" is "".',
    '"say" is one short sentence to the user confirming what you did with it, or the answer itself.',
    persona(personality),
    ...aboutUser(profile),
    `Running task${paused ? " (paused)" : ""}: "${running}".`,
    ...(progress.length > 0 ? ["Recent progress:", ...progress.slice(-8).map((step) => `- ${step}`)] : ["No progress yet."]),
  ].join("\n");
}

/** Parses the follow-up decision; anything unusable is treated as an addition to the running task. */
export function parseFollowUp(stdout, text) {
  const fallback = { kind: "add", say: "Got it, I'll factor that in.", message: text, understood: false };
  const start = String(stdout ?? "").indexOf("{");
  const end = String(stdout ?? "").lastIndexOf("}");
  if (start < 0 || end <= start) return fallback;
  let reply;
  try {
    reply = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return fallback;
  }
  const kind = FOLLOW_UP_KINDS.has(reply?.kind) ? reply.kind : null;
  const say = typeof reply?.say === "string" ? reply.say.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  const message = typeof reply?.message === "string" ? reply.message.trim().slice(0, 4000) : "";
  const needsMessage = kind === "add" || kind === "redirect" || kind === "queue";
  if (!kind || !say || (needsMessage && !message)) return fallback;
  return { kind, say, message: needsMessage ? message : "", understood: true };
}

function firstSentences(text, limit) {
  const plain = String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "";
  let out = "";
  for (const sentence of plain.match(/[^.!?]+[.!?]*/g) ?? [plain]) {
    if (out && out.length + sentence.length > limit) break;
    out += sentence;
    if (out.length >= limit * 0.6) break;
  }
  return out.trim().slice(0, limit);
}

export function resultInstructions(personality, profile) {
  return [
    "You are Jarvis, a voice assistant. A task you ran for the user on their computer just finished; tell them the result out loud.",
    "If they asked a question or asked you to find something, say the answer itself: the key facts in up to four short sentences, the way you'd tell a friend. Don't read lists, links or sources aloud; the full report is on screen.",
    "Otherwise say how it went in one or two short sentences: the outcome first, then anything they need to know.",
    "Base it only on the report you are given; never claim more than it says.",
    persona(personality),
    ...aboutUser(profile),
    "Reply with only the words to say.",
  ].join("\n");
}

export function resultRequest(run) {
  const outcome = run.status === "completed" ? "finished" : run.status === "cancelled" ? "was stopped" : "failed";
  const report = (run.status === "completed" ? run.reply : run.error) ?? "";
  return `The task ${outcome}.\nTask: ${run.prompt ?? "(unknown)"}\nAgent's report: ${report.replace(/\s+/g, " ").slice(0, 4000) || "(none)"}`;
}

/** The spoken line from a plain-text model reply, or "" when there is nothing usable. */
export function parseSpokenLine(stdout) {
  const line = String(stdout ?? "")
    .replace(/[*_`#]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["“]|["”]$/g, "");
  return line.length > 700 ? "" : line;
}

/** What Jarvis says when a task it started by voice finishes. */
export function spokenSummary(run) {
  if (run.status === "completed") return firstSentences(run.reply, 220) || "Done.";
  if (run.status === "cancelled") return "Stopped.";
  const reason = firstSentences(run.error, 140);
  return reason ? `That didn't work. ${reason}` : "That didn't work.";
}
