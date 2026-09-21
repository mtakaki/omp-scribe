/**
 * Unit tests for the Scribe IR layer: validation and file-id resolution of
 * `PlanBlueprint.files`/`steps`, and the disk hydration that grounds the
 * writer model's prose in real file content.
 */
import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hydrateScribeStep, resolveScribeSteps, validateScribeBlueprint, type ScribeStepResolved } from "../src/scribe-ir";
import type { PlanBlueprint } from "../src/types";

/** Runs `run` against a throwaway project root seeded with `files`. */
async function withProject<T>(files: Record<string, string>, run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "scribe-ir-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text, "utf8");
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const BASE: PlanBlueprint = {
  slug: "s",
  title: "T",
  context: "C",
  files: [
    ["A", "src/a.ts", "reason a"],
    ["B", "src/b.ts", "reason b"],
  ],
  steps: [
    ["A", "~", [2, 3], "Modify a.", [], []],
    ["B", "+", null, "Add b.", [], []],
  ],
  verification: [],
  assumptions: [],
};

describe("validateScribeBlueprint", () => {
  it("does not throw on a valid multi-file, multi-step blueprint", () => {
    expect(() => validateScribeBlueprint(BASE)).not.toThrow();
  });

  it("throws on a duplicate file id, naming the id", () => {
    const blueprint: PlanBlueprint = { ...BASE, files: [...BASE.files, ["A", "src/c.ts", "dup"]] };
    expect(() => validateScribeBlueprint(blueprint)).toThrow(/duplicate file id "A"/);
  });

  it("throws when a step references an unknown file id", () => {
    const blueprint: PlanBlueprint = { ...BASE, steps: [["Z", "~", [1, 1], "x", [], []]] };
    expect(() => validateScribeBlueprint(blueprint)).toThrow(/unknown file id "Z"/);
  });

  it("throws on an invalid operation string", () => {
    const blueprint: PlanBlueprint = { ...BASE, steps: [["A", "x" as never, null, "x", [], []]] };
    expect(() => validateScribeBlueprint(blueprint)).toThrow(/invalid operation/);
  });

  it("throws on an inverted range", () => {
    const blueprint: PlanBlueprint = { ...BASE, steps: [["A", "~", [100, 20], "x", [], []]] };
    expect(() => validateScribeBlueprint(blueprint)).toThrow(/range end \(20\) must be >= start \(100\)/);
  });

  it("throws on an empty-string intent", () => {
    const blueprint: PlanBlueprint = { ...BASE, steps: [["A", "~", [1, 1], "  ", [], []]] };
    expect(() => validateScribeBlueprint(blueprint)).toThrow(/intent must be a non-empty string/);
  });
});

describe("resolveScribeSteps", () => {
  it("resolves tuples to sequential S1, S2 ids with looked-up paths and null->undefined ranges", () => {
    const resolved = resolveScribeSteps(BASE);
    expect(resolved).toEqual([
      { id: "S1", filePath: "src/a.ts", operation: "~", lineRange: { start: 2, end: 3 }, intent: "Modify a.", preserve: [], doNot: [] },
      { id: "S2", filePath: "src/b.ts", operation: "+", lineRange: undefined, intent: "Add b.", preserve: [], doNot: [] },
    ]);
  });
});

describe("hydrateScribeStep", () => {
  const step = (overrides: Partial<ScribeStepResolved>): ScribeStepResolved => ({
    id: "S1",
    filePath: "src/a.ts",
    operation: "~",
    lineRange: undefined,
    intent: "x",
    preserve: [],
    doNot: [],
    ...overrides,
  });

  it("returns only the requested line range, numbered from the file's line 1", async () => {
    await withProject({ "src/a.ts": "line1\nline2\nline3\nline4\nline5\n" }, async root => {
      const hydrated = await hydrateScribeStep(root, step({ lineRange: { start: 2, end: 3 } }));
      expect(hydrated.snippet).toBe("    2| line2\n    3| line3");
    });
  });

  it("hydrates a single-line range to that one line only", async () => {
    await withProject({ "src/a.ts": "line1\nline2\nline3\nline4\nline5\n" }, async root => {
      const hydrated = await hydrateScribeStep(root, step({ lineRange: { start: 3, end: 3 } }));
      expect(hydrated.snippet).toBe("    3| line3");
    });
  });

  it("notes a file that does not exist yet instead of throwing", async () => {
    await withProject({}, async root => {
      const hydrated = await hydrateScribeStep(root, step({ filePath: "src/new.ts" }));
      expect(hydrated.snippet).toBe("(no snippet: src/new.ts does not exist yet — treat this step as authoring it from scratch)");
    });
  });

  it("refuses a path resolving outside the project root", async () => {
    await withProject({}, async root => {
      const hydrated = await hydrateScribeStep(root, step({ filePath: "../escape.ts", lineRange: { start: 1, end: 1 } }));
      expect(hydrated.snippet).toBe("(no snippet: ../escape.ts resolves outside the project root)");
    });
  });

  it("notes a range running past the end of the file", async () => {
    await withProject({ "src/a.ts": "line1\nline2\nline3\n" }, async root => {
      const hydrated = await hydrateScribeStep(root, step({ lineRange: { start: 2, end: 9 } }));
      expect(hydrated.snippet).toBe("    2| line2\n    3| line3\n(lines 4-9 were requested but src/a.ts ends at line 3)");
    });
  });

  it("caps a whole-file preview at 200 lines and reports the omitted remainder", async () => {
    const text = Array.from({ length: 250 }, (_unused, index) => `body-${index + 1}`).join("\n");
    await withProject({ "big.txt": `${text}\n` }, async root => {
      const hydrated = await hydrateScribeStep(root, step({ filePath: "big.txt" }));
      expect(hydrated.snippet).toContain("    1| body-1");
      expect(hydrated.snippet).toContain("  200| body-200");
      expect(hydrated.snippet).toContain("(50 further lines omitted)");
      expect(hydrated.snippet).not.toContain("body-201");
    });
  });
});
