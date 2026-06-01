import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

/**
 * Runs an `xcrun` subcommand and returns its trimmed stdout. Arguments are
 * always passed as an array (never interpolated into a shell string), so
 * device names, URLs, and status-bar values can't break out into shell
 * injection. Injecting a different `Runner` is how the tests drive the server
 * without a real simulator.
 */
export type Runner = (args: string[]) => string;

/** The real runner: shells out to `xcrun`. */
export const xcrun: Runner = (args) => {
  try {
    return execFileSync("xcrun", args, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024, // screenshots/JSON can be large
    }).trim();
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    throw new Error(
      err.stderr?.trim() || err.stdout?.trim() || err.message || String(e),
    );
  }
};

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------

/**
 * True when opt-in command logging is requested via `SIMULATOR_MCP_DEBUG`.
 * Any value except unset, empty, `"0"`, or `"false"` enables it.
 */
export function debugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.SIMULATOR_MCP_DEBUG;
  return (
    v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false"
  );
}

/**
 * Wraps a `Runner` so every issued command — and whether it succeeded or
 * threw — is logged to `log` (stderr by default). stderr is safe for an stdio
 * MCP server: it never touches the JSON-RPC stream on stdout. When logging is
 * disabled the original runner is returned untouched, so there is zero
 * overhead in the common case.
 */
export function withDebugLogging(
  run: Runner,
  log: (msg: string) => void = (m) => console.error(m),
  enabled: boolean = debugEnabled(),
): Runner {
  if (!enabled) return run;
  return (args) => {
    const cmd = `xcrun ${args.join(" ")}`;
    log(`[simulator-mcp] → ${cmd}`);
    try {
      const out = run(args);
      log(`[simulator-mcp] ✓ ${cmd}`);
      return out;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log(`[simulator-mcp] ✗ ${cmd} — ${message}`);
      throw e;
    }
  };
}

// ---------------------------------------------------------------------------
// Device resolution
// ---------------------------------------------------------------------------

/** A device entry as reported by `simctl list devices --json`. */
interface SimDevice {
  name: string;
  udid: string;
  state?: string;
  isAvailable?: boolean;
}

interface SimDeviceList {
  devices: Record<string, SimDevice[]>;
}

/** True if a string already looks like a simulator UDID. */
export function isUdid(value: string): boolean {
  return /^[0-9A-F-]{36}$/i.test(value);
}

/**
 * Resolves a device identifier — name or UDID — to a UDID usable by simctl.
 * `"booted"` and bare UDIDs pass straight through; names are matched
 * case-insensitively against available devices.
 */
export function resolveDevice(run: Runner, nameOrUdid: string): string {
  if (nameOrUdid === "booted") return "booted";
  if (isUdid(nameOrUdid)) return nameOrUdid;

  const parsed = JSON.parse(
    run(["simctl", "list", "devices", "--json"]),
  ) as SimDeviceList;

  for (const devices of Object.values(parsed.devices)) {
    const match = devices.find(
      (d) =>
        d.name.toLowerCase() === nameOrUdid.toLowerCase() &&
        d.isAvailable !== false,
    );
    if (match) return match.udid;
  }
  throw new Error(`No simulator found matching "${nameOrUdid}"`);
}

// ---------------------------------------------------------------------------
// Status bar argument building
// ---------------------------------------------------------------------------

export interface StatusBarOptions {
  time?: string;
  batteryLevel?: number;
  batteryState?: string;
  wifiMode?: string;
  wifiBars?: number;
  cellMode?: string;
  cellBars?: number;
  clear?: boolean;
}

/**
 * Builds the full `simctl statusbar` argument array for a device. With
 * `clear`, returns the clear command; otherwise an `override` with only the
 * provided flags. Numeric `0` values (e.g. `batteryLevel: 0`, `wifiBars: 0`)
 * are intentionally still emitted.
 */
export function buildStatusBarArgs(
  device: string,
  opts: StatusBarOptions,
): string[] {
  if (opts.clear) return ["simctl", "status_bar", device, "clear"];

  const args = ["simctl", "status_bar", device, "override"];
  if (opts.time !== undefined) args.push("--time", opts.time);
  if (opts.batteryLevel !== undefined)
    args.push("--batteryLevel", String(opts.batteryLevel));
  if (opts.batteryState !== undefined)
    args.push("--batteryState", opts.batteryState);
  if (opts.wifiMode !== undefined) args.push("--wifiMode", opts.wifiMode);
  if (opts.wifiBars !== undefined)
    args.push("--wifiBars", String(opts.wifiBars));
  if (opts.cellMode !== undefined) args.push("--cellularMode", opts.cellMode);
  if (opts.cellBars !== undefined)
    args.push("--cellularBars", String(opts.cellBars));
  return args;
}

// ---------------------------------------------------------------------------
// Device list formatting
// ---------------------------------------------------------------------------

/**
 * Formats the raw JSON from `simctl list devices --json` into a readable,
 * grouped-by-runtime listing. Runtimes with no available devices are skipped.
 */
export function formatDeviceList(rawJson: string): string {
  const parsed = JSON.parse(rawJson) as SimDeviceList;
  const lines: string[] = [];

  for (const [runtime, devices] of Object.entries(parsed.devices)) {
    const available = devices.filter((d) => d.isAvailable !== false && d.name);
    if (available.length === 0) continue;

    const label = runtime
      .replace("com.apple.CoreSimulator.SimRuntime.", "")
      .replace(/-(\d)/g, " $1");
    lines.push(`\n${label}`);

    for (const d of available) {
      const booted = d.state === "Booted" ? " ← booted" : "";
      lines.push(`  [${d.state}] ${d.name}${booted}`);
      lines.push(`          ${d.udid}`);
    }
  }

  return lines.join("\n").trim();
}
