import { createRequire } from 'node:module'
import JSZip from 'jszip'
import mammoth from 'mammoth'

const require = createRequire(import.meta.url)
const pdfParse = require('pdf-parse/lib/pdf-parse.js') as (buf: Buffer) => Promise<{ text: string }>

export type UploadKind = 'docx' | 'pdf' | 'pptx' | 'pages'

const ALLOWED_EXT = new Set(['docx', 'pdf', 'pptx', 'pages'])

export function isAllowedUploadFilename(name: string): boolean {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return ALLOWED_EXT.has(ext)
}

export function detectUploadKind(filename: string): UploadKind | null {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  if (ext === 'docx') return 'docx'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'pptx') return 'pptx'
  if (ext === 'pages') return 'pages'
  return null
}

export async function extractDocxText(buf: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: buf })
  return (value ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

async function extractPdfText(buf: Buffer): Promise<string> {
  const data = await pdfParse(buf)
  return (data.text ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

function extractATextFromSlideXml(xml: string): string {
  const parts: string[] = []
  const re = /<a:t[^>]*>([^<]*)<\/a:t>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) parts.push(m[1])
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

export async function extractPptxText(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf)
  const slidePaths = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a, b) => {
      const na = Number(/slide(\d+)\.xml$/i.exec(a)?.[1] ?? 0)
      const nb = Number(/slide(\d+)\.xml$/i.exec(b)?.[1] ?? 0)
      return na - nb
    })

  const chunks: string[] = []
  for (const path of slidePaths) {
    const f = zip.file(path)
    if (!f) continue
    const xml = await f.async('string')
    const t = extractATextFromSlideXml(xml)
    if (t) chunks.push(t)
  }

  const notePaths = Object.keys(zip.files)
    .filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(n))
    .sort((a, b) => {
      const na = Number(/notesSlide(\d+)\.xml$/i.exec(a)?.[1] ?? 0)
      const nb = Number(/notesSlide(\d+)\.xml$/i.exec(b)?.[1] ?? 0)
      return na - nb
    })
  for (const path of notePaths) {
    const f = zip.file(path)
    if (!f) continue
    const xml = await f.async('string')
    const t = extractATextFromSlideXml(xml)
    if (t) chunks.push(`[备注] ${t}`)
  }

  return chunks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

export async function extractPagesText(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf)
  const tryExact = ['QuickLook/Preview.pdf', 'preview.pdf', 'Preview.pdf']
  for (const p of tryExact) {
    const f = zip.file(p)
    if (f) {
      const inner = Buffer.from(await f.async('arraybuffer'))
      return extractPdfText(inner)
    }
  }
  const entries = Object.keys(zip.files).filter((k) => !zip.files[k].dir)
  for (const p of entries) {
    if (!p.toLowerCase().endsWith('.pdf')) continue
    const f = zip.file(p)
    if (!f) continue
    const inner = Buffer.from(await f.async('arraybuffer'))
    const t = await extractPdfText(inner)
    if (t.trim()) return t
  }
  throw new Error(
    '无法从 Pages 文件中提取文本（常见新格式不含预览 PDF）。请在 Pages 中「文件 → 导出为 → PDF」或「Word」后再上传。'
  )
}

export async function extractUploadText(filename: string, buf: Buffer): Promise<{ kind: UploadKind; text: string }> {
  const kind = detectUploadKind(filename)
  if (!kind) throw new Error(`不支持的文件类型：${filename}`)

  let text: string
  switch (kind) {
    case 'docx':
      text = await extractDocxText(buf)
      break
    case 'pdf':
      text = await extractPdfText(buf)
      break
    case 'pptx':
      text = await extractPptxText(buf)
      break
    case 'pages':
      text = await extractPagesText(buf)
      break
    default:
      throw new Error(`不支持的文件类型：${filename}`)
  }
  return { kind, text }
}
