import assert from "node:assert/strict";
import test from "node:test";

import { createHoldKey } from "../voice/hold-key.mjs";

/** A hold-key with a manual clock: `fire()` plays the pending timer as if the hold delay passed. */
function harness() {
  const calls = [];
  let pending = null;
  const hold = createHoldKey({
    start: () => calls.push("start"),
    end: () => calls.push("end"),
    cancel: () => calls.push("cancel"),
    setTimer: (callback) => {
      pending = callback;
      return 1;
    },
    clearTimer: () => {
      pending = null;
    },
  });
  const fire = () => {
    const callback = pending;
    pending = null;
    callback?.();
  };
  return { hold, calls, fire };
}

test("holding Control alone listens until it is released", () => {
  const { hold, calls, fire } = harness();
  hold.handle("down");
  assert.deepEqual(calls, [], "nothing before the hold delay");
  fire();
  hold.handle("up");
  assert.deepEqual(calls, ["start", "end"]);
});

test("quick taps and shortcuts like Ctrl+C never open the microphone", () => {
  const { hold, calls, fire } = harness();
  hold.handle("down");
  hold.handle("up");
  fire();
  hold.handle("down");
  hold.handle("other");
  fire();
  hold.handle("up");
  assert.deepEqual(calls, []);
});

test("a key pressed after listening began cancels, and nothing restarts until Control is released", () => {
  const { hold, calls, fire } = harness();
  hold.handle("down");
  fire();
  hold.handle("other");
  hold.handle("down");
  fire();
  assert.deepEqual(calls, ["start", "cancel"]);
  hold.handle("up");
  hold.handle("down");
  fire();
  assert.deepEqual(calls, ["start", "cancel", "start"]);
});

test("losing the watcher mid-hold drops what was heard", () => {
  const { hold, calls, fire } = harness();
  hold.handle("down");
  fire();
  hold.reset();
  hold.handle("up");
  assert.deepEqual(calls, ["start", "cancel"]);
});
