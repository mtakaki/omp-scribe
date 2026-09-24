/**
 * Plan-document section surgery — the pure text engine behind delegated plan
 * updates.
 *
 * The initial plan body is rendered once, from a full blueprint. Every later
 * refinement must not re-render it: the brain emits a small delta, the writer
 * model rewrites only the sections that delta touches, and this module splices
 * those sections back into the plan already on disk, leaving every other byte of
 * the document alone. Nothing here reads files, spawns sessions, or knows about
 * oh-my-pi — it is plain string work on Markdown.
 */

/** Plan-document section headings, keyed by the blueprint field that supplies
 *  their content, in canonical document order. */
export const PLAN_SECTIONS = {
  context: "Context",
  steps: "Approach",
  files: "Critical files & anchors",
  verification: "Verification",
  assumptions: "Assumptions & contingencies",
} as const;

/** Canonical plan-document section order.  A section the plan does not have yet
 *  is inserted where its heading belongs in this order; a heading absent from
 *  this list keeps its place when present and is appended when new.  Derived
 *  from {@link PLAN_SECTIONS} so the order can never drift from the field
 *  mapping. */
export const CANONICAL_PLAN_SECTIONS: readonly string[] = Object.values(PLAN_SECTIONS);

/** One `##` section: its heading text plus the raw slice from that heading line
 *  up to the next `##` heading (or the end of the document).  `text` is verbatim
 *  — a section a splice does not target round-trips byte-for-byte. */
export interface PlanSection {
  /** Heading text with the `##` marker and surrounding whitespace removed. */
  heading: string;
  /** Raw section text, heading line included, exactly as it appears. */
  text: string;
}

/** A parsed plan document: everything before the first `##` heading (the `#`
 *  title and any intro prose) plus the ordered sections. */
export interface PlanDocument {
  /** Content preceding the first `##` heading; `""` when the document opens
   *  with a section. */
  preamble: string;
  sections: PlanSection[];
}

/** An ATX level-2 heading: `## Heading`, at most three leading spaces, optional
 *  trailing hashes.  Deeper headings (`###`) are section content, not section
 *  boundaries. */
const SECTION_HEADING_RE = /^ {0,3}##(?!#)\s+(.*?)\s*#*\s*$/;

/** A code-fence opener: three or more backticks or tildes, indented at most
 *  three spaces. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** Heading identity key: trimmed, whitespace-collapsed, case-folded.  Two
 *  headings that differ only in spacing or case name the same section. */
export function planHeadingKey(heading: string): string {
  return heading.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Line indices of every level-2 ATX heading that sits outside a fenced code
 *  block.  Fence state is tracked so a `## ` line inside a ``` or ~~~ block is
 *  treated as content rather than a section boundary. */
export function scanPlanHeadings(lines: readonly string[]): number[] {
  const starts: number[] = [];
  let openFence: string | undefined;

  lines.forEach((line, index) => {
    const fence = FENCE_RE.exec(line)?.[1];
    if (openFence !== undefined) {
      // A closer repeats the opening character at least as many times and
      // carries nothing else.
      if (fence !== undefined && fence[0] === openFence[0] && fence.length >= openFence.length && line.trim() === fence) {
        openFence = undefined;
      }
      return;
    }
    if (fence !== undefined) {
      openFence = fence;
      return;
    }
    if (SECTION_HEADING_RE.test(line)) starts.push(index);
  });

  return starts;
}

/** Splits `text` into its preamble and its `##` sections.  Headings inside
 *  fenced code blocks are ignored, and `preamble` plus every section's raw
 *  `text` concatenates back to `text` exactly. */
export function splitPlanSections(text: string): PlanDocument {
  const lines = text.split("\n");
  const starts = scanPlanHeadings(lines);
  if (starts.length === 0) return { preamble: text, sections: [] };

  /** An exact byte slice: every line in `[from, to)` is terminated, except the
   *  last line of the document, which has no trailing newline of its own. */
  const slice = (from: number, to: number): string =>
    lines.slice(from, to).join("\n") + (to < lines.length ? "\n" : "");

  const sections: PlanSection[] = starts.map((from, index) => {
    const to = index + 1 < starts.length ? starts[index + 1] : lines.length;
    const heading = SECTION_HEADING_RE.exec(lines[from])?.[1] ?? "";
    return { heading, text: slice(from, to) };
  });

  return { preamble: slice(0, starts[0]), sections };
}

/** Renders a replacement section into the document's own shape: the heading
 *  line, one blank line, the body with surrounding blank lines trimmed, then the
 *  blank line that separates it from whatever follows — which is where the
 *  preceding section's raw slice ends in an untouched document.
 *
 *  The writer may open with blank lines or repeat the heading itself; the
 *  section's own heading line is stripped when present so it is never emitted
 *  twice, and anything the writer put before it is dropped rather than kept as
 *  body. */
function renderSection(section: PlanSection): string {
  const heading = section.heading.trim();
  const lines = section.text.split("\n");
  const headingAt = lines.findIndex(line => SECTION_HEADING_RE.test(line));
  let body: string;
  if (headingAt === -1) {
    body = section.text;
  } else {
    const found = planHeadingKey(SECTION_HEADING_RE.exec(lines[headingAt])?.[1] ?? "");
    body = (found === planHeadingKey(heading) ? lines.slice(headingAt + 1) : lines).join("\n");
  }

  const trimmed = body.trim();
  return trimmed === "" ? `## ${heading}\n\n` : `## ${heading}\n\n${trimmed}\n\n`;
}

/** Slices `replacements` into `current`, deleting every section named by
 *  `drops`, and returns the new document.
 *
 *  A replacement whose heading the document already has replaces that section in
 *  place; one it does not have is inserted where its canonical position falls
 *  ({@link CANONICAL_PLAN_SECTIONS}), or appended when the heading is not
 *  canonical.  Sections the call does not name — and the preamble — are copied
 *  verbatim, and an update that names nothing returns `current` unchanged. */
export function splicePlanSections(
  current: string,
  replacements: readonly PlanSection[],
  drops: readonly string[] = [],
): string {
  const dropped = new Set(drops.map(planHeadingKey).filter(key => key !== ""));
  if (replacements.length === 0 && dropped.size === 0) return current;

  const { preamble, sections } = splitPlanSections(current);
  const rank = (heading: string): number => {
    const canonical = CANONICAL_PLAN_SECTIONS.findIndex(entry => planHeadingKey(entry) === planHeadingKey(heading));
    return canonical === -1 ? Number.POSITIVE_INFINITY : canonical;
  };

  const result = sections.filter(section => !dropped.has(planHeadingKey(section.heading)));
  for (const replacement of replacements) {
    const key = planHeadingKey(replacement.heading);
    if (key === "") continue;
    const text = renderSection(replacement);

    const existing = result.findIndex(section => planHeadingKey(section.heading) === key);
    if (existing !== -1) {
      result[existing] = { heading: replacement.heading.trim(), text };
      continue;
    }

    // Insert after the last section that ranks no lower than this one. Unknown
    // headings rank last, so they land at the end of the document.
    const insertion = rank(replacement.heading);
    let at = result.length;
    while (at > 0 && rank(result[at - 1].heading) > insertion) at--;
    result.splice(at, 0, { heading: replacement.heading.trim(), text });
  }

  return `${preamble}${result.map(section => section.text).join("")}`;
}
