/**
 * Manages per-channel conversation state.
 * Keeps track of what the bot is waiting for from each user.
 */

export interface ConversationState {
  userId: string
  channelId: string
  pendingAction: string | null   // e.g. 'find_leads'
  gathered: Record<string, any>  // data collected so far
  history: { role: 'user' | 'assistant', content: string }[]
  lastUpdated: number
}

const conversations = new Map<string, ConversationState>()
const TTL = 5 * 60 * 1000 // 5 minutes of inactivity clears state

export function getConversation(userId: string, channelId: string): ConversationState {
  const key = `${channelId}:${userId}`
  let state = conversations.get(key)

  if (!state || Date.now() - state.lastUpdated > TTL) {
    state = {
      userId,
      channelId,
      pendingAction: null,
      gathered: {},
      history: [],
      lastUpdated: Date.now()
    }
    conversations.set(key, state)
  }

  return state
}

export function updateConversation(userId: string, channelId: string, updates: Partial<ConversationState>) {
  const key = `${channelId}:${userId}`
  const state = getConversation(userId, channelId)
  conversations.set(key, { ...state, ...updates, lastUpdated: Date.now() })
}

export function clearConversation(userId: string, channelId: string) {
  conversations.delete(`${channelId}:${userId}`)
}
