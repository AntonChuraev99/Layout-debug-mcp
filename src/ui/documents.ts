/**
 * Which document of the frame a snapshot belongs to. Node ids start over in every
 * document, and the inspector of a new document may report before the frame fires `load`
 * (or after it): the two events come in either order, once per document.
 *
 * - `current`: the document whose snapshots the window takes now;
 * - `dead`: the one a `load` replaced before the new one reported — its late snapshots are dropped;
 * - `awaitingLoad`: `current` reported before its own `load`, which is still to come.
 *
 * Pure, so both orders are unit-tested.
 */
export interface FrameDocs {
  current: string | null
  dead: string | null
  awaitingLoad: boolean
  /** A `load` came after `current` reported: the next document's `load` is behind us when it reports. */
  loadedSinceDoc: boolean
}

export const NO_DOCS: FrameDocs = { current: null, dead: null, awaitingLoad: false, loadedSinceDoc: false }

/**
 * A snapshot with `docId` came in.
 * - `stale`: from the document a `load` already replaced — drop it;
 * - `new`: a new document — edits addressed by the old node ids are void;
 * - `same`: the current document (or an inspector that does not say).
 */
export function snapshotDoc(s: FrameDocs, docId: string | undefined): { docs: FrameDocs; verdict: 'stale' | 'new' | 'same' } {
  if (docId && docId === s.dead) return { docs: s, verdict: 'stale' }
  if (!docId || docId === s.current) return { docs: s, verdict: 'same' }
  return {
    docs: { current: docId, dead: s.dead, awaitingLoad: !s.loadedSinceDoc, loadedSinceDoc: false },
    verdict: s.current === null ? 'same' : 'new',
  }
}

/**
 * The frame fired `load`. `reset`: a document is coming that has not reported yet — the
 * window drops the old page's snapshot and edits now. No reset when the new document
 * already reported (its snapshot is in and its edits may already be back).
 */
export function frameLoaded(s: FrameDocs): { docs: FrameDocs; reset: boolean } {
  if (s.awaitingLoad) return { docs: { ...s, awaitingLoad: false }, reset: false }
  return { docs: { ...s, dead: s.current, loadedSinceDoc: true }, reset: true }
}
