# Live edits survive a reload: an anchor-keyed list, restored by the window

Date: 2026-10-20. Issue #20.

## Context

Live edits were inline styles (web) or device overrides (Android) addressed by node id. Node ids die with the page, so any reload the window did not start itself (dev server full reload, the page reloading, the window reloading) dropped every edit. Only the window's own refresh after "done" carried them over, from memory.

## Decision

- One list of `LiveEdit` (`src/shared/protocol.ts`): the element's anchors, kind and label, the override in frame pixels, the page it belongs to, and `resolved`.
- The **window** owns it and keeps it in step with the page (`syncEdits` in `src/shared/liveEdits.ts`). The **server** keeps a copy in the session (`liveEdits` WebSocket frame, sent on every connect, `GET`/`DELETE /api/live-edits`), so it also outlives a window reload.
- On every page that comes in (a new inspector `docId`, even before the iframe `load`; on Android the first snapshot of a window session or a new app pid) the window finds each edit's element (`resolveEdit`: a unique test id, a unique DOM id, then the `occurrence`-th node with the path + source location) and re-applies it (`restorePlan`). Not found → `resolved: false`, listed in the header's Live edits panel until discarded.
- The list follows the page only after it was restored on that document and address. Before that, an empty page means "not restored yet".
- At "done", the request's own edit leaves the list at once (`dropHandedOver`, matched by page and occurrence).

## Why

- The window has the fresh snapshot; the server's copy is throttled (the mirror timer in `src/ui/App.tsx`), so resolving there would race the page.
- Anchors already identify an element across reloads for selection and threads; a second key would drift from them.
- Node ids restart per document and a document can report before `load`, so only a per-document id says when ids changed meaning.

## Consequences

- A server restart loses the list unless a window that still holds it reconnects (it sends it back).
- The list is keyed by the address opened in the window: a client-side route change inside the frame shows the old route's edits as not found.
- Android restore is not verified on a device; an app restart without a reported pid is not detected.
