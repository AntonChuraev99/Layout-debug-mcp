import { Fragment } from 'react'
import type { LayoutNode, NodeId, Override, Snapshot } from '../shared/protocol.ts'

interface Props {
  snapshot: Snapshot
  selectedId: NodeId | null
  overrides: Record<NodeId, Override>
  onSelect: (id: NodeId) => void
  onClearOverride: (id: NodeId) => void
}

function ancestorsOf(snapshot: Snapshot, id: NodeId): LayoutNode[] {
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

export function NodePanel({ snapshot, selectedId, overrides, onSelect, onClearOverride }: Props) {
  const node = selectedId ? snapshot.nodes[selectedId] : undefined

  if (!node) {
    return (
      <div className="panel panel--empty">
        Наведись на элемент и кликни, чтобы выделить слой. Клик по родителю в хлебных крошках поднимает на уровень выше.
      </div>
    )
  }

  const chain = ancestorsOf(snapshot, node.id)
  const children = node.childIds.map((id) => snapshot.nodes[id]).filter((n): n is LayoutNode => Boolean(n))
  const ov = overrides[node.id]
  /** Bounds are frame pixels; source code wants dp (Android) or css-px (web). */
  const inUnit = (px: number) => Math.round((px / snapshot.pxPerUnit) * 10) / 10

  return (
    <div className="panel">
      <nav className="crumbs">
        {chain.map((a) => (
          <button key={a.id} className="crumb" onClick={() => onSelect(a.id)} title={a.anchors.path}>
            {a.kind}
          </button>
        ))}
        <span className="crumb crumb--current">{node.kind}</span>
      </nav>

      <h2 className="panel__title">{node.label}</h2>

      <dl className="facts">
        <dt>Бокс</dt>
        <dd>
          {inUnit(node.bounds.w)}×{inUnit(node.bounds.h)} {snapshot.unit} @ {inUnit(node.bounds.x)},
          {inUnit(node.bounds.y)}
        </dd>
        {node.anchors.sourceLoc && (
          <>
            <dt>Исходник</dt>
            <dd className="mono">{node.anchors.sourceLoc}</dd>
          </>
        )}
        {node.anchors.className && (
          <>
            <dt>Классы</dt>
            <dd className="mono wrap">{node.anchors.className}</dd>
          </>
        )}
        {node.anchors.testId && (
          <>
            <dt>testId</dt>
            <dd className="mono">{node.anchors.testId}</dd>
          </>
        )}
        <dt>Путь</dt>
        <dd className="mono wrap">{node.anchors.path}</dd>
        {Object.entries(node.styles)
          // Size is already shown as the box; repeating it is noise.
          .filter(([key]) => !['width', 'height', 'x', 'y'].includes(key))
          .map(([key, value]) => (
            <Fragment key={key}>
              <dt>{key}</dt>
              <dd className="wrap">{value}</dd>
            </Fragment>
          ))}
      </dl>

      {ov && (
        <div className="tweak">
          <span>
            Сдвиг {inUnit(ov.dx)}, {inUnit(ov.dy)} {snapshot.unit}
            {ov.width != null ? ` · размер ${inUnit(ov.width)}×${inUnit(ov.height ?? 0)}` : ''}
          </span>
          <button onClick={() => onClearOverride(node.id)}>Сбросить</button>
        </div>
      )}

      {children.length > 0 && (
        <div className="children">
          <div className="children__title">Внутри ({children.length})</div>
          <div className="children__list">
            {children.slice(0, 40).map((c) => (
              <button key={c.id} className="child" onClick={() => onSelect(c.id)}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
