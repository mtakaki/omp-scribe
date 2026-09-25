/**
 * Literal-fidelity gate — the pure text engine that stops the cheap writer
 * model from paraphrasing load-bearing literals out of a delegated draft.
 *
 * The brain model submits a blueprint whose `intent`, `preserve`, `doNot`,
 * `files`, `verification`, and `assumptions` strings carry the exact
 * identifiers, paths, commands, expressions, and constants the plan depends
 * on.  The writer model renders those into prose, and a rendering model will
 * silently reword ``db.artwork.count({ where })`` into "the artwork count
 * call" or drop a backtick.  Without a check the brain has to re-read the plan
 * file and issue a `propose_plan_update` to restore the detail, which costs
 * more than the draft itself saved.
 *
 * This module extracts those literals from the brief input, reports which ones
 * a draft lost (and which sections the draft never emitted at all), and
 * renders the brief that asks the writer to re-emit a section with the missing
 * strings restored verbatim.  It reads no files, spawns no sessions, tracks no
 * fence state (the caller supplies plain section text), and imports no host
 * API — the writer session (`src/writer-session.ts`) owns all of that.
 */
import { planHeadingKey, type PlanSection } from "./plan-sections";

/** One plan section the gate verifies: the heading the draft must carry it
 *  under, plus every literal from the brief input that supplies it. */
export interface FidelityTarget {
  heading: string;
  literals: readonly string[];
}

/** A {@link FidelityTarget} plus the brief text it was built from, so the
 *  repair brief can hand the writer the same input the section was originally
 *  written from. */
export interface RepairTarget extends FidelityTarget {
  supplied: string;
}

/** One section the draft emitted but left incomplete: the heading, plus the
 *  literals its text should carry and does not. */
export interface FidelityGap {
  heading: string;
  missing: string[];
}

/** The gate's verdict on one draft.
 *
 *  `missing` is empty when every literal that could be checked survived.
 *  `missingSections` names the target sections the draft never emitted: a
 *  section the writer skipped is reported rather than repaired, because the
 *  existing update path already rejects an unrendered requested heading.
 *  `repaired` records that the gate spent at least one repair round on the
 *  draft, whether or not that round closed every gap. */
export interface FidelityReport {
  /** Distinct literals actually compared against a section the draft carries. */
  checked: number;
  repaired: boolean;
  /** Literals the checked sections do not contain, de-duplicated, in target order. */
  missing: string[];
  /** Target headings absent from the draft, in target order. */
  missingSections: string[];
  /** Per-section gaps, in target order. */
  gaps: FidelityGap[];
}

export const PLAN_FIDELITY_REPAIR_SYSTEM_PROMPT = `You re-emit plan-document sections so that every load-bearing literal the brief supplies survives verbatim. You receive one plain-text brief as the user message and must respond with ONLY the rewritten sections: for every heading the brief lists under SECTIONS TO RE-EMIT, its "## <heading>" line spelled exactly as the brief spells it, followed by that section's new body. No "# " title, no preamble, no code fences, no commentary, and never a section the brief does not request.

The brief is labelled plain text:
SECTIONS TO RE-EMIT - the headings to emit, in the order to emit them.
Then one block per section:
    MISSING LITERALS - the exact strings the draft lost, one backticked bullet each.
    CURRENT - that section's present Markdown, or "(missing)" when the plan has no such section yet.
    SUPPLIED CONTENT - the brief the section was originally written from.

Rules:
1. Start from the CURRENT text and keep every sentence it already states.
2. Fold every string listed under MISSING LITERALS back into the CURRENT sentence that discusses it, spelled character-for-character as the brief spells it and kept in backticks: never reword, abbreviate, reformat, re-case, or summarize one.
3. Never emit a bullet, list item, or line that consists only of the missing strings: each one belongs inside the sentence that states its role, never appended after the section's prose.
4. When a missing string belongs to no sentence CURRENT states, return CURRENT unchanged rather than inventing a place for it.
5. When CURRENT is "(missing)", author the section from its SUPPLIED CONTENT alone.
6. Change nothing else. Do not add, drop, reorder, compress, or condense any other sentence, claim, path, identifier, command, or constant, and never summarize the section.
7. Do not invent files, implementation details, APIs, dependencies, or behavior the supplied content does not state.
8. Do not restate, summarize, or reference any section the brief does not request.

You are a renderer, not a planner.`;

/** Shortest candidate kept: a two-character fragment is a symbol, not a
 *  load-bearing literal, and demanding it verbatim only invites noise. */
const MIN_LITERAL_LENGTH = 3;

/** Longest candidate kept.  A longer span is a sentence or a code block that
 *  the writer legitimately re-wraps, not a literal it must reproduce. */
const MAX_LITERAL_LENGTH = 96;

/** A Markdown list marker — `- `, `* `, `+ `, `1. `, `2) ` — with whatever
 *  indentation or block quote precedes it.  A literal-only line usually opens
 *  with one. */
const LINE_MARKER_RE = /^[\s>]*(?:[-*+]|\d+[.)])\s*/;

/** `` `code` `` spans, erased when a line is judged for being nothing but
 *  literals. */
const BACKTICK_SPAN_RE = /`[^`\n]*`/g;

/** What may survive between two literal spans on a literal-only line: the
 *  whitespace and separators a list of literals is written with. */
const SEPARATOR_RE = /[\s,;:—–|]/g;

/** A candidate a split left dangling: one that opens with a closing separator
 *  (`)`, `]`, `}`, `;`) or a comma, or that ends with an opening one (`(`,
 *  `[`, `{`) or a comma.  `=` and `.` are deliberately absent — a URL query
 *  ending in `=` and a `./relative` path are both real literals. */
const FRAGMENT_EDGE_RE = /[([{,]$|^[,)\]};]/;

/** A span that is exactly one quoted string, so the literal is the text inside
 *  its quotes. */
const QUOTED_SPAN_RE = /^(["'])(.+)\1$/;

/** `` `code` `` — an explicitly marked span.  Inner single spaces are allowed:
 *  a backticked command or expression (`` `bun test tests/auth.test.ts` ``)
 *  commonly carries them. */
const BACKTICKED_RE = /`([^`\n]+)`/g;

/** `"quoted"` — kept only when the span carries no whitespace at all, so a
 *  quoted sentence stays prose.  The lookarounds keep a quotation mark inside
 *  a word (or a doubled quote) from opening a span. */
const DOUBLE_QUOTED_RE = /(?<![\w"])"([^"\s]{2,80})"(?![\w"])/g;

/** `'quoted'` — same whitespace rule.  The lookbehind is what rejects the
 *  apostrophe in `the writer's output`. */
const SINGLE_QUOTED_RE = /(?<![\w'])'([^'\s]{2,80})'(?![\w'])/g;

/** `SCREAMING_SNAKE_CASE` — a named constant, at least one underscore. */
const CONSTANT_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

/** `local://<name>` — a resource reference the plan names. */
const LOCAL_REF_RE = /local:\/\/[A-Za-z0-9._/-]+/g;

/** `${...}` — a template fragment. */
const TEMPLATE_RE = /\$\{[^}\n]{1,64}\}/g;

/** A dotted call: `db.artwork.count({ where })`. */
const DOTTED_CALL_RE = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[ \t]*\([^()\n]*\)/g;

/** A project-relative path with an extension: `backend/src/routes/public.ts`. */
const PATH_RE = /\b[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+\.[A-Za-z][A-Za-z0-9]*\b/g;

interface Candidate {
  /** Offset in the source string; candidates are kept in the order they read. */
  index: number;
  value: string;
}

/** Every match of one pattern, with its offset and captured group.  `templates`
 *  is not used: the patterns are literal, so the capture group is fixed. */
function matches(pattern: RegExp, text: string, group: number): Candidate[] {
  const found: Candidate[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = match[group];
    if (value !== undefined) found.push({ index: match.index, value });
  }
  return found;
}

/** Whether a raw candidate is the shape of a literal rather than a fragment of
 *  prose: long enough to matter, short enough to be a literal, not a bare
 *  number, on one line, and free of double spaces (which only appear when the
 *  "literal" is really a sentence). */
function isLiteralShaped(raw: string): boolean {
  const value = raw.trim();
  if (value.length < MIN_LITERAL_LENGTH || value.length > MAX_LITERAL_LENGTH) return false;
  if (/^\d+$/.test(value)) return false;
  if (FRAGMENT_EDGE_RE.test(value)) return false;
  if (/[\t\r\n]/.test(value)) return false;
  return !value.includes("  ");
}

/** Whether one line is nothing but literals: it carries a backtick and, once
 *  its list marker, its backticked spans, and the separators between them are
 *  erased, nothing is left.  Deliberately line-based and fence-blind: the
 *  caller hands it plain section text. */
function isDumpLine(line: string): boolean {
  if (!line.includes("`")) return false;
  return line.replace(LINE_MARKER_RE, "").replace(BACKTICK_SPAN_RE, "").replace(SEPARATOR_RE, "") === "";
}

/** The literal-only lines of `text`.  A line whose whole content is the
 *  literals it lists satisfies a literal check without stating anything about
 *  them, so the gate strips such lines from a draft before judging it and
 *  refuses a repair response that answers with one. */
export function literalDumpLines(text: string): string[] {
  return text.split("\n").filter(isDumpLine);
}

/** `text` with every literal-only line dropped and every other byte left
 *  exactly as it was. */
export function removeLiteralDumpLines(text: string): string {
  return text
    .split("\n")
    .filter(line => !isDumpLine(line))
    .join("\n");
}

/**
 * Whitespace-insensitive match key: runs of whitespace collapse to one space
 * and the ends are trimmed, so a literal the writer re-wrapped across lines —
 * or one the brief itself wrapped — still matches.
 */
export function normalizeForMatch(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * Every load-bearing literal in `text`, in the order it reads, de-duplicated.
 *
 * Candidates are collected by pattern — backticked spans, quoted spans,
 * SCREAMING_SNAKE constants, `local://` references, template fragments, dotted
 * calls, and project-relative paths — then filtered by {@link isLiteralShaped}
 * and reduced: a candidate a literal kept earlier already contains is dropped,
 * so `` `${dir}${base}.webp` `` yields the whole backticked template rather
 * than three stray `${...}` fragments as well.  A backticked span that is one
 * quoted string yields its inner text; a span a nested backtick splits, or one
 * {@link isLiteralShaped} rejects as a fragment edge, is not kept.
 *
 * The extractor is deliberately conservative.  A literal it misses is simply
 * not verified, which costs one lost guarantee; a false positive costs a
 * repair call.  Prose is therefore never mined for meaning: quotes only count
 * when they carry no whitespace, and plain sentences produce nothing.
 */
export function extractLiterals(text: string | undefined): string[] {
  if (text === undefined || text === "") return [];

  const candidates = [
    ...matches(BACKTICKED_RE, text, 1).map(candidate => ({
      index: candidate.index,
      value: candidate.value.replace(QUOTED_SPAN_RE, "$2"),
    })),
    ...matches(DOUBLE_QUOTED_RE, text, 1),
    ...matches(SINGLE_QUOTED_RE, text, 1),
    ...matches(CONSTANT_RE, text, 0),
    ...matches(LOCAL_REF_RE, text, 0),
    ...matches(TEMPLATE_RE, text, 0),
    ...matches(DOTTED_CALL_RE, text, 0),
    ...matches(PATH_RE, text, 0),
  ]
    .filter(candidate => isLiteralShaped(candidate.value))
    .sort((a, b) => a.index - b.index);

  const kept: string[] = [];
  const keys: string[] = [];
  for (const candidate of candidates) {
    const value = candidate.value.trim();
    const key = normalizeForMatch(value);
    if (keys.some(existing => existing.includes(key))) continue;
    kept.push(value);
    keys.push(key);
  }
  return kept;
}

/**
 * The literals in `literals` that `text` does not contain, under
 * {@link normalizeForMatch}.  `undefined` — no section to check — reports every
 * literal as missing; callers that mean "the draft does not carry this section
 * at all" report it through `missingSections` instead.
 */
export function findMissingLiterals(text: string | undefined, literals: readonly string[]): string[] {
  if (text === undefined) return [...literals];
  const haystack = normalizeForMatch(text);
  return literals.filter(literal => !haystack.includes(normalizeForMatch(literal)));
}

/**
 * Compares every target's literals against the matching section of `current`.
 *
 * A target heading the draft does not carry contributes to `missingSections`
 * only: nothing can be compared, and the draft should be told about the
 * omission rather than repaired into carrying a section the caller never
 * asked for.  `checked` counts each literal that was actually compared, so a
 * report with `missing` empty means every compared literal survived.
 */
export function checkFidelity(
  targets: readonly FidelityTarget[],
  current: readonly PlanSection[],
): FidelityReport {
  const textByKey = new Map(current.map(section => [planHeadingKey(section.heading), section.text]));
  const gaps: FidelityGap[] = [];
  const missingSections: string[] = [];
  const checked = new Set<string>();

  for (const target of targets) {
    const text = textByKey.get(planHeadingKey(target.heading));
    if (text === undefined) {
      missingSections.push(target.heading);
      continue;
    }
    for (const literal of target.literals) checked.add(literal);
    const missing = findMissingLiterals(text, target.literals);
    if (missing.length > 0) gaps.push({ heading: target.heading, missing });
  }

  const missing: string[] = [];
  const seen = new Set<string>();
  for (const gap of gaps) {
    for (const literal of gap.missing) {
      const key = normalizeForMatch(literal);
      if (seen.has(key)) continue;
      seen.add(key);
      missing.push(literal);
    }
  }

  return { checked: checked.size, repaired: false, missing, missingSections, gaps };
}

/**
 * The repair brief: the sections to re-emit, and per section the exact strings
 * that went missing, the section's present text (or `(missing)`), and the brief
 * input it was written from.  Only the gapped sections appear — a heading the
 * writer was not asked to touch is never mentioned, so nothing invites it to
 * rewrite one.
 */
export function buildRepairPromptText(
  gaps: readonly FidelityGap[],
  targets: readonly RepairTarget[],
  current: readonly PlanSection[],
): string {
  const suppliedByKey = new Map(targets.map(target => [planHeadingKey(target.heading), target.supplied]));
  const textByKey = new Map(current.map(section => [planHeadingKey(section.heading), section.text]));

  const lines: string[] = [
    'SECTIONS TO RE-EMIT (emit exactly these, in this order, each starting with its "## <heading>" line)',
  ];
  gaps.forEach((gap, index) => lines.push(`${index + 1}. ${gap.heading}`));

  gaps.forEach((gap, index) => {
    lines.push("", `=== SECTION ${index + 1}: ${gap.heading} ===`, "MISSING LITERALS");
    lines.push(...(gap.missing.length === 0 ? ["- (none)"] : gap.missing.map(literal => `- \`${literal}\``)));
    lines.push("CURRENT");
    const text = textByKey.get(planHeadingKey(gap.heading));
    lines.push(text === undefined ? "(missing)" : text.trimEnd());
    lines.push("SUPPLIED CONTENT");
    lines.push((suppliedByKey.get(planHeadingKey(gap.heading)) ?? "(none)").trimEnd());
  });

  return `${lines.join("\n").trimEnd()}\n`;
}
