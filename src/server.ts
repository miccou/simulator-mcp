import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  buildStatusBarArgs,
  formatDeviceList,
  resolveDevice,
  withDebugLogging,
  xcrun,
  type Runner,
} from "./simctl.js";

// ---------------------------------------------------------------------------
// Dependencies (injectable for testing)
// ---------------------------------------------------------------------------

export interface ServerDeps {
  /** Runs an `xcrun` subcommand. Defaults to the real runner. */
  run?: Runner;
  /** Brings the Simulator app to the foreground (used by `boot`). */
  openApp?: () => void;
}

// ---------------------------------------------------------------------------
// Tool input schemas
// ---------------------------------------------------------------------------
//
// Each tool's arguments are described with zod so `McpServer` validates them
// at runtime before our handler ever runs. A malformed argument (a string `x`,
// a missing required field, an out-of-range battery level) now produces a clear
// error result instead of silently becoming `"undefined"` inside the command.

/** Shared optional device selector, defaulting to the booted device. */
const deviceArg = {
  device: z
    .string()
    .default("booted")
    .describe('Device name, UDID, or "booted" (default)'),
};

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Builds the iOS Simulator MCP server. Pass `deps` to inject a fake command
 * runner (and Simulator-app opener) in tests; the defaults shell out for real.
 */
export function createServer(deps: ServerDeps = {}): McpServer {
  const run = withDebugLogging(deps.run ?? xcrun);
  const openApp =
    deps.openApp ??
    (() => {
      execFileSync("open", ["-a", "Simulator"], { stdio: "ignore" });
    });

  const server = new McpServer({ name: "ios-simulator", version: "1.0.0" });

  // ── Visual ────────────────────────────────────────────────────────────────
  server.registerTool(
    "screenshot",
    {
      description:
        "Capture a screenshot of the booted iOS Simulator. " +
        "Returns the image as base64 PNG so you can visually inspect the UI. " +
        "Use this after navigating or tapping to see the current state.",
      inputSchema: { ...deviceArg },
    },
    async ({ device }) => {
      const dev = resolveDevice(run, device);
      const file = join(tmpdir(), `sim-${Date.now()}.png`);
      try {
        run(["simctl", "io", dev, "screenshot", file]);
        const base64 = readFileSync(file).toString("base64");
        return {
          content: [{ type: "image", data: base64, mimeType: "image/png" }],
        };
      } finally {
        if (existsSync(file)) unlinkSync(file);
      }
    },
  );

  // ── Navigation ──────────────────────────────────────────────────────────────
  server.registerTool(
    "open_url",
    {
      description:
        "Open a URL in Safari on the booted iOS Simulator. " +
        "Use http://localhost:3000 to preview the local dev server. " +
        "Also works with custom app URL schemes for deep-linking.",
      inputSchema: {
        url: z.string().describe("URL to open"),
        ...deviceArg,
      },
    },
    async ({ url, device }) => {
      const dev = resolveDevice(run, device);
      run(["simctl", "openurl", dev, url]);
      return { content: [{ type: "text", text: `Opened: ${url}` }] };
    },
  );

  // ── Touch ─────────────────────────────────────────────────────────────────
  server.registerTool(
    "tap",
    {
      description:
        "Simulate a finger tap at (x, y) coordinates on the booted Simulator screen. " +
        "Take a screenshot first to find the coordinates you want to tap.",
      inputSchema: {
        x: z.number().describe("X coordinate in points"),
        y: z.number().describe("Y coordinate in points"),
        ...deviceArg,
      },
    },
    async ({ x, y, device }) => {
      const dev = resolveDevice(run, device);
      run(["simctl", "io", dev, "tap", String(x), String(y)]);
      return { content: [{ type: "text", text: `Tapped (${x}, ${y})` }] };
    },
  );

  server.registerTool(
    "swipe",
    {
      description:
        "Simulate a swipe gesture on the booted Simulator. " +
        "Use to scroll: swipe from (centerX, bottom) to (centerX, top) to scroll down.",
      inputSchema: {
        x1: z.number().describe("Start X"),
        y1: z.number().describe("Start Y"),
        x2: z.number().describe("End X"),
        y2: z.number().describe("End Y"),
        duration: z
          .number()
          .default(500)
          .describe("Gesture duration in milliseconds (default 500)"),
        ...deviceArg,
      },
    },
    async ({ x1, y1, x2, y2, duration, device }) => {
      const dev = resolveDevice(run, device);
      run([
        "simctl",
        "io",
        dev,
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
    },
  );

  // ── Appearance ──────────────────────────────────────────────────────────────
  server.registerTool(
    "set_appearance",
    {
      description: "Switch the booted Simulator between light and dark mode.",
      inputSchema: {
        mode: z.enum(["light", "dark"]).describe("Appearance mode"),
        ...deviceArg,
      },
    },
    async ({ mode, device }) => {
      const dev = resolveDevice(run, device);
      run(["simctl", "ui", dev, "appearance", mode]);
      return { content: [{ type: "text", text: `Appearance set to ${mode}` }] };
    },
  );

  server.registerTool(
    "set_status_bar",
    {
      description:
        "Override the status bar on the booted Simulator for clean screenshots " +
        "(e.g. set time to 9:41, full battery). Pass clear: true to reset.",
      inputSchema: {
        time: z.string().optional().describe('Display time, e.g. "9:41"'),
        batteryLevel: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("Battery level 0–100"),
        batteryState: z
          .enum(["charging", "charged", "discharging"])
          .optional(),
        wifiMode: z.enum(["searching", "failed", "active"]).optional(),
        wifiBars: z.number().min(0).max(3).optional(),
        cellMode: z
          .enum(["notSupported", "searching", "failed", "active"])
          .optional(),
        cellBars: z.number().min(0).max(4).optional(),
        clear: z
          .boolean()
          .optional()
          .describe("Clear all status bar overrides"),
        ...deviceArg,
      },
    },
    async ({ device, ...opts }) => {
      const dev = resolveDevice(run, device);
      run(buildStatusBarArgs(dev, opts));
      const text = opts.clear
        ? "Status bar overrides cleared"
        : "Status bar updated";
      return { content: [{ type: "text", text }] };
    },
  );

  // ── Device management ─────────────────────────────────────────────────────────
  server.registerTool(
    "list_devices",
    {
      description:
        "List all available iOS Simulator devices with their state (Booted / Shutdown).",
      inputSchema: {},
    },
    async () => {
      const raw = run(["simctl", "list", "devices", "--json"]);
      return { content: [{ type: "text", text: formatDeviceList(raw) }] };
    },
  );

  server.registerTool(
    "boot",
    {
      description:
        "Boot an iOS Simulator device by name or UDID and open the Simulator app.",
      inputSchema: {
        device: z
          .string()
          .describe('Device name or UDID, e.g. "iPhone 16 Pro"'),
      },
    },
    async ({ device }) => {
      const udid = resolveDevice(run, device);
      run(["simctl", "boot", udid]);
      openApp();
      return {
        content: [{ type: "text", text: `Booted: ${device} (${udid})` }],
      };
    },
  );

  server.registerTool(
    "shutdown",
    {
      description: "Shutdown an iOS Simulator device.",
      inputSchema: { ...deviceArg },
    },
    async ({ device }) => {
      const dev = resolveDevice(run, device);
      run(["simctl", "shutdown", dev]);
      return { content: [{ type: "text", text: `Shutdown: ${dev}` }] };
    },
  );

  return server;
}
