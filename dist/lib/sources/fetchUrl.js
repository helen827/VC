import * as cheerio from 'cheerio';
export async function fetchUrlAsText(input) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
        const res = await fetch(input.url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'geo-agent-web/0.1 (+local) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari'
            }
        });
        if (!res.ok) {
            throw new Error(`Fetch ${res.status}: ${res.statusText}`);
        }
        const contentType = res.headers.get('content-type') ?? '';
        if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
            const raw = await res.text();
            return { title: undefined, text: raw.trim() };
        }
        const html = await res.text();
        const $ = cheerio.load(html);
        const title = $('title').first().text().trim() || undefined;
        $('script, style, noscript, svg, canvas, iframe, nav, footer, header, form').remove();
        const root = $('main').first().length ? $('main').first() : $('article').first().length ? $('article').first() : $('body');
        const lines = [];
        root.find('h1,h2,h3,p,li,blockquote,pre,code').each((_, el) => {
            const tag = el.tagName?.toLowerCase() ?? '';
            const raw = $(el).text().replace(/\s+/g, ' ').trim();
            if (!raw)
                return;
            if (tag.startsWith('h')) {
                lines.push(`# ${raw}`);
            }
            else {
                lines.push(raw);
            }
        });
        const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
        return { title, text };
    }
    finally {
        clearTimeout(t);
    }
}
