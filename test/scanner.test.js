import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseUsageFile, scanUsage } from "../src/scanner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, "fixtures");

describe("scanner", () => {
  it("parses JSONL usage records", () => {
    const events = parseUsageFile(path.join(fixtures, "codex-session.jsonl"), "codex");

    assert.equal(events.length, 2);
    assert.equal(events[0].client, "codex");
    assert.equal(events[0].model, "gpt-4o");
    assert.equal(events[0].inputTokens, 1000);
    assert.equal(events[0].outputTokens, 500);
    assert.equal(events[0].cacheReadTokens, 200);
    assert.equal(events[0].reasoningTokens, 50);
  });

  it("finds nested JSON usage records", () => {
    const events = parseUsageFile(path.join(fixtures, "claude-session.json"), "claude");

    assert.equal(events.length, 1);
    assert.equal(events[0].client, "claude");
    assert.equal(events[0].provider, "anthropic");
    assert.equal(events[0].cacheWriteTokens, 400);
    assert.equal(events[0].totalTokens, 4400);
  });

  it("aggregates explicit paths with date filters", async () => {
    const report = await scanUsage({
      paths: [path.join(fixtures, "codex-session.jsonl"), path.join(fixtures, "claude-session.json")],
      since: "2026-05-02",
      until: "2026-05-03"
    });

    assert.equal(report.totals.events, 2);
    assert.equal(report.totals.totalTokens, 7100);
    assert.deepEqual(report.byDay.map((day) => day.name), ["2026-05-02", "2026-05-03"]);
  });

  it("uses Korea time for day grouping", () => {
    const events = parseUsageFile(path.join(fixtures, "kst-session.jsonl"), "codex");

    assert.equal(events.length, 1);
    assert.equal(events[0].date, "2026-05-02");
  });

  it("uses Codex last_token_usage instead of cumulative total_token_usage", () => {
    const events = parseUsageFile(path.join(fixtures, "codex-token-count.jsonl"), "codex");

    assert.equal(events.length, 1);
    assert.equal(events[0].inputTokens, 1200);
    assert.equal(events[0].model, "gpt-5.5");
    assert.equal(events[0].cacheReadTokens, 800);
    assert.equal(events[0].outputTokens, 100);
    assert.equal(events[0].reasoningTokens, 20);
    assert.equal(events[0].billableInputTokens, 400);
    assert.equal(events[0].totalTokens, 1300);
  });

  it("applies credit pricing by matched model", async () => {
    const report = await scanUsage({
      paths: [path.join(fixtures, "codex-token-count.jsonl")],
      pricing: path.join(__dirname, "..", "config", "pricing.example.json")
    });

    assert.equal(report.pricing.currency, "credits");
    assert.equal(Number(report.totals.costUsd.toFixed(3)), 0.15);
  });
});
