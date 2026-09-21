import { useState } from 'react'
import type { ChatMessage } from '../shared/protocol.ts'

interface Props {
  chat: ChatMessage[]
  busy: boolean
  online: boolean
  agentAvailable: boolean
  hasSelection: boolean
  tweakCount: number
  onSubmit: (comment: string) => void
}

export function ChatPanel({ chat, busy, online, agentAvailable, hasSelection, tweakCount, onSubmit }: Props) {
  const [text, setText] = useState('')

  const blocked = !online || busy || (!hasSelection && tweakCount === 0)
  const submit = () => {
    const comment = text.trim()
    if (!comment || blocked) return
    onSubmit(comment)
    setText('')
  }

  return (
    <div className="chat">
      <div className="chat__log">
        {chat.length === 0 && (
          <div className="chat__hint">
            Выдели слой, при желании подвигай его — потом опиши правку. В агента уйдёт комментарий вместе с
            замерами, якорями и цепочкой родителей.
          </div>
        )}
        {chat.map((m) => (
          <div key={m.id} className={`msg msg--${m.role}${m.pending ? ' msg--pending' : ''}`}>
            {m.text}
          </div>
        ))}
      </div>

      {!agentAvailable && (
        <div className="chat__warn">
          Агент не настроен: правки копятся в очереди и доступны через MCP-инструмент <code>pending_requests</code>.
        </div>
      )}

      <div className="chat__input">
        <textarea
          value={text}
          placeholder={hasSelection ? 'Что поправить в этом элементе?' : 'Сначала выдели элемент'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
          }}
        />
        <button disabled={blocked || !text.trim()} onClick={submit}>
          {busy ? 'Работает…' : 'Отправить'}
          {tweakCount > 0 && <span className="badge">+{tweakCount}</span>}
        </button>
      </div>
    </div>
  )
}
