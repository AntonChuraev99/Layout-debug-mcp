import { CopyBlock } from './Blank.tsx'
import { useT } from './i18n.ts'

/**
 * The MCP server entry a client needs, in the `mcpServers.<name>` shape most clients share.
 * Client-neutral on purpose: no `type`, no client-specific keys. Pretty-printed, so the
 * popover never breaks the package name in half; it pastes as the same JSON.
 */
export const MCP_CONFIG_SNIPPET = '{\n  "command": "npx",\n  "args": ["-y", "layout-debug-mcp"]\n}'

/** Body of the header agent popover: who answers the chat, and how to connect one. */
export function AgentPopoverBody({ listening }: { listening: boolean }) {
  const { t } = useT()
  if (listening) {
    return (
      <div className="pop__body">
        <h2 className="pop__title">{t('agent.listening')}</h2>
        <p className="pop__text">{t('agent.listeningText')}</p>
      </div>
    )
  }
  return (
    <div className="pop__body agent-pop">
      <h2 className="pop__title">{t('agent.noneTitle')}</h2>
      <p className="pop__text">{t('agent.noneText')}</p>
      <ol className="agent-steps">
        <li>
          <span className="agent-steps__label">{t('agent.step1')}</span>
          <CopyBlock text={MCP_CONFIG_SNIPPET} />
        </li>
        <li>
          <span className="agent-steps__label">{t('agent.step2')}</span>
          <CopyBlock text={t('agent.phrase')} prose />
        </li>
      </ol>
      <p className="pop__note">{t('agent.clients')}</p>
    </div>
  )
}
