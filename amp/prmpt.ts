/**
 * prmpt on Amp.
 *
 * Amp has no shell-hook config file — plugins are TypeScript modules that
 * subscribe to lifecycle events, so this is the one host that cannot reuse
 * hooks/turn-end.mjs directly. The logic is deliberately identical: read the
 * turn's final assistant text, ask the backend once with a hard timeout, and
 * stay completely silent unless a decision comes back.
 *
 * Install: copy to `.amp/plugins/prmpt.ts` in your project, or
 * `~/.config/amp/plugins/prmpt.ts` to run it everywhere.
 *
 * Two details worth knowing, both easy to get wrong:
 *   - `event.message` is the USER'S prompt that started the turn, not the
 *     reply. The assistant text lives in `event.messages`.
 *   - Returning `{ action: 'continue' }` would start another turn. We never do.
 */
import type { PluginAPI } from '@ampcode/plugin'

const ENDPOINT = process.env.PRMPT_ENDPOINT ?? 'https://api.prmpt.cash/graphql'
const TOKEN = process.env.PRMPT_TOKEN ?? process.env.PRMPT_API_KEY ?? ''
const TIMEOUT_MS = 1500
const MIN_TURN_CHARS = 80
const MAX_TURN_CHARS = 4000

const SERVE_AD = `mutation($input: TurnContextInput!) {
  serveAd(input: $input) { requestId headline body clickUrl }
}`

/** Concatenate the text blocks of the last assistant message in the turn. */
function finalAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown }
    if (m?.role !== 'assistant') continue
    const content = m.content
    if (typeof content === 'string') return content.trim()
    if (!Array.isArray(content)) continue
    const text = content
      .filter(
        (b): b is { type: string; text: string } =>
          typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text',
      )
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (text) return text
  }
  return ''
}

export default function (amp: PluginAPI) {
  amp.on('agent.end', async (event, ctx) => {
    // Fail-open and silent is the whole contract: never interrupt a session.
    try {
      if (!TOKEN || process.env.PRMPT_DISABLED === '1') return
      if (event.status !== 'done') return

      let turnText = finalAssistantText((event as { messages?: unknown }).messages)
      if (turnText.length < MIN_TURN_CHARS) return
      if (turnText.length > MAX_TURN_CHARS) turnText = turnText.slice(-MAX_TURN_CHARS)

      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          query: SERVE_AD,
          variables: {
            input: {
              installId: process.env.PRMPT_INSTALL_ID ?? 'amp',
              sessionId: String((event as { thread?: { id?: string } }).thread?.id ?? 'amp'),
              turnText,
              harness: 'amp',
            },
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) return

      const body = (await res.json()) as {
        data?: { serveAd?: { headline?: string; body?: string; clickUrl?: string } | null }
      }
      const ad = body?.data?.serveAd
      if (!ad?.headline || !ad.clickUrl) return

      await ctx.ui.notify(
        [`Sponsored · ${ad.headline}`, ad.body, ad.clickUrl].filter(Boolean).join('\n'),
      )
    } catch {
      // Timeout, network failure, malformed response: say nothing.
    }
  })
}
