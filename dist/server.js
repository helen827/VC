import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { PastedBlocksSchema, runGeneratePipeline } from './lib/pipeline/run.js';
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
        const ok = file.mimetype ===
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
            file.originalname.toLowerCase().endsWith('.docx');
        if (ok)
            return cb(null, true);
        return cb(new Error('Only .docx is supported'));
    }
});
const CreateJobSchema = z.object({
    companyName: z.string().min(1).max(80),
    urls: z.string().optional(),
    pastedBlocksJson: z.string().optional()
});
app.use('/api', requireAccessToken);
app.post('/api/jobs', upload.array('docxFiles', 10), async (req, res) => {
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
        const docxFiles = (req.files ?? []).map((f) => ({
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
                    payload: { companyName, urls, pastedBlocks, docxFiles },
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
