export type MessageRenderMode = 'plain' | 'markdown' | 'raw'

const MARKDOWN_PREFIX = '<markdown/>'
const RAW_PREFIX = '<raw/>'

export function encodeMessageBody(text: string, mode: MessageRenderMode): string {
  if (mode === 'markdown') return `${MARKDOWN_PREFIX}${text}`
  if (mode === 'raw') return `${RAW_PREFIX}${text}`
  return text
}

export function decodeMessageBody(body: string): { mode: MessageRenderMode; text: string } {
  if (body.startsWith(MARKDOWN_PREFIX)) {
    return { mode: 'markdown', text: body.slice(MARKDOWN_PREFIX.length) }
  }
  if (body.startsWith(RAW_PREFIX)) {
    return { mode: 'raw', text: body.slice(RAW_PREFIX.length) }
  }
  return { mode: 'plain', text: body }
}
