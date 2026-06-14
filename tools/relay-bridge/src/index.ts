/**
 * sms-sushi ↔ Paperclip relay bridge
 *
 * Polls Paperclip for pending request_confirmation interactions on in_review
 * issues, pushes them to Tim's phone via sms-sushi Web Push, and writes his
 * yes/no tap-response back to the Paperclip interaction (accept/reject).
 *
 * Environment variables (required):
 *   PAPERCLIP_API_URL       — e.g. http://localhost:3100 or https://app.paperclip.ing
 *   PAPERCLIP_API_KEY       — Bearer token for the Paperclip API
 *   PAPERCLIP_COMPANY_ID    — Company UUID
 *   SMS_SUSHI_API_TOKEN     — sms-sushi API token (from ~/.claude/settings.json mcpServers)
 *   SMS_SUSHI_BASE_URL      — default: https://sms-sushi.fly.dev
 *
 * Optional:
 *   POLL_INTERVAL_MS        — Paperclip poll interval (default: 15000)
 *   SMS_POLL_TIMEOUT_MS     — sms-sushi long-poll timeout per attempt (default: 29000)
 *   STATE_FILE              — path to persist resolved interaction IDs (default: ./relay-state.json)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

const PAPERCLIP_API_URL = requireEnv("PAPERCLIP_API_URL");
const PAPERCLIP_API_KEY = requireEnv("PAPERCLIP_API_KEY");
const PAPERCLIP_COMPANY_ID = requireEnv("PAPERCLIP_COMPANY_ID");
const SMS_SUSHI_API_TOKEN = requireEnv("SMS_SUSHI_API_TOKEN");
const SMS_SUSHI_BASE_URL =
  process.env.SMS_SUSHI_BASE_URL ?? "https://sms-sushi.fly.dev";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "15000");
const SMS_POLL_TIMEOUT_MS = parseInt(
  process.env.SMS_POLL_TIMEOUT_MS ?? "29000"
);
const STATE_FILE = process.env.STATE_FILE ?? "./relay-state.json";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface PaperclipIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
}

interface PaperclipInteraction {
  id: string;
  issueId: string;
  kind: string;
  status: string;
  title: string;
  summary: string | null;
  payload: {
    prompt?: string;
    acceptLabel?: string;
    rejectLabel?: string;
  };
}

interface SmsSushiCreateResponse {
  ok: boolean;
  notification_id: string;
  status: string;
  expects_response: boolean;
}

interface SmsSushiNotification {
  notification_id: string;
  status: string;
  response: string | null;
}

// ─── Persistent state ─────────────────────────────────────────────────────────
// Tracks interaction IDs we have already resolved to Paperclip. On restart we
// skip these so we don't double-accept/reject.

interface RelayState {
  resolvedInteractionIds: string[];
}

function loadState(): Set<string> {
  if (existsSync(STATE_FILE)) {
    try {
      const raw = readFileSync(STATE_FILE, "utf-8");
      const parsed = JSON.parse(raw) as RelayState;
      return new Set(parsed.resolvedInteractionIds ?? []);
    } catch {
      // Corrupt state file — start fresh
    }
  }
  return new Set();
}

function saveState(resolved: Set<string>): void {
  const state: RelayState = {
    resolvedInteractionIds: [...resolved],
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── In-memory session state ──────────────────────────────────────────────────

// interactionId → { notifId, issueId }
const activeRelays = new Map<
  string,
  { notifId: string; issueId: string }
>();

// Interactions we have successfully resolved to Paperclip (persisted across restarts)
const resolved: Set<string> = loadState();

// ─── Paperclip helpers ───────────────────────────────────────────────────────

async function paperclipGet<T>(path: string): Promise<T> {
  const res = await fetch(`${PAPERCLIP_API_URL}${path}`, {
    headers: { Authorization: `Bearer ${PAPERCLIP_API_KEY}` },
  });
  if (!res.ok) {
    throw new Error(
      `Paperclip GET ${path} → HTTP ${res.status}: ${await res.text()}`
    );
  }
  return res.json() as Promise<T>;
}

async function paperclipPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${PAPERCLIP_API_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PAPERCLIP_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(
      `Paperclip POST ${path} → HTTP ${res.status}: ${await res.text()}`
    );
  }
  return res.json() as Promise<T>;
}

async function getInReviewIssues(): Promise<PaperclipIssue[]> {
  return paperclipGet<PaperclipIssue[]>(
    `/api/companies/${PAPERCLIP_COMPANY_ID}/issues?status=in_review&limit=100`
  );
}

async function getPendingConfirmations(
  issueId: string
): Promise<PaperclipInteraction[]> {
  const interactions = await paperclipGet<PaperclipInteraction[]>(
    `/api/issues/${issueId}/interactions`
  );
  return interactions.filter(
    (i) => i.kind === "request_confirmation" && i.status === "pending"
  );
}

// ─── sms-sushi helpers ───────────────────────────────────────────────────────

async function smsSushiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SMS_SUSHI_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SMS_SUSHI_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `sms-sushi POST ${path} → HTTP ${res.status}: ${await res.text()}`
    );
  }
  return res.json() as Promise<T>;
}

async function smsSushiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${SMS_SUSHI_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${SMS_SUSHI_API_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(
      `sms-sushi GET ${path} → HTTP ${res.status}: ${await res.text()}`
    );
  }
  return res.json() as Promise<T>;
}

async function sendNotification(
  interaction: PaperclipInteraction,
  issue: PaperclipIssue
): Promise<string> {
  const prompt =
    interaction.payload.prompt ?? interaction.summary ?? interaction.title;
  const acceptLabel = interaction.payload.acceptLabel ?? "Yes";
  const rejectLabel = interaction.payload.rejectLabel ?? "No";

  const message = `[${issue.identifier}] ${interaction.title}\n\n${prompt}`;

  const result = await smsSushiPost<SmsSushiCreateResponse>(
    "/api/v1/notifications",
    {
      message,
      type: "blocked",
      response_type: "choice",
      options: [acceptLabel, rejectLabel],
    }
  );

  return result.notification_id;
}

// Long-polls sms-sushi until a response arrives or the notification expires.
// Returns the raw response string on success, null on expiry/cancellation.
async function pollForResponse(notifId: string): Promise<string | null> {
  for (;;) {
    try {
      const signal = AbortSignal.timeout(SMS_POLL_TIMEOUT_MS);
      const res = await fetch(
        `${SMS_SUSHI_BASE_URL}/api/v1/notifications/${notifId}/poll`,
        {
          headers: { Authorization: `Bearer ${SMS_SUSHI_API_TOKEN}` },
          signal,
        }
      );

      if (!res.ok) {
        if (res.status === 404) {
          log(`Notification ${notifId} not found — treating as expired`);
          return null;
        }
        const body = await res.text();
        log(`poll HTTP ${res.status} for ${notifId}: ${body} — retrying in 2s`);
        await sleep(2000);
        continue;
      }

      const data = (await res.json()) as SmsSushiNotification;

      if (data.response !== null && data.response !== undefined) {
        return data.response;
      }

      if (data.status === "expired" || data.status === "cancelled") {
        log(`Notification ${notifId} ${data.status} without response`);
        return null;
      }

      // Status changed but no response yet — keep polling
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        // Normal long-poll timeout — check if there's already a response via GET
        try {
          const data = await smsSushiGet<SmsSushiNotification>(
            `/api/v1/notifications/${notifId}`
          );
          if (data.response !== null && data.response !== undefined) {
            return data.response;
          }
          if (data.status === "expired" || data.status === "cancelled") {
            log(`Notification ${notifId} ${data.status} (detected on timeout check)`);
            return null;
          }
        } catch {
          // Ignore GET errors and retry the poll
        }
        continue;
      }
      throw err;
    }
  }
}

// ─── Relay logic ─────────────────────────────────────────────────────────────

async function startRelay(
  interaction: PaperclipInteraction,
  issue: PaperclipIssue
): Promise<void> {
  let notifId: string;
  try {
    notifId = await sendNotification(interaction, issue);
    log(
      `→ Sent sms-sushi notification ${notifId} for [${issue.identifier}] "${interaction.title}"`
    );
  } catch (err) {
    log(`Failed to send notification for ${interaction.id}: ${err}`);
    return;
  }

  activeRelays.set(interaction.id, { notifId, issueId: issue.id });

  // Poll and resolve asynchronously
  pollAndResolve(interaction, issue, notifId).catch((err) => {
    log(`Relay error for ${interaction.id}: ${err}`);
    activeRelays.delete(interaction.id);
  });
}

async function pollAndResolve(
  interaction: PaperclipInteraction,
  issue: PaperclipIssue,
  notifId: string
): Promise<void> {
  log(`⏳ Polling sms-sushi for response on notification ${notifId}…`);

  const response = await pollForResponse(notifId);

  activeRelays.delete(interaction.id);

  if (response === null) {
    // Notification expired — the tick loop will re-send on the next pass
    log(
      `⚠ Notification ${notifId} expired without response for [${issue.identifier}] — will re-notify`
    );
    return;
  }

  log(
    `✓ Got response "${response}" for [${issue.identifier}] "${interaction.title}"`
  );

  const acceptLabel = interaction.payload.acceptLabel ?? "Yes";
  const isAccept =
    response.toLowerCase() === acceptLabel.toLowerCase() ||
    response.toLowerCase() === "yes" ||
    response === "1";

  try {
    if (isAccept) {
      await paperclipPost(
        `/api/issues/${issue.id}/interactions/${interaction.id}/accept`
      );
      log(`✓ Accepted interaction on ${issue.identifier}`);
    } else {
      await paperclipPost(
        `/api/issues/${issue.id}/interactions/${interaction.id}/reject`,
        { reason: `Declined via sms-sushi (tapped "${response}")` }
      );
      log(`✓ Rejected interaction on ${issue.identifier}`);
    }
    resolved.add(interaction.id);
    saveState(resolved);
  } catch (err) {
    log(`Failed to resolve interaction ${interaction.id}: ${err}`);
  }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  let issues: PaperclipIssue[];
  try {
    issues = await getInReviewIssues();
  } catch (err) {
    log(`Failed to fetch in_review issues: ${err}`);
    return;
  }

  for (const issue of issues) {
    let pending: PaperclipInteraction[];
    try {
      pending = await getPendingConfirmations(issue.id);
    } catch (err) {
      log(`Failed to fetch interactions for ${issue.identifier}: ${err}`);
      continue;
    }

    for (const interaction of pending) {
      if (resolved.has(interaction.id)) {
        // Already resolved in a previous session — skip
        continue;
      }
      if (!activeRelays.has(interaction.id)) {
        log(
          `New pending confirmation on ${issue.identifier}: "${interaction.title}"`
        );
        await startRelay(interaction, issue);
      }
    }
  }
}

async function main(): Promise<void> {
  log("sms-sushi ↔ Paperclip relay bridge starting");
  log(`  Paperclip:     ${PAPERCLIP_API_URL}`);
  log(`  sms-sushi:     ${SMS_SUSHI_BASE_URL}`);
  log(`  Poll interval: ${POLL_INTERVAL_MS}ms`);
  log(`  State file:    ${STATE_FILE}`);
  log(`  Resolved IDs:  ${resolved.size} loaded from state`);

  for (;;) {
    await tick();
    await sleep(POLL_INTERVAL_MS);
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
