import { Fragment, useEffect, useState } from 'react'
import type { LayoutNode, NodeId, Override, Snapshot } from '../shared/protocol.ts'
import { useT, type Translate } from './i18n.ts'
import { fmt, fmtSigned } from './thread.ts'

export function ancestorsOf(snapshot: Snapshot, id: NodeId): LayoutNode[] {
  const chain: LayoutNode[] = []
  let cur = snapshot.nodes[id]
  while (cur?.parentId) {
    const parent = snapshot.nodes[cur.parentId]
    if (!parent) break
    chain.unshift(parent)
    cur = parent
  }
  return chain
}

const CHILDREN_FIRST = 8

/** Size is already in the box row; repeating it is noise. */
const SKIP_STYLES = new Set(['width', 'height', 'x', 'y'])

/** A live tweak in words, for the window only — the agent gets the numbers, not this text. */
export function describeOverride(ov: Override, pxPerUnit: number, unit: string, t: Translate): string {
  const q = (px: number) => px / (pxPerUnit || 1)
  const parts: string[] = []
  if (ov.dx || ov.dy) parts.push(t('override.offset', { dx: fmtSigned(q(ov.dx)), dy: fmtSigned(q(ov.dy)) }))
  if (ov.width != null || ov.height != null) {
    parts.push(t('override.size', { w: ov.width != null ? fmt(q(ov.width)) : '—', h: ov.height != null ? fmt(q(ov.height)) : '—' }))
  }
  if (ov.hidden) parts.push(t('override.hidden'))
  return parts.length ? `${parts.join(', ')} ${unit}` : ''
}

interface Props {
  snapshot: Snapshot
  node: LayoutNode
  override: Override | undefined
  onSelect: (id: NodeId) => void
}

/** Facts about one node: what used to be the side panel, now folded into the palette. */
export function NodeDetails({ snapshot, node, override: ov, onSelect }: Props) {
  const { t } = useT()
  const [allChildren, setAllChildren] = useState(false)
  useEffect(() => setAllChildren(false), [node.id])

  const children = node.childIds.map((id) => snapshot.nodes[id]).filter((n): n is LayoutNode => Boolean(n))
  /** Bounds are frame pixels; source code wants dp (Android) or css-px (web). */
  const q = (px: number) => fmt(px / (snapshot.pxPerUnit || 1))
  const styles = Object.entries(node.styles).filter(([k]) => !SKIP_STYLES.has(k))
  const shown = allChildren ? children : children.slice(0, CHILDREN_FIRST)
  const tweak = ov ? describeOverride(ov, snapshot.pxPerUnit, snapshot.unit, t) : ''

  return (
    <div className="details">
      <dl className="facts">
        <dt>{t('details.box')}</dt>
        <dd>
          {q(node.bounds.w)} × {q(node.bounds.h)} {snapshot.unit}
          <span className="facts__sub">
            x {q(node.bounds.x)}, y {q(node.bounds.y)}
          </span>
        </dd>
        {tweak && (
          <>
            <dt>{t('details.edit')}</dt>
            <dd className="facts__ink">{tweak}</dd>
          </>
        )}
        {node.anchors.sourceLoc && (
          <>
            <dt>{t('details.source')}</dt>
            <dd className="mono">{node.anchors.sourceLoc}</dd>
          </>
        )}
        {node.anchors.testId && (
          <>
            <dt>testId</dt>
            <dd className="mono">{node.anchors.testId}</dd>
          </>
        )}
        {node.anchors.className && (
          <>
            <dt className="facts__wide">{t('details.classes')}</dt>
            <dd className="facts__wide mono">{node.anchors.className}</dd>
          </>
        )}
        <dt className="facts__wide">{t('details.path')}</dt>
        <dd className="facts__wide mono">{node.anchors.path}</dd>
        {styles.map(([key, value]) => (
          <Fragment key={key}>
            <dt title={key}>{key}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>

      {children.length > 0 && (
        <div className="kids">
          <div className="kids__title">{t('details.inside', { count: children.length })}</div>
          {shown.map((c) => (
            <button key={c.id} type="button" className="kid" onClick={() => onSelect(c.id)} title={c.anchors.path}>
              <span className="kid__kind">{c.kind}</span>
              <span className="kid__label">{c.label}</span>
            </button>
          ))}
          {!allChildren && children.length > CHILDREN_FIRST && (
            <button type="button" className="kid kid--more" onClick={() => setAllChildren(true)}>
              {t('common.more', { count: children.length - CHILDREN_FIRST })}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
