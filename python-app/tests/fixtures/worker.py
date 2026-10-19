import contextlib
import io
import json
import os
import signal
import sys
import time

# Like the real worker: interrupts (the runner's deadline) reach model code only.
signal.signal(signal.SIGINT, signal.SIG_IGN)
print(json.dumps({"ready": True, "platform": sys.platform}), flush=True)
namespace = {"os": os, "time": time}
for line in sys.stdin:
    request = json.loads(line)
    captured = io.StringIO()
    signal.signal(signal.SIGINT, signal.default_int_handler)
    try:
        with contextlib.redirect_stdout(captured):
            exec(request["code"], namespace)  # noqa: S102 - Test-only desktop-free worker fixture.
        output = captured.getvalue()
    except BaseException as error:  # noqa: BLE001 - The protocol fixture returns arbitrary snippet failures.
        output = captured.getvalue() + (str(error) or type(error).__name__)
    finally:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    print(json.dumps({"id": request["id"], "output": [{"type": "input_text", "text": output}]}), flush=True)
