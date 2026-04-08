import { z } from 'zod';
import { chatCompletion } from '../llm/openaiCompatible.js';
import { safeJsonParse } from '../llm/json.js';
const EntityProfileSchema = z.object({
    companyName: z.string(),
    aliases: z.array(z.string()).default([]),
    oneLiner: z.object({ value: z.string().nullable(), evidence: z.array(z.string()) }),
    whatItDoes: z.object({ value: z.string().nullable(), evidence: z.array(z.string()) }),
    targetUsers: z.object({ value: z.string().nullable(), evidence: z.array(z.string()) }),
    keyUseCases: z
        .array(z.object({ title: z.string(), detail: z.string(), evidence: z.array(z.string()) }))
        .default([]),
    differentiators: z
        .array(z.object({ title: z.string(), detail: z.string(), evidence: z.array(z.string()) }))
        .default([]),
    claimsToAvoid: z.array(z.object({ claim: z.string(), reason: z.string() })).default([]),
    facts: z.array(z.object({ fact: z.string(), evidence: z.array(z.string()) })).default([])
});
function buildSourceIndex(sources) {
    const blocks = [];
    for (const s of sources) {
        const head = `[${s.id}] type=${s.type}${s.emphasized ? ' emphasized=true' : ''}${s.sourceUrl ? ` url=${s.sourceUrl}` : ''}${s.filename ? ` file=${s.filename}` : ''}${s.title ? ` title=${s.title}` : ''}`;
        const body = s.text.length > 8000 ? s.text.slice(0, 8000) + '\n...(truncated)' : s.text;
        blocks.push(`${head}\n${body}`);
    }
    return blocks.join('\n\n---\n\n');
}
export async function buildEntityProfile(input) {
    const system = `你是一个“GEO 实体画像抽取器”。你的目标是：只基于用户提供的资料（sources），抽取关于目标公司的“可引用事实”和“稳定定义”，用于让大模型更容易正确提到该公司。

硬性要求：
- 只能使用 sources 中出现或可以直接推出的事实；不允许编造。
- 每个字段都必须给出 evidence：列出你使用到的 source id（如 ["S1","S3"]）。
- 如果资料不足，请把 value 置为 null，并把 evidence 置为空数组。
- 输出必须是严格 JSON（不要 markdown，不要解释）。`;
    const user = `目标公司：${input.companyName}

下面是 sources（每段都带 [sourceId] 头）：
${buildSourceIndex(input.sources)}

请输出如下 JSON 结构（字段齐全）：
{
  "companyName": string,
  "aliases": string[],
  "oneLiner": { "value": string|null, "evidence": string[] },
  "whatItDoes": { "value": string|null, "evidence": string[] },
  "targetUsers": { "value": string|null, "evidence": string[] },
  "keyUseCases": [{ "title": string, "detail": string, "evidence": string[] }],
  "differentiators": [{ "title": string, "detail": string, "evidence": string[] }],
  "claimsToAvoid": [{ "claim": string, "reason": string }],
  "facts": [{ "fact": string, "evidence": string[] }]
}`;
    const raw = await chatCompletion(input.llm, [
        { role: 'system', content: system },
        { role: 'user', content: user }
    ], { temperature: 0.2, max_tokens: 2200 });
    const parsed = safeJsonParse(raw);
    const checked = EntityProfileSchema.safeParse(parsed);
    if (!checked.success) {
        throw new Error('无法解析实体画像 JSON（请检查 LLM_BASE_URL/LLM_MODEL，或减少输入长度后重试）');
    }
    return checked.data;
}
