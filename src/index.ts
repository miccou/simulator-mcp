#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run an `xcrun` subcommand. Arguments are passed as an array (never
 * interpolated into a shell string) so device names, URLs, and status-bar
 * values can't break out into shell injection.
 */
function xcrun(args: string[]): string {
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
}

/** Resolve a device identifier — name or UDID — to a UDID usable by simctl. */
function resolveDevice(nameOrUdid: string): string {
  if (nameOrUdid === "booted") return "booted";
  // If it looks like a UDID already (hex + dashes) just return it
  if (/^[0-9A-F-]{36}$/i.test(nameOrUdid)) return nameOrUdid;
  // Otherwise find a matching device name
  const raw = xcrun(["simctl", "list", "devices", "--json"]);
  const parsed = JSON.parse(raw) as {
    devices: Record<
      string,
      Array<{ name: string; udid: string; isAvailable: boolean }>
    >;
  };
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

/** Read the `device` argument, defaulting to "booted", and resolve it. */
function deviceArg(args: Record<string, unknown>): string {
  return resolveDevice((args.device as string | undefined) ?? "booted");
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "ios-simulator", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const DEVICE_PROP = {
  device: {
    type: "string",
    description: 'Device name, UDID, or "booted" (default)',
    default: "booted",
  },
} as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ── Visual ──────────────────────────────────────────────────────────────
    {
      name: "screenshot",
      description:
        "Capture a screenshot of the booted iOS Simulator. " +
        "Returns the image as base64 PNG so you can visually inspect the UI. " +
        "Use this after navigating or tapping to see the current state.",
      inputSchema: {
        type: "object",
        properties: { ...DEVICE_PROP },
      },
    },

    // ── Navigation ───────────────────────────────────────────────────────────
    {
      name: "open_url",
      description:
        "Open a URL in Safari on the booted iOS Simulator. " +
        "Use http://localhost:3000 to preview the local dev server. " +
        "Also works with custom app URL schemes for deep-linking.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to open" },
          ...DEVICE_PROP,
        },
        required: ["url"],
      },
    },

    // ── Touch ────────────────────────────────────────────────────────────────
    {
      name: "tap",
      description:
        "Simulate a finger tap at (x, y) coordinates on the booted Simulator screen. " +
        "Take a screenshot first to find the coordinates you want to tap.",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "X coordinate in points" },
          y: { type: "number", description: "Y coordinate in points" },
          ...DEVICE_PROP,
        },
        required: ["x", "y"],
      },
    },
    {
      name: "swipe",
      description:
        "Simulate a swipe gesture on the booted Simulator. " +
        "Use to scroll: swipe from (centerX, bottom) to (centerX, top) to scroll down.",
      inputSchema: {
        type: "object",
        properties: {
          x1: { type: "number", description: "Start X" },
          y1: { type: "number", description: "Start Y" },
          x2: { type: "number", description: "End X" },
          y2: { type: "number", description: "End Y" },
          duration: {
            type: "number",
            description: "Gesture duration in milliseconds (default 500)",
            default: 500,
          },
          ...DEVICE_PROP,
        },
        required: ["x1", "y1", "x2", "y2"],
      },
    },

    // ── Appearance ───────────────────────────────────────────────────────────
    {
      name: "set_appearance",
      description: "Switch the booted Simulator between light and dark mode.",
      inputSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["light", "dark"],
            description: "Appearance mode",
          },
          ...DEVICE_PROP,
        },
        required: ["mode"],
      },
    },
    {
      name: "set_status_bar",
      description:
        "Override the status bar on the booted Simulator for clean screenshots " +
        "(e.g. set time to 9:41, full battery). Pass clear: true to reset.",
      inputSchema: {
        type: "object",
        properties: {
          time: { type: "string", description: 'Display time, e.g. "9:41"' },
          batteryLevel: { type: "number", description: "Battery level 0–100" },
          batteryState: {
            type: "string",
            enum: ["charging", "charged", "discharging"],
          },
          wifiMode: {
            type: "string",
            enum: ["searching", "failed", "active"],
          },
          wifiBars: { type: "number", minimum: 0, maximum: 3 },
          cellMode: {
            type: "string",
            enum: ["notSupported", "searching", "failed", "active"],
          },
          cellBars: { type: "number", minimum: 0, maximum: 4 },
          clear: {
            type: "boolean",
            description: "Clear all status bar overrides",
          },
          ...DEVICE_PROP,
        },
      },
    },

    // ── Device management ────────────────────────────────────────────────────
    {
      name: "list_devices",
      description:
        "List all available iOS Simulator devices with their state (Booted / Shutdown).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "boot",
      description:
        "Boot an iOS Simulator device by name or UDID and open the Simulator app.",
      inputSchema: {
        type: "object",
        properties: {
          device: {
            type: "string",
            description: 'Device name or UDID, e.g. "iPhone 16 Pro"',
          },
        },
        required: ["device"],
      },
    },
    {
      name: "shutdown",
      description: "Shutdown an iOS Simulator device.",
      inputSchema: {
        type: "object",
        properties: { ...DEVICE_PROP },
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      // ── screenshot ─────────────────────────────────────────────────────────
      case "screenshot": {
        const device = deviceArg(args);
        const file = join(tmpdir(), `sim-${Date.now()}.png`);
        try {
          xcrun(["simctl", "io", device, "screenshot", file]);
          const base64 = readFileSync(file).toString("base64");
          return {
            content: [{ type: "image", data: base64, mimeType: "image/png" }],
          };
        } finally {
          if (existsSync(file)) unlinkSync(file);
        }
      }

      // ── open_url ───────────────────────────────────────────────────────────
      case "open_url": {
        const device = deviceArg(args);
        const url = args.url as string;
        xcrun(["simctl", "openurl", device, url]);
        return { content: [{ type: "text", text: `Opened: ${url}` }] };
      }

      // ── tap ────────────────────────────────────────────────────────────────
      case "tap": {
        const device = deviceArg(args);
        const x = args.x as number;
        const y = args.y as number;
        xcrun(["simctl", "io", device, "tap", String(x), String(y)]);
        return { content: [{ type: "text", text: `Tapped (${x}, ${y})` }] };
      }

      // ── swipe ──────────────────────────────────────────────────────────────
      case "swipe": {
        const device = deviceArg(args);
        const {
          x1,
          y1,
          x2,
          y2,
          duration = 500,
        } = args as {
          x1: number;
          y1: number;
          x2: number;
          y2: number;
          duration?: number;
        };
        xcrun([
          "simctl",
          "io",
          device,
          "swipe",
          String(x1),
          String(y1),
          String(x2),
          String(y2),
          String(duration),
        ]);
        return {
          content: [
            {
              type: "text",
              text: `Swiped (${x1},${y1}) → (${x2},${y2}) over ${duration}ms`,
            },
          ],
        };
      }

      // ── set_appearance ─────────────────────────────────────────────────────
      case "set_appearance": {
        const device = deviceArg(args);
        const mode = args.mode as string;
        xcrun(["simctl", "ui", device, "appearance", mode]);
        return {
          content: [{ type: "text", text: `Appearance set to ${mode}` }],
        };
      }

      // ── set_status_bar ─────────────────────────────────────────────────────
      case "set_status_bar": {
        const device = deviceArg(args);
        if (args.clear) {
          xcrun(["simctl", "statusbar", device, "clear"]);
          return {
            content: [{ type: "text", text: "Status bar overrides cleared" }],
          };
        }
        const parts = ["simctl", "statusbar", device, "override"];
        if (args.time) parts.push("--time", args.time as string);
        if (args.batteryLevel !== undefined)
          parts.push("--batteryLevel", String(args.batteryLevel as number));
        if (args.batteryState)
          parts.push("--batteryState", args.batteryState as string);
        if (args.wifiMode) parts.push("--wifiMode", args.wifiMode as string);
        if (args.wifiBars !== undefined)
          parts.push("--wifiBars", String(args.wifiBars as number));
        if (args.cellMode) parts.push("--cellMode", args.cellMode as string);
        if (args.cellBars !== undefined)
          parts.push("--cellBars", String(args.cellBars as number));
        xcrun(parts);
        return { content: [{ type: "text", text: "Status bar updated" }] };
      }

      // ── list_devices ───────────────────────────────────────────────────────
      case "list_devices": {
        const raw = xcrun(["simctl", "list", "devices", "--json"]);
        const parsed = JSON.parse(raw) as {
          devices: Record<
            string,
            Array<{
              name: string;
              udid: string;
              state: string;
              isAvailable: boolean;
            }>
          >;
        };
        const lines: string[] = [];
        for (const [runtime, devices] of Object.entries(parsed.devices)) {
          const available = devices.filter(
            (d) => d.isAvailable !== false && d.name,
          );
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
        return { content: [{ type: "text", text: lines.join("\n").trim() }] };
      }

      // ── boot ───────────────────────────────────────────────────────────────
      case "boot": {
        const udid = resolveDevice(args.device as string);
        xcrun(["simctl", "boot", udid]);
        execFileSync("open", ["-a", "Simulator"], { stdio: "ignore" });
        return {
          content: [
            {
              type: "text",
              text: `Booted: ${args.device as string} (${udid})`,
            },
          ],
        };
      }

      // ── shutdown ───────────────────────────────────────────────────────────
      case "shutdown": {
        const device = deviceArg(args);
        xcrun(["simctl", "shutdown", device]);
        return { content: [{ type: "text", text: `Shutdown: ${device}` }] };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("iOS Simulator MCP server ready");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
