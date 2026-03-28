import { GoogleGenerativeAI } from '@google/generative-ai'
import Groq from 'groq-sdk'
import type { ConversationState } from './conversation'

let _gemini: GoogleGenerativeAI | null = null
let _groq: Groq | null = null
const getGemini = () => _gemini ??= new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)
const getGroq = () => _groq ??= new Groq({ apiKey: process.env.GROQ_API_KEY })

export interface BrainResponse {
  type: 'action' | 'question' | 'answer' | 'confused'
  message: string          // What the bot says out loud
  action?: string          // 'find_leads' | 'show_leads' | 'show_status'
  params?: Record<string, any>  // Extracted params for the action
}

const SYSTEM_PROMPT = `You are Ardeno OS — the AI brain of Ardeno Studio, a premium web design agency in Sri Lanka.
You help the team find leads, manage outreach, and run the agency autonomously.

Your personality: confident, sharp, concise. You talk like a smart team member, not a robot.
Never say "I'm an AI". Never be robotic. Be direct and useful.

You can perform these ACTIONS when you have enough info:
- find_leads: Find businesses that need websites (needs: niche, location, optionally: quality)
- show_leads: Show recent leads from the database
- show_status: Show engine status and stats
- rescan_leads: Re-scan leads that are missing phone/website and fill them in using AI

CRITICAL RULES:
1. NEVER say "I'll find leads" or "I'll send you leads" without returning type "action". If you say you'll do it, DO it.
2. Use conversation history to fill in missing context. If niche was mentioned earlier, use it. If location was mentioned earlier, use it.
3. "ao high-end" after talking about restaurants in Colombo = find high-end restaurants in Colombo. Connect the dots.
4. Only ask a follow-up question if you genuinely cannot determine both niche AND location from the full conversation.
5. Default location is Colombo, Sri Lanka if not specified.
6. Keep replies SHORT. One sentence max unless listing data.

ALWAYS respond with valid JSON:
{
  "type": "action" | "question" | "answer",
  "message": "what you say out loud",
  "action": "find_leads" (only when type is action),
  "params": { "niche": "...", "location": "...", "quality": "high|mid|budget", "limit": 10 }
}`

export async function think(
  userMessage: string,
  state: ConversationState
): Promise<BrainResponse> {
  // Build conversation history for context
  const history = state.history.slice(-12) // last 12 messages for context
  const historyText = history.map(h => `${h.role === 'user' ? 'User' : 'Ardeno OS'}: ${h.content}`).join('\n')

  const prompt = historyText
    ? `Previous conversation:\n${historyText}\n\nUser just said: "${userMessage}"\n\nRespond as Ardeno OS:`
    : `User just said: "${userMessage}"\n\nRespond as Ardeno OS:`

  let raw: string
  try {
    raw = await callGemini(prompt)
  } catch {
    try {
      raw = await callGroq(prompt)
    } catch (e: any) {
      return {
        type: 'confused',
        message: `My brain's having a moment. Try again? (Error: ${e.message})`
      }
    }
  }

  return parseResponse(raw)
}

async function callGemini(prompt: string): Promise<string> {
  const model = getGemini().getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: SYSTEM_PROMPT
  })
  const result = await model.generateContent(prompt)
  return result.response.text()
}

async function callGroq(prompt: string): Promise<string> {
  const completion = await getGroq().chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ],
    temperature: 0.4
  })
  return completion.choices[0].message.content ?? '{}'
}

function parseResponse(raw: string): BrainResponse {
  try {
    const cleaned = raw.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim()

    // Sometimes the LLM wraps in extra text — find the JSON block
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON found')

    const parsed = JSON.parse(jsonMatch[0])
    return {
      type: parsed.type ?? 'answer',
      message: parsed.message ?? 'Got it.',
      action: parsed.action,
      params: parsed.params
    }
  } catch {
    // Fallback — treat raw text as a plain answer
    return {
      type: 'answer',
      message: raw.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim().slice(0, 500)
    }
  }
}
