/**
 * SmsSushi integration for the claude-local adapter.
 *
 * All calls are fail-open: errors are caught and logged, never propagated to
 * the heartbeat run. A SmsSushi outage must never block, delay, or fail an
 * agent run.
 *
 * Enabled per agent via adapter config `smsSushiEnabled: true`.
 * Token: SMS_SUSHI_API_TOKEN env var.
 * URL:   SMS_SUSHI_BASE_URL   env var (default: https://sms-sushi.fly.dev).
 */

const REQUEST_TIMEOUT_MS = 5_000;
const APPROVAL_POLL_INTERVAL_MS = 5_000;
const APPROVAL_BRIDGE_TICK_MS = 15_000;
const RENOTIFY_THROTTLE_MS = 5 * 60_000;

export interface SmsSushiConfig {
  apiToken: string;
  baseUrl: string;
}

export function readSmsSushiConfig(
  config: Record<string, unknown>,
  env: Record<string, string>,
): SmsSushiConfig | null {
  const enabled = config.smsSushiEnabled === true || config.smsSushiEnabled === "true";
  if (!enabled) return null;
  const apiToken = env.SMS_SUSHI_API_TOKEN?.trim() ?? "";
  if (!apiToken) return null;
  return {
    apiToken,
    baseUrl: env.SMS_SUSHI_BASE_URL?.trim() || "https://sms-sushi.fly.dev",
  };
}

async function smsSushiFetch(
  cfg: SmsSushiConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.apiToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Session lifecycle (item 2) ──────────────────────────────────────────────

export async function smsSushiRegisterSession(
  cfg: SmsSushiConfig,
  meta: { taskId: string | null; agentId: string; runId: string },
): Promise<string | null> {
  try {
    const data = (await smsSushiFetch(cfg, "POST", "/api/v1/sessions", {
      session_type: "claude_code",
      role: "standalone",
      capabilities: ["paperclip"],
      metadata: { task_id: meta.taskId, agent_id: meta.agentId, run_id: meta.runId },
    })) as { session_id?: string } | null;
    return data?.session_id ?? null;
  } catch {
    return null;
  }
}

export async function smsSushiSessionHeartbeat(cfg: SmsSushiConfig, sessionId: string): Promise<void> {
  try {
    await smsSushiFetch(cfg, "POST", `/api/v1/sessions/${sessionId}/heartbeat`, {
      work_state: "working",
    });
  } catch {
    // fail-open
  }
}

export async function smsSushiCompleteSession(cfg: SmsSushiConfig, sessionId: string): Promise<void> {
  try {
    await smsSushiFetch(cfg, "POST", `/api/v1/sessions/${sessionId}/complete`);
  } catch {
    // fail-open
  }
}

// ─── Task-completion notification (item 1) ───────────────────────────────────

export async function smsSushiNotifyTaskComplete(
  cfg: SmsSushiConfig,
  message: string,
  state: "complete" | "blocked",
): Promise<void> {
  try {
    await smsSushiFetch(cfg, "POST", "/api/v1/notifications", {
      message,
      type: "task_complete",
      expects_response: false,
      state,
    });
  } catch {
    // fail-open
  }
}

// ─── Approval bridge (item 3) ────────────────────────────────────────────────

interface PaperclipInteraction {
  id: string;
  kind: string;
  status: string;
  title: string;
  summary: string | null;
  payload: { prompt?: string; acceptLabel?: string; rejectLabel?: string };
}

async function paperclipFetch(
  apiUrl: string,
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface ApprovalBridge {
  stop(): void;
}

export function startApprovalBridge(input: {
  cfg: SmsSushiConfig;
  taskId: string;
  apiUrl: string;
  apiKey: string;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}): ApprovalBridge {
  const { cfg, taskId, apiUrl, apiKey, onLog } = input;
  let stopped = false;

  // Track interactions already relayed: id → timestamp of last send
  const lastNotifiedAt = new Map<string, number>();

  async function tick(): Promise<void> {
    const interactions = (await paperclipFetch(
      apiUrl,
      apiKey,
      "GET",
      `/api/issues/${taskId}/interactions`,
    )) as PaperclipInteraction[] | null;
    if (!Array.isArray(interactions)) return;

    const pending = interactions.filter(
      (i) => i.kind === "request_confirmation" && i.status === "pending",
    );

    for (const interaction of pending) {
      if (stopped) return;

      const lastSent = lastNotifiedAt.get(interaction.id) ?? 0;
      if (Date.now() - lastSent < RENOTIFY_THROTTLE_MS) continue; // throttle re-sends

      lastNotifiedAt.set(interaction.id, Date.now());

      const prompt = interaction.payload.prompt ?? interaction.summary ?? interaction.title;
      const acceptLabel = interaction.payload.acceptLabel ?? "Accept";
      const rejectLabel = interaction.payload.rejectLabel ?? "Reject";

      const notifData = (await smsSushiFetch(cfg, "POST", "/api/v1/notifications", {
        message: `[Approval needed] ${interaction.title}\n\n${prompt}`,
        type: "permission_prompt",
        expects_response: true,
        response_type: "choice",
        options: [acceptLabel, rejectLabel],
      })) as { notification_id?: string } | null;

      if (!notifData?.notification_id) {
        void onLog("stdout", `[sms-sushi] Failed to send approval notification for ${interaction.id}\n`);
        lastNotifiedAt.delete(interaction.id); // allow retry next tick
        continue;
      }

      const notifId = notifData.notification_id;
      void onLog("stdout", `[sms-sushi] Approval notification ${notifId} sent for ${interaction.id}\n`);

      // Poll SmsSushi response without blocking the main bridge loop
      void (async () => {
        while (!stopped) {
          await sleep(APPROVAL_POLL_INTERVAL_MS);
          const poll = (await smsSushiFetch(
            cfg,
            "GET",
            `/api/v1/notifications/${notifId}`,
          )) as { status?: string; response?: string | null } | null;
          if (!poll) continue;

          if (poll.response != null) {
            const isAccept =
              poll.response.toLowerCase() === acceptLabel.toLowerCase() ||
              poll.response.toLowerCase() === "yes" ||
              poll.response === "1";
            const endpoint = isAccept ? "accept" : "reject";
            const body = isAccept
              ? undefined
              : { reason: `Declined via SmsSushi: "${poll.response}"` };
            await paperclipFetch(
              apiUrl,
              apiKey,
              "POST",
              `/api/issues/${taskId}/interactions/${interaction.id}/${endpoint}`,
              body,
            );
            void onLog(
              "stdout",
              `[sms-sushi] Interaction ${interaction.id} ${endpoint}ed via phone response\n`,
            );
            // Mark with far-future timestamp so it won't be re-sent
            lastNotifiedAt.set(interaction.id, Date.now() + 365 * 24 * 60 * 60_000);
            return;
          }

          if (poll.status === "expired" || poll.status === "cancelled") {
            void onLog("stdout", `[sms-sushi] Notification ${notifId} expired without response\n`);
            // Clear timestamp so the bridge can re-send after RENOTIFY_THROTTLE_MS
            lastNotifiedAt.delete(interaction.id);
            return;
          }
          // status=awaiting_response or similar — keep polling
        }
      })();
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        await tick();
      } catch {
        // fail-open: loop survives tick errors
      }
      if (!stopped) await sleep(APPROVAL_BRIDGE_TICK_MS);
    }
  }

  void loop();

  return { stop: () => { stopped = true; } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
