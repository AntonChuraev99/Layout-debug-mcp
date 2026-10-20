---
title: "Android: element text from semantics, and the Compose compatibility matrix"
date: 2026-10-20
type: decision
keywords: [android, semantics, text, contentDescription, isPlaced, prefetch, compatibility, emulator, ci]
---

# Android: element text from semantics, and the Compose compatibility matrix

Follows [android-agent-packaging-2026-10-20.md](android-agent-packaging-2026-10-20.md) (#17, #22).

## Context

Android nodes were labelled only by composable name (`Text`, `Text`, `Text`). The tree relies on `@UiToolingDataApi` and on reflection into `LayoutNode`, verified on one Compose line, and a failed reflective lookup was a silent no-op.

## Decision

- **Text comes from the semantics tree, matched by object identity.** For each Compose root the agent walks `RootForTest.semanticsOwner.unmergedRootSemanticsNode` and keys `SemanticsProperties.Text` / `EditableText` / `ContentDescription` by `SemanticsNode.layoutInfo`, the same `LayoutNode` object ui-tooling emits as `NodeGroup.node`. A node takes only the text of its own layout node, so a `Button` stays `Button` and its `Text` child carries "Save"; text is attached before same-box chains collapse, and the surviving node inherits it (`Card { Text("Save") }`). `Group.parameters` was rejected: it depends on parameter names and lambda field layout, and misses text set through semantics (content descriptions, text fields).
- **Unplaced nodes are dropped.** A lazy list composes items ahead of a scroll and keeps some for reuse without placing them; ui-tooling reports those at (0, 0) with their own size, so they covered the top bar and won clicks there. Nodes with `LayoutInfo.isPlaced == false` are removed with their subtree, and call groups left empty go too.
- **Compatibility is a tested matrix, not a claim.** The sample builds against a Compose BOM given by `-PcomposeBom` (with `-PactivityCompose` for the 1.7 floor, where activity-compose 1.13 would pull Compose 1.9 in). An instrumentation test asserts the Compose UI version the app actually runs (`/health` `compose`, read from `META-INF/androidx.compose.ui_ui.version`), the tree, the dropped prefetched items and a live edit. CI runs it on an API 36 emulator (reactivecircus/android-emulator-runner) for every line from 1.7 to 1.12; 1.8 pins activity-compose 1.10.1 for the same reason.
- **Failures name the version, and only missing APIs blame it.** Linkage and reflection failures (a missing or inaccessible Compose member) say the version is not supported; any other exception is reported as an agent error to report. A live edit that cannot be re-applied is dropped and returned in `/tree` `overrideErrors`; a text read failure goes out as a `warnings` entry. The window shows both.

## Consequences

- The agent sees "Row 1" on the `Text`, not on the `RowCard`.
- Each new Compose line needs a matrix row (about 5–10 CI minutes each, approx.); rows not in CI are "not verified".
