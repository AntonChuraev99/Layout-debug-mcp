# Moved element: child boxes, the ghost copy, pointer position on Alt

Date: 2026-10-07.

## 1. After a move, selection used the old place

**Symptom.** After an element is moved, its children's boxes are drawn at the old place, and a click on the new place selects the parent.

**Cause.** The inspector measures the snapshot with moves removed, while the parent's `translate` carries the whole subtree. The overlay (`src/ui/Overlay.tsx`) added only the node's own override.

**Fix.** `inheritedShifts()` in `src/ui/pick.ts` sums ancestor moves; hit test, boxes, labels and the off-screen check in `src/ui/App.tsx` use it. Tests: e2e `4c` in `tests/e2e/live-edit.spec.ts`, unit `src/ui/pick.test.ts`.

**Open for Android.** Correct only if the on-device agent reports boxes without moves (not verified on a device); otherwise children move twice after a recapture.

## 2. Ghost copy at the old place

- **Web** (`src/inspector/index.ts`, `src/inspector/ghost.ts`): a copy in a layer outside `<body>`, so snapshot, hit test and DOM watching do not see it; `class`, `id`, `data-*` and ARIA are stripped; clipped by scrolling ancestors. e2e `4d`, `4e`.
- **Android** (`frameCropRect` in `src/ui/geometry.ts`): a crop of the frame at the original bounds; waits for `img.decode()` if the frame is still decoding. Not verified on a device.

## 3. Pointer position when Alt is pressed

**Symptom.** e2e `3d2` was flaky: on Alt with a still mouse, the highlight sometimes did not appear.

**Cause.** On Alt the overlay takes the mouse over the iframe; Chromium re-checks the element under the pointer, and the page gets `pointerleave` inside its viewport. The inspector reset the position and lost the race with the window's request.

**Fix.** The inspector resets the position only when the pointer leaves through the viewport edge. The window tracks whether the pointer is over its own cards (`pointerOnChrome` in `src/ui/Overlay.tsx`) and ignores the inspector's answer then. e2e `2e`, `2f`.
