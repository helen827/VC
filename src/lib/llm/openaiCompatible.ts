import { z } from 'zod'

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export type LlmClient = {
  baseUrl: string
  apiKey: string
  model: string
}

const ChatCompletionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().optional() }).optional()
      })
    )
    .optional()
})

export async function chatCompletion(
  client: LlmClient,
  messages: ChatMessage[],
  opts?: { temperature?: number; max_tokens?: number }
): Promise<string> {
  const url = `${client.baseUrl.replace(/\/+$/, '')}/chat/completions`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${client.apiKey}`
    },
    body: JSON.stringify({
      model: client.model,
      messages,
      temperature: opts?.temperature ?? 0.4,
      max_tokens: opts?.max_tokens ?? 2500
    })
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (res.status === 401) {
      const hint =
        client.baseUrl.includes('qnaigc.com') || client.baseUrl.includes('qiniu')
          ? ' 请确认 .env 中 LLM_API_KEY 填的是七牛「AI 大模型推理」的 API Key（Bearer），不要填 AK/SK。'
          : ' 请检查 .env 中 LLM_API_KEY 是否正确。'
      throw new Error(`LLM API 401: 鉴权失败。${hint} ${text ? `(${text.slice(0, 120)})` : ''}`)
    }
    throw new Error(`LLM API ${res.status}: ${text || res.statusText}`)
  }
  const raw = await res.json()
  const parsed = ChatCompletionResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error('LLM response schema mismatch')
  }
  const content = parsed.data.choices?.[0]?.message?.content?.trim() ?? ''
  return content
}

