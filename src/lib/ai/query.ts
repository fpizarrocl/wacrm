import { contentText, type ChatMessage } from './types'

/**
 * The text to retrieve knowledge against: the most recent customer
 * (`user`) turn in the conversation context. Falls back to the last
 * message of any role, then empty string. Shared by the draft route and
 * the auto-reply bot so both query the knowledge base the same way.
 *
 * An image-only turn (no caption) yields '' here — retrieval just has
 * nothing to match against for that turn, same as an empty text message.
 */
export function latestUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return contentText(messages[i].content)
  }
  return messages.length > 0 ? contentText(messages[messages.length - 1].content) : ''
}
