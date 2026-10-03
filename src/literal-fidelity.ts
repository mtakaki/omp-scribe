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
 * strings restored verbatim.
 *
 * It also owns the literal table: the `[[id]]` marker grammar, the validation
 * of a planner-declared table, and the deterministic substitution that replaces
 * each marker with the exact value the table declares — so the common case
 * spends no repair session at all, and the extraction-and-repair path above
 * survives only as the fallback for literals the planner never declared.
 *
 * It reads no files, spawns no sessions, tracks no fence state (the caller
 * supplies plain section text), and imports no host API — the writer session
 * (`src/writer-session.ts`) owns all of that.
 */
import { planHeadingKey, type PlanSection } from "./plan-sections";
import type { ScribeLiteral } from "./types";

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

/** What one draft's literal handling cost: how many `[[id]]` markers the gate
 *  substituted deterministically, the marker bodies no table entry declared,
 *  and the repair sessions spent on the literals no table entry covered. */
export interface LiteralRunMetrics {
  /** Markers replaced with their declared value, counted per occurrence. */
  resolved: number;
  /** Marker bodies no declared id matched, de-duplicated, in reading order. */
  unresolved: string[];
  /** LLM repair rounds the gate ran for this draft. */
  repairRounds: number;
  repairInputTokens: number;
  repairOutputTokens: number;
}

/** The result of substituting a document's `[[id]]` markers: the rewritten
 *  text, how many markers resolved, and the bodies that stayed unresolved. */
export interface PlaceholderResolution {
  markdown: string;
  /** Markers replaced, counted per occurrence. */
  resolved: number;
  /** Marker bodies no declared id matched, de-duplicated, in reading order. */
  unresolved: string[];
}

export const PLAN_FIDELITY_REPAIR_SYSTEM_PROMPT = `You re-emit plan-document sections so that every load-bearing literal the brief supplies survives verbatim. You receive one plain-text brief as the user message and must respond with ONLY the rewritten sections: for every heading the brief lists under SECTIONS TO RE-EMIT, its "## <heading>" line spelled exactly as the brief spells it, followed by that section's new body. No "# " title, no preamble, no code fences, no commentary, and never a section the brief does not request.

The brief is labelled plain text:
LITERALS - optional; when present, each line is \`[[<id>]] = <json value>\`, the exact strings the \`[[<id>]]\` markers stand for.
SECTIONS TO RE-EMIT - the headings to emit, in the order to emit them.
Then one block per section:
    MISSING LITERALS - the exact strings the draft lost; a declared one prints as \`- [[<id>]] = <json value>\`, an undeclared one as a backticked bullet.
    CURRENT - that section's present Markdown, or "(missing)" when the plan has no such section yet.
    SUPPLIED CONTENT - the brief the section was originally written from.

Rules:
1. Start from the CURRENT text and keep every sentence it already states.
2. Restore every string listed under MISSING LITERALS inside the CURRENT sentence that discusses it: a declared one by re-emitting its \`[[<id>]]\` marker exactly where its value belongs, an undeclared one by spelling the value character-for-character in backticks. Never reword, abbreviate, reformat, re-case, or summarize one, and never type the value a declared marker stands for.
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

/** Longest literal-table value kept: a declared literal is an exact string,
 *  not a document, so a legitimate code block or doc paragraph fits with wide
 *  margin while a whole-document dump still trips the bound. */
export const MAX_LITERAL_VALUE_LENGTH = 8000;

/** The id grammar a literal-table entry may use: a letter, then up to 31
 *  letters, digits, underscores, or hyphens. */
export const LITERAL_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/** A `[[` … `]]` marker span: a body of 0 to 64 characters other than `[`, `]`,
 *  or a newline.  Global, for scanning and substitution. */
const ANY_MARKER_RE = /\[\[([^\[\]\n]{0,64})\]\]/g;

/** The same span without the `g` flag: `.test()` on a global regex is
 *  stateful, so every shape check uses this one. */
const ANY_MARKER_TEST_RE = /\[\[[^\[\]\n]{0,64}\]\]/;

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
  if (ANY_MARKER_TEST_RE.test(value)) return false;
  if (value.length < MIN_LITERAL_LENGTH || value.length > MAX_LITERAL_LENGTH) return false;
  if (/^\d+$/.test(value)) return false;
  if (FRAGMENT_EDGE_RE.test(value)) return false;
  if (/[\t\r\n]/.test(value)) return false;
  return !value.includes("  ");
}

/** Whether one line is nothing but literals: it carries a backtick or a
 *  `[[id]]` marker and, once its list marker, its backticked spans, its marker
 *  spans, and the separators between them are erased, nothing is left.
 *  Deliberately line-based and fence-blind: the caller hands it plain section
 *  text. */
function isDumpLine(line: string): boolean {
  if (!line.includes("`") && !ANY_MARKER_TEST_RE.test(line)) return false;
  return (
    line
      .replace(LINE_MARKER_RE, "")
      .replace(BACKTICK_SPAN_RE, "")
      .replace(ANY_MARKER_RE, "")
      .replace(SEPARATOR_RE, "") === ""
  );
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

// ─── Literal table ────────────────────────────────────────────────────────────

/**
 * Merge any number of literal lists into one, in reading order: a value whose
 * {@link normalizeForMatch} key an earlier kept value already contains is
 * dropped, so the whole of a `` `${dir}${base}.webp` `` template wins over the
 * `${...}` fragments it contains.
 */
export function mergeLiterals(...lists: readonly (readonly string[])[]): string[] {
  const kept: string[] = [];
  const keys: string[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const value = raw.trim();
      const key = normalizeForMatch(value);
      if (key === "" || keys.some(existing => existing.includes(key))) continue;
      kept.push(value);
      keys.push(key);
    }
  }
  return kept;
}

/** The trimmed `[[...]]` marker bodies in `text`, in reading order and
 *  de-duplicated under {@link String.prototype.toLowerCase}.  An empty body —
 *  `[[]]` — is not an id, so it is not returned. */
export function literalMarkers(text: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const match of text.matchAll(ANY_MARKER_RE)) {
    const id = (match[1] ?? "").trim();
    if (id === "") continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(id);
  }
  return ids;
}

/** The `value` of every declared literal whose `id` appears as a `[[id]]`
 *  marker in `text`, in table order.  Ids match case-insensitively. */
export function referencedLiterals(text: string, literals: readonly ScribeLiteral[] | undefined): string[] {
  if (literals === undefined || literals.length === 0) return [];
  const referenced = new Set(literalMarkers(text).map(id => id.toLowerCase()));
  return literals.filter(([id]) => referenced.has(id.toLowerCase())).map(([, value]) => value);
}

/** The brief's `LITERALS` block: a header line, then one `[[<id>]] = <json
 *  value>` line per declared literal, then a blank line.  An empty table yields
 *  no lines, so a caller can splice the block in unconditionally. */
export function formatLiteralTable(literals: readonly ScribeLiteral[] | undefined): string[] {
  if (literals === undefined || literals.length === 0) return [];
  return [
    "LITERALS (each marker below must appear in your response exactly where its value belongs; Scribe substitutes the exact value afterwards — never type the value yourself)",
    ...literals.map(([id, value]) => `[[${id}]] = ${JSON.stringify(value)}`),
    "",
  ];
}

/**
 * Replace every `[[id]]` marker whose body is a declared id with that literal's
 * exact value.  An unknown or malformed span is left byte-identical and its
 * trimmed body recorded once in `unresolved`.  Substitution is a single pass
 * over the input text with a function callback, so a value that itself contains
 * marker syntax is never substituted a second time.
 */
export function resolveLiteralPlaceholders(
  text: string,
  literals: readonly ScribeLiteral[] | undefined,
): PlaceholderResolution {
  const byId = new Map<string, string>();
  for (const [id, value] of literals ?? []) {
    const key = id.toLowerCase();
    if (!byId.has(key)) byId.set(key, value);
  }

  const unresolved: string[] = [];
  const seenUnresolved = new Set<string>();
  let resolved = 0;
  const markdown = text.replace(ANY_MARKER_RE, (span: string, body: string) => {
    const trimmed = body.trim();
    const value = byId.get(trimmed.toLowerCase());
    if (value === undefined) {
      if (!seenUnresolved.has(trimmed)) {
        seenUnresolved.add(trimmed);
        unresolved.push(trimmed);
      }
      return span;
    }
    resolved += 1;
    return value;
  });

  return { markdown, resolved, unresolved };
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

  return mergeLiterals(candidates.map(candidate => candidate.value));
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

  return { checked: checked.size, repaired: false, missing: gapLiterals(gaps), missingSections, gaps };
}

/**
 * The literals of `gaps`, in reading order, de-duplicated under
 * {@link normalizeForMatch} so two gaps naming the same literal report it once.
 */
export function gapLiterals(gaps: readonly FidelityGap[]): string[] {
  const literals: string[] = [];
  const seen = new Set<string>();
  for (const gap of gaps) {
    for (const literal of gap.missing) {
      const key = normalizeForMatch(literal);
      if (seen.has(key)) continue;
      seen.add(key);
      literals.push(literal);
    }
  }
  return literals;
}

/**
 * `report` narrowed to the gaps whose literals `sections` does not carry
 * anywhere: a literal that survives in another section — or in the same one
 * under a different wrapping — was never lost, so reporting it as missing would
 * be untrue and re-emitting it in a flagged section would buy nothing.
 * `checked` and `missingSections` pass through unchanged.
 */
export function absentGaps(report: FidelityReport, sections: readonly PlanSection[]): FidelityGap[] {
  const haystack = normalizeForMatch(sections.map(section => section.text).join("\n"));
  return report.gaps
    .map(gap => ({
      heading: gap.heading,
      missing: gap.missing.filter(literal => !haystack.includes(normalizeForMatch(literal))),
    }))
    .filter(gap => gap.missing.length > 0);
}

/**
 * The repair brief: the literal table (when one was declared), the sections to
 * re-emit, and per section the exact strings that went missing — a declared one
 * printed as its `[[<id>]]` marker and JSON value, an undeclared one backticked
 * — the section's present text (or `(missing)`), and the brief input it was
 * written from.  Only the gapped sections appear — a heading the writer was not
 * asked to touch is never mentioned, so nothing invites it to rewrite one.
 */
export function buildRepairPromptText(
  gaps: readonly FidelityGap[],
  targets: readonly RepairTarget[],
  current: readonly PlanSection[],
  literals: readonly ScribeLiteral[] | undefined,
): string {
  const suppliedByKey = new Map(targets.map(target => [planHeadingKey(target.heading), target.supplied]));
  const textByKey = new Map(current.map(section => [planHeadingKey(section.heading), section.text]));
  const declaredByValue = new Map((literals ?? []).map(([id, value]) => [normalizeForMatch(value), { id, value }]));

  const lines: string[] = [
    ...formatLiteralTable(literals),
    'SECTIONS TO RE-EMIT (emit exactly these, in this order, each starting with its "## <heading>" line)',
  ];
  gaps.forEach((gap, index) => lines.push(`${index + 1}. ${gap.heading}`));

  gaps.forEach((gap, index) => {
    lines.push("", `=== SECTION ${index + 1}: ${gap.heading} ===`, "MISSING LITERALS");
    lines.push(
      ...(gap.missing.length === 0
        ? ["- (none)"]
        : gap.missing.map(literal => {
            const declared = declaredByValue.get(normalizeForMatch(literal));
            return declared === undefined
              ? `- \`${literal}\``
              : `- [[${declared.id}]] = ${JSON.stringify(declared.value)}`;
          })),
    );
    lines.push("CURRENT");
    const text = textByKey.get(planHeadingKey(gap.heading));
    lines.push(text === undefined ? "(missing)" : text.trimEnd());
    lines.push("SUPPLIED CONTENT");
    lines.push((suppliedByKey.get(planHeadingKey(gap.heading)) ?? "(none)").trimEnd());
  });

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Validate a planner-declared literal table.  A no-op for an absent table; a
 * malformed entry, an id outside {@link LITERAL_ID_RE}, two ids colliding under
 * case folding, and a blank value each throw with the offending index, id, and
 * value.  Every value longer than {@link MAX_LITERAL_VALUE_LENGTH} is collected
 * and reported in a single throw with its actual character count.  The gate
 * cannot substitute a marker a broken table declares, so this runs before any
 * draft is written.
 */
export function validateLiteralTable(literals: unknown): void {
  if (literals === undefined) return;
  if (!Array.isArray(literals)) throw new Error("literals: must be an array of [id, value] tuples.");

  const seen = new Set<string>();
  const oversized: Array<{ index: number; id: string; length: number }> = [];
  literals.forEach((entry: unknown, index: number) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error(`literals[${index}]: must be a 2-element [id, value] tuple.`);
    }
    const [id, value] = entry as [unknown, unknown];
    if (typeof id !== "string" || !LITERAL_ID_RE.test(id)) {
      throw new Error(
        `literals[${index}]: id must match [A-Za-z][A-Za-z0-9_-]{0,31} (1-32 characters), got ${JSON.stringify(id)}.`,
      );
    }
    const key = id.toLowerCase();
    if (seen.has(key)) throw new Error(`literals[${index}]: duplicate literal id ${JSON.stringify(id)}.`);
    seen.add(key);
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`literals[${index}] (id ${JSON.stringify(id)}): value must be a non-empty string.`);
    }
    if (value.length > MAX_LITERAL_VALUE_LENGTH) {
      oversized.push({ index, id, length: value.length });
    }
  });

  if (oversized.length > 0) {
    throw new Error(
      oversized
        .map(
          ({ index, id, length }) =>
            `literals[${index}] (id ${JSON.stringify(id)}): value is ${length} characters, exceeding the ${MAX_LITERAL_VALUE_LENGTH}-character bound.`,
        )
        .join(" "),
    );
  }
}

/**
 * Validate the planner's use of `[[id]]` markers against the declared table, in
 * both directions: every marker in `texts` must name a declared id — a marker
 * no entry owns can never be substituted, so it would ship into the plan as
 * literal `[[id]]` text — and every declared id must be named by a marker.
 * Ids compare under case folding, matching {@link resolveLiteralPlaceholders},
 * and the marker scan runs even when no table was declared.  A no-op only when
 * there is no marker and no id to check.
 */
export function validateLiteralUsage(literals: unknown, texts: readonly string[]): void {
  const table = Array.isArray(literals) ? literals : [];
  const declared = new Set<string>();
  for (const entry of table) {
    if (Array.isArray(entry) && typeof entry[0] === "string") declared.add(entry[0].toLowerCase());
  }

  const markers: string[] = [];
  const seenMarkers = new Set<string>();
  for (const text of texts) {
    for (const id of literalMarkers(text)) {
      const key = id.toLowerCase();
      if (seenMarkers.has(key)) continue;
      seenMarkers.add(key);
      markers.push(id);
    }
  }

  const undeclared = markers.filter(id => !declared.has(id.toLowerCase()));
  if (undeclared.length > 0) {
    const names = undeclared.map(id => `[[${id}]]`).join(", ");
    throw new Error(
      `literals: the blueprint's prose uses ${names} but no literal declares ${undeclared.length === 1 ? "it" : "them"}; declare each id with the exact value it stands for, or drop the marker.`,
    );
  }

  const unreferenced = table
    .filter((entry: unknown): entry is [string, unknown] => Array.isArray(entry) && typeof entry[0] === "string")
    .map(([id]) => id)
    .filter(id => !seenMarkers.has(id.toLowerCase()));

  if (unreferenced.length > 0) {
    throw new Error(
      `literals: ${unreferenced.map(id => JSON.stringify(id)).join(", ")} declared but never referenced as [[<id>]] in the blueprint's prose; reference each one where its value belongs, or drop it.`,
    );
  }
}
