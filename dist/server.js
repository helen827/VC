import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { chatCompletion } from './lib/llm/openaiCompatible.js';
import { PastedBlocksSchema, runGeneratePipeline } from './lib/pipeline/run.js';
import { isAllowedUploadFilename } from './lib/sources/extractUploadText.js';
const jobs = new Map();
function envNumber(key, fallback) {
    const raw = process.env[key];
    if (!raw)
        return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}
function mustEnv(key) {
    const v = process.env[key]?.trim();
    if (!v)
        throw new Error(`Missing env: ${key}`);
    return v;
}
function makeLlmClient() {
    const baseUrl = (process.env.LLM_BASE_URL || 'https://api.qnaigc.com/v1').trim();
    const llmKeyRaw = process.env.LLM_API_KEY?.trim() || '';
    const qiniuKeyRaw = process.env.QINIU_AI_API_KEY?.trim() || '';
    let apiKey = (llmKeyRaw || qiniuKeyRaw || '');
    if (!apiKey) {
        throw new Error('Missing env: LLM_API_KEY (or QINIU_AI_API_KEY)');
    }
    const model = (process.env.LLM_MODEL || 'deepseek-v3').trim();
    if (/^bearer\s+/i.test(apiKey)) {
        apiKey = apiKey.replace(/^bearer\s+/i, '').trim();
    }
    return { baseUrl, apiKey, model };
}
const app = express();
app.disable('x-powered-by');
app.use(express.static(new URL('../public', import.meta.url).pathname));
const ACCESS_TOKEN = process.env.ACCESS_TOKEN?.trim() || '';
function checkAccessToken(req) {
    if (!ACCESS_TOKEN)
        return true;
    const header = req.header('authorization') || '';
    const x = req.header('x-access-token') || '';
    const q = typeof req.query.access_token === 'string' ? req.query.access_token : '';
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const token = bearer || x || q;
    return token === ACCESS_TOKEN;
}
function requireAccessToken(req, res, next) {
    if (checkAccessToken(req))
        return next();
    res.status(401).json({ error: 'unauthorized' });
}
app.get('/healthz', (_req, res) => {
    res.status(200).send('ok');
});
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 20 * 1024 * 1024,
        files: 10
    },
    fileFilter: (_req, file, cb) => {
        if (isAllowedUploadFilename(file.originalname))
            return cb(null, true);
        return cb(new Error('仅支持上传：.docx / .pdf / .pptx / .pages（旧版 .ppt 请先另存为 .pptx）'));
    }
});
const CreateJobSchema = z.object({
    companyName: z.string().min(1).max(80),
    urls: z.string().optional(),
    pastedBlocksJson: z.string().optional()
});
app.use('/api', express.json({ limit: '1mb' }));
app.use('/api', requireAccessToken);
const QuestionAudienceEnum = z.enum(['market_investor', 'gov_guidance_fund']);
const SuggestQuestionsSchema = z.object({
    companyName: z.string().optional(),
    industry: z.string().optional(),
    product: z.string().optional(),
    definition: z.string().optional(),
    competitors: z.string().optional(),
    questionAudiences: z.array(QuestionAudienceEnum).min(1).max(2)
});
function suggestAudienceMode(audiences) {
    const m = audiences.includes('market_investor');
    const g = audiences.includes('gov_guidance_fund');
    if (m && g)
        return 'both';
    if (g)
        return 'gov_only';
    return 'market_only';
}
function looksMedTechRelated(industry, product, definition) {
    const s = `${industry} ${product} ${definition}`.toLowerCase();
    return /医|药械|器械|诊疗|临床|植入|脑机|神经|bci|nmpa|注册证|二类|三类|有源|无创|康复|诊断|医院|患者|fda|ce\b/i.test(s);
}
function suggestQuestionsSystemMessage(mode) {
    const base = '你只输出最终内容：每行一个完整问句。不要序号、不要分组标题（如A类B类/1)/2)）、不要括号说明、不要思考过程。';
    const cnStartup = ' 必须包含「××领域创业公司有哪些」「××赛道创业公司有哪些」类基础句式（××用用户行业词）；并包含「国内」「创业公司」「有哪些」组合行。不得用「头部玩家」替代「创业公司/初创」字面。';
    if (mode === 'both') {
        return (base +
            cnStartup +
            ' 本题同时面向市场化投资人与政府引导基金：两类口吻各占约一半并混排，不要明显分成两段。问句应像真实搜索输入，不要写成投委材料。');
    }
    if (mode === 'gov_only') {
        return base + cnStartup + ' 问句主体以政府引导基金/地方国资/园区/LP 的搜索关切为主，避免整表都是估值/融资炒作。';
    }
    return base + cnStartup + ' 问句主体以市场化投资人行业检索为主。';
}
function suggestKeywordSource(industry, product, definition) {
    return [industry, product, definition]
        .map((s) => s.trim())
        .filter(Boolean)
        .join('；');
}
/** 同一行同时含「国内」「创业公司」「有哪些」——投资人最常见基础检索句式 */
function countLiteralDomesticStartupWhichLines(questions) {
    return questions.filter((q) => q.includes('国内') && q.includes('创业公司') && q.includes('有哪些')).length;
}
function pickTopicPhrase(industry, product, definition) {
    const a = industry.trim();
    const b = product.trim();
    const c = definition.trim();
    if (a)
        return a;
    if (b)
        return b;
    if (c)
        return c.length > 24 ? `${c.slice(0, 24)}…` : c;
    return '该领域';
}
/**
 * LLM 仍可能用「头部玩家」规避「创业公司」字面——在服务端补齐硬性检索句式。
 */
function ensureLiteralDomesticStartupQuestions(questions, industry, product, definition) {
    const topic = pickTopicPhrase(industry, product, definition);
    const need = 2 - countLiteralDomesticStartupWhichLines(questions);
    if (need <= 0)
        return questions;
    const injected = [];
    if (need >= 1)
        injected.push(`国内${topic}创业公司有哪些`);
    if (need >= 2)
        injected.push(`国内做${topic}的创业公司有哪些`);
    const seen = new Set(questions.map((q) => q.trim()));
    const extra = injected.filter((q) => !seen.has(q));
    return [...extra, ...questions];
}
/** 「××领域/赛道创业公司有哪些」——搜索框最常见句式之一 */
function countDomainOrTrackStartupWhich(questions) {
    return questions.filter((q) => (q.includes('创业公司') || q.includes('初创公司')) &&
        q.includes('有哪些') &&
        (q.includes('领域') || q.includes('赛道'))).length;
}
function ensureBasicStartupListingQuestions(questions, industry, product, definition) {
    const topic = pickTopicPhrase(industry, product, definition);
    const seen = new Set(questions.map((q) => q.trim()));
    const toAdd = [];
    const domainCount = countDomainOrTrackStartupWhich(questions);
    if (domainCount < 2) {
        if (topic !== '该领域') {
            const a = `${topic}领域创业公司有哪些`;
            const b = `${topic}赛道创业公司有哪些`;
            if (!seen.has(a)) {
                toAdd.push(a);
                seen.add(a);
            }
            if (!seen.has(b)) {
                toAdd.push(b);
                seen.add(b);
            }
        }
        else {
            const g1 = `新兴领域创业公司有哪些`;
            const g2 = `国内热门赛道创业公司有哪些`;
            if (!seen.has(g1)) {
                toAdd.push(g1);
                seen.add(g1);
            }
            if (!seen.has(g2)) {
                toAdd.push(g2);
                seen.add(g2);
            }
        }
    }
    const hasStartupWhich = questions.some((q) => q.includes('创业公司有哪些') ||
        q.includes('初创公司有哪些') ||
        (q.includes('创业公司') && q.includes('有哪些')));
    if (!hasStartupWhich) {
        if (topic !== '该领域') {
            const c = `有哪些${topic}创业公司`;
            const d = `做${topic}的创业公司有哪些`;
            if (!seen.has(c)) {
                toAdd.push(c);
                seen.add(c);
            }
            if (!seen.has(d)) {
                toAdd.push(d);
                seen.add(d);
            }
        }
    }
    return [...toAdd, ...questions];
}
function hasChinaChuangListLine(questions) {
    return questions.some((q) => q.includes('中国') && q.includes('初创') && q.includes('清单'));
}
function ensureChinaChuangListQuestion(questions, industry, product, definition) {
    if (hasChinaChuangListLine(questions))
        return questions;
    const topic = pickTopicPhrase(industry, product, definition);
    const line = `中国${topic}初创公司清单有哪些`;
    if (questions.some((q) => q.trim() === line))
        return questions;
    return [line, ...questions];
}
function extractIndustryKeywords(industry, product, definition) {
    const raw = `${industry} ${product} ${definition}`.trim();
    const parts = raw
        .split(/[、，,；;\s\n\r]+/g)
        .map((s) => s.trim())
        .filter((s) => s.length >= 2 && s.length <= 20);
    const out = [];
    const seen = new Set();
    for (const p of parts) {
        if (seen.has(p))
            continue;
        seen.add(p);
        out.push(p);
    }
    // 从最长字段抽 4–6 字子串，提高「脑机接口」等核心词覆盖率
    const longest = [industry, product, definition].reduce((a, b) => (b.length > a.length ? b : a), '');
    const s = longest.replace(/\s/g, '');
    for (let len = 6; len >= 4; len--) {
        for (let i = 0; i + len <= s.length && out.length < 14; i++) {
            const sub = s.slice(i, i + len);
            if (seen.has(sub))
                continue;
            seen.add(sub);
            out.push(sub);
        }
    }
    return out.slice(0, 14);
}
function countTripleComboLines(questions) {
    return questions.filter((q) => (q.includes('国内') || q.includes('中国')) &&
        (q.includes('创业公司') || q.includes('初创')) &&
        (q.includes('有哪些') || q.includes('清单'))).length;
}
const GOV_CTX_RE = /园区|返投|国资|引导基金|地方政府|产业园|招采|配套|产业规划|产投|示范应用|LP|落户|落地指标/;
/** 像尽调访谈/财务审问，不像搜索框 —— 命中应扣分 */
const DD_INTERVIEW_RE = /贵公司|贵司|你们公司|毛利率|净利率|多少亿|IRR|EBITDA|留存率|LTV|CAC|Payback|本轮融资|估值区间|尽职调查|投决|投委会|护城河是什么|壁垒是什么|销售周期多长|客单价|续约率|回款周期|ARR|MRR|GMV|烧钱| runway|烧钱率/i;
function countDdInterviewLines(questions, companyName) {
    const co = companyName.trim();
    return questions.filter((q) => {
        if (DD_INTERVIEW_RE.test(q))
            return true;
        if (co && new RegExp(`${escapeRegExp(co)}.+?(毛利率|估值|融资轮次|壁垒|护城河|核心技术|专利布局|供应商|客户画像)`, 'u').test(q)) {
            return true;
        }
        return false;
    }).length;
}
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function scoreQuestionSet(questions, mode, industry, product, definition, companyName) {
    const n = questions.length;
    const keywords = extractIndustryKeywords(industry, product, definition);
    const hasCo = Boolean(companyName.trim());
    const breakdown = [];
    const hints = [];
    let total = 0;
    const lit = countLiteralDomesticStartupWhichLines(questions);
    const sLit = lit >= 2 ? 18 : lit === 1 ? 10 : 0;
    breakdown.push({ key: 'literalDomestic', score: sLit, max: 18, detail: `含「国内+创业公司+有哪些」同行 ${lit} 条` });
    total += sLit;
    if (lit < 2)
        hints.push('增加至少两条「国内…创业公司有哪些」式问句');
    const domainN = countDomainOrTrackStartupWhich(questions);
    const sDomain = domainN >= 2 ? 12 : domainN === 1 ? 7 : 0;
    breakdown.push({
        key: 'domainOrTrackStartup',
        score: sDomain,
        max: 12,
        detail: `「领域/赛道+创业公司+有哪些」式 ${domainN} 条（目标≥2）`
    });
    total += sDomain;
    if (domainN < 2)
        hints.push('必须包含「××领域创业公司有哪些」「××赛道创业公司有哪些」类基础搜索问句');
    const sChina = hasChinaChuangListLine(questions) ? 10 : 0;
    breakdown.push({ key: 'chinaChuangList', score: sChina, max: 10, detail: sChina ? '已含中国+初创+清单' : '缺中国+初创+清单' });
    total += sChina;
    if (!sChina)
        hints.push('补一条「中国…初创…清单」式问句');
    const triple = countTripleComboLines(questions);
    const sTriple = Math.min(12, Math.round((triple / 5) * 12));
    breakdown.push({ key: 'tripleCombo', score: sTriple, max: 12, detail: `三合一同行 ${triple} 条（目标≥5）` });
    total += sTriple;
    if (triple < 5)
        hints.push('增加「国内/中国+创业公司或初创+有哪些或清单」组合问句');
    const cnLines = questions.filter((q) => q.includes('国内') || q.includes('中国')).length;
    const suLines = questions.filter((q) => q.includes('创业公司') || q.includes('初创')).length;
    const sFreq = Math.min(10, Math.round(5 * Math.min(1, cnLines / 6) + 5 * Math.min(1, suLines / 6)));
    breakdown.push({
        key: 'cnStartupSpread',
        score: sFreq,
        max: 10,
        detail: `含国内/中国 ${cnLines} 行，含创业公司/初创 ${suLines} 行（各目标≥6）`
    });
    total += sFreq;
    if (cnLines < 6 || suLines < 6)
        hints.push('让更多问句分别出现「国内/中国」与「创业公司/初创」');
    let cov = 0;
    let sInd = 0;
    if (n > 0 && keywords.length > 0) {
        const hit = questions.filter((q) => keywords.some((k) => q.includes(k))).length;
        cov = hit / n;
        sInd = Math.round(22 * cov);
        breakdown.push({
            key: 'industryKeywordCoverage',
            score: sInd,
            max: 22,
            detail: `关键词命中比例 ${Math.round(cov * 100)}%`
        });
        if (cov < 0.55)
            hints.push('提高问句里对用户行业/产品关键词的覆盖');
    }
    else {
        sInd = keywords.length === 0 && n > 0 ? 8 : 0;
        breakdown.push({
            key: 'industryKeywordCoverage',
            score: sInd,
            max: 22,
            detail: keywords.length === 0 ? '未能从输入提取关键词，给基础分' : '无问句'
        });
        if (keywords.length === 0)
            hints.push('补充「行业/产品/产品定义」以便问法更贴领域');
    }
    total += sInd;
    if (mode === 'both') {
        const govHits = questions.filter((q) => GOV_CTX_RE.test(q)).length;
        const r = n ? govHits / n : 0;
        let sGov = 5;
        if (r >= 0.22 && r <= 0.58)
            sGov = 18;
        else if (r >= 0.12 && r < 0.7)
            sGov = 12;
        breakdown.push({
            key: 'govAudienceMix',
            score: sGov,
            max: 18,
            detail: `政府语境占比 ${Math.round(r * 100)}%（双选目标约25–55%）`
        });
        total += sGov;
        if (r < 0.2 || r > 0.6)
            hints.push('双选时增加或减少带园区/返投/国资/引导基金等政府检索语境的问句');
    }
    else {
        breakdown.push({ key: 'govAudienceMix', score: 0, max: 0, detail: '非双选不适用' });
    }
    const trigRe = /对标|替代|推荐|清单|谁在做|代表公司/;
    const trigHits = questions.filter((q) => trigRe.test(q)).length;
    const trigRatio = n ? trigHits / n : 0;
    const sTrig = Math.min(12, Math.round(12 * Math.min(1, trigRatio / 0.22)));
    breakdown.push({
        key: 'triggerWords',
        score: sTrig,
        max: 12,
        detail: `含对标/替代/推荐/清单/谁在做/代表公司 的问句占比 ${Math.round(trigRatio * 100)}%`
    });
    total += sTrig;
    if (trigRatio < 0.18)
        hints.push('增加对标、替代方案、推荐清单、谁在做等触发式问句');
    const ddLines = countDdInterviewLines(questions, companyName);
    const sSearchLike = Math.max(0, 15 - Math.min(15, ddLines * 3));
    breakdown.push({
        key: 'searchNotDdInterview',
        score: sSearchLike,
        max: 15,
        detail: `疑似尽调/财务审问式 ${ddLines} 条（目标接近0）`
    });
    total += sSearchLike;
    if (ddLines > 0)
        hints.push('删掉「毛利率/估值/壁垒/供应商/客户画像」等访谈式问句，改成「有哪些公司/怎么选/对标谁/清单」类搜索问法');
    let sCount = 0;
    if (n >= 50 && n <= 80)
        sCount = 8;
    else if (n >= 40 && n <= 95)
        sCount = 5;
    else if (n >= 20)
        sCount = 2;
    breakdown.push({ key: 'countBand', score: sCount, max: 8, detail: `共 ${n} 条（目标约50–80）` });
    total += sCount;
    if (n < 45 || n > 85)
        hints.push('调整生成条数到约50–80条');
    if (hasCo) {
        const nameHits = questions.filter((q) => q.includes(companyName.trim())).length;
        const sName = Math.min(10, Math.round((nameHits / 12) * 10));
        breakdown.push({
            key: 'companyNameMentions',
            score: sName,
            max: 10,
            detail: `含公司名 ${nameHits} 条（目标≥12）`
        });
        total += sName;
        if (nameHits < 10)
            hints.push('在更多行业检索问句中自然带入公司名');
    }
    else {
        breakdown.push({ key: 'companyNameMentions', score: 5, max: 5, detail: '未提供公司名，给基础分' });
        total += 5;
    }
    const maxRaw = breakdown.reduce((acc, b) => acc + b.max, 0);
    const score = maxRaw > 0 ? Math.min(100, Math.round((total / maxRaw) * 100)) : 0;
    return { score, breakdown, hints: [...new Set(hints)].slice(0, 5) };
}
function parseQuestionsFromLlmText(text) {
    return text
        .split(/\n+/)
        .map((s) => s.trim().replace(/^[\-\*\d\.\)\s]+/, '').trim())
        .filter(Boolean);
}
function normalizeSuggestedQuestions(questions, industry, product, definition) {
    let q = [...questions];
    q = ensureBasicStartupListingQuestions(q, industry, product, definition);
    q = ensureLiteralDomesticStartupQuestions(q, industry, product, definition);
    q = ensureChinaChuangListQuestion(q, industry, product, definition);
    return q.slice(0, 120);
}
function minimalFallbackQuestions(industry, product, definition, companyName) {
    const topic = pickTopicPhrase(industry, product, definition);
    const co = companyName.trim();
    const lines = topic === '该领域'
        ? [
            `新兴领域创业公司有哪些`,
            `国内热门赛道创业公司有哪些`,
            `中国初创公司清单有哪些`,
            `国内创业公司有哪些值得看`
        ]
        : [
            `${topic}领域创业公司有哪些`,
            `${topic}赛道创业公司有哪些`,
            `有哪些${topic}创业公司`,
            `国内${topic}创业公司有哪些`,
            `国内做${topic}的创业公司有哪些`,
            `中国${topic}初创公司清单有哪些`,
            `${topic}赛道有哪些代表公司`
        ];
    if (topic !== '该领域') {
        lines.push(`${topic}行业对标公司有哪些`, `有哪些做${topic}的初创公司`, `${topic}典型应用场景案例有哪些`, `${topic}最近融资事件有哪些`);
    }
    else {
        lines.push(`新兴赛道行业对标公司有哪些`, `硬科技典型应用场景案例有哪些`, `科技赛道最近融资事件有哪些`);
    }
    if (co) {
        lines.push(`${co}对标哪些公司`, `${co}属于哪一类代表公司`, `${co}与哪些公司常被列入同一清单`);
    }
    return normalizeSuggestedQuestions(lines, industry, product, definition);
}
function buildSuggestQuestionsUserPrompt(mode, medTechExtra, hasCompanyName, industry, product, definition, companyName, competitors, audiences, retryHint) {
    const { intro, constraints, quotas, closingLines } = buildSuggestQuestionsPromptParts(mode, medTechExtra, hasCompanyName, industry, product, definition);
    const audienceLabel = `本次问法面向：${audiences.map((a) => (a === 'market_investor' ? '市场化投资人' : '政府引导基金')).join(' + ')}。`;
    const parts = [
        ...intro,
        ``,
        audienceLabel,
        ``,
        `强约束：`,
        ...constraints,
        ``,
        ...quotas,
        ``,
        `输入信息：`,
        companyName ? `- 公司名：${companyName}` : `- 公司名：未提供（按产品/能力生成通用问法）`,
        industry ? `- 行业：${industry}` : `- 行业：未提供`,
        product ? `- 产品/能力：${product}` : `- 产品/能力：未提供`,
        definition ? `- 产品定义/一句话描述：${definition}` : `- 产品定义/一句话描述：未提供`,
        competitors ? `- 竞品/替代：${competitors}` : `- 竞品/替代：未提供`,
        ...(closingLines.length ? ['', ...closingLines] : []),
        ``,
        `【最后一条纪律】①至少 2 行同时含「国内」「创业公司」「有哪些」；②至少 1 行同时含「中国」「初创」「清单」；③至少 2 行须为「用户行业词+领域或赛道+创业公司有哪些」结构（例：脑机接口医疗器械领域创业公司有哪些）。仅写「头部玩家」但未出现「创业公司/初创」视为未满足。`
    ];
    if (retryHint) {
        parts.push(``, `【优化重试】${retryHint}`);
    }
    return parts.join('\n');
}
function buildSuggestQuestionsPromptParts(mode, medTechExtra, hasCompanyName, industry, product, definition) {
    const medTechGovLine = medTechExtra
        ? `若该行业涉及医疗器械/临床/注册等：政府侧问法可自然覆盖（择要）：注册与临床属地、生产与委托制造、入院与招采/医保衔接、数据与隐私与人类遗传资源等合规（用中性问法）、关键件国产化与供应链安全、伦理与社会接受度。`
        : ``;
    const commonIntent = [
        `你要生成“投资人真实会在 AI 搜索里输入”的问句清单（GEO 问法族），围绕行业信息检索，而不是尽调审问。`,
        `问句要更像：清单/对比/选型/代表公司/对标/替代方案/案例/里程碑，而不是：估值审问/IRR/投委材料。`
    ];
    const introMarket = [
        `你是市场化投资人助手，擅长把行业信息检索问题问得更像真实搜索输入。`,
        ...commonIntent
    ];
    const introGov = [
        `你是政府引导基金/地方产投/园区条线的行业研究助手，擅长把行业信息检索问题问得更像真实搜索输入。`,
        ...commonIntent,
        `政府侧常见检索维度：产业链位置、落地与配套、国资合规与流程、区域带动与就业税收、返投口径、与社会资本协同、园区载体等；不编造具体政策条文。`,
        ...(medTechGovLine ? [medTechGovLine] : [])
    ];
    const introBoth = [
        `你同时熟悉市场化投资人与政府引导基金/地方产投的检索习惯。`,
        ...commonIntent,
        `本次必须两类口吻各占约一半并混排，不要明显分段。`
    ];
    const quotasIntent = [
        `数量与结构（总计约 60 条，50–80 均可；不要输出任何标题或分组标签）：`,
        `- 第一优先（约 12 条）：「××领域/赛道创业公司有哪些」「有哪些××创业公司」等清单式，必须分散在全文，不要只堆在开头`,
        `- 行业信息检索类其余约 28 条：对比选型、应用场景/案例、事件/里程碑（融资/合作/试点/临床/注册/招采等按行业替换）`,
        `- 点名触发类约 20 条：须含“对标/替代方案/推荐/清单/谁在做/代表公司”等之一；“头部玩家”仅作补充，不能顶替「创业公司/初创」字面`
    ];
    const namingRules = [];
    if (hasCompanyName) {
        namingRules.push(`- 用户提供了公司名：请至少 12 条问句在行业检索语境下显式包含公司名（例如“X公司对标谁/属于哪一类/与哪些公司同类/在清单里怎么找/和哪些公司一起被列为代表玩家”），但不要每条都硬塞。`, `- 至少 6 条包含公司名的问句必须带“对标/替代/同类/代表公司/推荐/清单/谁在做”等触发词之一，避免只是把公司名硬插进融资盘点句式`);
    }
    else {
        namingRules.push(`- 用户未提供公司名：问句以行业检索为主，通过“代表公司/对标/清单”结构让回答能自然列出公司。`);
    }
    const keywordSource = suggestKeywordSource(industry, product, definition);
    const industryKeywordRule = keywordSource
        ? `- 至少约 40 条问句须自然嵌入与用户领域相关的检索词；优先使用用户已填信息中的词：${keywordSource}（可拆成 2-8 字核心名词使用，勿机械重复同一句式）`
        : `- 用户行业信息较少时：至少约 40 条问句仍须像真实搜索，包含该赛道常见名词（从「行业/产品/定义」能推则推）`;
    const lexicalChinaStartup = [
        `- 【最重要】投资人最常搜的基础句式，整表至少 4 条必须接近下面模板（把「××」换成用户行业/产品核心词）：「××领域创业公司有哪些」「××赛道创业公司有哪些」「有哪些××创业公司」「做××的创业公司有哪些」`,
        `- 上述基础句式必须出现字面「创业公司」或「初创公司」以及「有哪些」，不可用「头部玩家有哪些」单独替代`,
        `- 词频硬约束：整表至少 6 条须含「国内」或「中国」之一；至少 6 条须含「创业公司」或「初创」之一`,
        `- 字面三合一（同一行内、顺序可穿插领域词）：至少 5 条须同时含「国内」或「中国」+「创业公司」或「初创」+「有哪些」或「清单」之一`,
        `- 字面强约束：至少 2 条同一行内同时出现「国内」「创业公司」「有哪些」；至少 1 条同一行内同时出现「中国」「初创」「清单」`,
        `- 禁止偷换：不得仅用「头部玩家」「龙头」「第一梯队」替代「创业公司」或「初创」来满足硬性句式`
    ];
    const constraintsBase = [
        `- 只输出问句，每行一条；不要编号、不要加 A类/B类、不要加解释`,
        `- 中文为主；可混合行业常见英文缩写，但不要像财务审问清单`,
        `- 句子尽量短，避免把 3 个问题塞进一句话`,
        `- 每个意图簇都要覆盖到，避免 60 条都变成“公司清单”一种句式`,
        industryKeywordRule,
        ...lexicalChinaStartup
    ];
    const marketTone = [
        `- 市场化口吻偏：竞争格局/对标/替代方案/商业化路径/客户与渠道/落地阻力/行业里程碑/代表公司清单`,
        `- 市场化口吻避免：纯投委追问式“你们的毛利/留存/IRR/退出时间表”长句审问；要写成投资人会搜的短问句`
    ];
    const govTone = [
        `- 政府口吻偏：产业链环节与卡点/落地载体与配套/合规与流程/区域带动与返投/与链主协同/示范应用与试点`,
        `- 政府口吻句式建议包含主体或语境词：地方/园区/引导基金/国资/返投/落地/配套/产业规划/示范应用/招采等（择一即可）`
    ];
    if (mode === 'market_only') {
        return {
            intro: introMarket,
            constraints: [...constraintsBase, ...marketTone, ...namingRules],
            quotas: quotasIntent,
            closingLines: [
                `输出前自检：是否“对比/选型/案例/里程碑/代表公司”覆盖充分？是否避免把大部分问句写成估值与融资审问？`,
                `输出前自检：是否有≥2行同时含子串「国内」「创业公司」「有哪些」？是否有≥1行同时含「中国」「初创」「清单」？三合一组合是否≥5？是否约40条含用户领域关键词？`
            ]
        };
    }
    if (mode === 'gov_only') {
        return {
            intro: introGov,
            constraints: [...constraintsBase, ...govTone, ...namingRules],
            quotas: quotasIntent,
            closingLines: [
                `输出前自检：政府侧问句是否多数能看出产业落地/合规/配套/返投/区域带动等视角？是否避免整表像市场化基金估值清单？`,
                `输出前自检：是否有≥2行同时含「国内」「创业公司」「有哪些」？三合一组合是否≥5？政府侧问句也可使用上述基础检索句式。`
            ]
        };
    }
    return {
        intro: introBoth,
        constraints: [...constraintsBase, ...marketTone, ...govTone, ...namingRules],
        quotas: quotasIntent,
        closingLines: [
            `输出前自检：两类口吻是否大致各占一半并混排？点名触发词（代表公司/对标/替代/推荐/清单/谁在做）是否分布在多种意图里而非集中一处？`,
            `输出前自检：是否有≥2行同时含「国内」「创业公司」「有哪些」？三合一组合是否≥5？是否约40条含用户领域关键词？`,
            ...(medTechExtra
                ? [
                    `医疗器械等合规行业：政府侧问句需部分出现注册/临床/招采医保衔接/合规/供应链等检索维度（中性问法）。`
                ]
                : [])
        ]
    };
}
app.post('/api/suggest_questions', async (req, res) => {
    try {
        const llm = makeLlmClient();
        const input = SuggestQuestionsSchema.parse(req.body);
        const companyName = (input.companyName ?? '').trim();
        const industry = (input.industry ?? '').trim();
        const product = (input.product ?? '').trim();
        const definition = (input.definition ?? '').trim();
        const competitors = (input.competitors ?? '').trim();
        const audiences = input.questionAudiences;
        const mode = suggestAudienceMode(audiences);
        const medTechExtra = looksMedTechRelated(industry, product, definition);
        const hasCompanyName = Boolean(companyName);
        const MAX_ATTEMPTS = 4;
        let bestQuestions = [];
        let bestScore = -1;
        let bestBreakdown = [];
        let bestHints = [];
        let attempts = 0;
        let lastScore = 0;
        let lastHints = [];
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            attempts = attempt + 1;
            const retryHint = attempt > 0 && lastHints.length
                ? `上一轮质量分 ${lastScore}（满分100）。请按下列方向改写或增补问句：${lastHints.join('；')}`
                : undefined;
            const userPrompt = buildSuggestQuestionsUserPrompt(mode, medTechExtra, hasCompanyName, industry, product, definition, companyName, competitors, audiences, retryHint);
            const text = await chatCompletion(llm, [
                { role: 'system', content: suggestQuestionsSystemMessage(mode) },
                { role: 'user', content: userPrompt }
            ], { temperature: 0.25, max_tokens: 2800 });
            let questions = normalizeSuggestedQuestions(parseQuestionsFromLlmText(text), industry, product, definition);
            if (questions.length === 0) {
                lastScore = 0;
                lastHints = ['模型未返回有效行，请重试生成'];
                continue;
            }
            const scored = scoreQuestionSet(questions, mode, industry, product, definition, companyName);
            if (scored.score > bestScore) {
                bestScore = scored.score;
                bestQuestions = questions;
                bestBreakdown = scored.breakdown;
                bestHints = scored.hints;
            }
            if (scored.score > 80) {
                bestQuestions = questions;
                bestScore = scored.score;
                bestBreakdown = scored.breakdown;
                bestHints = scored.hints;
                break;
            }
            lastScore = scored.score;
            lastHints = scored.hints.length ? scored.hints : ['提高硬性句式与行业词覆盖'];
        }
        if (bestQuestions.length === 0) {
            bestQuestions = minimalFallbackQuestions(industry, product, definition, companyName);
            const fb = scoreQuestionSet(bestQuestions, mode, industry, product, definition, companyName);
            bestScore = fb.score;
            bestBreakdown = fb.breakdown;
            bestHints = fb.hints;
            attempts = Math.max(attempts, 1);
        }
        const qualityOk = bestScore > 80;
        res.json({
            questions: bestQuestions,
            score: bestScore,
            qualityOk,
            attempts,
            breakdown: bestBreakdown,
            hints: bestHints
        });
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.status(400).json({ error: msg });
    }
});
app.post('/api/jobs', upload.array('uploadFiles', 10), async (req, res) => {
    try {
        const parsed = CreateJobSchema.parse(req.body);
        const companyName = parsed.companyName.trim();
        const urls = parsed.urls
            ?.split(/\n+/)
            .map((s) => s.trim())
            .filter(Boolean) ?? [];
        const pastedRaw = parsed.pastedBlocksJson?.trim() || '[]';
        const pastedUnknown = JSON.parse(pastedRaw);
        const pastedBlocks = PastedBlocksSchema.parse(pastedUnknown);
        const uploadFiles = (req.files ?? []).map((f) => ({
            filename: f.originalname,
            buffer: f.buffer
        }));
        const llm = makeLlmClient();
        const fetchTimeoutMs = envNumber('FETCH_TIMEOUT_MS', 15_000);
        const fetchConcurrency = envNumber('FETCH_CONCURRENCY', 4);
        const id = nanoid();
        const job = {
            id,
            status: 'queued',
            message: '已创建任务，等待开始…',
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        jobs.set(id, job);
        res.json({ jobId: id });
        // Run async
        void (async () => {
            const update = (status, message, zip) => {
                const next = jobs.get(id);
                if (!next)
                    return;
                next.status = status;
                next.message = message;
                next.updatedAt = Date.now();
                if (zip)
                    next.zip = zip;
            };
            try {
                update('running', '开始生成…');
                const out = await runGeneratePipeline({
                    llm,
                    fetchTimeoutMs,
                    fetchConcurrency,
                    payload: { companyName, urls, pastedBlocks, uploadFiles },
                    onMessage: (m) => update('running', m)
                });
                const next = jobs.get(id);
                if (next) {
                    next.zip = out.zipBuffer;
                    next.sop = out.sopMarkdown;
                    next.sopPlan = out.sopPlan;
                    next.evalSuite = out.evalSuite;
                    next.files = out.contentFiles.map((f) => ({
                        path: f.path,
                        bytes: Buffer.byteLength(f.content, 'utf-8')
                    }));
                    next.fileContents = out.contentFiles.reduce((acc, f) => {
                        acc[f.path] = f.content;
                        return acc;
                    }, {});
                    next.status = 'done';
                    next.message = '已完成：请先按 SOP 执行并直接复制下方各平台文案（zip 仅作为备份）。';
                    next.updatedAt = Date.now();
                }
                else {
                    update('done', '已完成，可下载。', out.zipBuffer);
                }
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                update('error', msg);
            }
        })();
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'Bad request';
        res.status(400).send(msg);
    }
});
app.get('/api/jobs/:id', (req, res) => {
    const id = String(req.params.id);
    const job = jobs.get(id);
    if (!job) {
        res.status(404).json({ status: 'error', message: 'Job not found' });
        return;
    }
    res.json({
        status: job.status,
        message: job.message,
        hasZip: Boolean(job.zip),
        hasSop: Boolean(job.sop),
        files: job.files ?? []
    });
});
app.get('/api/jobs/:id/sop', (req, res) => {
    const id = String(req.params.id);
    const job = jobs.get(id);
    if (!job) {
        res.status(404).send('Job not found');
        return;
    }
    if (job.status !== 'done' || !job.sop) {
        res.status(409).send('Job not ready');
        return;
    }
    // Backward-compatible: keep returning plain text SOP.
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(job.sop);
});
app.get('/api/jobs/:id/sop_plan', (req, res) => {
    const id = String(req.params.id);
    const job = jobs.get(id);
    if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
    }
    if (job.status !== 'done' || !job.sopPlan) {
        res.status(409).json({ error: 'Job not ready' });
        return;
    }
    res.json(job.sopPlan);
});
app.get('/api/jobs/:id/eval', (req, res) => {
    const id = String(req.params.id);
    const job = jobs.get(id);
    if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
    }
    if (job.status !== 'done' || !job.evalSuite) {
        res.status(409).json({ error: 'Job not ready' });
        return;
    }
    res.json(job.evalSuite);
});
app.get('/api/jobs/:id/files', (req, res) => {
    const id = String(req.params.id);
    const job = jobs.get(id);
    if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
    }
    if (job.status !== 'done' || !job.files) {
        res.status(409).json({ error: 'Job not ready' });
        return;
    }
    res.json({ files: job.files });
});
app.get('/api/jobs/:id/file', (req, res) => {
    const id = String(req.params.id);
    const path = String(req.query.path ?? '');
    const job = jobs.get(id);
    if (!job) {
        res.status(404).send('Job not found');
        return;
    }
    if (job.status !== 'done' || !job.fileContents) {
        res.status(409).send('Job not ready');
        return;
    }
    const content = job.fileContents[path];
    if (typeof content !== 'string') {
        res.status(404).send('File not found');
        return;
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(content);
});
app.get('/api/jobs/:id/download', (req, res) => {
    const id = String(req.params.id);
    const job = jobs.get(id);
    if (!job) {
        res.status(404).send('Job not found');
        return;
    }
    if (job.status !== 'done' || !job.zip) {
        res.status(409).send('Job not ready');
        return;
    }
    const safeName = `geo_pack_${id}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.send(job.zip);
});
const port = envNumber('PORT', 3417);
const server = app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[geo-agent-web] listening on http://localhost:${port}`);
});
server.on('error', (err) => {
    const anyErr = err;
    if (anyErr?.code === 'EADDRINUSE') {
        // eslint-disable-next-line no-console
        console.error(`[geo-agent-web] Port ${port} is already in use. ` +
            `Stop the existing process or set PORT to another value in .env, then restart.`);
        process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.error('[geo-agent-web] Server error:', anyErr?.message ?? anyErr);
    process.exit(1);
});
