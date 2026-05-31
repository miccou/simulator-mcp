# simulator-mcp

> Let your AI assistant see and drive the iOS Simulator.

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that gives
Claude, Cursor, and other MCP-capable assistants hands-on control of the iOS
Simulator. It can take screenshots, tap, swipe, open URLs and deep links, toggle
dark mode, and clean up the status bar for pixel-perfect captures — all through
Apple's own `simctl` tooling.

Point your assistant at your locally running app and let it _look_ at the screen,
navigate, and verify the UI the same way you would.

<!-- TODO: hero screenshot / demo GIF goes here -->

## Why

LLMs are great at writing UI code but normally fly blind — they can't tell whether
the thing they built actually renders. This server closes that loop: the assistant
takes a screenshot, sees the result, taps where it needs to, and screenshots again.

Typical uses:

- **"Open my dev server and tell me how it looks."** → `open_url` + `screenshot`
- **"Tap the login button and check the next screen."** → `screenshot` → `tap` → `screenshot`
- **"Grab light and dark mode versions of this view."** → `set_appearance` + `screenshot` ×2
- **"Give me a clean App Store screenshot."** → `set_status_bar` (9:41, full battery) + `screenshot`

## Requirements

- **macOS** (the iOS Simulator is macOS-only)
- **Xcode** or the **Xcode Command Line Tools**, so that `xcrun simctl` is available
- **Node.js 18+**

Verify your setup:

```bash
xcrun simctl list devices
```

If that prints a list of simulators, you're good to go.

## Installation

No global install needed — your MCP client launches the server on demand with
`npx`. Just add the config below for your client.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ios-simulator": {
      "command": "npx",
      "args": ["-y", "simulator-mcp"]
    }
  }
}
```

Restart Claude Desktop. You'll see the simulator tools appear in the tools menu.

### Claude Code

```bash
claude mcp add ios-simulator -- npx -y simulator-mcp
```

### Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project):

```json
{
  "mcpServers": {
    "ios-simulator": {
      "command": "npx",
      "args": ["-y", "simulator-mcp"]
    }
  }
}
```

### VS Code (GitHub Copilot / MCP)

```json
{
  "servers": {
    "ios-simulator": {
      "command": "npx",
      "args": ["-y", "simulator-mcp"]
    }
  }
}
```

### Pinning a version

Swap `simulator-mcp` for `simulator-mcp@1.0.0` in any of the above to pin a release.

## Tools

| Tool             | What it does                                                                 |
| ---------------- | ---------------------------------------------------------------------------- |
| `screenshot`     | Capture the screen and return it as a PNG image for the assistant to inspect |
| `open_url`       | Open a URL or custom app scheme in the Simulator (Safari / deep links)       |
| `tap`            | Tap at `(x, y)` coordinates                                                  |
| `swipe`          | Swipe / scroll from one point to another over a given duration               |
| `set_appearance` | Switch between `light` and `dark` mode                                       |
| `set_status_bar` | Override time, battery, Wi-Fi and cellular for clean screenshots, or `clear` |
| `list_devices`   | List available simulators and their state (Booted / Shutdown)                |
| `boot`           | Boot a device by name or UDID and open the Simulator app                     |
| `shutdown`       | Shut down a device                                                           |

Every tool accepts an optional `device` argument — a device **name**
(`"iPhone 16 Pro"`), a **UDID**, or `"booted"` (the default). Names are matched
case-insensitively against available simulators.

### Examples

Once it's wired up, just talk to your assistant naturally:

> "Boot an iPhone 16 Pro, open http://localhost:3000, and show me the home screen."

> "Tap the hamburger menu in the top-left, then screenshot the drawer."

> "Set the status bar to 9:41 with full battery and no carrier text, switch to dark
> mode, and capture a screenshot I can use in the App Store."

> "Scroll to the bottom of the page and tell me if the footer renders correctly."

## How it works

The server is a thin, well-typed wrapper around `xcrun simctl`. It speaks MCP over
stdio, exposes the tools above, and shells out to the simulator command-line tools.
Screenshots are written to a temp file, read back as base64 PNG, and returned as an
MCP image so the model can actually see them. Command arguments are passed to
`xcrun` as an argument array (not a shell string), so device names, URLs, and
status-bar values can't trigger shell injection.

## Local development

```bash
git clone https://github.com/miccou/ios-simulator-mcp.git
cd ios-simulator-mcp
npm install
npm run build      # compile TypeScript → dist/
npm run dev        # watch mode
npm run typecheck  # type-check without emitting
npm test           # run the test suite (no simulator required)
```

Point your MCP client at your local checkout while developing:

```json
{
  "mcpServers": {
    "ios-simulator": {
      "command": "node",
      "args": ["/absolute/path/to/ios-simulator-mcp/dist/index.js"]
    }
  }
}
```

You can also exercise the server by hand with the official
[MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

To smoke-test every tool against a **real** booted simulator (boots an iPhone,
overrides the status bar, switches to dark mode, opens a URL, and saves a
screenshot to `/tmp/sim-e2e.png`):

```bash
npm run build
node scripts/e2e.mjs
```

The automated `npm test` suite mocks `xcrun`, so this script is the way to catch
issues that only surface against the actual `simctl` binary.

For a hands-off, never-ending demo (handy for screen recordings), `scripts/demo.mjs`
boots a simulator and then loops until you Ctrl-C: every 10s it browses to one of
20 well-known sites, and on a 5s offset it tweaks something else (dark/light mode,
status-bar overrides, scrolling).

```bash
npm run build
node scripts/demo.mjs            # or: node scripts/demo.mjs "iPhone 16 Pro"
```

## Troubleshooting

- **"No simulator found matching ..."** — run `list_devices` (or `xcrun simctl list
  devices`) to see exact names, or boot one first with `boot`.
- **Commands fail with no booted device** — most tools default to `"booted"`; make
  sure a simulator is running, or pass an explicit `device`.
- **`xcrun: command not found`** — install the Xcode Command Line Tools with
  `xcode-select --install`.
- **`tap` / `swipe` do nothing** — these require a booted device and a foreground
  app that accepts the input; take a `screenshot` first to confirm coordinates.

## Contributing

Issues and PRs welcome. Please run `npm run typecheck` and `npm test` before
opening a PR — both run automatically in CI on every push and pull request.

The test suite mocks the `xcrun` boundary, so it runs anywhere (including Linux
CI) without a real simulator: unit tests cover device resolution and argument
building in `src/simctl.ts`, and integration tests drive the MCP server over an
in-memory transport to assert the exact commands each tool issues.

## License

[MIT](./LICENSE) © Michael Cousins
