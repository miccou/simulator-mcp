import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const DEVICE = "iPhone 16";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
});
const client = new Client({ name: "e2e", version: "1.0.0" });
await client.connect(transport);

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const c = res.content?.[0];
  const summary =
    c?.type === "image" ? `<image ${c.data.length} b64 chars>` : c?.text;
  console.log(`\n▶ ${name}(${JSON.stringify(args)})${res.isError ? " [ERROR]" : ""}`);
  console.log(summary?.split("\n").slice(0, 8).join("\n"));
  return res;
};

await call("list_devices");
await call("boot", { device: DEVICE });

// Wait for the device to finish booting before driving the UI.
console.log("\n… waiting for boot");
execFileSync("xcrun", ["simctl", "bootstatus", DEVICE, "-b"], { stdio: "ignore" });

await call("set_status_bar", {
  time: "9:41",
  batteryLevel: 100,
  batteryState: "charged",
  wifiBars: 3,
  cellBars: 4,
});
await call("set_appearance", { mode: "dark" });
await call("open_url", { url: "https://www.apple.com" });
await new Promise((r) => setTimeout(r, 4000)); // let the page load

const shot = await call("screenshot");
const img = shot.content.find((c) => c.type === "image");
if (img) {
  writeFileSync("/tmp/sim-e2e.png", Buffer.from(img.data, "base64"));
  console.log("\n✔ wrote /tmp/sim-e2e.png");
}

await call("shutdown", { device: DEVICE });
await client.close();
console.log("\n✅ done");
