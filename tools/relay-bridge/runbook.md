# sms-sushi ↔ Paperclip Relay Bridge — Runbook

## What it does

Polls Paperclip for `request_confirmation` interactions on `in_review` issues, pushes them to Tim's phone via sms-sushi Web Push, and writes his tap-response (yes/no) back to the Paperclip interaction (accept/reject).

**Flow:**
1. Agent creates a `request_confirmation` interaction on an issue and sets it to `in_review`
2. Bridge finds the interaction, sends a sms-sushi push notification to Tim's phone/menubar
3. Bridge long-polls sms-sushi for his response
4. Tim taps yes/no in the sms-sushi PWA or menubar app
5. Bridge calls `POST /api/issues/:id/interactions/:interactionId/accept` or `/reject`
6. Paperclip wakes the issue assignee with the outcome

## Config / secrets

Copy `.env.example` to `.env` and fill in:

| Variable               | Where to get it                                          |
|------------------------|----------------------------------------------------------|
| `PAPERCLIP_API_URL`    | Local: `http://localhost:3100`. Prod: the Paperclip URL  |
| `PAPERCLIP_API_KEY`    | From `paperclipai agent local-cli <agent-id>` or a service token |
| `PAPERCLIP_COMPANY_ID` | Your company UUID (visible in any API response)          |
| `SMS_SUSHI_API_TOKEN`  | From `~/.claude/settings.json` → `mcpServers.sms-sushi.env.SMS_SUSHI_API_TOKEN` |
| `SMS_SUSHI_BASE_URL`   | `https://sms-sushi.fly.dev` (default)                   |

Optional tuning:
- `POLL_INTERVAL_MS` — how often to check Paperclip for new interactions (default: 15000ms)
- `SMS_POLL_INTERVAL_MS` — how often to GET-poll sms-sushi for a response (default: 5000ms)
- `STATE_FILE` — path for resolved-interaction state (default: `./relay-state.json`)

## How to run

### One-time setup

```sh
cd tools/relay-bridge
pnpm install --ignore-workspace
cp .env.example .env
# edit .env with real values
```

### Run (foreground, for development/demo)

```sh
cd tools/relay-bridge
pnpm start
# or: node_modules/.bin/tsx src/index.ts
```

### Run persistently (background, macOS)

```sh
cd tools/relay-bridge
nohup pnpm start >> /tmp/relay-bridge.log 2>&1 &
echo $! > /tmp/relay-bridge.pid
```

To stop:
```sh
kill $(cat /tmp/relay-bridge.pid)
```

### Check status

```sh
# See the running bridge
ps aux | grep "tsx src/index.ts"

# Watch live log
tail -f /tmp/relay-bridge.log

# Check state file (resolved interaction IDs)
cat relay-state.json
```

## How an agent triggers a relay

1. Create a `request_confirmation` interaction on the issue:

```ts
await fetch(`${PAPERCLIP_API_URL}/api/issues/${issueId}/interactions`, {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    kind: "request_confirmation",
    idempotencyKey: `confirmation:${issueId}:plan:${revisionId}`,
    title: "Approve deployment to production?",
    summary: "Service X has passed QA. Ready to ship?",
    continuationPolicy: "wake_assignee_on_accept",
    payload: {
      version: 1,
      prompt: "Deploy service X to production now?",
      acceptLabel: "Yes, deploy",
      rejectLabel: "No, hold",
    },
  }),
});
```

2. Set the issue to `in_review`:

```ts
await fetch(`${PAPERCLIP_API_URL}/api/issues/${issueId}`, {
  method: "PATCH",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({ status: "in_review", comment: "Waiting for Tim's approval via relay bridge." }),
});
```

3. The bridge picks it up within `POLL_INTERVAL_MS`, sends the notification, and resolves the interaction when Tim responds.

## Behavior notes

- **State persistence**: resolved interaction IDs are saved to `STATE_FILE`. On restart the bridge skips already-resolved interactions so it doesn't double-accept/reject.
- **Expired notifications**: if Tim doesn't respond within sms-sushi's TTL, the notification expires. The bridge removes it from its active set, and on the next tick it re-sends a fresh notification.
- **Only `request_confirmation`**: the bridge handles yes/no decisions only. Multi-option and free-text interactions are out of scope for this pilot.
- **Only `in_review` issues**: the bridge scans issues with `status: in_review`. Pending interactions on `in_progress` or other statuses are ignored.
- **Accept mapping**: the first option (accept label) maps to accept; anything else maps to reject. Response is case-insensitive matched against `acceptLabel`, "yes", or "1".

## Effort actuals vs. S estimate

- Estimate: **S (~1–2 days)**
- Actual: **~3–4 hours** (one heartbeat)
  - API discovery: ~30 min
  - Core bridge implementation: ~1 hour
  - State persistence + expiry handling: ~30 min
  - Testing and end-to-end demo: ~1 hour
  - Runbook: ~30 min

Well within the S envelope.
