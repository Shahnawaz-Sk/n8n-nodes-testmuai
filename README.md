# n8n-nodes-testmuai

Verified n8n community node for [TestMu AI Browser Cloud](https://www.testmuai.com/browser-cloud/) (formerly LambdaTest). Lets your AI Agent drive real browsers — Chrome, Firefox, Safari, Edge — across Windows, macOS, and Linux. Every session runs live and can be viewed on the Browser Cloud dashboard with video replay, console logs, and network capture for full debugging visibility.

## Documentation

- [What is Browser Cloud](https://www.testmuai.com/support/docs/what-is-browser-cloud/?utm_source=github&utm_medium=referral)

## What's in the package

One node: **TestMu AI (Formerly LambdaTest) Agent** — a tool that any AI Agent calls to drive a real cloud browser. Connects to TestMu's cloud via the W3C WebDriver protocol over HTTPS, so it works inside n8n Cloud's verified-node sandbox.

Looking for the script-runner or in-process Playwright agent? Those features live in the companion package [`n8n-nodes-browsercloud`](https://github.com/keys-github/n8n-browsercloud) (self-hosted n8n only).

## Install

In your n8n instance:

- **Self-hosted:** Settings → Community Nodes → Install → enter `n8n-nodes-testmuai`
- **n8n Cloud:** Available in the Verified Community Nodes marketplace.

## Credentials

Add a **TestMu AI (Formerly LambdaTest) API** credential with:

- **Username** — your TestMu AI username
- **Access Key** — your TestMu AI access key

Find both in your TestMu account profile.

## How to use with an AI Agent

```
[Trigger] → [AI Agent]
              ↑ Tools (sub-input on the bottom of the Agent node)
              [TestMu AI (Formerly LambdaTest) Agent]
              ↑ Chat Model
              [Gemini / Claude / OpenAI Chat Model]
```

1. Add an **AI Agent** node.
2. Wire any tool-calling-capable Chat Model (Gemini 2.5 Flash, GPT-4o, Claude Sonnet) into the Agent's Chat Model socket.
3. Wire **TestMu AI (Formerly LambdaTest) Agent** into the Agent's Tools socket.
4. Pick your TestMu credential (available on your TestMu AI dashboard) on the tool node.
5. Configure browser, platform, region (US/EU), and version.
6. Give the Agent a goal in its user message — e.g. "Open news.ycombinator.com and tell me the title of the top story."

### Suggested system message for the AI Agent

```
You drive a real cloud browser via the TestMu AI Agent tool. Steps:

1. Call navigate first to open the right URL.
2. Click and type refer to elements by their ref number from the latest snapshot.
   Every tool response includes a fresh snapshot — use it.
3. If an element's role contains "(readonly)", do NOT try to type into it.
   Click it instead — it usually opens a picker with a real input you can type into.
4. Use get_text to extract content.
5. When the goal is achieved, ALWAYS call action=release as your final tool call.
   This frees the cloud browser immediately instead of letting it idle-time out. You can also type "Release session after completion" in natural language to achieve the same.

Never refer to refs from previous turns — refs are only valid against the latest snapshot.
```

## Actions exposed

| Action | Purpose |
|---|---|
| `navigate` | Open a URL |
| `snapshot` | Return a numbered list of interactive elements on the current page |
| `click` | Click an element by its ref number |
| `type` | Type text into an input by ref (optionally pressing Enter after) |
| `get_text` | Read text from a ref or the whole page |
| `screenshot` | Capture a base64 PNG of the current viewport (useful for vision models) |
| `release` | End the cloud browser session. The AI Agent should call this when the goal is achieved. |

After every action, the response includes a fresh page snapshot — so the AI Agent rarely needs to call `snapshot` separately between every click and type.

## Architecture notes

- Pure HTTP — no third-party Node dependencies, no subprocess spawning, no in-process Playwright. All browser interaction goes through TestMu's WebDriver Hub via n8n's sandboxed `httpRequest` helper.
- Session state lives in n8n's workflow static data, scoped by execution ID. Stale sessions auto-prune after 30 minutes.
- Elements are tagged with `data-n8n-ref` attributes by the snapshot script so click / type can find them again reliably via a single CSS selector lookup.
- Live session videos and console / network logs are visible on the TestMu AI's Browsercloud dashboard.

## Limitations vs the companion `n8n-nodes-browsercloud` package

- No script-runner (cannot exist in the verified sandbox — would need `child_process` and `fs`).
- No in-process Playwright (network roundtrip per action vs in-memory call).
- Full-page screenshots return viewport-only (W3C WebDriver doesn't standardize full-page; we report `fullPageRequested: true` so callers know what was asked for).

For workflows that need any of the above, install the companion `n8n-nodes-browsercloud` package on self-hosted n8n.

## License

MIT
