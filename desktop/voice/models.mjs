// Voice models live in the app's data folder, not the repo: downloaded once, SHA-256 verified, then reused.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
const KWS = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";
const MOONSHINE = "sherpa-onnx-moonshine-base-en-int8";
// Jarvis's voice: Kokoro v1.0 (int8), speaker "Heart" unless Settings → Voice picks another of its 28 English speakers.
// Piper "Alan" was 5× faster but sounded flat; Kokoro is far more natural, and speaking sentence by sentence hides most
// of its ~1 s per sentence.
const KOKORO = "kokoro-int8-multi-lang-v1_0";

export const VOICE_MODELS = [
  { label: "wake word", url: `${RELEASES}/kws-models/${KWS}.tar.bz2`, bytes: 17626723, sha256: "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a", unpacksTo: KWS },
  { label: "speech detector", url: `${RELEASES}/asr-models/silero_vad.onnx`, bytes: 643854, sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6", file: "silero_vad.onnx" },
  { label: "speech recognizer", url: `${RELEASES}/asr-models/${MOONSHINE}.tar.bz2`, bytes: 250807309, sha256: "21870cecaa2e44e4e2bf63e02d1072bed183ccd10284871353bd9d24dad14e5e", unpacksTo: MOONSHINE },
  { label: "Jarvis voice", url: `${RELEASES}/tts-models/${KOKORO}.tar.bz2`, bytes: 132303094, sha256: "4c3052abaa60943a341f193888cf6abd68787dae6ab8ae5c925a706caa247e4e", unpacksTo: KOKORO },
];

// "HEY JARVIS" in the wake model's BPE tokens, from `sherpa-onnx-cli text2token --tokens-type bpe`.
// :3.5 boosts the phrase in beam search, #0.08 is the trigger threshold (lower fires more easily). Measured with four
// synthetic voices over a song with sung vocals: 4/4 detected with music as loud as the voice (the earlier :3.0 #0.12
// got 2/4), 0/12 false wakes on near-misses ("Hey Travis", "Hey Jarrod", "Hey Javier", "Java is"), 0 over 60 s of
// song. With music louder than the voice no setting wakes (0/4); the push-to-talk shortcut covers that case.
export const WAKE_KEYWORDS = "▁HE Y ▁JA R VI S :3.5 #0.08 @HEY_JARVIS\n";

export function voiceModelPaths(root) {
  const kws = path.join(root, KWS);
  const moon = path.join(root, MOONSHINE);
  const kokoro = path.join(root, KOKORO);
  return {
    kws: {
      encoder: path.join(kws, "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
      decoder: path.join(kws, "decoder-epoch-12-avg-2-chunk-16-left-64.onnx"),
      joiner: path.join(kws, "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
    },
    kwsTokens: path.join(kws, "tokens.txt"),
    keywords: path.join(root, "keywords.txt"),
    vad: path.join(root, "silero_vad.onnx"),
    moonshine: {
      preprocessor: path.join(moon, "preprocess.onnx"),
      encoder: path.join(moon, "encode.int8.onnx"),
      uncachedDecoder: path.join(moon, "uncached_decode.int8.onnx"),
      cachedDecoder: path.join(moon, "cached_decode.int8.onnx"),
    },
    moonshineTokens: path.join(moon, "tokens.txt"),
    tts: {
      model: path.join(kokoro, "model.int8.onnx"),
      voices: path.join(kokoro, "voices.bin"),
      tokens: path.join(kokoro, "tokens.txt"),
      dataDir: path.join(kokoro, "espeak-ng-data"),
    },
    // Kokoro takes one lexicon per model instance, so the speaker loads the one matching the chosen voice's accent.
    ttsLexicons: {
      American: path.join(kokoro, "lexicon-us-en.txt"),
      British: path.join(kokoro, "lexicon-gb-en.txt"),
    },
  };
}

function installed(root, model) {
  return existsSync(path.join(root, model.unpacksTo ?? model.file));
}

async function download(model, target, onBytes) {
  const response = await fetch(model.url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Could not download the ${model.label} model (HTTP ${response.status}).`);
  const hash = createHash("sha256");
  const file = createWriteStream(target);
  let received = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    received += chunk.length;
    onBytes(received);
    if (!file.write(chunk)) await new Promise((resolve) => file.once("drain", resolve));
  }
  await new Promise((resolve, reject) => file.end((error) => (error ? reject(error) : resolve())));
  if (hash.digest("hex") !== model.sha256) throw new Error(`The ${model.label} model download was corrupted. Try again.`);
}

/** Downloads whatever is missing. onProgress({ label, received, total }) covers all missing models together. */
export async function ensureVoiceModels(root, onProgress = () => {}) {
  await mkdir(root, { recursive: true });
  const missing = VOICE_MODELS.filter((model) => !installed(root, model));
  const total = missing.reduce((sum, model) => sum + model.bytes, 0);
  let done = 0;
  for (const model of missing) {
    const partial = path.join(root, `${path.basename(new URL(model.url).pathname)}.part`);
    try {
      await download(model, partial, (received) => onProgress({ label: model.label, received: done + received, total }));
      if (model.file) await rename(partial, path.join(root, model.file));
      else await run("tar", ["-xjf", partial, "-C", root]); // bsdtar on macOS and Windows 10+ reads .tar.bz2
    } finally {
      await rm(partial, { force: true });
    }
    done += model.bytes;
  }
  await writeFile(path.join(root, "keywords.txt"), WAKE_KEYWORDS);
  return voiceModelPaths(root);
}
