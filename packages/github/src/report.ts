import type { CheckVerdict, Finding, ResolvedSettings } from '@review-agent/core'
import type { AnchorResult, AnchoredFinding } from './anchor'
import { findingId } from './marker'

/** All this module needs to know about the last review of this pull request: that there was one.
 *  Task 11's `MarkerRun` satisfies it structurally, so a caller passes one straight in. */
export type PreviousReview = { headSha: string }

export type PostingPlan = {
  inline: AnchoredFinding[]
  summaryOnly: Finding[]
  suppressed: Finding[]
}

type Candidate = { finding: Finding; anchor: AnchoredFinding | null }

/** The check pass's verdicts, with the findings they were passed — `CheckVerdict.index` addresses
 *  that array, so the two travel together or the indexes mean nothing. */
export type CheckedFindings = { findings: Finding[]; verdicts: CheckVerdict[] }

const RANK: Record<CheckVerdict['verdict'], number> = { refuted: 2, uncertain: 1, confirmed: 0 }

/** Verdicts by `findingId` — file, category and title — rather than by array position, because
 *  anchoring reorders and splits the reviewer's list and a position would then address the wrong
 *  finding. A verdict whose index is not a finding is dropped: a malformed verdict must not decide
 *  what is said about some other finding.
 *
 *  Two findings can share an id (the same title twice in one file). There is no way to tell which
 *  verdict belongs to which, so the collision resolves to the MORE CONSERVATIVE one — refuted over
 *  uncertain over confirmed, and the lower severity — which can only say less, never more. */
const verdictsById = (check: CheckedFindings | null): Map<string, CheckVerdict> => {
  const byId = new Map<string, CheckVerdict>()
  if (check === null) return byId
  for (const v of check.verdicts) {
    const finding = check.findings[v.index]
    if (finding === undefined) continue
    const id = findingId(finding)
    const seen = byId.get(id)
    if (seen === undefined) { byId.set(id, v); continue }
    byId.set(id, {
      ...seen,
      verdict: RANK[v.verdict] > RANK[seen.verdict] ? v.verdict : seen.verdict,
      severity: Math.min(seen.severity, v.severity) as CheckVerdict['severity'],
    })
  }
  return byId
}

/** The positions, in the array the check pass was given, of the findings it marked as repeating an
 *  earlier one (`CheckVerdict.duplicateOf`; a multi-reviewer review, spec 0.2.0 §8.3, decision
 *  §14.17). A duplicate is not said — like a refuted finding — and stays on the record.
 *
 *  By position rather than by `findingId`, unlike `verdictsById`: the verdict names the finding it is
 *  about by index, the caller drops these before anchoring reorders anything, and two findings that
 *  share an id — the same title twice in one file — are exactly the pair this must tell apart, keeping
 *  one and dropping the other. A `duplicateOf` that does not point at an earlier finding names nothing
 *  (`runCheckPass` already makes it null; this does not trust that it did), so a pair can never drop
 *  each other. Empty when no check pass ran, or when it was not asked about duplicates. */
export const duplicatesIn = (check: CheckedFindings | null): Set<number> => {
  const out = new Set<number>()
  for (const v of check?.verdicts ?? []) {
    const d = v.duplicateOf
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d >= v.index) continue
    if (v.index >= (check?.findings.length ?? 0)) continue
    out.add(v.index)
  }
  return out
}

// `atCheckSeverity` was here and is deleted (Criss, 2026-09-16). It existed for one caller: the
// marker's matcher paired an old row against a new finding by NEAREST SEVERITY, and the marker
// stores what was said, which carries the check pass's number — so handing the matcher the
// reviewer's raw pre-check severity compared a lowered number against an unlowered one, in the same
// direction, on every re-review. With matching gone there is nothing to correct the offset for.
// `verdictsById` below stays: `selectForPosting` and publishReview's confirmed set both read it.

/** Design §3.1 and §5: what this review says, and where. Anchoring decided what CAN be said; this
 *  decides what SHOULD be. */
export const selectForPosting = (a: {
  anchored: AnchorResult
  settings: ResolvedSettings
  previous: PreviousReview | null
  /** The disprove-it pass, when it ran (design §4.6). Criss, 2026-09-13: a **refuted** finding is
   *  never posted, and a confirmed or uncertain one is posted at the CHECK's severity rather than
   *  the reviewer's. The first trial is why: the reviewer rated a guess 5 and a fact the pull
   *  request itself disclosed 7, while the check said 3 for both, and nothing read those verdicts. */
  check?: CheckedFindings | null
}): PostingPlan => {
  const { anchored, settings } = a
  const { mode } = settings.report
  const verdictOf = verdictsById(a.check ?? null)

  // `silent` and `check-only` both post no comment at all. Whether a check run is created is the
  // difference between them, and that belongs to whoever posts (sub-project 2), not here.
  if (mode === 'silent' || mode === 'check-only') {
    return {
      inline: [],
      summaryOnly: [],
      suppressed: [...anchored.inline.map((x) => x.finding), ...anchored.summaryOnly],
    }
  }

  const inline: AnchoredFinding[] = []
  const summaryOnly: Finding[] = []
  // A refuted finding lands here: recorded, so a reader can see the pass rejected it, and said
  // nowhere. The list is filled while the candidates are built, below.
  const suppressed: Finding[] = []

  // Worst first, so `maxInline` is spent on the worst. Array.prototype.sort is stable, so equal
  // severities keep the order the reviewer returned them in, and an anchorable finding comes
  // before an unanchorable one of the same severity.
  //
  // The check's verdict is applied BEFORE the sort, so `maxInline` is spent on what the check
  // thinks is worst rather than on what the reviewer first claimed.
  const refuted: Finding[] = []
  const candidates: Candidate[] = [
    ...anchored.inline.map((x): Candidate => ({ finding: x.finding, anchor: x })),
    ...anchored.summaryOnly.map((f): Candidate => ({ finding: f, anchor: null })),
  ].flatMap((c): Candidate[] => {
    const v = verdictOf.get(findingId(c.finding))
    if (v === undefined) return [c]
    if (v.verdict === 'refuted') { refuted.push(c.finding); return [] }
    if (v.severity === c.finding.severity) return [c]
    const finding = { ...c.finding, severity: v.severity }
    return [{ finding, anchor: c.anchor === null ? null : { ...c.anchor, finding } }]
  }).sort((x, y) => y.finding.severity - x.finding.severity)

  // `firstReviewLowBandCap` is the most findings BELOW severity.bands.medium this review mentions
  // at all — three on a first review, none on a later one unless the deployment repeats nits.
  // Spent before the inline decision, so it caps how many are mentioned, not where they appear.
  const lowBandBelow = settings.severity.bands.medium
  let lowBandLeft =
    a.previous === null || settings.report.repeatNits ? settings.report.firstReviewLowBandCap : 0

  for (const c of candidates) {
    if (c.finding.severity < lowBandBelow) {
      if (lowBandLeft === 0) { suppressed.push(c.finding); continue }
      lowBandLeft -= 1
    }
    if (
      mode === 'inline+summary' &&
      c.anchor !== null &&
      c.finding.severity >= settings.severity.postInlineAtOrAbove &&
      inline.length < settings.report.maxInline
    ) {
      inline.push(c.anchor)
      continue
    }
    summaryOnly.push(c.finding)
  }

  return { inline, summaryOnly, suppressed: [...refuted, ...suppressed] }
}
