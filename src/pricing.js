import fs from "node:fs";

const EMPTY_PRICING = {
  currency: "credits",
  unit: "per_1m_tokens",
  usdPerCredit: 0.04,
  label: "",
  models: []
};

export function loadPricing(filePath) {
  if (!filePath) return EMPTY_PRICING;
  if (!fs.existsSync(filePath)) {
    throw new Error(`Pricing file not found: ${filePath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return {
    currency: parsed.currency || EMPTY_PRICING.currency,
    unit: parsed.unit || "per_1m_tokens",
    usdPerCredit: Number.isFinite(Number(parsed.usdPerCredit)) ? Number(parsed.usdPerCredit) : EMPTY_PRICING.usdPerCredit,
    label: parsed.label || "",
    models: Array.isArray(parsed.models) ? parsed.models : []
  };
}

export function estimateCostUsd(event, pricing) {
  const model = event.model || "unknown";
  const row = findModelPricing(model, pricing);
  if (!row) return 0;

  const million = 1_000_000;
  const inputTokens = Number.isFinite(event.billableInputTokens) ? event.billableInputTokens : event.inputTokens;
  return (
    (inputTokens / million) * numberOrZero(row.input) +
    (event.outputTokens / million) * numberOrZero(row.output) +
    (event.cacheReadTokens / million) * numberOrZero(row.cacheRead) +
    (event.cacheWriteTokens / million) * numberOrZero(row.cacheWrite) +
    (event.reasoningTokens / million) * numberOrZero(row.reasoning)
  );
}

function findModelPricing(model, pricing) {
  for (const row of pricing.models || []) {
    if (!row.match) continue;
    if (safeRegex(row.match).test(model)) return row;
  }
  return null;
}

function safeRegex(pattern) {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(`^${escapeRegExp(pattern)}$`, "i");
  }
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
