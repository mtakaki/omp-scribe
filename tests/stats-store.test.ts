import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  appendSavingsRun,
  formatSavingsDashboard,
  readStatsFile,
  SAVINGS_STATS_RELATIVE_PATH,
  type SavingsRunLogEntry,
  type SavingsStatsFile,
} from "../src/stats-store";

function makeEntry(overrides: Partial<SavingsRunLogEntry> = {}): SavingsRunLogEntry {
  return {
    timestamp: new Date().toISOString(),
    slug: "test-plan",
    brainModel: "anthropic/claude-opus-4-5",
    writerModel: "anthropic/claude-haiku-3-5",
    brainInputTokens: 1000,
    brainOutputTokens: 50,
    writerInputTokens: 2000,
    writerOutputTokens: 300,
    irOutputTokens: 42,
    writerCostUsd: 0,
    actualCostUsd: 0.001,
    baselineCostUsd: 0.010,
    netSavingsUsd: 0.009,
    priced: true,
    ...overrides,
  };
}

let cwd: string;

beforeEach(async () => {
  cwd = join(tmpdir(), `scribe-test-${randomUUID()}`);
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("readStatsFile", () => {
  it("returns a zeroed structure when no file exists (ENOENT self-heal)", async () => {
    const stats = await readStatsFile(cwd);
    expect(stats.version).toBe(1);
    expect(stats.totalRuns).toBe(0);
    expect(stats.runs).toHaveLength(0);
  });

  it("returns zeroed structure for malformed JSON (self-heal)", async () => {
    const dir = join(cwd, ".claude", "plans");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(cwd, SAVINGS_STATS_RELATIVE_PATH), "{ invalid json {{");
    const stats = await readStatsFile(cwd);
    expect(stats.totalRuns).toBe(0);
  });

  it("returns zeroed structure when schema is wrong (self-heal)", async () => {
    const dir = join(cwd, ".claude", "plans");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(cwd, SAVINGS_STATS_RELATIVE_PATH), JSON.stringify({ version: 2, data: [] }));
    const stats = await readStatsFile(cwd);
    expect(stats.totalRuns).toBe(0);
  });
});

describe("appendSavingsRun", () => {
  it("writes and reads back a single run correctly", async () => {
    const entry = makeEntry();
    const returned = await appendSavingsRun(cwd, entry);
    expect(returned.totalRuns).toBe(1);
    expect(returned.runs).toHaveLength(1);
    expect(returned.runs[0]!.slug).toBe("test-plan");

    // Confirm durable write: fresh readStatsFile sees same data
    const reread = await readStatsFile(cwd);
    expect(reread.totalRuns).toBe(1);
    expect(reread.runs[0]!.slug).toBe("test-plan");
  });

  it("accumulates totals across multiple runs", async () => {
    const e1 = makeEntry({ brainInputTokens: 100, netSavingsUsd: 0.005 });
    const e2 = makeEntry({ brainInputTokens: 200, netSavingsUsd: 0.010 });
    await appendSavingsRun(cwd, e1);
    const stats = await appendSavingsRun(cwd, e2);
    expect(stats.totalRuns).toBe(2);
    expect(stats.totalBrainInputTokens).toBe(300);
    expect(stats.totalNetSavingsUsd).toBeCloseTo(0.015, 8);
  });

  it("counts unpriced runs separately", async () => {
    await appendSavingsRun(cwd, makeEntry({ priced: true }));
    await appendSavingsRun(cwd, makeEntry({ priced: false }));
    const stats = await readStatsFile(cwd);
    expect(stats.totalRuns).toBe(2);
    expect(stats.totalUnpricedRuns).toBe(1);
  });

  it("counts plan and doc runs separately", async () => {
    await appendSavingsRun(cwd, makeEntry({ mode: "plan", slug: "a-plan" }));
    await appendSavingsRun(cwd, makeEntry({ mode: "doc", slug: "a-doc" }));
    const stats = await readStatsFile(cwd);
    expect(stats.totalRuns).toBe(2);
    expect(stats.totalPlanRuns).toBe(1);
    expect(stats.totalDocRuns).toBe(1);
  });

  it("counts runs with an estimated baseline separately", async () => {
    await appendSavingsRun(cwd, makeEntry({ priced: false, baselineIsEstimate: true, actualCostUsd: 0, baselineCostUsd: 0.033 }));
    await appendSavingsRun(cwd, makeEntry()); // legacy entry: field absent, must not count
    await appendSavingsRun(cwd, makeEntry({ priced: false, baselineIsEstimate: true, actualCostUsd: 0, baselineCostUsd: 0.033 }));
    const stats = await readStatsFile(cwd);
    expect(stats.totalRuns).toBe(3);
    expect(stats.totalEstimatedBaselineRuns).toBe(2);
  });

  it("accumulates blueprint tokens, treating entries without the field as zero", async () => {
    await appendSavingsRun(cwd, makeEntry({ irOutputTokens: 120 }));
    const legacy = makeEntry();
    delete legacy.irOutputTokens;
    const stats = await appendSavingsRun(cwd, legacy);
    expect(stats.totalIrOutputTokens).toBe(120);
  });

  it("prepends new entries (most-recent-first)", async () => {
    const e1 = makeEntry({ slug: "first" });
    const e2 = makeEntry({ slug: "second" });
    await appendSavingsRun(cwd, e1);
    await appendSavingsRun(cwd, e2);
    const stats = await readStatsFile(cwd);
    expect(stats.runs[0]!.slug).toBe("second");
    expect(stats.runs[1]!.slug).toBe("first");
  });

  it("caps runs array at 200 entries", async () => {
    // Write 201 entries sequentially to verify the 200-entry cap
    for (let i = 0; i < 201; i++) {
      await appendSavingsRun(cwd, makeEntry({ slug: `plan-${i}` }));
    }
    const stats = await readStatsFile(cwd);
    expect(stats.totalRuns).toBe(201);
    expect(stats.runs).toHaveLength(200);
    // Most recent first: plan-200 should be at index 0
    expect(stats.runs[0]!.slug).toBe("plan-200");
  });

  it("atomic write: produces a valid JSON file (no leftover .tmp files)", async () => {
    const entry = makeEntry();
    await appendSavingsRun(cwd, entry);
    const statsPath = join(cwd, SAVINGS_STATS_RELATIVE_PATH);
    const raw = await readFile(statsPath, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    // No sibling tmp files left
    const dir = join(cwd, ".claude", "plans");
    const files = await readdir(dir);
    expect(files.filter((f: string) => f.includes(".tmp-"))).toHaveLength(0);
  });
});

describe("formatSavingsDashboard", () => {
  it("renders a non-empty box for zero-run stats", () => {
    const empty: SavingsStatsFile = {
      version: 1,
      totalRuns: 0,
      totalUnpricedRuns: 0,
      totalActualCostUsd: 0,
      totalBaselineCostUsd: 0,
      totalNetSavingsUsd: 0,
      totalBrainInputTokens: 0,
      totalBrainOutputTokens: 0,
      totalWriterInputTokens: 0,
      totalWriterOutputTokens: 0,
      runs: [],
    };
    const output = formatSavingsDashboard(empty);
    expect(output).toContain("SCRIBE COST-SAVINGS DASHBOARD");
    expect(output).toContain("Total plan-mode runs");
    // No recent-run section when runs is empty
    expect(output).not.toContain("Recent runs:");
    // No estimate marker or note when no baseline was estimated
    expect(output).not.toContain("~$");
    expect(output).not.toContain("not billed amounts");
  });

  it("renders the doc-mode run count", () => {
    const stats: SavingsStatsFile = {
      version: 1,
      totalRuns: 4,
      totalUnpricedRuns: 0,
      totalActualCostUsd: 0,
      totalBaselineCostUsd: 0,
      totalNetSavingsUsd: 0,
      totalBrainInputTokens: 0,
      totalBrainOutputTokens: 0,
      totalWriterInputTokens: 0,
      totalWriterOutputTokens: 0,
      totalPlanRuns: 1,
      totalDocRuns: 2,
      runs: [],
    };
    const output = formatSavingsDashboard(stats);
    const docLine = output.split("\n").find(line => line.includes("Total doc-mode runs"));
    expect(docLine).toContain("2");
  });

  it("includes unpriced warning when totalUnpricedRuns > 0", () => {
    const stats: SavingsStatsFile = {
      version: 1,
      totalRuns: 1,
      totalUnpricedRuns: 1,
      totalActualCostUsd: 0,
      totalBaselineCostUsd: 0,
      totalNetSavingsUsd: 0,
      totalBrainInputTokens: 0,
      totalBrainOutputTokens: 0,
      totalWriterInputTokens: 0,
      totalWriterOutputTokens: 0,
      runs: [],
    };
    const output = formatSavingsDashboard(stats);
    expect(output).toContain("no known per-token output rate in the catalog");
  });

  it("estimates brain output without scribe by trading the blueprint for the writer's document", () => {
    const stats: SavingsStatsFile = {
      version: 1,
      totalRuns: 1,
      totalUnpricedRuns: 0,
      totalActualCostUsd: 0,
      totalBaselineCostUsd: 0,
      totalNetSavingsUsd: 0,
      totalBrainInputTokens: 1000,
      totalBrainOutputTokens: 2000,
      totalWriterInputTokens: 0,
      totalWriterOutputTokens: 3000,
      totalIrOutputTokens: 400,
      runs: [],
    };
    const row = formatSavingsDashboard(stats)
      .split("\n")
      .find(line => line.includes("Estimated brain tokens output without scribe"));
    expect(row).toContain("4,600");
  });

  it("falls back to brain + writer output when a pre-existing file lacks the blueprint total", () => {
    const stats: SavingsStatsFile = {
      version: 1,
      totalRuns: 1,
      totalUnpricedRuns: 0,
      totalActualCostUsd: 0,
      totalBaselineCostUsd: 0,
      totalNetSavingsUsd: 0,
      totalBrainInputTokens: 1000,
      totalBrainOutputTokens: 2000,
      totalWriterInputTokens: 0,
      totalWriterOutputTokens: 3000,
      runs: [],
    };
    const row = formatSavingsDashboard(stats)
      .split("\n")
      .find(line => line.includes("Estimated brain tokens output without scribe"));
    expect(row).toContain("5,000");
  });

  it("flags an @plan-role estimated baseline with a ~$ marker and note", () => {
    const stats: SavingsStatsFile = {
      version: 1,
      totalRuns: 1,
      totalUnpricedRuns: 1,
      totalActualCostUsd: 0,
      totalBaselineCostUsd: 0.033,
      totalNetSavingsUsd: 0.033,
      totalBrainInputTokens: 1000,
      totalBrainOutputTokens: 50,
      totalWriterInputTokens: 0,
      totalWriterOutputTokens: 2000,
      totalEstimatedBaselineRuns: 1,
      runs: [
        makeEntry({
          priced: false,
          baselineIsEstimate: true,
          actualCostUsd: 0,
          baselineCostUsd: 0.033,
          netSavingsUsd: 0.033,
        }),
      ],
    };
    const output = formatSavingsDashboard(stats);

    const estimateRow = output.split("\n").find(line => line.includes("Baseline via @plan-role estimate"));
    expect(estimateRow).toContain("1");

    const savingsLine = output.split("\n").find(line => line.includes("Total net savings"));
    expect(savingsLine).toContain("~$0.0330");

    // The recent-run row carries the ~$ marker rather than reading "unpriced"
    const recentLine = output.split("\n").find(line => line.includes("test-plan"));
    expect(recentLine).toContain("~$0.0330");
    expect(output).not.toContain("unpriced");

    expect(output).toContain("not billed amounts");
  });

  it("truncates slug to 28 chars in recent run rows", async () => {
    const entry = makeEntry({ slug: "a-very-long-slug-name-that-exceeds-28-chars" });
    await appendSavingsRun(cwd, entry);
    const stats = await readStatsFile(cwd);
    const output = formatSavingsDashboard(stats);
    // Slug > 28 chars → truncated with "..."
    expect(output).toContain("...");
  });

  it("shows all 5 recent runs when runs.length === 5", () => {
    const runs: SavingsRunLogEntry[] = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ slug: `plan-${i}`, timestamp: new Date(Date.now() - i * 1000).toISOString() }),
    );
    const stats: SavingsStatsFile = {
      version: 1,
      totalRuns: 5,
      totalUnpricedRuns: 0,
      totalActualCostUsd: 0.005,
      totalBaselineCostUsd: 0.05,
      totalNetSavingsUsd: 0.045,
      totalBrainInputTokens: 0,
      totalBrainOutputTokens: 0,
      totalWriterInputTokens: 0,
      totalWriterOutputTokens: 0,
      runs,
    };
    const output = formatSavingsDashboard(stats);
    // All 5 run slugs appear
    for (let i = 0; i < 5; i++) {
      expect(output).toContain(`plan-${i}`);
    }
  });

  it("each row fits exactly 66 chars (64 inner + 2 border)", () => {
    const stats: SavingsStatsFile = {
      version: 1,
      totalRuns: 1,
      totalUnpricedRuns: 0,
      totalActualCostUsd: 0.001,
      totalBaselineCostUsd: 0.010,
      totalNetSavingsUsd: 0.009,
      totalBrainInputTokens: 1000,
      totalBrainOutputTokens: 50,
      totalWriterInputTokens: 2000,
      totalWriterOutputTokens: 300,
      runs: [makeEntry()],
    };
    const output = formatSavingsDashboard(stats);
    for (const line of output.split("\n")) {
      if (line.startsWith("╔") || line.startsWith("╟") || line.startsWith("╚") || line.startsWith("║")) {
        expect(line.length).toBe(66);
      }
    }
  });
});
