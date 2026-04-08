import { z } from 'zod';
import { chatCompletion } from '../llm/openaiCompatible.js';
import { safeJsonParse } from '../llm/json.js';
const EvalSuiteSchema = z.object({
    questions: z.array(z.object({
        id: z.string(),
        category: z.enum(['recommendation', 'compare', 'howto', 'supplier', 'brand']),
        query: z.string(),
        expected: z.string()
    })),
    rubricMarkdown: z.string(),
    templateCsv: z.string()
});
export async function generateEvalSuite(input) {
    const system = `你是一个“GEO 评测套件生成器”。你需要给出一组中文测试问题，用于在豆包/千问/DeepSeek 等平台人工提问，并评估是否能正确提到目标公司。

要求：
- 覆盖 5 类：recommendation / compare / howto / supplier / brand。
- 每类至少 6 个问题，总计不少于 30 个。
- expected 字段写“我们希望回答里出现的要点”，包括公司名与正确定位（不要要求不现实的内容）。
- 生成一个 rubricMarkdown：如何人工打分（是否提到公司名、是否描述正确、是否有事实错误、是否引用来源等）。
- 生成 templateCsv：列包含 question_id, category, query, platform, model, answer, score_mention, score_correct, score_evidence, notes。`;
    const user = `目标公司画像（JSON）：
${JSON.stringify(input.profile, null, 2)}

请输出严格 JSON：
{
  "questions": [{ "id": "...", "category": "recommendation|compare|howto|supplier|brand", "query": "...", "expected": "..." }],
  "rubricMarkdown": "...",
  "templateCsv": "..."
}`;
    const raw = await chatCompletion(input.llm, [
        { role: 'system', content: system },
        { role: 'user', content: user }
    ], { temperature: 0.4, max_tokens: 2800 });
    const parsed = safeJsonParse(raw);
    const checked = EvalSuiteSchema.safeParse(parsed);
    if (!checked.success) {
        throw new Error('无法解析评测套件 JSON');
    }
    return checked.data;
}
