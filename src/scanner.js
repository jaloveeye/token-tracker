import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { estimateCostUsd, loadPricing } from "./pricing.js";

const SUPPORTED_EXTENSIONS = new Set([".json", ".jsonl", ".ndjson"]);
const DEFAULT_CLIENT_ROOTS = [
  {
    client: "codex",
    paths: () => [
      path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions"),
      path.join(configDir(), "headless", "codex")
    ]
  },
  {
    client: "claude",
    paths: () => [
      path.join(os.homedir(), ".claude", "projects"),
      path.join(os.homedir(), ".claude", "transcripts")
    ]
  },
  {
    client: "opencode",
    paths: () => [path.join(os.homedir(), ".local", "share", "opencode", "storage", "message")]
  },
  {
    client: "gemini",
    paths: () => [path.join(os.homedir(), ".gemini", "tmp")]
  },
  {
    client: "imports",
    paths: () => [
      process.env.TOKEN_TRACKER_IMPORT_DIR,
      path.join(configDir(), "imports")
    ].filter(Boolean)
  }
];

export function discoverSources(options = {}) {
  const requestedClients = normalizeList(options.clients);
  const manualPaths = normalizeList(options.paths);

  if (manualPaths.length > 0) {
    return manualPaths.map((sourcePath) => ({
      client: inferClientFromPath(sourcePath),
      path: expandHome(sourcePath),
      exists: fs.existsSync(expandHome(sourcePath))
    }));
  }

  return DEFAULT_CLIENT_ROOTS
    .filter((root) => requestedClients.length === 0 || requestedClients.includes(root.client))
    .flatMap((root) =>
      root.paths().map((sourcePath) => ({
        client: root.client,
        path: sourcePath,
        exists: fs.existsSync(sourcePath)
      }))
    );
}

export async function scanUsage(options = {}) {
  const pricing = loadPricing(options.pricing);
  const since = options.since ? startOfDay(options.since) : null;
  const until = options.until ? endOfDay(options.until) : null;
  const files = [];

  for (const source of discoverSources(options).filter((item) => item.exists)) {
    for (const filePath of walkFiles(source.path)) {
      if (SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        files.push({ client: source.client, filePath });
      }
    }
  }

  const events = [];
  for (const file of files) {
    const parsedEvents = parseUsageFile(file.filePath, file.client);
    for (const event of parsedEvents) {
      if (since && event.timestamp && event.timestamp < since) continue;
      if (until && event.timestamp && event.timestamp > until) continue;
      event.costUsd = estimateCostUsd(event, pricing);
      events.push(event);
    }
  }

  events.sort((a, b) => (a.timestamp?.getTime() || 0) - (b.timestamp?.getTime() || 0));
  return {
    generatedAt: new Date().toISOString(),
    filters: {
      clients: normalizeList(options.clients),
      paths: normalizeList(options.paths),
      since: options.since || null,
      until: options.until || null
    },
    pricing: {
      currency: pricing.currency,
      unit: pricing.unit,
      usdPerCredit: pricing.usdPerCredit,
      label: pricing.label
    },
    totals: aggregateTotals(events),
    byClient: aggregateBy(events, "client"),
    byModel: aggregateBy(events, "model"),
    byDay: aggregateByDay(events),
    events
  };
}

export function parseUsageFile(filePath, fallbackClient = "unknown") {
  const text = fs.readFileSync(filePath, "utf8");
  const values = parseJsonLike(text);
  const events = [];
  const context = {
    filePath,
    fallbackClient,
    events,
    seen: new WeakSet(),
    defaultModel: ""
  };

  for (const value of values) {
    context.seen = new WeakSet();
    collectUsageEvents(value, context);
  }

  return dedupeEvents(events);
}

function parseJsonLike(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return [JSON.parse(trimmed)];
    } catch {
      return parseJsonLines(text);
    }
  }

  return parseJsonLines(text);
}

function parseJsonLines(text) {
  const values = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) continue;
    try {
      values.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }
  return values;
}

function collectUsageEvents(value, context) {
  if (!value || typeof value !== "object") return;
  if (context.seen.has(value)) return;
  context.seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectUsageEvents(item, context);
    return;
  }

  updateRecordContext(value, context);

  const codexUsage = findCodexTokenUsage(value);
  if (codexUsage) {
    const event = normalizeUsageEvent(value, codexUsage, context.filePath, context.fallbackClient, context);
    if (event.totalTokens > 0) context.events.push(event);
    return;
  }

  const usage = findUsagePayload(value);
  if (usage) {
    const event = normalizeUsageEvent(value, usage, context.filePath, context.fallbackClient, context);
    if (event.totalTokens > 0) context.events.push(event);
  }

  for (const child of Object.values(value)) {
    if (usage && child === usage) continue;
    if (child && typeof child === "object") collectUsageEvents(child, context);
  }
}

function updateRecordContext(record, context) {
  const model = record?.type === "turn_context" ? record?.payload?.model : null;
  if (typeof model === "string" && model.trim()) {
    context.defaultModel = model.trim();
  }
}

function findCodexTokenUsage(record) {
  if (record?.type !== "event_msg") return null;
  if (record?.payload?.type !== "token_count") return null;
  return record.payload.info?.last_token_usage || null;
}

function findUsagePayload(record) {
  const candidates = [
    record.usage,
    record.tokenUsage,
    record.token_usage,
    record.tokens,
    record.metrics?.usage,
    record.message?.usage,
    record.response?.usage,
    record.metadata?.usage,
    record.metadata?.tokenUsage,
    record.metadata?.codebuff?.usage,
    record
  ];

  return candidates.find((candidate) => candidate && tokenTotal(candidate) > 0) || null;
}

function normalizeUsageEvent(record, usage, filePath, fallbackClient, context = {}) {
  const inputTokens = pickNumber(usage, [
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "promptTokens",
    "input",
    "prompt"
  ]);
  const outputTokens = pickNumber(usage, [
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens",
    "output",
    "completion"
  ]);
  const cacheReadTokens = pickNumber(usage, [
    "cache_read_tokens",
    "cacheReadTokens",
    "cached_input_tokens",
    "cachedInputTokens",
    "cache_read",
    "cacheRead",
    ["cache", "read"]
  ]);
  const cacheReadIncludedInInput = hasPositiveNumber(usage, ["cached_input_tokens", "cachedInputTokens"]);
  const cacheWriteTokens = pickNumber(usage, [
    "cache_write_tokens",
    "cacheWriteTokens",
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "cache_write",
    "cacheWrite",
    ["cache", "write"]
  ]);
  const reasoningTokens = pickNumber(usage, [
    "reasoning_tokens",
    "reasoningTokens",
    "reasoning_output_tokens",
    "reasoningOutputTokens",
    "thoughts_tokens",
    "thoughtsTokens",
    "reasoning"
  ]);
  const reportedTotalTokens = pickNumber(usage, ["total_tokens", "totalTokens"]);

  const timestamp = findTimestamp(record) || findTimestamp(usage) || fileMtime(filePath);
  return {
    client: normalizeString(findString(record, ["client", "source", "app", "tool"])) || fallbackClient,
    provider: normalizeString(findString(record, ["provider", "providerID", "provider_id"])) || "unknown",
    model: normalizeString(findString(record, ["model", "modelID", "model_id", "modelName", "model_slug"])) || context.defaultModel || "unknown",
    timestamp,
    date: timestamp ? formatDateInTimeZone(timestamp, "Asia/Seoul") : "unknown",
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    billableInputTokens: cacheReadIncludedInInput ? Math.max(0, inputTokens - cacheReadTokens) : inputTokens,
    totalTokens: reportedTotalTokens || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens,
    costUsd: 0,
    path: filePath
  };
}

function tokenTotal(value) {
  return (
    pickNumber(value, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens", "input", "prompt"]) +
    pickNumber(value, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens", "output", "completion"]) +
    pickNumber(value, ["cache_read_tokens", "cacheReadTokens", "cached_input_tokens", "cachedInputTokens", "cache_read", "cacheRead", ["cache", "read"]]) +
    pickNumber(value, ["cache_write_tokens", "cacheWriteTokens", "cache_creation_input_tokens", "cacheCreationInputTokens", "cache_write", "cacheWrite", ["cache", "write"]]) +
    pickNumber(value, ["reasoning_tokens", "reasoningTokens", "reasoning_output_tokens", "reasoningOutputTokens", "thoughts_tokens", "thoughtsTokens", "reasoning"])
  );
}

function pickNumber(object, keys) {
  for (const key of keys) {
    const value = Array.isArray(key) ? getPath(object, key) : object?.[key];
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function hasPositiveNumber(object, keys) {
  return keys.some((key) => {
    const value = Array.isArray(key) ? getPath(object, key) : object?.[key];
    const number = Number(value);
    return Number.isFinite(number) && number > 0;
  });
}

function findString(record, keys) {
  for (const key of keys) {
    if (typeof record?.[key] === "string" && record[key].trim()) return record[key];
  }

  for (const value of Object.values(record || {})) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const found = findString(value, keys);
    if (found) return found;
  }

  return null;
}

function findTimestamp(record) {
  const direct = [
    record?.timestamp,
    record?.created_at,
    record?.createdAt,
    record?.updated_at,
    record?.updatedAt,
    record?.started_at,
    record?.startedAt,
    record?.time?.created,
    record?.time?.createdAt,
    record?.message?.created_at,
    record?.message?.createdAt
  ].find(Boolean);

  return parseTimestamp(direct);
}

function parseTimestamp(value) {
  if (!value) return null;
  if (typeof value === "number") {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && /^\d+$/.test(value)) return parseTimestamp(numeric);
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function walkFiles(rootPath) {
  const result = [];
  const stack = [rootPath];

  while (stack.length > 0) {
    const current = stack.pop();
    let stat;
    try {
      stat = fs.statSync(current);
    } catch {
      continue;
    }

    if (stat.isFile()) {
      result.push(current);
      continue;
    }

    if (!stat.isDirectory()) continue;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".codex") continue;
      stack.push(path.join(current, entry.name));
    }
  }

  return result;
}

function aggregateTotals(events) {
  return events.reduce(
    (totals, event) => addEvent(totals, event),
    emptyAggregate("total")
  );
}

function aggregateBy(events, key) {
  const map = new Map();
  for (const event of events) {
    const value = event[key] || "unknown";
    if (!map.has(value)) map.set(value, emptyAggregate(value));
    addEvent(map.get(value), event);
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function aggregateByDay(events) {
  const map = new Map();
  for (const event of events) {
    const value = event.date || "unknown";
    if (!map.has(value)) map.set(value, emptyAggregate(value));
    addEvent(map.get(value), event);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function addEvent(target, event) {
  target.events += 1;
  target.inputTokens += event.inputTokens;
  target.outputTokens += event.outputTokens;
  target.cacheReadTokens += event.cacheReadTokens;
  target.cacheWriteTokens += event.cacheWriteTokens;
  target.reasoningTokens += event.reasoningTokens;
  target.totalTokens += event.totalTokens;
  target.costUsd += event.costUsd || 0;
  return target;
}

function emptyAggregate(name) {
  return {
    name,
    events: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: 0
  };
}

function dedupeEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = [
      event.path,
      event.timestamp,
      event.client,
      event.provider,
      event.model,
      event.inputTokens,
      event.outputTokens,
      event.cacheReadTokens,
      event.cacheWriteTokens,
      event.reasoningTokens
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function startOfDay(value) {
  const date = new Date(`${value}T00:00:00+09:00`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid --since date: ${value}`);
  return date;
}

function endOfDay(value) {
  const date = new Date(`${value}T23:59:59.999+09:00`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid --until date: ${value}`);
  return date;
}

function fileMtime(filePath) {
  try {
    return fs.statSync(filePath).mtime;
  } catch {
    return null;
  }
}

function getPath(object, parts) {
  return parts.reduce((current, part) => current?.[part], object);
}

function normalizeList(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean);
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function inferClientFromPath(sourcePath) {
  const lower = sourcePath.toLowerCase();
  for (const client of ["codex", "claude", "opencode", "gemini", "cursor", "amp"]) {
    if (lower.includes(client)) return client;
  }
  return "imports";
}

function configDir() {
  return process.env.TOKEN_TRACKER_CONFIG_DIR || path.join(os.homedir(), ".config", "token-tracker");
}

function formatDateInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
