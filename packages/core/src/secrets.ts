import type { ReviewOutput } from './findings'

export type SecretHit = { pattern: string; where: string }

// Narrow, prefixed, high-confidence patterns only. No generic "high entropy string" rule and no
// `password\s*=` rule: a review output legitimately quotes code and hashes, and a false positive
// does not warn, it refuses the whole review.
const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'github-token', re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/ },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'private-key', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
]

export const scanForSecrets = (text: string): SecretHit[] => {
  const hits: SecretHit[] = []
  const seen = new Set<string>()
  text.split('\n').forEach((line, idx) => {
    for (const p of PATTERNS) {
      if (!p.re.test(line)) continue
      const key = `${p.name}:${idx}`
      if (seen.has(key)) continue
      seen.add(key)
      hits.push({ pattern: p.name, where: `line ${idx + 1}` })
    }
  })
  return hits
}

export class SecretLeak extends Error {
  readonly hits: SecretHit[]
  constructor(hits: SecretHit[]) {
    // Names and locations only. Never the matched text.
    super(`review output withheld: ${hits.length} possible secret(s) — ` +
          hits.map((h) => `${h.pattern} at ${h.where}`).join('; '))
    this.name = 'SecretLeak'
    this.hits = hits
  }
}

const strings = (o: ReviewOutput): [string, string][] => {
  const out: [string, string][] = [
    ['summary', o.summary],
    ['intent.note', o.intent.note],
  ]
  o.findings.forEach((f, i) => {
    out.push([`findings[${i}].file`, f.file])
    out.push([`findings[${i}].title`, f.title])
    out.push([`findings[${i}].explanation`, f.explanation])
    if (f.suggestion !== null) out.push([`findings[${i}].suggestion`, f.suggestion])
    f.evidence.forEach((e, j) => out.push([`findings[${i}].evidence[${j}]`, e]))
  })
  o.inconclusive.forEach((c, i) => {
    out.push([`inconclusive[${i}].question`, c.question])
    out.push([`inconclusive[${i}].whatWouldSettleIt`, c.whatWouldSettleIt])
  })
  return out
}

export const assertNoSecrets = (o: ReviewOutput): void => {
  const hits = strings(o).flatMap(([path, text]) =>
    scanForSecrets(text).map((h) => ({ pattern: h.pattern, where: `${path}:${h.where}` })),
  )
  if (hits.length > 0) throw new SecretLeak(hits)
}
