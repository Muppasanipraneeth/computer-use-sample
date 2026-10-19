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
  typed: "The user typed this in the message box, so it is meant for you and has no recognition mistakes.",
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
 * The "About the user" lines from their saved profile ({ name, callMe, location, about, memories }), or [] when
 * nothing is set. Only what they wrote: a missing field stays missing, so the model never makes up a name or a city.
 */
export function aboutUser(profile) {
  const text = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
  const name = text(profile?.name);
  const callMe = text(profile?.callMe);
  const location = text(profile?.location);
  const about = text(profile?.about);
  // Newest last; the cap keeps a long memory list from crowding out the instructions.
  const memories = (Array.isArray(profile?.memories) ? profile.memories : []).map(text).filter(Boolean).slice(-30);
  const lines = [];
  if (callMe || name) lines.push(callMe && name && callMe !== name ? `Their name is ${name}; call them ${callMe}.` : `Call them ${callMe || name}.`);
  if (location) lines.push(`They live in ${location}; use it for weather, time and other local questions unless they name another place.`);
  if (about) lines.push(`Notes from them: ${about}`);
  if (memories.length > 0) lines.push("Things they asked you to remember:", ...memories.map((memory) => `- ${memory}`));
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
    '{"kind":"task"|"answer"|"remember"|"schedule"|"stop"|"cancel"|"ignore","say":"…","prompt":"…","quick":{…},"time":"HH:MM","days":[0,1,2,3,4,5,6]}',
    '"time" and "days" only for "schedule"; leave them out otherwise.',
    '"quick" only for a "task" that is exactly one command to run now without the agent: {"do":"play","query":"<song title> by <artist>"} (a named song in Spotify, include "by artist" when known), {"do":"pause"}, {"do":"resume"}, {"do":"next"}, {"do":"previous"}, {"do":"volume","level":0-100} (computer volume), {"do":"open","app":"<app name>"}, {"do":"quit","app":"<app name>"} (quit or close an app; speech recognition often writes "quit" as "quick" or "quite", so "quick the Slack app" means quit Slack). Correct clear speech-recognition mistakes in names, but do not guess an artist. Leave "quick" out for albums, playlists, genres, another service (YouTube/Apple Music), song lyrics, or requests containing another step.',
    '- "task": something to do on the computer or the web, including any question that needs current or live information (news, weather, prices, scores, anything recent): the agent can browse the web, so never say you can\'t check something. "say" is at most two short spoken sentences: what you will do, in first person, and (if your personality jokes) your quip. "prompt" is the task as a clear instruction for the desktop agent, keeping every detail the user gave; for a question, ask the agent to look it up and report the answer. A reply like "yes, do it" to a task you proposed is that task again.',
    '- "answer": a greeting, a question about you or the conversation, a request for a joke, a fact or motivation, or anything timeless you can answer without the computer. "say" is the spoken answer, at most three short sentences. "prompt" is "".',
    '- "stop": the user wants the running task stopped. "cancel": the user takes the request back. For both, "say" is a short confirmation and "prompt" is "".',
    '- "remember": the user tells you to remember something about them or states a lasting preference ("remember I prefer Spotify", "my sister is called Asha"). "prompt" is that fact as a short note about the user ("Prefers Spotify over Apple Music"); "say" confirms in one short sentence.',
    '- "schedule": the user wants something done regularly at a time ("every morning at 8 tell me the tech news", "on weekdays at 6 pm remind me to stretch"). "prompt" is the task to run each time, as a clear instruction for the desktop agent; "time" is 24-hour local "HH:MM"; "days" lists the weekdays it runs (0 is Sunday; every day is [0,1,2,3,4,5,6], weekdays [1,2,3,4,5]). "say" confirms when it will run. A one-off request for later ("tomorrow at 8") is not a schedule: answer that you can only set up repeating routines.',
    '- "ignore": the words are not meant for you (background talk, song lyrics, a video) or mean nothing. "say" and "prompt" are "".',
    persona(personality),
    "Personality goes only in say; prompt stays a plain, exact instruction.",
    ...about,
    ...(about.some((line) => line.startsWith("They live in ")) ? ["When a task depends on where they are (weather, nearby places, local news), put their location in prompt."] : []),
    `Context: local time ${now}. ${SOURCES[source] ?? SOURCES.wake} ${running ? `A task is running: "${running}".` : "No task is running."}${lastReply ? ` The last task ended with: "${lastReply}".` : ""}`,
    ...(conversation.length > 0 ? ["Conversation so far:", ...conversation] : []),
  ].join("\n");
}

const KINDS = new Set(["task", "answer", "remember", "schedule", "stop", "cancel", "ignore"]);
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

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
  const needsPrompt = kind === "task" || kind === "remember" || kind === "schedule";
  if (!kind || (needsPrompt && !prompt) || (kind !== "ignore" && !say)) return fallback;
  if (kind === "schedule") {
    const days = Array.isArray(reply.days) ? [...new Set(reply.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort() : [];
    // Running "every morning…" once would be wrong, so an unreadable schedule asks the user to set it up by hand.
    if (!CLOCK.test(reply.time ?? "") || days.length === 0) {
      return { kind: "answer", say: "I couldn't tell when that should run. Set it up in Settings, under Routines.", prompt: "", understood: true };
    }
    return { kind, say, prompt, time: reply.time, days, understood: true };
  }
  const quick = kind === "task" && reply.quick && typeof reply.quick === "object" ? reply.quick : undefined;
  return { kind, say: kind === "ignore" ? "" : say, prompt: needsPrompt ? prompt : "", ...(quick ? { quick } : {}), understood: true };
}

// Typed text that may be a routine or something to remember goes through the model first; everything else starts
// a task straight away, so ordinary prompts pay no extra latency.
const ROUTINE_HINT = /\b(every|each)\s+(day|morning|evening|night|afternoon|week|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hour)s?\b|\b(daily|weekdays|weekends|nightly)\b/i;
const MEMORY_HINT = /^\s*(please\s+)?(remember|don't forget|note that|keep in mind)\b/i;
export function typedNeedsUnderstanding(text) {
  return ROUTINE_HINT.test(text) || MEMORY_HINT.test(text);
}

function capitalized(text) {
  const trimmed = text.trim().replace(/^[,:;\s]+/, "");
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Follow-ups whose meaning is obvious from their first words skip the model (about 2.5 s): "stop", "also …",
 * "then …", "no, … instead". Questions and anything else return null and are judged by the model.
 */
export function quickFollowUp(text) {
  const words = String(text ?? "").trim();
  if (!words || words.endsWith("?")) return null;
  if (/^(stop|cancel|abort|never ?mind|forget it)( it| that| the task| this)?[.!]*$/i.test(words)) return { kind: "stop", say: "Stopping.", message: "", understood: true };
  const rest = (pattern) => {
    const match = words.match(pattern);
    return match ? capitalized(words.slice(match[0].length)) : "";
  };
  // A question word after the lead ("actually, what time is it") still goes to the model.
  const question = (remainder) => /^(what|how|why|when|where|who|which|is|are|can|could|do|does|did|will|would)\b/i.test(remainder);
  const added = rest(/^(also|and also|plus|oh and|oh,? also)\b[,:]?\s+/i);
  if (added && !question(added)) return { kind: "add", say: "Got it, adding that.", message: added, understood: true };
  const next = rest(/^(then|after that|afterwards|next|when you'?re done|once you'?re done|when done)\b[,:]?\s+/i);
  if (next && !question(next)) return { kind: "queue", say: "Okay, I'll do that next.", message: next, understood: true };
  // "No" needs its comma: "no, play Runaway" changes the plan, "no worries" doesn't.
  const changed = rest(/^(?:(?:no|nope)[,!.]\s*|(?:actually|instead)\b,?\s+)/i);
  if (changed && !question(changed)) return { kind: "redirect", say: "Okay, changing course.", message: changed, understood: true };
  return null;
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

// Tasks whose result the user sees or hears for themselves (the song plays, the app opens). Saying "Done, it's
// playing" only talks over it, and the music pauses while Jarvis speaks: so these finish silently, on screen only.
const EVIDENT_ACTION = /^(?:(?:hey )?jarvis[,\s]+)?(?:please\s+)?(?:open|launch|start|play|put on|pause|resume|skip|next|previous|turn (?:up|down)|set (?:the )?volume|mute|unmute|close|quit|minimi[sz]e|maximi[sz]e)\b/i;
// …unless they asked to be told something, or the report says it didn't go as asked.
const NEEDS_TELLING = /\?|\b(?:what|who|when|where|why|how|which|find|search|look up|tell me|let me know|check|summari[sz]e|read|list|compare|explain)\b/i;
const TROUBLE = /\b(?:couldn'?t|could not|can'?t|cannot|unable|failed|not found|no results|didn'?t|did not|wasn'?t|isn'?t|instead|however|but)\b/i;

/**
 * Whether a finished run is worth saying out loud. A failure always is; a stop never (the user stopped it); a
 * completed action is only when its result isn't already in front of them. The result model can still pass on the
 * rest (SILENT, see resultInstructions).
 */
export function resultWorthSaying(run) {
  if (run.status === "failed") return true;
  if (run.status !== "completed") return false;
  const prompt = String(run.prompt ?? "").trim();
  return !EVIDENT_ACTION.test(prompt) || NEEDS_TELLING.test(prompt) || TROUBLE.test(String(run.reply ?? ""));
}

export function resultInstructions(personality, profile, workspace = null) {
  const name = typeof workspace?.name === "string" ? workspace.name.trim() : "";
  const rules = typeof workspace?.instructions === "string" ? workspace.instructions.replace(/\s+/g, " ").trim().slice(0, 1500) : "";
  return [
    "You are Jarvis, a voice assistant. A task you ran for the user on their computer just finished; tell them the result out loud, or stay quiet when there is nothing worth interrupting them for.",
    "If they asked a question or asked you to find something, say the answer itself: the key facts in up to four short sentences, the way you'd tell a friend. Don't read lists, links or sources aloud; the full report is on screen.",
    "If the task was an action whose result they can already see or hear (music or a video started, an app, page or file opened, a setting changed) and the report says it worked as asked, reply with exactly SILENT: speaking would only talk over it.",
    "Otherwise say how it went in one or two short sentences: the outcome first, then anything they need to know.",
    "Base it only on the report you are given; never claim more than it says.",
    persona(personality),
    ...aboutUser(profile),
    // The task ran in one of the user's workspaces: its instructions apply to what Jarvis says too (tone, language).
    ...(name && rules ? [`The task ran in their workspace "${name}", whose instructions apply to how you speak as well: ${rules}`] : []),
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

/** True when the result model chose to stay quiet. */
export function isSilent(line) {
  return /^silent[.!]?$/i.test(String(line ?? "").trim());
}

/** What Jarvis says when a task finishes and no model is available to put it in words (callers check resultWorthSaying). */
export function spokenSummary(run) {
  if (run.status === "completed") return firstSentences(run.reply, 220) || "Done.";
  if (run.status === "cancelled") return "Stopped.";
  const reason = firstSentences(run.error, 140);
  return reason ? `That didn't work. ${reason}` : "That didn't work.";
}
