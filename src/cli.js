#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSources, scanUsage } from "./scanner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

main().catch((error) => {
  console.error(`token-tracker: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  applyDefaultPricing(options);

  if (options.help || command === "help") {
    printHelp();
    return;
  }

  if (command === "sources") {
    printSources(discoverSources(options), options);
    return;
  }

  if (command === "dashboard") {
    const report = await scanUsage(options);
    const output = options.out || path.join(process.cwd(), "reports", "token-dashboard.html");
    writeDashboard(report, output, { live: false });
    console.log(`Dashboard written to ${output}`);
    if (options.serve) serveFile(output, Number(options.port || 4173), options.host || "localhost");
    return;
  }

  if (command === "live" || command === "serve") {
    await serveLiveDashboard(options, Number(options.port || 4173), options.host || "localhost");
    return;
  }

  if (command === "scan" || !command) {
    const report = await scanUsage(options);
    if (options.out) writeJson(options.out, report);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
      if (options.out) console.log(`\nJSON written to ${options.out}`);
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function applyDefaultPricing(options) {
  if (options.pricing) return;
  const defaultPricing = path.join(__dirname, "..", "config", "pricing.example.json");
  if (fs.existsSync(defaultPricing)) options.pricing = defaultPricing;
}

function parseArgs(args) {
  const command = args[0] && !args[0].startsWith("-") ? args.shift() : "scan";
  const options = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => args[++i];

    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--serve") options.serve = true;
    else if (arg === "--open=false") options.open = false;
    else if (arg === "--client" || arg === "-c") push(options, "clients", next());
    else if (arg.startsWith("--client=")) push(options, "clients", arg.slice("--client=".length));
    else if (arg === "--path" || arg === "-p") push(options, "paths", next());
    else if (arg.startsWith("--path=")) push(options, "paths", arg.slice("--path=".length));
    else if (arg === "--since") options.since = next();
    else if (arg.startsWith("--since=")) options.since = arg.slice("--since=".length);
    else if (arg === "--until") options.until = next();
    else if (arg.startsWith("--until=")) options.until = arg.slice("--until=".length);
    else if (arg === "--pricing") options.pricing = next();
    else if (arg.startsWith("--pricing=")) options.pricing = arg.slice("--pricing=".length);
    else if (arg === "--out" || arg === "-o") options.out = next();
    else if (arg.startsWith("--out=")) options.out = arg.slice("--out=".length);
    else if (arg === "--port") options.port = next();
    else if (arg.startsWith("--port=")) options.port = arg.slice("--port=".length);
    else if (arg === "--host") options.host = next();
    else if (arg.startsWith("--host=")) options.host = arg.slice("--host=".length);
    else if (arg === "--refresh") options.refresh = next();
    else if (arg.startsWith("--refresh=")) options.refresh = arg.slice("--refresh=".length);
    else throw new Error(`Unknown option: ${arg}`);
  }

  return { command, options };
}

function push(options, key, value) {
  if (!value) throw new Error(`Missing value for --${key}`);
  if (!options[key]) options[key] = [];
  options[key].push(value);
}

function printHelp() {
  console.log(`token-tracker

Usage:
  token-tracker scan [options]
  token-tracker sources [options]
  token-tracker dashboard [options]
  token-tracker live [options]

Options:
  -c, --client <name>       Filter clients: codex, claude, opencode, gemini, imports
  -p, --path <dir-or-file>  Scan explicit files/directories instead of default locations
      --since <YYYY-MM-DD>  Include records on or after date
      --until <YYYY-MM-DD>  Include records on or before date
      --pricing <file>      Apply model prices from config/pricing.example.json format
      --json                Print JSON
  -o, --out <file>          Write JSON or dashboard output
      --serve               Serve dashboard locally after writing it
      --port <number>       Dashboard server port, default 4173
      --host <host>         Dashboard server host, default localhost
      --refresh <seconds>   Live dashboard refresh interval, default 10
  -h, --help                Show this help
`);
}

function printSources(sources, options) {
  if (options.json) {
    console.log(JSON.stringify(sources, null, 2));
    return;
  }

  console.log("Client    Status   Path");
  console.log("--------  -------  ----");
  for (const source of sources) {
    console.log(`${pad(source.client, 8)}  ${pad(source.exists ? "found" : "missing", 7)}  ${source.path}`);
  }
}

function printReport(report) {
  const totals = report.totals;
  console.log("Token Tracker Summary");
  console.log("=====================");
  console.log(`Events:     ${formatNumber(totals.events)}`);
  console.log(`Tokens:     ${formatNumber(totals.totalTokens)}`);
  console.log(`Input:      ${formatNumber(totals.inputTokens)}`);
  console.log(`Output:     ${formatNumber(totals.outputTokens)}`);
  console.log(`Cache read: ${formatNumber(totals.cacheReadTokens)}`);
  console.log(`Cache write:${formatNumber(totals.cacheWriteTokens)}`);
  console.log(`Reasoning:  ${formatNumber(totals.reasoningTokens)}`);
  if (totals.costUsd > 0) console.log(`Cost:       ${formatCost(totals.costUsd, report.pricing)}`);
  if (report.pricing?.label) console.log(`Pricing:    ${report.pricing.label}`);

  printTable("\nBy client", report.byClient.slice(0, 12), report.pricing);
  printTable("\nBy model", report.byModel.slice(0, 12), report.pricing);
}

function printTable(title, rows, pricing) {
  console.log(title);
  console.log("Name                              Events        Tokens                        Cost");
  console.log("--------------------------------  ------  ------------  --------------------------");
  if (rows.length === 0) {
    console.log("(no usage records found)");
    return;
  }
  for (const row of rows) {
    console.log(`${pad(truncate(row.name, 32), 32)}  ${pad(formatNumber(row.events), 6)}  ${pad(formatNumber(row.totalTokens), 12)}  ${pad(row.costUsd ? formatCost(row.costUsd, pricing) : "-", 26)}`);
  }
}

function writeJson(output, report) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
}

function writeDashboard(report, output, options = {}) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const html = renderDashboard(report, options);
  fs.writeFileSync(output, html);
}

function renderDashboard(report, options = {}) {
  const template = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.html"), "utf8");
  return template.replace(
    "/*__TOKEN_TRACKER_DATA__*/",
    [
      `window.TOKEN_TRACKER_DATA = ${JSON.stringify(report)};`,
      `window.TOKEN_TRACKER_LIVE = ${JSON.stringify(Boolean(options.live))};`,
      `window.TOKEN_TRACKER_REFRESH_MS = ${JSON.stringify(Number(options.refreshMs || 10_000))};`
    ].join("\n      ")
  );
}

function serveFile(filePath, port, host) {
  const html = fs.readFileSync(filePath);
  const server = http.createServer((request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(html);
  });
  server.on("error", handleServerError);
  server.listen(port, host, () => {
    console.log(`Dashboard available at http://${host}:${port}`);
  });
}

async function serveLiveDashboard(options, port, host) {
  let latestReport = await scanUsage(options);
  const refreshMs = Math.max(1, Number(options.refresh || 10)) * 1000;

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

      if (url.pathname === "/api/report") {
        latestReport = await scanUsage(options);
        sendJson(response, latestReport);
        return;
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store"
        });
        response.end(renderDashboard(latestReport, { live: true, refreshMs }));
        return;
      }

      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error.message }));
    }
  });

  server.on("error", handleServerError);
  server.listen(port, host, () => {
    console.log(`Live dashboard available at http://${host}:${port}`);
    console.log(`Refreshing every ${refreshMs / 1000}s`);
  });
}

function handleServerError(error) {
  if (error.code === "EADDRINUSE") {
    console.error(`token-tracker: port is already in use. Try --port ${Number(error.port || 4173) + 1}`);
  } else {
    console.error(`token-tracker: failed to start web server: ${error.message}`);
  }
  process.exitCode = 1;
}

function sendJson(response, value) {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(value));
}

function pad(value, width) {
  return String(value).padEnd(width).slice(0, width);
}

function truncate(value, width) {
  const text = String(value);
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value || 0);
}

function formatCost(value, pricing) {
  if (!value) return "-";
  const currency = pricing?.currency || "credits";
  if (currency.toLowerCase() === "usd") return `$${value.toFixed(4)}`;
  if (currency.toLowerCase() === "credits") {
    const usdPerCredit = Number(pricing?.usdPerCredit || 0.04);
    return `${formatNumber(roundCost(value))} credits (~$${(value * usdPerCredit).toFixed(2)})`;
  }
  return `${roundCost(value)} ${currency}`;
}

function roundCost(value) {
  return Math.round(value * 1000) / 1000;
}
