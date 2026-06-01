import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildStatusBarArgs,
  formatDeviceList,
  isUdid,
  resolveDevice,
  type Runner,
} from "../src/simctl.js";

// A Runner that records the args it was called with and returns canned output.
function fakeRunner(output = ""): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (args: string[]) => {
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

test("isUdid rejects 36-char near-misses that aren't the 8-4-4-4-12 shape", () => {
  // Right length, dashes in the wrong places.
  assert.equal(isUdid("AAAAAAAAB-BBB-CCCC-DDDD-EEEEEEEEEEEE"), false);
  assert.equal(isUdid("-AAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"), false);
  assert.equal(isUdid("AAAAAAAA-BBBBCCCC-DDDD-EEEE-FFFFFFFFFF"), false);
  // 36 chars of all dashes — matched by the old loose regex.
  assert.equal(isUdid("------------------------------------"), false);
  // Non-hex character in an otherwise well-shaped UDID.
  assert.equal(isUdid("GGGGGGGG-BBBB-CCCC-DDDD-EEEEEEEEEEEE"), false);
  // Correct shape but wrong length.
  assert.equal(isUdid("AAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"), false);
  assert.equal(isUdid("AAAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"), false);
});

// ── resolveDevice ─────────────────────────────────────────────────────────────

test("resolveDevice passes 'booted' through without shelling out", async () => {
  const run = fakeRunner();
  assert.equal(await resolveDevice(run, "booted"), "booted");
  assert.equal(run.calls.length, 0);
});

test("resolveDevice passes a bare UDID through without shelling out", async () => {
  const run = fakeRunner();
  const udid = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
  assert.equal(await resolveDevice(run, udid), udid);
  assert.equal(run.calls.length, 0);
});

test("resolveDevice matches a device name case-insensitively", async () => {
  const run = fakeRunner(DEVICE_JSON);
  assert.equal(
    await resolveDevice(run, "iphone 16 pro"),
    "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  );
  assert.deepEqual(run.calls[0], ["simctl", "list", "devices", "--json"]);
});

test("resolveDevice skips unavailable devices", async () => {
  const run = fakeRunner(DEVICE_JSON);
  await assert.rejects(
    () => resolveDevice(run, "Old Unavailable"),
    /No simulator found matching "Old Unavailable"/,
  );
});

test("resolveDevice throws on an unknown name", async () => {
  const run = fakeRunner(DEVICE_JSON);
  await assert.rejects(
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
