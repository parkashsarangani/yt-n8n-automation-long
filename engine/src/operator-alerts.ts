/**
 * Notifies a human when driveUnattended() gives up on a run instead of only
 * logging it. Production incident 2026-09-18: a run sat retrying an
 * unrecoverable failure every ~16 minutes for 6+ hours with nothing but a
 * console line to show for it -- nobody was watching stdout, so nobody knew.
 *
 * Two independent, individually opt-in delivery paths, both best-effort:
 *  - a webhook POST (works unmodified with a Slack incoming webhook, which
 *    reads top-level `text`, or an n8n webhook node, which can read the full
 *    JSON and fan out however that project already routes notifications);
 *  - a direct email via the Resend API (one HTTP call, no SDK dependency).
 * Each is a deliberate no-op when its env vars are unset -- alerting is
 * opt-in infrastructure, and neither path may ever fail or block the run it
 * is reporting on.
 */

export interface OperatorAlertFailure {
  node_id: string;
  error: string;
}

export interface OperatorAlertPayload {
  run_id: string;
  reason: string;
  failures: OperatorAlertFailure[];
}

export interface OperatorAlertOptions {
  webhookUrl?: string;
  resendApiKey?: string;
  emailTo?: string;
  emailFrom?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: number;
  cooldownMs?: number;
}

/**
 * How long the same run+failure stays silent after it has alerted once.
 *
 * Production incident 2026-09-19: run 69dbad4e was blocked on a provider 429
 * and the scheduler re-entered driveUnattended() every ~16 minutes. Each pass
 * hit the same give-up and sent another email -- 41 of them in a day. "This
 * run needs attention" is a STATE, not an event: alert when it becomes true,
 * then stay quiet until it is either resolved or old enough to be worth
 * repeating.
 */
export const ALERT_COOLDOWN_MS = 6 * 60 * 60_000;

/**
 * Keyed on the run and what is wrong with it -- deliberately NOT on the error
 * text, which embeds provider request ids and timestamps that differ on every
 * retry and would defeat the dedup entirely.
 */
const lastAlertAt = new Map<string, number>();

function alertKey(payload: OperatorAlertPayload): string {
  const nodes = payload.failures.map((f) => f.node_id).sort().join(",");
  return `${payload.run_id}::${payload.reason}::${nodes}`;
}

function shortRunId(runId: string): string {
  return runId.startsWith("run_") ? runId.slice(4, 12) : runId;
}

export function formatOperatorAlertText(payload: OperatorAlertPayload): string {
  const detail = payload.failures.map((f) => `${f.node_id}: ${f.error}`).join("; ") || payload.reason;
  return `[vidgen] run ${shortRunId(payload.run_id)} needs operator attention -- ${payload.reason}: ${detail}`;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function notifyWebhook(
  payload: OperatorAlertPayload,
  webhookUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<void> {
  try {
    const response = await postJson(
      webhookUrl,
      {
        text: formatOperatorAlertText(payload),
        run_id: payload.run_id,
        reason: payload.reason,
        failures: payload.failures,
      },
      {},
      fetchImpl,
      timeoutMs,
    );
    if (!response.ok) {
      console.error(`[operator-alerts] webhook responded ${response.status} for run ${shortRunId(payload.run_id)}`);
    }
  } catch (error) {
    // Alerting failing silently would defeat the point of this module, so it
    // logs -- but it never throws, since a dead webhook must not affect the
    // run it is reporting on.
    console.error(`[operator-alerts] failed to notify webhook for run ${shortRunId(payload.run_id)}: ${String(error)}`);
  }
}

async function notifyEmail(
  payload: OperatorAlertPayload,
  opts: { apiKey: string; to: string; from: string },
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<void> {
  const text = formatOperatorAlertText(payload);
  try {
    const response = await postJson(
      "https://api.resend.com/emails",
      {
        from: opts.from,
        to: [opts.to],
        subject: `[vidgen] run ${shortRunId(payload.run_id)} needs operator attention`,
        text,
      },
      { authorization: `Bearer ${opts.apiKey}` },
      fetchImpl,
      timeoutMs,
    );
    if (!response.ok) {
      console.error(`[operator-alerts] email API responded ${response.status} for run ${shortRunId(payload.run_id)}`);
    }
  } catch (error) {
    console.error(`[operator-alerts] failed to send email for run ${shortRunId(payload.run_id)}: ${String(error)}`);
  }
}

export async function sendOperatorAlert(
  payload: OperatorAlertPayload,
  opts: OperatorAlertOptions = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const webhookUrl = (opts.webhookUrl ?? process.env["OPERATOR_ALERT_WEBHOOK_URL"])?.trim();
  const resendApiKey = (opts.resendApiKey ?? process.env["RESEND_API_KEY"])?.trim();
  const emailTo = (opts.emailTo ?? process.env["OPERATOR_ALERT_EMAIL_TO"])?.trim();
  const emailFrom = (opts.emailFrom ?? process.env["OPERATOR_ALERT_EMAIL_FROM"])?.trim();

  const emailConfigured = Boolean(resendApiKey && emailTo && emailFrom);
  // Nothing to deliver to: leave the cooldown untouched so configuring a
  // destination later still gets the first real alert.
  if (!webhookUrl && !emailConfigured) return;

  const now = opts.now ?? Date.now();
  const cooldownMs = opts.cooldownMs ?? ALERT_COOLDOWN_MS;
  const key = alertKey(payload);
  const previous = lastAlertAt.get(key);
  if (previous !== undefined && now - previous < cooldownMs) {
    console.log(`[operator-alerts] suppressed repeat alert for run ${shortRunId(payload.run_id)} (${payload.reason})`);
    return;
  }
  lastAlertAt.set(key, now);

  const deliveries: Array<Promise<void>> = [];
  if (webhookUrl) deliveries.push(notifyWebhook(payload, webhookUrl, fetchImpl, timeoutMs));
  if (emailConfigured) {
    deliveries.push(notifyEmail(payload, { apiKey: resendApiKey!, to: emailTo!, from: emailFrom! }, fetchImpl, timeoutMs));
  }
  await Promise.all(deliveries);
}
