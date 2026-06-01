import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildStatusBarArgs,
  debugEnabled,
  formatDeviceList,
  isUdid,
  resolveDevice,
  withDebugLogging,
  type Runner,
} from "../src/simctl.js";

// A Runner that records the args it was called with and returns canned output.
function fakeRunner(output = ""): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = ((args: string[]) => {
    calls.push(args);
    return output;
  }) as Runner & { calls: string[][] };
  run.calls = calls;
  return run;
}

const DEVICE_JSON = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
      {
        name: "iPhone 16 Pro",
        udid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
        state: "Booted",
        isAvailable: true,
      },
      {
        name: "iPad Pro",
        udid: "11111111-2222-3333-4444-555555555555",
        state: "Shutdown",
        isAvailable: true,
      },
      {
        name: "Old Unavailable",
        udid: "99999999-9999-9999-9999-999999999999",
        state: "Shutdown",
        isAvailable: false,
      },
    ],
  },
});

// ── isUdid ──────────────────────────────────────────────────────────────────

test("isUdid recognizes a 36-char UDID and rejects names", () => {
  assert.equal(isUdid("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"), true);
  assert.equal(isUdid("iPhone 16 Pro"), false);
  assert.equal(isUdid("booted"), false);
});

// ── resolveDevice ─────────────────────────────────────────────────────────────

test("resolveDevice passes 'booted' through without shelling out", () => {
  const run = fakeRunner();
  assert.equal(resolveDevice(run, "booted"), "booted");
  assert.equal(run.calls.length, 0);
});

test("resolveDevice passes a bare UDID through without shelling out", () => {
  const run = fakeRunner();
  const udid = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
  assert.equal(resolveDevice(run, udid), udid);
  assert.equal(run.calls.length, 0);
});

test("resolveDevice matches a device name case-insensitively", () => {
  const run = fakeRunner(DEVICE_JSON);
  assert.equal(
    resolveDevice(run, "iphone 16 pro"),
    "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  );
  assert.deepEqual(run.calls[0], ["simctl", "list", "devices", "--json"]);
});

test("resolveDevice skips unavailable devices", () => {
  const run = fakeRunner(DEVICE_JSON);
  assert.throws(
    () => resolveDevice(run, "Old Unavailable"),
    /No simulator found matching "Old Unavailable"/,
  );
});

test("resolveDevice throws on an unknown name", () => {
  const run = fakeRunner(DEVICE_JSON);
  assert.throws(
    () => resolveDevice(run, "Nonexistent"),
    /No simulator found matching "Nonexistent"/,
  );
});

// ── buildStatusBarArgs ────────────────────────────────────────────────────────

test("buildStatusBarArgs builds a clear command", () => {
  assert.deepEqual(buildStatusBarArgs("booted", { clear: true }), [
    "simctl",
    "status_bar",
    "booted",
    "clear",
  ]);
});

test("buildStatusBarArgs emits only the provided override flags", () => {
  assert.deepEqual(
    buildStatusBarArgs("booted", { time: "9:41", batteryState: "charged" }),
    [
      "simctl",
      "status_bar",
      "booted",
      "override",
      "--time",
      "9:41",
      "--batteryState",
      "charged",
    ],
  );
});

test("buildStatusBarArgs still emits numeric zero values", () => {
  assert.deepEqual(
    buildStatusBarArgs("booted", { batteryLevel: 0, wifiBars: 0, cellBars: 0 }),
    [
      "simctl",
      "status_bar",
      "booted",
      "override",
      "--batteryLevel",
      "0",
      "--wifiBars",
      "0",
      "--cellularBars",
      "0",
    ],
  );
});

test("buildStatusBarArgs builds a full override with simctl's real flag names", () => {
  assert.deepEqual(
    buildStatusBarArgs("booted", {
      time: "9:41",
      batteryLevel: 100,
      batteryState: "charged",
      wifiMode: "active",
      wifiBars: 3,
      cellMode: "active",
      cellBars: 4,
    }),
    [
      "simctl",
      "status_bar",
      "booted",
      "override",
      "--time",
      "9:41",
      "--batteryLevel",
      "100",
      "--batteryState",
      "charged",
      "--wifiMode",
      "active",
      "--wifiBars",
      "3",
      "--cellularMode",
      "active",
      "--cellularBars",
      "4",
    ],
  );
});

// ── formatDeviceList ──────────────────────────────────────────────────────────

test("formatDeviceList groups by runtime and marks the booted device", () => {
  const out = formatDeviceList(DEVICE_JSON);
  assert.match(out, /iOS 17 5/); // runtime label cleaned up
  assert.match(out, /\[Booted\] iPhone 16 Pro ← booted/);
  assert.match(out, /\[Shutdown\] iPad Pro/);
  assert.doesNotMatch(out, /Old Unavailable/); // unavailable filtered out
});

test("formatDeviceList skips runtimes with no available devices", () => {
  const raw = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-16-0": [
        { name: "Gone", udid: "x", state: "Shutdown", isAvailable: false },
      ],
    },
  });
  assert.equal(formatDeviceList(raw), "");
});

// ── debugEnabled ──────────────────────────────────────────────────────────────

test("debugEnabled is off when the env var is unset, empty, '0', or 'false'", () => {
  assert.equal(debugEnabled({}), false);
  assert.equal(debugEnabled({ SIMULATOR_MCP_DEBUG: "" }), false);
  assert.equal(debugEnabled({ SIMULATOR_MCP_DEBUG: "0" }), false);
  assert.equal(debugEnabled({ SIMULATOR_MCP_DEBUG: "false" }), false);
  assert.equal(debugEnabled({ SIMULATOR_MCP_DEBUG: "FALSE" }), false);
});

test("debugEnabled is on for '1', 'true', or any other value", () => {
  assert.equal(debugEnabled({ SIMULATOR_MCP_DEBUG: "1" }), true);
  assert.equal(debugEnabled({ SIMULATOR_MCP_DEBUG: "true" }), true);
  assert.equal(debugEnabled({ SIMULATOR_MCP_DEBUG: "yes" }), true);
});

// ── withDebugLogging ──────────────────────────────────────────────────────────

test("withDebugLogging returns the runner untouched when disabled", () => {
  const run = fakeRunner("out");
  const wrapped = withDebugLogging(run, () => {}, false);
  assert.equal(wrapped, run); // same reference: zero overhead
});

test("withDebugLogging logs the command and its success, passing output through", () => {
  const logs: string[] = [];
  const run = fakeRunner("device-list");
  const wrapped = withDebugLogging(run, (m) => logs.push(m), true);

  const out = wrapped(["simctl", "list", "devices", "--json"]);

  assert.equal(out, "device-list"); // stdout still returned
  assert.deepEqual(run.calls[0], ["simctl", "list", "devices", "--json"]);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /→ xcrun simctl list devices --json/);
  assert.match(logs[1], /✓ xcrun simctl list devices --json/);
});

test("withDebugLogging logs the error message and re-throws", () => {
  const logs: string[] = [];
  const run: Runner = () => {
    throw new Error("Unknown subcommand 'status_bar'");
  };
  const wrapped = withDebugLogging(run, (m) => logs.push(m), true);

  assert.throws(
    () => wrapped(["simctl", "status_bar", "booted", "clear"]),
    /Unknown subcommand/,
  );
  assert.match(logs[0], /→ xcrun simctl status_bar booted clear/);
  assert.match(logs[1], /✗ xcrun simctl status_bar booted clear — Unknown subcommand/);
});
