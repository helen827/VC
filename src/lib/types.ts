export type SourceType = 'url' | 'paste' | 'docx'

export type Source = {
  id: string
  type: SourceType
  title?: string
  emphasized?: boolean
  sourceUrl?: string
  filename?: string
  extractedAt: string
  text: string
}

export type EntityProfile = {
  companyName: string
  aliases: string[]
  oneLiner: {
    value: string | null
    evidence: string[]
  }
  whatItDoes: {
    value: string | null
    evidence: string[]
  }
  targetUsers: {
    value: string | null
    evidence: string[]
  }
  keyUseCases: Array<{ title: string; detail: string; evidence: string[] }>
  differentiators: Array<{ title: string; detail: string; evidence: string[] }>
  claimsToAvoid: Array<{ claim: string; reason: string }>
  facts: Array<{ fact: string; evidence: string[] }>
}

export type GeneratedFile = {
  path: string
  content: string
}

export type EvalSuite = {
  questions: Array<{
    id: string
    category: 'recommendation' | 'compare' | 'howto' | 'supplier' | 'brand'
    query: string
    expected: string
  }>
  rubricMarkdown: string
  templateCsv: string
}

