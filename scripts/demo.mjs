// Live demo: boots a simulator, then on a loop drives it through the MCP server
// until you stop it (Ctrl-C). Every 10s it navigates to one of 20 well-known
// sites; on a 5s offset it mutates something else (appearance / status bar /
// scroll). Optionally pass a device name: `node scripts/demo.mjs "iPhone 16 Pro"`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const DEVICE = process.argv[2] ?? "iPhone 16";

const URLS = [
  "https://www.google.com",
  "https://www.apple.com",
  "https://www.wikipedia.org",
  "https://www.github.com",
  "https://www.youtube.com",
  "https://www.amazon.com",
  "https://www.reddit.com",
  "https://www.bbc.com",
  "https://www.nytimes.com",
  "https://www.stackoverflow.com",
  "https://www.npmjs.com",
  "https://www.cloudflare.com",
  "https://www.mozilla.org",
  "https://www.netflix.com",
  "https://www.spotify.com",
  "https://www.microsoft.com",
  "https://www.linkedin.com",
  "https://news.ycombinator.com",
  "https://www.theverge.com",
  "https://www.wired.com",
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Each mutation touches something *other* than navigation.
const MUTATIONS = [
  {
    label: "appearance → dark",
    run: (c) => c.callTool({ name: "set_appearance", arguments: { mode: "dark" } }),
  },
  {
    label: "appearance → light",
    run: (c) => c.callTool({ name: "set_appearance", arguments: { mode: "light" } }),
  },
  {
    label: "status bar → 9:41, full",
    run: (c) =>
      c.callTool({
        name: "set_status_bar",
        arguments: { time: "9:41", batteryLevel: 100, batteryState: "charged", wifiBars: 3, cellBars: 4 },
      }),
  },
  {
    label: "status bar → randomized",
    run: (c) =>
      c.callTool({
        name: "set_status_bar",
        arguments: {
          time: `${rand(1, 12)}:${String(rand(0, 59)).padStart(2, "0")}`,
          batteryLevel: rand(1, 100),
          batteryState: pick(["charging", "charged", "discharging"]),
          wifiBars: rand(0, 3),
          cellBars: rand(0, 4),
        },
      }),
  },
  {
    label: "status bar → cleared",
    run: (c) => c.callTool({ name: "set_status_bar", arguments: { clear: true } }),
  },
  {
    label: "scroll down",
    run: (c) =>
      c.callTool({ name: "swipe", arguments: { x1: 200, y1: 620, x2: 200, y2: 220, duration: 350 } }),
  },
  {
    label: "scroll up",
    run: (c) =>
      c.callTool({ name: "swipe", arguments: { x1: 200, y1: 220, x2: 200, y2: 620, duration: 350 } }),
  },
];

const ts = () => new Date().toLocaleTimeString();
const log = (msg) => console.log(`[${ts()}] ${msg}`);

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
const client = new Client({ name: "demo", version: "1.0.0" });
await client.connect(transport);

log(`booting ${DEVICE} …`);
await client.callTool({ name: "boot", arguments: { device: DEVICE } }); // boot now waits for the device to be ready
log("booted — starting demo loop (Ctrl-C to stop)");

let urlIdx = Math.floor(Math.random() * URLS.length);
let lastMutation = -1;

const navigate = async () => {
  const url = URLS[urlIdx];
  urlIdx = (urlIdx + 1) % URLS.length;
  log(`→ open  ${url}`);
  try {
    await client.callTool({ name: "open_url", arguments: { device: DEVICE, url } });
  } catch (e) {
    log(`  ! open failed: ${e.message}`);
  }
};

const mutate = async () => {
  let i;
  do {
    i = Math.floor(Math.random() * MUTATIONS.length);
  } while (i === lastMutation && MUTATIONS.length > 1);
  lastMutation = i;
  const m = MUTATIONS[i];
  log(`~ tweak ${m.label}`);
  try {
    await m.run(client);
  } catch (e) {
    log(`  ! tweak failed: ${e.message}`);
  }
};

// URL at t=0,10,20…; mutation offset by 5s at t=5,15,25…
let mutateInterval;
await navigate();
const urlTimer = setInterval(navigate, 10_000);
const mutateTimer = setTimeout(() => {
  mutate();
  mutateInterval = setInterval(mutate, 10_000);
}, 5_000);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(urlTimer);
  clearTimeout(mutateTimer);
  clearInterval(mutateInterval);
  log("stopping — leaving the simulator as-is");
  await client.close().catch(() => {});
  process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
