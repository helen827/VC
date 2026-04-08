import mammoth from 'mammoth'

export async function extractDocxText(buf: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: buf })
  return (value ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

