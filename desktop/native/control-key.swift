// Jarvis's key watcher for hold-to-talk and dictation (macOS). Electron's globalShortcut can only register key
// combinations, never lone modifiers, so this tiny helper listens instead and prints one line per change on stdout:
//   "ready" / "untrusted"  once at start: whether macOS lets it see keys (Accessibility, granted to Jarvis, its parent)
//   "down"   Control went down with no other modifier held (ask Jarvis)
//   "up"     Control went up
//   "other"  another key, modifier or mouse button joined it, so Control is part of a shortcut (Ctrl+C, Ctrl+click)
//   "dictate-down" / "dictate-up" / "dictate-other"  the same for Control+Option held together (dictation: what you
//            say is typed where your cursor is)
// On stdin it takes "paste": it presses ⌘V for Jarvis, which puts the dictated words on the clipboard first.
// How long counts as a hold lives in desktop/voice/hold-key.mjs. The helper exits when its stdin closes, so it never
// outlives Jarvis. It only observes events; apart from that ⌘V it never sends, changes or blocks any.
import AppKit

setvbuf(stdout, nil, _IOLBF, 0)

let modifiers: NSEvent.ModifierFlags = [.shift, .control, .option, .command]
let dictateKeys: NSEvent.ModifierFlags = [.control, .option]
var controlDown = false
var dictating = false
// After a dictation hold, nothing new starts until every modifier is up: letting go of Option first must not turn the
// Control still held into an "ask Jarvis" hold.
var settling = false

_ = NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged]) { event in
    let held = event.modifierFlags.intersection(modifiers)
    if held.isEmpty { settling = false }
    if !dictating, !settling, held == dictateKeys {
        if controlDown {
            controlDown = false
            print("other") // Control alone became Control+Option: not an "ask Jarvis" hold after all
        }
        dictating = true
        print("dictate-down")
        return
    }
    if dictating {
        if held == dictateKeys { return }
        dictating = false
        settling = true
        // Letting go of either key ends it; Command or Shift joining means it was a shortcut (Ctrl+Opt+Cmd+…).
        print(held.isSubset(of: dictateKeys) ? "dictate-up" : "dictate-other")
        return
    }
    if !controlDown, !settling, held == .control {
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
    if dictating { print("dictate-other") }
}

/// ⌘V into whatever app has focus, with only Command set, whatever modifiers are still physically held.
func paste() {
    let source = CGEventSource(stateID: .hidSystemState)
    let v: CGKeyCode = 9 // kVK_ANSI_V
    for keyDown in [true, false] {
        let event = CGEvent(keyboardEventSource: source, virtualKey: v, keyDown: keyDown)
        event?.flags = .maskCommand
        event?.post(tap: .cghidEventTap)
    }
}

DispatchQueue.global().async {
    while let line = readLine() {
        if line == "paste" { DispatchQueue.main.async { paste() } }
    }
    exit(0)
}

print(AXIsProcessTrusted() ? "ready" : "untrusted")
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
app.run()
