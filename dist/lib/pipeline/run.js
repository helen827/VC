import { nanoid } from 'nanoid';
import pLimit from 'p-limit';
import { z } from 'zod';
import { fetchUrlAsText } from '../sources/fetchUrl.js';
import { extractUploadText } from '../sources/extractUploadText.js';
import { buildEntityProfile } from './buildProfile.js';
import { generateGeoAssets } from './generateAssets.js';
import { generateEvalSuite } from './generateEval.js';
import { buildExportZip } from '../export/buildZip.js';
import { buildStaticGeoGuideMarkdown } from './staticGeoGuide.js';
export const PastedBlocksSchema = z.array(z.object({
    title: z.string().optional(),
    emphasized: z.boolean().optional(),
    sourceUrl: z.string().optional(),
    text: z.string().optional()
}));
function nowIso() {
    return new Date().toISOString();
}
function normalizeUrls(raw) {
    return raw
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.replace(/[)\],.。；;]+$/, ''))
        .filter((s) => /^https?:\/\//i.test(s))
        .slice(0, 20);
}
function clampText(text, limit) {
    const t = text.trim();
    if (t.length <= limit)
        return t;
    return t.slice(0, limit) + '\n...(truncated)';
}
export async function runGeneratePipeline(input) {
    const msg = (m) => input.onMessage?.(m);
    const extractedAt = nowIso();
    const sources = [];
    const urls = normalizeUrls(input.payload.urls);
    const limit = pLimit(Math.max(1, Math.min(8, input.fetchConcurrency)));
    if (urls.length > 0) {
        msg(`抓取 URL：${urls.length} 个…`);
        const results = await Promise.allSettled(urls.map((url) => limit(async () => {
            const { title, text } = await fetchUrlAsText({ url, timeoutMs: input.fetchTimeoutMs });
            const cleaned = clampText(text, 40_000);
            const id = `S${nanoid(8)}`;
            sources.push({
                id,
                type: 'url',
                title,
                emphasized: false,
                sourceUrl: url,
                extractedAt,
                text: cleaned
            });
        })));
        const ok = results.filter((r) => r.status === 'fulfilled').length;
        const bad = results.length - ok;
        msg(`抓取完成：成功 ${ok}，失败 ${bad}。`);
    }
    const pasted = input.payload.pastedBlocks
        .map((b) => ({
        title: b.title?.trim() || undefined,
        emphasized: Boolean(b.emphasized),
        sourceUrl: b.sourceUrl?.trim() || undefined,
        text: (b.text ?? '').trim()
    }))
        .filter((b) => b.text.length > 0)
        .slice(0, 20);
    for (const b of pasted) {
        const id = `S${nanoid(8)}`;
        sources.push({
            id,
            type: 'paste',
            title: b.title,
            emphasized: b.emphasized,
            sourceUrl: b.sourceUrl,
            extractedAt,
            text: clampText(b.text, 40_000)
        });
    }
    if (pasted.length > 0)
        msg(`已加入手动材料：${pasted.length} 段。`);
    const uploads = input.payload.uploadFiles.slice(0, 10);
    if (uploads.length > 0)
        msg(`解析上传文件：${uploads.length} 个…`);
    for (const f of uploads) {
        try {
            const { kind, text } = await extractUploadText(f.filename, f.buffer);
            if (!text.trim()) {
                msg(`跳过（无文本）：${f.filename}`);
                continue;
            }
            const id = `S${nanoid(8)}`;
            sources.push({
                id,
                type: kind,
                filename: f.filename,
                emphasized: true,
                extractedAt,
                text: clampText(text, 60_000)
            });
        }
        catch (e) {
            const msgText = e instanceof Error ? e.message : String(e);
            msg(`解析失败（${f.filename}）：${msgText}`);
        }
    }
    if (sources.length === 0) {
        throw new Error('没有可用资料：请至少提供 1 个 URL 或粘贴/上传材料。');
    }
    msg('生成实体画像…');
    const profile = await buildEntityProfile({
        llm: input.llm,
        companyName: input.payload.companyName,
        sources
    });
    msg('生成 GEO 内容包…');
    const llmContentFiles = await generateGeoAssets({ llm: input.llm, profile, sources });
    const staticGuide = {
        path: 'content/website/geo_guide.md',
        content: buildStaticGeoGuideMarkdown(profile.companyName || input.payload.companyName)
    };
    const contentFiles = [
        ...llmContentFiles.filter((f) => f.path !== staticGuide.path),
        staticGuide
    ];
    msg('生成评测/监控包…');
    const evalSuite = await generateEvalSuite({ llm: input.llm, profile });
    msg('生成发布 SOP…');
    const sopPlan = buildSopPlan({
        companyName: profile.companyName || input.payload.companyName,
        contentFiles
    });
    const sopMarkdown = sopPlanToText(sopPlan);
    msg('打包导出 zip…');
    const zipBuffer = await buildExportZip({
        companyName: input.payload.companyName,
        generatedAt: nowIso(),
        llm: { baseUrl: input.llm.baseUrl, model: input.llm.model },
        sources,
        profile,
        contentFiles,
        evalSuite
    });
    msg('完成。');
    return { sources, profile, contentFiles, evalSuite, zipBuffer, sopMarkdown, sopPlan };
}
function buildSopPlan(input) {
    const byPath = new Set(input.contentFiles.map((f) => f.path));
    const find = (p) => (byPath.has(p) ? p : null);
    const company = input.companyName;
    const websiteAbout = find('content/website/about.md');
    const websiteFaq = find('content/website/faq.md');
    const wechatLong = find('content/wechat/authority_longform.md');
    const zhihuAnswers = find('content/zhihu/answers.md');
    const sections = [];
    const websiteItems = [];
    if (websiteAbout)
        websiteItems.push({ platform: 'website', title: '官网 About / 公司介绍页', path: websiteAbout });
    if (websiteFaq)
        websiteItems.push({ platform: 'website', title: '官网 FAQ（覆盖问法族）', path: websiteFaq });
    sections.push({
        title: '官网（优先级：最高）',
        instructions: [
            '把以下页面发布到官网（或 docs 子站）。',
            '确保可公开访问，标题清晰，首段包含公司名与一句话定位。'
        ],
        items: websiteItems
    });
    const wechatItems = [];
    if (wechatLong)
        wechatItems.push({ platform: 'wechat', title: '公众号权威长文（信息密度高，便于引用）', path: wechatLong });
    sections.push({
        title: '公众号（优先级：高）',
        instructions: ['发布 1 篇权威长文，把关键事实/案例/边界写清楚，便于被引用。'],
        items: wechatItems
    });
    const zhihuItems = [];
    if (zhihuAnswers)
        zhihuItems.push({ platform: 'zhihu', title: '知乎问答合集（拆分为多条发布）', path: zhihuAnswers });
    sections.push({
        title: '知乎（优先级：高）',
        instructions: ['把回答拆成多条发布，每条覆盖一个高频问法；标题尽量出现“类别词/场景词”，首段自然出现公司名。'],
        items: zhihuItems
    });
    sections.push({
        title: '第三方背书（PR/付费加速器）',
        instructions: [
            '定位：这是“需要花钱/资源”的加速器，用第三方页面增强可信度与可引用性（比自家内容更容易被模型当作证据）。',
            '优先级建议：先把官网/公众号/知乎发布好，再用第三方背书放大效果。',
            '选择对象：行业垂直媒体、合作伙伴官网公告、可公开客户案例页（越“第三方”越有效）。',
            '每篇第三方内容必须包含（越靠前越好）：标题/副标题含“公司名+类别词+场景词”；首段定义句（是谁/做什么/面向谁/差异点）；3-5条事实要点；至少1个可核验链接（指向官网关键页）；统一落款信息（全称/简称/英文名/官网域名）。',
            '避免：堆形容词（领先/最强）但无事实；不同媒体稿对定位/产品名/人群表述打架；只发品牌宣传不覆盖高频问法族。'
        ],
        items: []
    });
    sections.push({
        title: '抽检评测（闭环）',
        instructions: [
            '目标：验证在豆包/千问/DeepSeek 上，模型是否能提到公司名、是否描述正确。',
            '在本页面直接复制“问题集”逐个提问，并自行记录哪些问题能/不能命中公司名。',
            '根据结果迭代官网 FAQ / 知乎问答 / 公众号内容，再发布一轮。'
        ],
        items: [
            { platform: 'eval', title: '问题集（复制去提问）', path: 'eval:questions' }
        ]
    });
    return {
        companyName: company,
        summary: [
            `目标：让豆包 / 千问 / DeepSeek 更容易正确提到「${company}」。`,
            '方法：把“可引用事实 + 统一定义句 + 高覆盖问法”分发到多个公开渠道，并通过抽检评测持续迭代。'
        ],
        sections
    };
}
function sopPlanToText(plan) {
    const lines = [];
    lines.push(`发布 SOP：${plan.companyName}`);
    lines.push('');
    for (const s of plan.summary)
        lines.push(`- ${s}`);
    for (const sec of plan.sections) {
        lines.push('');
        lines.push(`【${sec.title}】`);
        for (const i of sec.instructions)
            lines.push(`- ${i}`);
        for (const it of sec.items)
            lines.push(`- ${it.title}: ${it.path}`);
        if (sec.items.length === 0 && sec.title.includes('官网')) {
            lines.push('- （未生成官网页面文件，请检查生成结果）');
        }
        if (sec.items.length === 0 && sec.title.includes('公众号')) {
            lines.push('- （未生成公众号文案，请检查生成结果）');
        }
        if (sec.items.length === 0 && sec.title.includes('知乎')) {
            lines.push('- （未生成知乎文案，请检查生成结果）');
        }
    }
    return lines.join('\n');
}
