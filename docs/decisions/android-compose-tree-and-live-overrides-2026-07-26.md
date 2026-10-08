---
title: "Android: Compose tree from ui-tooling, live overrides by modifier swap"
date: 2026-07-26
type: decision
keywords: [compose, ui-tooling, asTree, LayoutNode, modifier, reflection, adb-forward, live-edit]
---

# Android: Compose tree from ui-tooling, live overrides by modifier swap

The on-device agent is not in this repo yet (#8), so its names are not searchable here.

## Context

The tool must select any layer of a Compose screen and move it on the device without a rebuild. `uiautomator dump` gives only the flat accessibility tree: containers and wrappers are missing. Compose Hot Reload targets desktop JVM; Android Studio Live Edit has no public API. A rebuild takes 30–90 s (approx.).

## Decision

- **Tree.** A debug-only agent wraps the content root in `Inspectable` and reads `CompositionData.asTree()`: boxes in px and compiler `file:line` (source: androidx.compose.ui:ui-tooling; needs `sourceInformation`, on in debug builds).
- **Transport.** An HTTP endpoint in the debug build plus `adb forward`. One call returns the tree and a `PixelCopy` frame, so they are atomic (source: on-device agent).
- **Live overrides.** Reflection swaps `LayoutNode.modifier` for `Modifier.offset(...).then(original)`; reset restores the original. No `Modifier.tweakable` hook in app code, no compiler plugin (source: spike notes, 2026-07-26).
- **Release safety.** The agent is `debugImplementation` only (source: Gradle dependency scope).

## Spike findings (Compose Multiplatform 1.11, Kotlin 2.3.20, emulator API 36)

- Root `compositionData` alone misses `SubcomposeLayout` content (Scaffold, lazy lists); `LocalInspectionTables` with a shared `MutableSet<CompositionData>` collects every slot table (source: Compose runtime).
- `ComposeUiNode` is internal; `getModifier` / `setModifier` are found by reflection by name prefix, because Kotlin mangles internal names (source: Compose UI 1.11).
- The raw tree is unreadable. Collapsing chains with an identical box onto the outer node (its call site is in project code) and inheriting the nearest `LayoutNode` upwards makes it usable.
- A move applies to the selected node, not its content: moving an inner `Row` leaves background and clip in place. Breadcrumbs let the user pick the outer node.

## Consequences

- `@UiToolingDataApi` is not stable; the supported range must be tested (#22) (source: ui-tooling API annotation).
- Shared code changed for Android: hit test picks the tightest box, depth only breaks ties; `styles` is a flat string map; boxes and overrides are in frame pixels with `pxPerUnit`; the first snapshot of a session resets device overrides.
