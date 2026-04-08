import JSZip from 'jszip'
import type { EntityProfile, EvalSuite, GeneratedFile, Source } from '../types.js'

export async function buildExportZip(input: {
  companyName: string
  generatedAt: string
  llm: { baseUrl: string; model: string }
  sources: Source[]
  profile: EntityProfile
  contentFiles: GeneratedFile[]
  evalSuite: EvalSuite
}): Promise<Buffer> {
  const zip = new JSZip()

  zip.file(
    'manifest.json',
    JSON.stringify(
      {
        companyName: input.companyName,
        generatedAt: input.generatedAt,
        llm: input.llm,
        inputs: {
          sourcesCount: input.sources.length,
          byType: input.sources.reduce<Record<string, number>>((acc, s) => {
            acc[s.type] = (acc[s.type] ?? 0) + 1
            return acc
          }, {})
        }
      },
      null,
      2
    )
  )

  zip.file('sources/sources.json', JSON.stringify(input.sources, null, 2))
  for (const s of input.sources) {
    zip.file(`sources/${s.id}.txt`, s.text)
  }

  zip.file('profile/entity_profile.json', JSON.stringify(input.profile, null, 2))

  for (const f of input.contentFiles) {
    zip.file(f.path, f.content)
  }

  zip.file('eval/questions.json', JSON.stringify(input.evalSuite.questions, null, 2))
  zip.file('eval/rubric.md', input.evalSuite.rubricMarkdown)
  zip.file('eval/template.csv', input.evalSuite.templateCsv)

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return buf
}

