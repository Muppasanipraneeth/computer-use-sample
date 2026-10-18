from app.desktop.input_rules import desktop_permission_hint, shortcut_instruction
from app.desktop.worker import enable_dpi_awareness
from app.lab_catalog import instructions


def test_shortcuts_follow_the_machine():
    mac = shortcut_instruction("darwin")
    windows = shortcut_instruction("win32")
    assert "command" in mac and "ctrl" not in mac.split("Do not")[0]
    assert "ctrl" in windows and "command key" in windows
    assert "macOS" in desktop_permission_hint("darwin")
    assert "Windows" in desktop_permission_hint("win32")


def test_desktop_instructions_name_the_host_shortcut():
    mac = instructions("desktop", "desktop://primary", platform="darwin")
    windows = instructions("desktop", "desktop://primary", platform="win32")
    assert "This machine is macOS" in mac
    assert "This machine is Windows" in windows
    assert "command key" in mac
    assert "ctrl key" in windows
    assert "Unreal Editor" in mac and "Unreal Editor" in windows
    assert "W move" in mac and "W move" in windows
    assert "command+space" in mac
    assert "ctrl+space" in windows
    assert "Camera Actor" in mac and "property" in windows


def test_dpi_awareness_is_a_no_op_off_windows():
    enable_dpi_awareness()
