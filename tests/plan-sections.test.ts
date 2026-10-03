/**
 * Unit tests for the plan section engine: splitting a plan document into its
 * `##` sections and splicing rendered replacements back in without touching
 * anything the update did not name.
 */
import { describe, expect, it } from "bun:test";
import {
  CANONICAL_PLAN_SECTIONS,
  PLAN_SECTIONS,
  planHeadingKey,
  scanPlanHeadings,
  splicePlanSections,
  splitPlanSections,
  type PlanSection,
} from "../src/plan-sections";

const PLAN = `# Auth refresh plan

Context paragraph.

## Context

Add refresh tokens to the auth flow.

## Approach

- Modify \`src/auth.ts\` lines 42-67 to issue refresh tokens.

## Critical files & anchors

- \`src/auth.ts\` — password validation and cookie handling

## Verification

- \`bun test tests/auth.test.ts\` passes
- Manual: sign in, wait for expiry, still signed in

## Assumptions & contingencies

- Tokens live 30 days; shorten if the user asks
`;

/** The raw text of one section of {@link PLAN}, as a splice would leave it. */
function sectionText(heading: string): string {
  const section = splitPlanSections(PLAN).sections.find(entry => entry.heading === heading);
  if (section === undefined) throw new Error(`fixture has no "${heading}" section`);
  return section.text;
}

function headingsOf(text: string): string[] {
  return splitPlanSections(text).sections.map(section => section.heading);
}

describe("splitPlanSections", () => {
  it("round-trips the document through its preamble and sections", () => {
    const { preamble, sections } = splitPlanSections(PLAN);
    expect(preamble).toBe("# Auth refresh plan\n\nContext paragraph.\n\n");
    expect(`${preamble}${sections.map(section => section.text).join("")}`).toBe(PLAN);
    expect(sections.map(section => section.heading)).toEqual([
      "Context",
      "Approach",
      "Critical files & anchors",
      "Verification",
      "Assumptions & contingencies",
    ]);
  });

  it("treats a document with no section heading as one preamble", () => {
    const prose = "Just a title\n\nand a paragraph.\n";
    expect(splitPlanSections(prose)).toEqual({ preamble: prose, sections: [] });
  });

  it("ignores headings inside fenced code blocks", () => {
    const text = "## Real\n\n```md\n## Not a section\n### Also not\n```\n\ntail\n";
    expect(headingsOf(text)).toEqual(["Real"]);
    expect(splitPlanSections(text).sections[0]!.text).toContain("## Not a section");
  });

  it("does not treat deeper headings or unspaced hashes as sections", () => {
    const text = "## Real\n\n### Deeper\n\n##NotAHeading\n";
    expect(headingsOf(text)).toEqual(["Real"]);
  });

  it("scans heading line indices outside fences", () => {
    expect(scanPlanHeadings(["# Title", "## A", "```", "## B", "```", "## C"])).toEqual([1, 5]);
  });
});

describe("splicePlanSections", () => {
  it("returns the document byte-identical when nothing is replaced or dropped", () => {
    expect(splicePlanSections(PLAN, [])).toBe(PLAN);
    expect(splicePlanSections(PLAN, [], [])).toBe(PLAN);
  });

  it("replaces a section in place and leaves every other section untouched", () => {
    const replacement: PlanSection = {
      heading: "Verification",
      text: "## Verification\n\n- `bun test tests/auth.test.ts` passes\n- Manual: sign in, wait for expiry, still signed in\n- Refresh token rolls 7 days before expiry\n",
    };
    const output = splicePlanSections(PLAN, [replacement]);

    expect(headingsOf(output)).toEqual([
      "Context",
      "Approach",
      "Critical files & anchors",
      "Verification",
      "Assumptions & contingencies",
    ]);
    for (const heading of ["Context", "Approach", "Critical files & anchors", "Assumptions & contingencies"]) {
      expect(output).toContain(sectionText(heading));
    }
    expect(output).toContain("- Refresh token rolls 7 days before expiry");
    // The old Verification bullets are gone: a supplied section replaces it.
    expect(output).not.toContain("- Manual: sign in, wait for expiry, still signed in\n\n");
    // Only the Verification section differs from the original document.
    expect(output).toBe(PLAN.replace(sectionText("Verification"), "## Verification\n\n- `bun test tests/auth.test.ts` passes\n- Manual: sign in, wait for expiry, still signed in\n- Refresh token rolls 7 days before expiry\n\n"));
  });

  it("inserts a missing section at its canonical position", () => {
    const without: string = PLAN.replace(sectionText("Critical files & anchors"), "");
    const output = splicePlanSections(without, [{ heading: "Critical files & anchors", text: "## Critical files & anchors\n\n- `src/auth.ts` — token issue path\n" }]);

    expect(headingsOf(output)).toEqual([
      "Context",
      "Approach",
      "Critical files & anchors",
      "Verification",
      "Assumptions & contingencies",
    ]);
    expect(output).toContain("- `src/auth.ts` — token issue path");
    expect(output).toContain(sectionText("Approach"));
  });

  it("inserts a section the document lacks ahead of a later one", () => {
    const without: string = PLAN.replace(sectionText("Assumptions & contingencies"), "");
    const output = splicePlanSections(without, [{ heading: "Assumptions & contingencies", text: "## Assumptions & contingencies\n\n- Tokens live 30 days\n" }]);

    expect(headingsOf(output)).toEqual([
      "Context",
      "Approach",
      "Critical files & anchors",
      "Verification",
      "Assumptions & contingencies",
    ]);
    expect(output).toContain("- Tokens live 30 days");
    expect(output).toContain(sectionText("Verification"));
  });

  it("appends an unknown heading at the end of the document", () => {
    const output = splicePlanSections(PLAN, [{ heading: "Rollout", text: "## Rollout\n\n- Ship behind a flag first\n" }]);

    expect(headingsOf(output)).toEqual([
      "Context",
      "Approach",
      "Critical files & anchors",
      "Verification",
      "Assumptions & contingencies",
      "Rollout",
    ]);
    expect(output.endsWith("## Rollout\n\n- Ship behind a flag first\n\n")).toBe(true);
    expect(output.indexOf("## Rollout")).toBeGreaterThan(output.indexOf("## Assumptions & contingencies"));
    for (const heading of headingsOf(PLAN)) expect(output).toContain(sectionText(heading));
  });

  it("drops named sections and keeps the rest byte-identical", () => {
    const output = splicePlanSections(PLAN, [], ["Assumptions & contingencies"]);

    expect(headingsOf(output)).toEqual([
      "Context",
      "Approach",
      "Critical files & anchors",
      "Verification",
    ]);
    for (const heading of headingsOf(output)) expect(output).toContain(sectionText(heading));
    expect(output).not.toContain("Tokens live 30 days");
    expect(output).toBe(PLAN.replace(sectionText("Assumptions & contingencies"), ""));
  });

  it("applies drops and replacements in one pass", () => {
    const output = splicePlanSections(
      PLAN,
      [{ heading: "Verification", text: "## Verification\n\n- `bun test` passes\n" }],
      ["Assumptions & contingencies", "Critical files & anchors"],
    );

    expect(headingsOf(output)).toEqual(["Context", "Approach", "Verification"]);
    expect(output).toContain("- `bun test` passes");
    expect(output).toContain(sectionText("Context"));
    expect(output).not.toContain("Tokens live 30 days");
    expect(output).not.toContain("password validation and cookie handling");
  });

  it("matches an existing heading regardless of case and spacing", () => {
    const output = splicePlanSections(PLAN, [{ heading: "  verification  ", text: "## verification\n\n- rewritten\n" }]);

    expect(headingsOf(output)).toEqual([
      "Context",
      "Approach",
      "Critical files & anchors",
      "verification",
      "Assumptions & contingencies",
    ]);
    expect(output).toContain("- rewritten");
    expect(output).not.toContain("Manual: sign in, wait for expiry, still signed in");
  });

  it("does not treat a heading inside a fence as a section to splice", () => {
    const text = "## Real\n\n```md\n## Not a section\n```\n\nbody\n";
    const output = splicePlanSections(text, [{ heading: "Not a section", text: "## Not a section\n\n- hijacked\n" }]);

    expect(headingsOf(output)).toEqual(["Real", "Not a section"]);
    expect(output).toContain("```md\n## Not a section\n```");
    expect(output).toContain("## Not a section\n\n- hijacked");
    expect(output.indexOf("## Not a section\n\n- hijacked")).toBeGreaterThan(output.indexOf("```md\n## Not a section\n```"));
  });

  it("renders a replacement with the document's heading and blank-line shape", () => {
    const output = splicePlanSections(PLAN, [
      { heading: "Approach", text: "\n## Approach\n\n\n- one step\n\n\n" },
    ]);

    expect(output).toContain("## Approach\n\n- one step\n\n## Critical files & anchors");
    expect(output).toBe(PLAN.replace(sectionText("Approach"), "## Approach\n\n- one step\n\n"));
  });

  it("keeps the canonical order and section names in one place", () => {
    expect(CANONICAL_PLAN_SECTIONS).toEqual([
      "Context",
      "Approach",
      "Critical files & anchors",
      "Verification",
      "Assumptions & contingencies",
    ]);
    expect(PLAN_SECTIONS.steps).toBe("Approach");
    expect(planHeadingKey("  Critical  files & Anchors ")).toBe("critical files & anchors");
  });
});
