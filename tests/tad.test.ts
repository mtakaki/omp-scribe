/**
 * Unit tests for the TAD (Tokenized Architectural Diff) layer: the wire format
 * `PlanBlueprint.approach` carries and the disk hydration that grounds the
 * writer model's prose in real file content.
 */
import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hydrateTadStep, parseTadLine, TAD_LINE_RE } from "../src/tad";

/** Runs `run` against a throwaway project root seeded with `files`. */
async function withProject<T>(files: Record<string, string>, run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "scribe-tad-"));
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

describe("parseTadLine", () => {
  it("extracts every field of a full TAD line", () => {
    const line = "@src/writer-session.ts[40-92]{~}deps(src/tad.ts,src/types.ts)#switch_prompt_to_text";
    expect(parseTadLine(line)).toEqual({
      raw: line,
      filePath: "src/writer-session.ts",
      lineRange: { start: 40, end: 92 },
      operation: "~",
      dependencies: ["src/tad.ts", "src/types.ts"],
      intent: "switch_prompt_to_text",
    });
  });

  it("parses a new-file step with no range and no deps", () => {
    const step = parseTadLine("@src/tad.ts{+}#add_tad_parser");
    expect(step.filePath).toBe("src/tad.ts");
    expect(step.lineRange).toBeUndefined();
    expect(step.operation).toBe("+");
    expect(step.dependencies).toEqual([]);
  });

  it("parses a single-line [N] range as start === end", () => {
    const step = parseTadLine("@backend/prisma/copy-prod-to-staging.ts[189]{~}deps()#extend_main_signature_with_source_dest_origin_params");
    expect(step.lineRange).toEqual({ start: 189, end: 189 });
  });

  it("rejects lines the tool schema refuses, and inverted ranges with a reason", () => {
    // The Zod schema applies TAD_LINE_RE, so a line it rejects must never reach
    // parseTadLine; a line it accepts — including an inverted range — must parse
    // or fail with a descriptive message.
    for (const bad of ["src/tad.ts{~}#missing_at_prefix", "@src/tad.ts[1-2]{*}#bad_operation", "@src/tad.ts{+}#bad intent"]) {
      expect(TAD_LINE_RE.test(bad)).toBe(false);
      expect(() => parseTadLine(bad)).toThrow(/Malformed TAD line/);
    }
    expect(TAD_LINE_RE.test("@src/tad.ts[4-2]{~}#inverted")).toBe(true);
    expect(() => parseTadLine("@src/tad.ts[4-2]{~}#inverted")).toThrow(/precedes start/);
  });
});

describe("hydrateTadStep", () => {
  it("returns only the requested line range, numbered from the file's line 1", async () => {
    await withProject({ "src/a.ts": "line1\nline2\nline3\nline4\nline5\n" }, async root => {
      const hydrated = await hydrateTadStep(root, parseTadLine("@src/a.ts[2-3]{~}deps()#edit"));
      expect(hydrated.snippet).toBe("    2| line2\n    3| line3");
    });
  });

  it("hydrates a single-line [N] range to that one line only", async () => {
    await withProject({ "src/a.ts": "line1\nline2\nline3\nline4\nline5\n" }, async root => {
      const hydrated = await hydrateTadStep(root, parseTadLine("@src/a.ts[3]{~}deps()#edit"));
      expect(hydrated.snippet).toBe("    3| line3");
    });
  });

  it("notes a file that does not exist yet instead of throwing", async () => {
    await withProject({}, async root => {
      const hydrated = await hydrateTadStep(root, parseTadLine("@src/new.ts{+}#add"));
      expect(hydrated.snippet).toBe("(no snippet: src/new.ts does not exist yet — treat this step as authoring it from scratch)");
    });
  });

  it("refuses a path resolving outside the project root", async () => {
    await withProject({}, async root => {
      const hydrated = await hydrateTadStep(root, parseTadLine("@../escape.ts[1-1]{~}#escape"));
      expect(hydrated.snippet).toBe("(no snippet: ../escape.ts resolves outside the project root)");
    });
  });

  it("notes a range running past the end of the file", async () => {
    await withProject({ "src/a.ts": "line1\nline2\nline3\n" }, async root => {
      const hydrated = await hydrateTadStep(root, parseTadLine("@src/a.ts[2-9]{~}#tail"));
      expect(hydrated.snippet).toBe(
        "    2| line2\n    3| line3\n(lines 4-9 were requested but src/a.ts ends at line 3)",
      );
    });
  });

  it("caps a whole-file preview at 200 lines and reports the omitted remainder", async () => {
    const text = Array.from({ length: 250 }, (_unused, index) => `body-${index + 1}`).join("\n");
    await withProject({ "big.txt": `${text}\n` }, async root => {
      const hydrated = await hydrateTadStep(root, parseTadLine("@big.txt{+}#whole_file"));
      expect(hydrated.snippet).toContain("    1| body-1");
      expect(hydrated.snippet).toContain("  200| body-200");
      expect(hydrated.snippet).toContain("(50 further lines omitted)");
      expect(hydrated.snippet).not.toContain("body-201");
    });
  });
});
