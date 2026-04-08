import { z } from 'zod'
import type { EntityProfile, GeneratedFile, Source } from '../types.js'
import type { LlmClient } from '../llm/openaiCompatible.js'
import { chatCompletion } from '../llm/openaiCompatible.js'
import { safeJsonParse } from '../llm/json.js'

const GeneratedFilesSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      content: z.string()
    })
  )
})

function buildCitationHelp(sources: Source[]): string {
  const lines: string[] = []
  for (const s of sources) {
    const label = `[${s.id}] ${s.type}${s.emphasized ? ' (重点)' : ''}${s.sourceUrl ? ` ${s.sourceUrl}` : ''}${
      s.filename ? ` ${s.filename}` : ''
    }`
    lines.push(label)
  }
  return lines.join('\n')
}

export async function generateGeoAssets(input: {
  llm: LlmClient
  profile: EntityProfile
  sources: Source[]
}): Promise<GeneratedFile[]> {
  const system = `你是一个“面向中国平台的 GEO 内容生成器”。目标：让豆包/千问/DeepSeek 等在回答相关问题时，更容易正确提到目标公司。

写作原则：
- 中文为主；公司名在关键位置自然出现（标题/首段/小标题/FAQ 问题）。
- 多做“可引用、可检索”的结构：定义句、要点列表、FAQ、对比要点。
- 不要夸大或编造；如果缺资料，用更保守表述（如“根据公开资料…”）。
- 用脚注形式标注引用来源：[^S1]，脚注区列出 source id 与 URL/文件名（不要硬贴长链接到正文）。

输出要求（硬性）：
- 只输出严格 JSON：{ "files": [{ "path": "...", "content": "..." }] }。
- 每个 content 是 Markdown。
- path 使用以下前缀之一：
  - content/website/
  - content/wechat/
  - content/zhihu/`

  const user = `这是实体画像（JSON）：
${JSON.stringify(input.profile, null, 2)}

可引用 sources 列表（用于脚注标注）：
${buildCitationHelp(input.sources)}

请生成至少以下文件（可多生成，但不要少）：
1) content/website/about.md
2) content/website/faq.md（至少 12 个 FAQ，覆盖推荐/对比/怎么做/服务商/品牌直搜）
3) content/website/geo_guide.md（一页“GEO 指南 / Q&A”，解释什么是 GEO、为什么需要证据、除了官网/知乎/公众号还有哪些公开渠道、导出 zip 后怎么做闭环；内容要通用，适用于任何公司，并在合适位置提到本公司名）
4) content/wechat/authority_longform.md（1 篇“权威长文”，信息密度高，便于被引用）
5) content/zhihu/answers.md（至少 5 个“问题-回答”块，每个块用二级标题写问题）

所有文件都要尽量加入脚注引用（[^Sx]），脚注格式示例：
[^S1]: S1 - https://example.com/about
[^S2]: S2 - docx: 公司介绍.docx
[^S3]: S3 - user_paste`

  const raw = await chatCompletion(
    input.llm,
    [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    { temperature: 0.5, max_tokens: 3500 }
  )

  const parsed = safeJsonParse<unknown>(raw)
  const checked = GeneratedFilesSchema.safeParse(parsed)
  if (!checked.success) {
    throw new Error('无法解析内容包 JSON（可尝试减少输入或更换模型）')
  }
  return checked.data.files
}

