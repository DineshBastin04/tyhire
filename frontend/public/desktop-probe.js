#!/usr/bin/env node
/**
 * POC desktop probe for Section 2's "background app monitor" and "external display
 * detection" — the two features a browser genuinely cannot see on its own.
 *
 * This is a proof-of-mechanism, not a distributable product: a real candidate won't have
 * Node.js installed, so shipping this .js file is a POC stand-in for what would eventually
 * be a compiled native binary with an installer. What IS real here: it actually runs, lists
 * real processes, actually detects real monitor count, and actually reports to the backend
 * over the same /signals + /probe-heartbeat endpoints the rest of the integrity pipeline
 * uses — nothing about the reporting side is mocked.
 *
 * Usage:
 *   node probe.js --session-id <uuid> [--api-base http://localhost:8000/api/v1]
 */

const { execSync } = require("child_process");
const os = require("os");

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    apiBase: "http://localhost:8000/api/v1",
    intervalSeconds: 5,
    blockedApps: ["chatgpt", "anydesk", "teamviewer", "obs", "discord"],
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session-id") config.sessionId = args[++i];
    else if (args[i] === "--api-base") config.apiBase = args[++i];
    else if (args[i] === "--interval") config.intervalSeconds = Number(args[++i]);
    else if (args[i] === "--blocked-apps") {
      config.blockedApps = args[++i].split(",").map((s) => s.trim().toLowerCase());
    }
  }

  if (!config.sessionId) {
    console.error("Usage: node probe.js --session-id <uuid> [--api-base <url>]");
    process.exit(1);
  }
  return config;
}

function listProcessNames() {
  try {
    if (os.platform() === "win32") {
      const output = execSync("tasklist /FO CSV /NH", { encoding: "utf8" });
      return output
        .split("\n")
        .map((line) => (line.split('","')[0] || "").replace(/^"/, "").toLowerCase())
        .filter(Boolean);
    }
    const output = execSync("ps -A -o comm=", { encoding: "utf8" });
    return output
      .split("\n")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  } catch (err) {
    console.error("[probe] could not list processes:", err.message);
    return [];
  }
}

function countDisplays() {
  try {
    if (os.platform() === "win32") {
      const script =
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens.Length";
      const output = execSync(`powershell -NoProfile -Command "${script}"`, { encoding: "utf8" });
      return parseInt(output.trim(), 10) || 1;
    }
    // Display enumeration on macOS/Linux isn't implemented in this POC — Windows is the
    // primary target here. Reporting 1 avoids false external-display flags on those platforms.
    return 1;
  } catch (err) {
    console.error("[probe] could not count displays:", err.message);
    return 1;
  }
}

async function post(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function tick(config, startedAt) {
  const processes = listProcessNames();
  const matched = [...new Set(processes.filter((p) => config.blockedApps.some((b) => p.includes(b))))];
  const displayCount = countDisplays();
  const offsetMs = Date.now() - startedAt;

  const events = [];
  if (matched.length > 0) {
    events.push({
      signal_type: "unauthorized_app_detected",
      session_offset_ms: offsetMs,
      weight: 8,
      meta: { apps: matched },
    });
  }
  if (displayCount > 1) {
    events.push({
      signal_type: "external_display_detected",
      session_offset_ms: offsetMs,
      weight: 8,
      meta: { display_count: displayCount },
    });
  }

  if (events.length > 0) {
    const res = await post(`${config.apiBase}/interviews/${config.sessionId}/signals`, events);
    console.log(
      `[probe] ${new Date().toISOString()} reported ${events.length} signal(s) ` +
        `(${events.map((e) => e.signal_type).join(", ")}) -> HTTP ${res.status}`
    );
  }

  const heartbeat = await post(`${config.apiBase}/interviews/${config.sessionId}/probe-heartbeat`, {});
  console.log(`[probe] ${new Date().toISOString()} heartbeat -> HTTP ${heartbeat.status}`);
}

async function main() {
  const config = parseArgs();
  const startedAt = Date.now();

  console.log(`[probe] monitoring session ${config.sessionId}`);
  console.log(`[probe] reporting to ${config.apiBase}`);
  console.log(`[probe] blocked apps: ${config.blockedApps.join(", ")}`);
  console.log(`[probe] checking every ${config.intervalSeconds}s — leave this running`);

  await tick(config, startedAt).catch((err) => console.error("[probe] tick failed:", err.message));
  setInterval(() => {
    tick(config, startedAt).catch((err) => console.error("[probe] tick failed:", err.message));
  }, config.intervalSeconds * 1000);
}

main();
