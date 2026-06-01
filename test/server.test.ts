import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { createServer, type ServerDeps } from "../src/server.js";

const DEVICE_JSON = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
      {
        name: "iPhone 16 Pro",
        udid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
        state: "Booted",
        isAvailable: true,
      },
    ],
  },
});

// Fake PNG bytes the screenshot handler will read back.
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Harness {
  client: Client;
  calls: string[][];
  openAppCalls: number;
}

// Spins up a client wired to a server with a recording fake runner.
async function connect(
  overrides: Partial<ServerDeps> = {},
): Promise<Harness> {
  const calls: string[][] = [];
  let openAppCalls = 0;

  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[1] === "list" && args[2] === "devices") return DEVICE_JSON;
    if (args.includes("screenshot")) {
      writeFileSync(args[args.length - 1], FAKE_PNG); // emulate simctl writing the file
    }
    return "";
  };

  const server = createServer({
    run,
    openApp: () => {
      openAppCalls++;
    },
    ...overrides,
  });

  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  return {
    client,
    calls,
    get openAppCalls() {
      return openAppCalls;
    },
  };
}

// ── ListTools ─────────────────────────────────────────────────────────────────

test("lists all nine tools with input schemas", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();

  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      "boot",
      "list_devices",
      "open_url",
      "screenshot",
      "set_appearance",
      "set_status_bar",
      "shutdown",
      "swipe",
      "tap",
    ],
  );
  for (const t of tools) {
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.description, `${t.name} should have a description`);
  }
});

// ── screenshot ────────────────────────────────────────────────────────────────

test("screenshot returns the captured PNG as a base64 image", async () => {
  const { client, calls } = await connect();
  const res = await client.callTool({ name: "screenshot", arguments: {} });

  const content = res.content as Array<{
    type: string;
    data: string;
    mimeType: string;
  }>;
  assert.equal(content[0].type, "image");
  assert.equal(content[0].mimeType, "image/png");
  assert.equal(content[0].data, FAKE_PNG.toString("base64"));

  const shot = calls.find((c) => c.includes("screenshot"))!;
  assert.equal(shot[0], "simctl");
  assert.equal(shot[1], "io");
  assert.equal(shot[2], "booted");
  assert.equal(shot[3], "screenshot");
});

// ── open_url / shell-injection guarantee ───────────────────────────────────────

test("open_url passes the URL through as a single argument (no shell splitting)", async () => {
  const { client, calls } = await connect();
  const nasty = "http://localhost:3000/?x=1; rm -rf / && echo pwned";
  const res = await client.callTool({
    name: "open_url",
    arguments: { url: nasty },
  });

  assert.notEqual(res.isError, true);
  assert.deepEqual(calls[0], ["simctl", "openurl", "booted", nasty]);
  // The metacharacter-laden URL stays exactly one array element.
  assert.equal(calls[0][3], nasty);
});

// ── tap / swipe ────────────────────────────────────────────────────────────────

test("tap stringifies coordinates", async () => {
  const { client, calls } = await connect();
  await client.callTool({ name: "tap", arguments: { x: 42, y: 99 } });
  assert.deepEqual(calls[0], ["simctl", "io", "booted", "tap", "42", "99"]);
});

test("swipe defaults duration to 500ms", async () => {
  const { client, calls } = await connect();
  await client.callTool({
    name: "swipe",
    arguments: { x1: 1, y1: 2, x2: 3, y2: 4 },
  });
  assert.deepEqual(calls[0], [
    "simctl",
    "io",
    "booted",
    "swipe",
    "1",
    "2",
    "3",
    "4",
    "500",
  ]);
});

// ── set_appearance / set_status_bar ─────────────────────────────────────────────

test("set_appearance forwards the mode", async () => {
  const { client, calls } = await connect();
  await client.callTool({
    name: "set_appearance",
    arguments: { mode: "dark" },
  });
  assert.deepEqual(calls[0], ["simctl", "ui", "booted", "appearance", "dark"]);
});

test("set_status_bar override vs clear produce different messages", async () => {
  const { client, calls } = await connect();

  const override = await client.callTool({
    name: "set_status_bar",
    arguments: { time: "9:41" },
  });
  assert.match((override.content as [{ text: string }])[0].text, /updated/);
  assert.deepEqual(calls[0], [
    "simctl",
    "status_bar",
    "booted",
    "override",
    "--time",
    "9:41",
  ]);

  const cleared = await client.callTool({
    name: "set_status_bar",
    arguments: { clear: true },
  });
  assert.match((cleared.content as [{ text: string }])[0].text, /cleared/);
  assert.deepEqual(calls[1], ["simctl", "status_bar", "booted", "clear"]);
});

// ── list_devices ─────────────────────────────────────────────────────────────

test("list_devices returns a formatted, human-readable listing", async () => {
  const { client } = await connect();
  const res = await client.callTool({ name: "list_devices", arguments: {} });
  const text = (res.content as [{ text: string }])[0].text;
  assert.match(text, /iPhone 16 Pro ← booted/);
});

// ── boot ──────────────────────────────────────────────────────────────────────

test("boot resolves a name to a UDID and opens the Simulator app", async () => {
  const harness = await connect();
  const res = await harness.client.callTool({
    name: "boot",
    arguments: { device: "iPhone 16 Pro" },
  });

  const bootCall = harness.calls.find((c) => c[1] === "boot")!;
  assert.deepEqual(bootCall, [
    "simctl",
    "boot",
    "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  ]);
  assert.equal(harness.openAppCalls, 1);
  assert.match((res.content as [{ text: string }])[0].text, /Booted/);
});

// ── shutdown ────────────────────────────────────────────────────────────────

test("shutdown targets the booted device by default", async () => {
  const { client, calls } = await connect();
  await client.callTool({ name: "shutdown", arguments: {} });
  assert.deepEqual(calls[0], ["simctl", "shutdown", "booted"]);
});

// ── error handling ─────────────────────────────────────────────────────────────

test("an unknown device name yields an error result, not a crash", async () => {
  const { client } = await connect();
  const res = await client.callTool({
    name: "open_url",
    arguments: { url: "http://x", device: "Nonexistent Device" },
  });
  assert.equal(res.isError, true);
  assert.match(
    (res.content as [{ text: string }])[0].text,
    /No simulator found matching/,
  );
});

// ── runtime input validation ────────────────────────────────────────────────

test("a missing required argument is rejected before the command runs", async () => {
  const { client, calls } = await connect();
  const res = await client.callTool({ name: "open_url", arguments: {} });

  assert.equal(res.isError, true);
  assert.match((res.content as [{ text: string }])[0].text, /validation/i);
  assert.equal(calls.length, 0); // nothing was ever shelled out
});

test("a wrong-typed argument is rejected instead of becoming 'undefined'", async () => {
  const { client, calls } = await connect();
  const res = await client.callTool({
    name: "tap",
    arguments: { x: "not-a-number", y: 99 },
  });

  assert.equal(res.isError, true);
  assert.match((res.content as [{ text: string }])[0].text, /validation/i);
  assert.equal(calls.length, 0);
});

test("an out-of-range value is rejected by the schema", async () => {
  const { client, calls } = await connect();
  const res = await client.callTool({
    name: "set_status_bar",
    arguments: { wifiBars: 9 },
  });

  assert.equal(res.isError, true);
  assert.match((res.content as [{ text: string }])[0].text, /validation/i);
  assert.equal(calls.length, 0);
});

test("an invalid enum value is rejected by the schema", async () => {
  const { client, calls } = await connect();
  const res = await client.callTool({
    name: "set_appearance",
    arguments: { mode: "sepia" },
  });

  assert.equal(res.isError, true);
  assert.match((res.content as [{ text: string }])[0].text, /validation/i);
  assert.equal(calls.length, 0);
});
