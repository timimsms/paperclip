# SmsSushi Integration

The Paperclip claude-local adapter optionally integrates with [SmsSushi](https://sms-sushi.fly.dev) to deliver phone notifications on task completion and surface live agent sessions in the SmsSushi PWA. It also wires a lightweight approval bridge so operators can accept or reject Paperclip `request_confirmation` interactions from their phone.

All SmsSushi calls are **fail-open**: an outage, timeout, or error never blocks, delays, or fails an agent heartbeat. When SmsSushi is unreachable the harness behaves exactly as it does today.

## Enabling

Add to an agent's adapter config:

```json
{
  "smsSushiEnabled": true
}
```

Set environment variables on the Paperclip server (or in `.env`):

```
SMS_SUSHI_API_TOKEN=<your-token>
SMS_SUSHI_BASE_URL=https://sms-sushi.fly.dev   # optional; this is the default
```

The token is the same one used by the SmsSushi MCP server. Take effect immediately on the next heartbeat — no server restart required.

## What it does

### 1. Task-completion notifications

When a heartbeat exits and the issue status is `done` or `blocked`, SmsSushi sends a push notification to the operator's phone with the issue title and a Paperclip deep link.

### 2. Session visibility

On heartbeat start, the adapter registers a SmsSushi session tagged with `{task_id, agent_id, run_id}`. During the run it sends a heartbeat every 90 seconds. On exit it marks the session complete. Live sessions appear in the SmsSushi PWA.

### 3. Approval bridge

While Claude is running, a background loop polls for pending `request_confirmation` interactions on the current task (every 15 s). When one is found it sends a `permission_prompt` notification to the operator's phone. The operator taps Accept or Reject; the response is relayed back to the Paperclip interaction endpoint. Claude's blocked wait resolves normally — the same as a web-UI tap.

Key guarantees:
- **Human-in-the-loop preserved.** The operator still makes an explicit approve/reject decision; nothing auto-approves.
- **Phone tap ≡ web tap.** Same Paperclip API endpoint, same identity assumptions, no broader authority.
- **Re-notify throttle.** If a notification expires without response it is resent after 5 minutes.

## Rolling back

Set `smsSushiEnabled: false` in the agent's adapter config (or delete the key). All SmsSushi code paths are skipped on the next heartbeat. No server restart needed.

## Credential requirements

| Credential | Where | Notes |
|---|---|---|
| `SMS_SUSHI_API_TOKEN` | Server env | Same token used by the MCP server |
| `SMS_SUSHI_BASE_URL` | Server env (optional) | Defaults to `https://sms-sushi.fly.dev` |

Never store the token in adapter config or issue descriptions — use env vars only.
