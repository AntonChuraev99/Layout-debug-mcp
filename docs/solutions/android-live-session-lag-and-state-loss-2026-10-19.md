# Android live session: lag, lost chat state, misleading "app is silent"

## Symptoms

- The chat jumped to the bottom and lost focus and unsent text on every device frame; the palette field lost its caret (issue #6).
- Device frames were slow over wireless adb, and each open window started its own capture.
- On wireless adb the window said "Waiting for the app — run a debug build with the agent" while the app was running.
- The old page was sometimes not held during the post-reply reload (e2e `11d`).

## Causes

1. **Node ids change on every capture.** `selected` was read as `snapshot.nodes[selectedId]` while the id was re-resolved one render later, so for one render nothing was selected and the chat remounted. The palette body was keyed by `node.id`.
2. **Tree and picture were two sequential round trips**, captures were not shared between windows, and the server timeouts outlived the window's watchdog, so requests piled up.
3. **A dead adb link looks like a silent agent:** `adb devices` still lists the device, every request through the forward times out, and any timeout was classified as `device_no_bridge`.
4. **The reload hold was released on the first new snapshot**, about one paint after `load`.

## Fix

1. Selection keeps its anchors and is resolved in the same render (`src/ui/selection.ts`); components that hold user state are keyed by `elementKey`, not by id. The card is hidden, not unmounted, during a drag.
2. One capture fetches tree and screenshot in parallel under one time budget below the window watchdog, the PNG is cached per frame, concurrent requests share one capture (`src/server/androidCapture.ts`). A capture that overlaps a live edit does not cache its picture.
3. A capture that fails like a silent agent triggers one cached `adb shell echo ok` probe; a timeout becomes `device_unresponsive` with reconnect steps.
4. The hold is released two animation frames after the first new snapshot.

## Tests

`src/ui/selection.test.ts`, `src/server/androidCapture.test.ts`, `src/server/androidApp.test.ts`; e2e `tests/e2e/float.spec.ts`, `tests/e2e/android-window.spec.ts` on a fake device (`tests/e2e/fakeDevice.ts`), `mcp-loop` `11d`.

## Note

Most of the remaining frame time is the on-device PNG encode. The on-device agent is in `android/layout-debug-agent`.
