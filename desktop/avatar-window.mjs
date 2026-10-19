// The floating Jarvis face: a small transparent window above other apps while you talk to Jarvis or a task works on
// your screen. It never takes focus (a non-activating panel on macOS), lets clicks through everywhere but the face
// and its caption, can be dragged anywhere (the spot is remembered), and opens Jarvis when clicked.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { BrowserWindow, ipcMain, screen } from "electron";

import { faceState, faceVisible, moodFor, placeFace } from "./avatar-mood.mjs";

const SIZE = { width: 400, height: 150 };
// After the conversation ends the face lingers this long, so a quick next question doesn't make it blink out and in.
const LINGER_MS = 2200;
const DONE_MS = 2600;

export function createAvatar({ directory, userData, onOpen, log }) {
  const placeFile = path.join(userData, "avatar.json");
  let win = null;
  let loaded = null;
  let enabled = true;
  let shown = false;
  let hideTimer = null;
  let dragFrom = null;
  const face = { voice: "off", task: null, text: "", mood: "neutral" };

  function savedPlace() {
    try {
      return JSON.parse(readFileSync(placeFile, "utf8"));
    } catch {
      return null;
    }
  }

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    const areas = [screen.getPrimaryDisplay(), ...screen.getAllDisplays()].map((display) => display.workArea);
    const { x, y } = placeFace(savedPlace(), SIZE, areas);
    win = new BrowserWindow({
      ...SIZE,
      x,
      y,
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
    // Clicks go through to whatever is underneath, except over the face (the page asks for them back on hover).
    win.setIgnoreMouseEvents(true, { forward: true });
    loaded = win.loadFile(path.join(directory, "renderer", "avatar.html")).catch((error) => log.warn("floating face failed to load", error));
    win.on("closed", () => {
      win = null;
      shown = false;
    });
    return win;
  }

  async function publish() {
    if (!enabled) return;
    const state = faceState(face.voice, face.task);
    const visible = faceVisible(face.voice, face.task);
    if (visible) {
      clearTimeout(hideTimer);
      hideTimer = null;
      const target = ensureWindow();
      await loaded;
      if (target.isDestroyed()) return;
      target.webContents.send("avatar:state", { state, mood: face.mood, caption: face.text, show: true });
      if (!shown) {
        target.showInactive();
        shown = true;
      }
      // A finished task's reaction shows briefly on its own, then the face floats away.
      if (state === "done") hideTimer = setTimeout(() => setTask(null), DONE_MS);
    } else if (shown && !hideTimer) {
      win?.webContents.send("avatar:state", { state: "idle", mood: "neutral", caption: "", show: true });
      hideTimer = setTimeout(() => {
        hideTimer = null;
        win?.webContents.send("avatar:state", { state: "idle", mood: "neutral", caption: "", show: false });
      }, LINGER_MS);
    }
  }

  function setTask(task, text = "", outcome = null) {
    face.task = task;
    if (task) {
      face.text = text;
      face.mood = task === "done" ? moodFor(text, outcome) : task === "asking" ? "curious" : "neutral";
    }
    void publish();
  }

  ipcMain.on("avatar:interactive", (_event, on) => win?.setIgnoreMouseEvents(!on, { forward: true }));
  ipcMain.on("avatar:faded", () => {
    if (hideTimer || faceVisible(face.voice, face.task)) return; // something new came in while it faded
    win?.hide();
    shown = false;
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
    try {
      writeFileSync(placeFile, JSON.stringify({ x, y }));
    } catch (error) {
      log.warn("couldn't remember where the floating face was put", error);
    }
  });
  ipcMain.on("avatar:open", () => onOpen());

  return {
    /** From the main window: a voice state change, or what Jarvis is about to say (text, plus a task's outcome). */
    voice({ state, text, outcome } = {}) {
      if (typeof state === "string") face.voice = state;
      if (typeof text === "string" && text) {
        face.text = text.replace(/\s+/g, " ").trim().slice(0, 240);
        face.mood = moodFor(face.text, outcome ?? null);
      } else if (state && state !== "speaking") {
        face.text = "";
        face.mood = "neutral";
      }
      void publish();
    },
    task: setTask,
    /** Loudness, 0–1: Jarvis's voice moves the mouth, the user's moves the listening rings. */
    level(level, source) {
      if (shown && win && !win.isDestroyed()) win.webContents.send("avatar:level", level, source);
    },
    setEnabled(on) {
      enabled = on;
      if (!on && win && !win.isDestroyed()) {
        win.hide();
        shown = false;
      }
    },
  };
}
