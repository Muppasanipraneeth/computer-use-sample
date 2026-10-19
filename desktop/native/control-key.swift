// Jarvis's Control-key watcher for hold-to-talk (macOS). Electron's globalShortcut can only register key combinations,
// never a lone modifier, so this tiny helper listens instead and prints one line per change on stdout:
//   "ready" / "untrusted"  once at start: whether macOS lets it see keys (Accessibility, granted to Jarvis, its parent)
//   "down"   Control went down with no other modifier held
//   "up"     Control went up
//   "other"  another key, modifier or mouse button joined it, so Control is part of a shortcut (Ctrl+C, Ctrl+click)
// How long counts as a hold lives in desktop/voice/hold-key.mjs. The helper exits when its stdin closes, so it never
// outlives Jarvis. It only observes events; it never changes or blocks them.
import AppKit

setvbuf(stdout, nil, _IOLBF, 0)

let modifiers: NSEvent.ModifierFlags = [.shift, .control, .option, .command]
var controlDown = false

_ = NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged]) { event in
    let held = event.modifierFlags.intersection(modifiers)
    if !controlDown, held == .control {
        controlDown = true
        print("down")
    } else if controlDown, !held.contains(.control) {
        controlDown = false
        print("up")
    } else if controlDown, held != .control {
        print("other")
    }
}
_ = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown]) { _ in
    if controlDown { print("other") }
}

DispatchQueue.global().async {
    while readLine() != nil {}
    exit(0)
}

print(AXIsProcessTrusted() ? "ready" : "untrusted")
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
app.run()
