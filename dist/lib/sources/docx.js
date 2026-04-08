import mammoth from 'mammoth';
export async function extractDocxText(buf) {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return (value ?? '').replace(/\n{3,}/g, '\n\n').trim();
}
