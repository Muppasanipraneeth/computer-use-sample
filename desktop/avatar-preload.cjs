// The floating face's only channel to the app: what to show, how loud, and the user dragging or clicking it.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("avatarApi", {
  onState: (handler) => ipcRenderer.on("avatar:state", (_event, payload) => handler(payload)),
  onLevel: (handler) => ipcRenderer.on("avatar:level", (_event, level, source) => handler(level, source)),
  interactive: (on) => ipcRenderer.send("avatar:interactive", Boolean(on)),
  faded: () => ipcRenderer.send("avatar:faded"),
  dragStart: () => ipcRenderer.send("avatar:drag-start"),
  dragMove: (dx, dy) => ipcRenderer.send("avatar:drag-move", dx, dy),
  dragEnd: () => ipcRenderer.send("avatar:drag-end"),
  open: () => ipcRenderer.send("avatar:open"),
  talk: (kind) => ipcRenderer.send("avatar:talk", kind),
  action: (name, value) => ipcRenderer.send("avatar:action", name, value),
});
