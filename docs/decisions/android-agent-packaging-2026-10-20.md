---
title: "Android agent as a debug-only library pair"
date: 2026-10-20
type: decision
keywords: [android, maven-central, debugImplementation, noop, androidx-startup, LocalInspectionTables, loopback]
---

# Android agent as a debug-only library pair

## Context

The on-device agent lived in a spike app (#8). It needed a composable wrapper in the app's main source set to provide `LocalInspectionTables`, so release code referenced tool code. Outside users could not use Android mode at all.

## Decision

- **Two artifacts** in `android/`: `layout-debug-agent` (`debugImplementation`) and `layout-debug-noop` (`releaseImplementation`), same `LayoutDebug` object (`install`, `isRunning`); the noop has empty bodies and no dependencies. Group `io.github.antonchuraev99`, published with `com.vanniktech.maven.publish` to the Central Portal.
- **No app code.** The agent starts from an androidx.startup `Initializer` and sets Compose's `isDebugInspectorInfoEnabled` before the first composition. Compose then keeps every composition's slot tables under the `inspection_slot_table_set` view tag and provides them as `LocalInspectionTables`, so subcompositions are captured (source: `Wrapper.android.kt` in androidx, same in 2024 and 2026 sources). This is the mechanism Android Studio's Layout Inspector uses.
- **Subcompositions are nested** under their host: a table's first layout node's `LayoutInfo.parentInfo` is looked up among all tables' nodes.
- **Names come from app code.** A same-box chain keeps the outermost call whose `SourceLocation.packageHash` is not a Compose package (the compiler's package hash, the signal Layout Inspector uses), so a lazy item shows as `RowCard`, not `SaveableStateProvider`.
- **Loopback IPv4 only** (`127.0.0.1`), requests with `Origin`, cross-site `Sec-Fetch-Site` or a non-loopback `Host` get `403`, no CORS. The agent refuses to start in a non-debuggable app.
- **Compose floor, not the app's version.** The agent compiles against Compose BOM 2024.09.00 (1.7) and Kotlin language 2.2, so it never upgrades a consumer's Compose or stdlib in debug only.

## Why

One line per build type, nothing in release (checked in CI with the R8 mapping and `apkanalyzer`), and no source changes in the app. A wrapper composable would still need the noop to provide it and would miss content composed outside it.

## Consequences

- Install must happen before the first activity composes; a late `install` gets a visible "no slot tables" error from `/tree`.
- `isDebugInspectorInfoEnabled` also turns on modifier inspector info in debug builds (small overhead).
- The package-hash list is ours to keep current; a missing Compose package only degrades which name a collapsed chain shows.
- Content of dialogs and popups is captured in its own window's coordinates.
