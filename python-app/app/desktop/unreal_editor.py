"""Default Unreal Editor controls for Windows and macOS.

The engine itself is not in this repo. These are the stock Level Editor keys from
Epic's viewport-controls page, plus the menu-key difference between the two desktops.
https://dev.epicgames.com/documentation/en-us/unreal-engine/viewport-controls-in-unreal-engine
"""


def unreal_editor_card(platform: str) -> str:
    menu = "command" if platform == "darwin" else "ctrl"
    content_drawer = (
        "On macOS, do not press command+space; that opens Spotlight. Open the Content Drawer from its toolbar button."
        if platform == "darwin"
        else "On Windows, ctrl+space opens the Content Drawer."
    )
    return "\n".join([
        "The open application is Unreal Editor. Stay inside that window.",
        "Viewport keys match on Windows and macOS: Q select, W move, E rotate, R scale, Space cycles those tools, F frames the selection, G toggles game view.",
        "Hold the right mouse button and press W A S D to fly. Alt+left-drag orbits, Alt+right-drag dollies, Alt+middle-drag tracks.",
        f"Menu commands use {menu}: {menu}+z undo, {menu}+s save.",
        content_drawer,
        "This level is a property. Add a Camera Actor from Place Actors, aim it at the property, and leave that camera selected. Do not save, render, or package unless the prompt says so.",
    ])
