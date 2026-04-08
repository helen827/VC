export function extractFirstJsonObject(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return null;
    // Try fenced ```json blocks first
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenceMatch?.[1]) {
        const candidate = fenceMatch[1].trim();
        if (candidate.startsWith('{') && candidate.endsWith('}'))
            return candidate;
    }
    const start = trimmed.indexOf('{');
    if (start === -1)
        return null;
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (ch === '{')
            depth++;
        else if (ch === '}')
            depth--;
        if (depth === 0) {
            const candidate = trimmed.slice(start, i + 1).trim();
            return candidate;
        }
    }
    return null;
}
export function safeJsonParse(text) {
    const candidate = extractFirstJsonObject(text);
    if (!candidate)
        return null;
    try {
        return JSON.parse(candidate);
    }
    catch {
        return null;
    }
}
