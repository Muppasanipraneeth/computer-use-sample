"""Shortcut and permission text for the OS that is actually running the desktop worker."""


def operating_system_name(platform: str) -> str:
    if platform == "darwin":
        return "macOS"
    if platform == "win32":
        return "Windows"
    return platform


def shortcut_instruction(platform: str) -> str:
    if platform == "darwin":
        return "This machine is macOS. Use the command key for shortcuts, such as command+z. Do not use ctrl for menu shortcuts."
    if platform == "win32":
        return "This machine is Windows. Use the ctrl key for shortcuts, such as ctrl+z. Do not use the command key."
    return f"This machine is {operating_system_name(platform)}. Use the ctrl key for shortcuts."


def desktop_permission_hint(platform: str) -> str:
    if platform == "darwin":
        return (
            "On macOS, turn on Jarvis (or the Terminal you started the runner from) under System Settings > "
            "Privacy & Security > Accessibility and > Screen Recording, then reopen it."
        )
    if platform == "win32":
        return (
            "On Windows, start the runner from a normal graphical desktop session, not a service, "
            "and keep the target app on the primary display."
        )
    return "Use a graphical desktop session and keep the target app on the primary display."
