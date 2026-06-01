import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

/**
 * Runs an `xcrun` subcommand and resolves with its trimmed stdout. Arguments
 * are always passed as an array (never interpolated into a shell string), so
 * device names, URLs, and status-bar values can't break out into shell
 * injection. The call is async so it never blocks the Node event loop — even
 * while a large screenshot or JSON payload is read off the pipe. Injecting a
 * different `Runner` is how the tests drive the server without a real
 * simulator.
 */
export type Runner = (args: string[]) => Promise<string>;

/** The real runner: shells out to `xcrun`. */
export const xcrun: Runner = async (args) => {
  try {
    const { stdout } = await execFileAsync("xcrun", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024, // screenshots/JSON can be large
    });
    return stdout.trim();
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    throw new Error(
      err.stderr?.trim() || err.stdout?.trim() || err.message || String(e),
    );
  }
};

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
  return /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(
    value,
  );
}

/**
 * Resolves a device identifier — name or UDID — to a UDID usable by simctl.
 * `"booted"` and bare UDIDs pass straight through; names are matched
 * case-insensitively against available devices.
 */
export async function resolveDevice(
  run: Runner,
  nameOrUdid: string,
): Promise<string> {
  if (nameOrUdid === "booted") return "booted";
  if (isUdid(nameOrUdid)) return nameOrUdid;

  const parsed = JSON.parse(
    await run(["simctl", "list", "devices", "--json"]),
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
