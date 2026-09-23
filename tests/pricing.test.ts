import { describe, expect, it } from "bun:test";
import { computeCosts } from "../src/pricing";

describe("computeCosts", () => {
  it("computes actual and baseline when brainOutputRatePerMillionUsd is nonzero (priced)", () => {
    const result = computeCosts({
      brainActualTotalCostUsd: 1.65,   // input + exploration/thinking output component
      writerActualCostUsd: 0.008,
      brainOutputRatePerMillionUsd: 15, // e.g. claude-3-opus output rate
      documentOutputTokens: 1000,
      blueprintOutputTokens: 0,      // no blueprint credit in this case
      brainInputTokens: 500_000,
      referenceInputRatePerMillionUsd: 3,   // present but must be ignored on the priced path
      referenceOutputRatePerMillionUsd: 15,
    });

    expect(result.priced).toBe(true);
    expect(result.baselineIsEstimate).toBe(false);

    // actual = brain total + writer total
    expect(result.actualCostUsd).toBeCloseTo(1.65 + 0.008, 8);

    // baseline = brain total turn cost + documentOutputTokens * rate / 1e6
    const expectedBaseline = 1.65 + (1000 * 15) / 1e6;
    expect(result.baselineCostUsd).toBeCloseTo(expectedBaseline, 8);

    // net savings = max(0, baseline - actual)
    expect(result.netSavingsUsd).toBeCloseTo(Math.max(0, expectedBaseline - (1.65 + 0.008)), 8);
  });

  it("credits the blueprint tokens back out of the baseline", () => {
    // The brain only emitted a compact blueprint because of scribe, so the
    // counterfactual must bill it for the returned document *net of* the
    // blueprint it replaced — 1,000 − 400 = 600 tokens, not the full 1,000.
    const result = computeCosts({
      brainActualTotalCostUsd: 2.00,
      writerActualCostUsd: 0,
      brainOutputRatePerMillionUsd: 15,
      documentOutputTokens: 1000,
      blueprintOutputTokens: 400,
      brainInputTokens: 500_000,
      referenceInputRatePerMillionUsd: 0,
      referenceOutputRatePerMillionUsd: 0,
    });

    expect(result.priced).toBe(true);
    // baseline = 2.00 shared turn cost + (1000 - 400) * 15 / 1e6
    expect(result.baselineCostUsd).toBeCloseTo(2.00 + (600 * 15) / 1e6, 8);
    expect(result.actualCostUsd).toBeCloseTo(2.00, 8);
    expect(result.netSavingsUsd).toBeCloseTo((600 * 15) / 1e6, 8);
  });

  it("clamps net savings to zero when the blueprint outweighed the returned document", () => {
    // A tiny document with a bulky blueprint produces a negative delegation
    // delta; the clamp keeps the reported saving at $0.00 rather than negative.
    const result = computeCosts({
      brainActualTotalCostUsd: 2.00,
      writerActualCostUsd: 0,
      brainOutputRatePerMillionUsd: 15,
      documentOutputTokens: 100,
      blueprintOutputTokens: 900,
      brainInputTokens: 500_000,
      referenceInputRatePerMillionUsd: 0,
      referenceOutputRatePerMillionUsd: 0,
    });

    expect(result.netSavingsUsd).toBe(0);
  });

  it("sets priced:false when brainOutputRatePerMillionUsd is zero", () => {
    const result = computeCosts({
      brainActualTotalCostUsd: 0,
      writerActualCostUsd: 0,
      brainOutputRatePerMillionUsd: 0,
      documentOutputTokens: 5000,
      blueprintOutputTokens: 0,
      brainInputTokens: 1000,
      referenceInputRatePerMillionUsd: 0,  // reference model unavailable
      referenceOutputRatePerMillionUsd: 0,
    });

    expect(result.priced).toBe(false);
    expect(result.baselineIsEstimate).toBe(false);
    // baseline reduces to just brainActualTotalCostUsd (the document-token term vanishes)
    expect(result.baselineCostUsd).toBeCloseTo(0, 8);
    expect(result.actualCostUsd).toBeCloseTo(0, 8);
    expect(result.netSavingsUsd).toBe(0);
  });

  it("baseline reduces to brainActualTotalCostUsd when rate is zero even with nonzero tokens", () => {
    const result = computeCosts({
      brainActualTotalCostUsd: 0.50,
      writerActualCostUsd: 0.002,
      brainOutputRatePerMillionUsd: 0,
      documentOutputTokens: 10_000,
      blueprintOutputTokens: 0,
      brainInputTokens: 20_000,
      referenceInputRatePerMillionUsd: 0,
      referenceOutputRatePerMillionUsd: 0,
    });

    expect(result.priced).toBe(false);
    expect(result.baselineIsEstimate).toBe(false);
    // rate=0 → the document-token term vanishes, so the baseline is the brain's own turn cost
    expect(result.baselineCostUsd).toBeCloseTo(0.50, 8);
    expect(result.actualCostUsd).toBeCloseTo(0.502, 8);
    // baseline (0.50) < actual (0.502) → savings clamped at 0
    expect(result.netSavingsUsd).toBe(0);
  });

  it("netSavingsUsd is zero when actual exceeds baseline", () => {
    // Contrive a case where actual > baseline: high writer cost with tiny brain output rate.
    const result = computeCosts({
      brainActualTotalCostUsd: 0.001,
      writerActualCostUsd: 50.00, // very expensive writer
      brainOutputRatePerMillionUsd: 0.28, // low output rate
      documentOutputTokens: 1000,
      blueprintOutputTokens: 0,
      brainInputTokens: 1000,
      referenceInputRatePerMillionUsd: 0,
      referenceOutputRatePerMillionUsd: 0,
    });

    expect(result.netSavingsUsd).toBe(0);
  });

  it("local model with all-zero costs produces zeroed result with priced:false", () => {
    const result = computeCosts({
      brainActualTotalCostUsd: 0,
      writerActualCostUsd: 0,
      brainOutputRatePerMillionUsd: 0,
      documentOutputTokens: 3000,
      blueprintOutputTokens: 0,
      brainInputTokens: 1200,
      referenceInputRatePerMillionUsd: 0,
      referenceOutputRatePerMillionUsd: 0,
    });

    expect(result.actualCostUsd).toBe(0);
    expect(result.baselineCostUsd).toBe(0);
    expect(result.netSavingsUsd).toBe(0);
    expect(result.priced).toBe(false);
    expect(result.baselineIsEstimate).toBe(false);
  });

  it("produces nonzero baseline and savings for a fully local brain run when a @plan reference rate is available", () => {
    // Regression: a local/custom brain model charges nothing and has no catalog
    // rate, so both baseline and net savings previously collapsed to $0.00 even
    // though the returned document still cost the brain model real money to produce.
    const result = computeCosts({
      brainActualTotalCostUsd: 0,
      writerActualCostUsd: 0,
      brainOutputRatePerMillionUsd: 0,
      documentOutputTokens: 2000,
      blueprintOutputTokens: 0,
      brainInputTokens: 1000,
      referenceInputRatePerMillionUsd: 3,   // e.g. claude-3-opus input rate
      referenceOutputRatePerMillionUsd: 15, // e.g. claude-3-opus output rate
    });

    expect(result.priced).toBe(false);
    expect(result.baselineIsEstimate).toBe(true);
    expect(result.actualCostUsd).toBe(0);

    // baseline = (brainInputTokens * ref input rate + documentOutputTokens * ref output rate) / 1e6
    const expectedBaseline = (1000 * 3 + 2000 * 15) / 1e6;
    expect(result.baselineCostUsd).toBeCloseTo(expectedBaseline, 8);
    expect(result.netSavingsUsd).toBeCloseTo(expectedBaseline, 8);
  });

  it("keeps net savings positive when a large shared exploration cost cancels out", () => {
    // Regression: the baseline used to price only the brain's *input* cost, so the
    // brain's own exploration/thinking output cost appeared on the actual side only.
    // The baseline then fell below the actual cost and every run clamped to $0.00
    // even though delegating the document to the writer still saved real money.
    const result = computeCosts({
      brainActualTotalCostUsd: 2.00, // large shared exploration cost, identical in both scenarios
      writerActualCostUsd: 0,        // free local writer, so the whole delegation delta is saved
      brainOutputRatePerMillionUsd: 15,
      documentOutputTokens: 3000,
      blueprintOutputTokens: 0,
      brainInputTokens: 500_000,
      referenceInputRatePerMillionUsd: 0,
      referenceOutputRatePerMillionUsd: 0,
    });

    expect(result.priced).toBe(true);
    expect(result.baselineIsEstimate).toBe(false);
    // baseline = the brain's own turn cost + the document's tokens priced at the brain's rate
    expect(result.baselineCostUsd).toBeCloseTo(2.00 + 0.045, 8);
    expect(result.actualCostUsd).toBeCloseTo(2.00, 8);
    // The shared 2.00 cancels; only the 0.045 delegation delta remains
    expect(result.netSavingsUsd).toBeCloseTo(0.045, 8);
  });
});
