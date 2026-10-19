// Floating Jarvis: a small transparent window above every app. At rest it's just "the Jarvis line", the glowing wave
// from the launch intro, breathing above the Dock; when you talk, Jarvis thinks or speaks, or a task works on the
// screen, the line moves with the voice and his expressive face rises above it with a caption. It never takes focus
// (a non-activating panel on macOS) and lets clicks through everywhere but the line, face and caption. Click the line
// to talk, hold it to talk for as long as you hold, drag it anywhere (it snaps to the presets), right-click it to
// adjust: when it shows, its size, where it sits, or hide it for an hour.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { BrowserWindow, ipcMain, Menu, screen } from "electron";

import { FACE_SIZES, faceMode, faceScale, faceState, faceVisible, moodFor, placeFace, snapFace } from "./avatar-mood.mjs";

const BASE = { width: 420, height: 250 };
// After a conversation the face lingers this long before settling back into the line (or hiding), so a quick next
// question doesn't make it pop out and in.
const LINGER_MS = 2200;
const DONE_MS = 2600;
const SNOOZE_MS = 60 * 60 * 1000;
const SPOT_LABELS = { "bottom-center": "Bottom centre", "bottom-right": "Bottom right", "top-center": "Top centre", "top-right": "Top right" };
const MODE_LABELS = { always: "Always (the Jarvis line)", talking: "Only while talking or working", off: "Off" };
const SIZE_LABELS = { small: "Small", medium: "Medium", large: "Large" };

export function createAvatar({ directory, userData, onOpen, onTalk, onSettings, onPrefs, log }) {
  // A preset ({ spot }) or a dragged position ({ x, y }). (avatar.json held the old face-only window's spot.)
  const placeFile = path.join(userData, "floating-jarvis.json");
  let win = null;
  let loaded = null;
  let mode = "always";
  let size = "medium";
  let shown = false;
  let lingering = null;
  let snoozedUntil = 0;
  let dragFrom = null;
  const face = { voice: "off", task: null, text: "", mood: "neutral" };

  const windowSize = () => {
    const scale = faceScale(size);
    return { width: Math.round(BASE.width * scale), height: Math.round(BASE.height * scale) };
  };

  function readPlace() {
    try {
      return JSON.parse(readFileSync(placeFile, "utf8"));
    } catch {
      return null;
    }
  }

  function writePlace(place) {
    try {
      writeFileSync(placeFile, JSON.stringify(place));
    } catch (error) {
      log.warn("couldn't remember where the floating Jarvis was put", error);
    }
  }

  function areas() {
    return [screen.getPrimaryDisplay(), ...screen.getAllDisplays()].map((display) => display.workArea);
  }

  function applyBounds() {
    if (!win || win.isDestroyed()) return;
    const bounds = windowSize();
    win.setBounds({ ...placeFace(readPlace(), bounds, areas()), ...bounds });
    // The page is laid out at medium size; zoom scales every part of it, so it stays crisp at any size.
    win.webContents.setZoomFactor(faceScale(size));
  }

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    const bounds = windowSize();
    win = new BrowserWindow({
      ...bounds,
      ...placeFace(readPlace(), bounds, areas()),
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      alwaysOnTop: true,
      backgroundColor: "#00000000",
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
      webPreferences: { preload: path.join(directory, "avatar-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, "floating");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true, { forward: true });
    loaded = win
      .loadFile(path.join(directory, "renderer", "avatar.html"))
      .then(() => win?.webContents.setZoomFactor(faceScale(size)))
      .catch((error) => log.warn("floating Jarvis failed to load", error));
    win.on("closed", () => {
      win = null;
      shown = false;
    });
    return win;
  }

  async function publish() {
    const active = faceVisible(face.voice, face.task);
    if (active) {
      clearTimeout(lingering);
      lingering = null;
    }
    // The line rests on screen only in "always" mode and not while snoozed; the face shows in either visible mode.
    const resting = mode === "always" && Date.now() >= snoozedUntil;
    const visible = mode !== "off" && (active || lingering !== null || resting);
    if (!visible) {
      if (shown) win?.webContents.send("avatar:state", { show: false });
      return;
    }
    const target = ensureWindow();
    await loaded;
    if (target.isDestroyed()) return;
    const expanded = active || lingering !== null;
    target.webContents.send("avatar:state", {
      show: true,
      expanded,
      state: expanded ? faceState(face.voice, face.task) : "idle",
      mood: expanded ? face.mood : "neutral",
      caption: expanded ? face.text : "",
      voiceOn: face.voice !== "off",
    });
    if (!shown) {
      target.showInactive();
      shown = true;
    }
  }

  // When a conversation ends the face stays a moment, then settles back into the line (or hides).
  function settle() {
    if (faceVisible(face.voice, face.task) || lingering) return;
    lingering = setTimeout(() => {
      lingering = null;
      face.text = "";
      face.mood = "neutral";
      void publish();
    }, LINGER_MS);
  }

  function setTask(task, text = "", outcome = null) {
    face.task = task;
    if (task) {
      face.text = text;
      face.mood = task === "done" ? moodFor(text, outcome) : task === "asking" ? "curious" : "neutral";
      // A finished task's reaction shows briefly on its own.
      if (task === "done") setTimeout(() => face.task === "done" && setTask(null), DONE_MS);
    } else settle();
    void publish();
  }

  function setMode(next) {
    mode = faceMode(next);
    void publish();
  }

  function setSize(next) {
    size = Object.hasOwn(FACE_SIZES, next) ? next : "medium";
    applyBounds();
  }

  function popMenu() {
    const place = readPlace();
    const template = [
      { label: "Open Jarvis", click: () => onOpen() },
      { label: "Talk to Jarvis", enabled: face.voice !== "off", click: () => onTalk("tap") },
      { type: "separator" },
      { label: "Show", submenu: Object.entries(MODE_LABELS).map(([value, label]) => ({ label, type: "radio", checked: mode === value, click: () => { setMode(value); onPrefs({ floatingFace: value }); } })) },
      { label: "Size", submenu: Object.entries(SIZE_LABELS).map(([value, label]) => ({ label, type: "radio", checked: size === value, click: () => { setSize(value); onPrefs({ floatingSize: value }); } })) },
      {
        label: "Position",
        submenu: [
          ...Object.entries(SPOT_LABELS).map(([spot, label]) => ({ label, type: "radio", checked: place?.spot === spot || (!place && spot === "bottom-center"), click: () => { writePlace({ spot }); applyBounds(); } })),
          { label: "Where I dragged it", type: "radio", checked: Number.isFinite(place?.x), enabled: Number.isFinite(place?.x) },
        ],
      },
      { label: "Hide for an hour", visible: mode === "always", click: () => { snoozedUntil = Date.now() + SNOOZE_MS; setTimeout(() => void publish(), SNOOZE_MS + 1000); void publish(); } },
      { type: "separator" },
      { label: "Floating Jarvis settings…", click: () => onSettings() },
    ];
    Menu.buildFromTemplate(template).popup({ window: win ?? undefined });
  }

  ipcMain.on("avatar:interactive", (_event, on) => win?.setIgnoreMouseEvents(!on, { forward: true }));
  ipcMain.on("avatar:faded", () => {
    if (!win || win.isDestroyed()) return;
    // Something new may have come in while it faded out.
    const resting = mode === "always" && Date.now() >= snoozedUntil;
    if (mode === "off" || (!faceVisible(face.voice, face.task) && !lingering && !resting)) {
      win.hide();
      shown = false;
    }
  });
  ipcMain.on("avatar:drag-start", () => {
    dragFrom = win ? win.getPosition() : null;
  });
  ipcMain.on("avatar:drag-move", (_event, dx, dy) => {
    if (win && dragFrom && Number.isFinite(dx) && Number.isFinite(dy)) win.setPosition(Math.round(dragFrom[0] + dx), Math.round(dragFrom[1] + dy));
  });
  ipcMain.on("avatar:drag-end", () => {
    dragFrom = null;
    if (!win) return;
    const [x, y] = win.getPosition();
    const bounds = windowSize();
    const area = screen.getDisplayMatching({ x, y, ...bounds }).workArea;
    const snapped = snapFace({ x, y }, bounds, area);
    writePlace(snapped.spot ? { spot: snapped.spot } : { x: snapped.x, y: snapped.y });
    if (snapped.spot) win.setPosition(snapped.x, snapped.y, true);
  });
  ipcMain.on("avatar:open", () => onOpen());
  ipcMain.on("avatar:talk", (_event, kind) => {
    if (["tap", "hold-start", "hold-end"].includes(kind)) onTalk(kind);
  });
  ipcMain.on("avatar:menu", () => popMenu());
  // Screens added, removed or rearranged: a dragged spot that's now off screen falls back to its preset.
  for (const event of ["display-added", "display-removed", "display-metrics-changed"]) screen.on(event, () => applyBounds());

  return {
    /** From the main window: a voice state change, or what Jarvis is about to say (text, plus a task's outcome). */
    voice({ state, text, outcome } = {}) {
      if (typeof state === "string") face.voice = state;
      if (typeof text === "string" && text) {
        face.text = text.replace(/\s+/g, " ").trim().slice(0, 240);
        face.mood = moodFor(face.text, outcome ?? null);
      }
      if (!faceVisible(face.voice, face.task)) settle();
      void publish();
    },
    task: setTask,
    /** Loudness, 0–1: Jarvis's voice and the user's both move the line; Jarvis's also moves the mouth. */
    level(level, source) {
      if (shown && win && !win.isDestroyed()) win.webContents.send("avatar:level", level, source);
    },
    setPrefs({ mode: nextMode, size: nextSize }) {
      if (nextSize !== undefined && nextSize !== size) setSize(nextSize);
      if (nextMode !== undefined) setMode(nextMode);
    },
  };
}
