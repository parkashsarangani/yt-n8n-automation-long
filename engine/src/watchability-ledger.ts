/**
 * Canonical watchability evaluation, addressed by an immutable fingerprint.
 *
 * The watchability critic is stochastic: three reruns of `run_112aa43f`,
 * `run_c0e582cc` and `run_db4c97bb` — byte-identical script, identical critic
 * prompt/model/config, identical thresholds — produced materially different
 * gating decisions (first_30 rolled 0.68 / 0.87 / 0.77; payoff rolled 0.68 /
 * 0.84). That makes the whole DAG non-reproducible for identical content.
 *
 * A watchability decision is a DERIVED artifact of immutable inputs. Once an
 * (script + evaluator) fingerprint has an adjudicated report, every later run
 * of that exact content under that exact evaluator reuses it — the same way a
 * reused voice artifact is not re-synthesised. Re-grading is only correct for
 * a genuinely new fingerprint.
 *
 * The ledger is a small on-disk map, mirroring the image-bank pattern:
 *   <dataDir>/watchability-ledger/<fingerprint>.json
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { WATCHABILITY_POLICY_VERSION } from "./watchability-policy.ts";

export interface WatchabilityEvaluator {
  critic_prompt_ref: string;
  critic_model_capability: string;
  critic_effort: string;
  critic_prefer_paid: boolean;
  policy_version: string;
}

export interface WatchabilityFingerprintInput {
  /** Content hash of the immutable draft_script artifact (`sha256:...`). */
  script_artifact_id: string;
  /** The grading runtime as declared on the critic agent definition. */
  evaluator: WatchabilityEvaluator;
  /**
   * The duration profile the deterministic gate grades against. Grading floors
   * differ by profile (compact / transition / long_form), so it is part of the
   * fingerprint. Pass the profile MODE plus the target seconds so two runs at
   * different seconds in the same mode still share a fingerprint only when the
   * grading surface is truly identical.
   */
  duration_profile: string;
}

export interface CanonicalWatchability {
  fingerprint: string;
  /** The adjudicated report artifact id used by the gate. */
  canonical_report_id: string;
  /** Every raw critic report observed for this fingerprint, oldest first. */
  raw_report_ids: string[];
  /** How `canonical_report_id` was produced. */
  adjudication: "single" | "median_of_3" | "adopted";
  evaluator: WatchabilityEvaluator;
  script_artifact_id: string;
  duration_profile: string;
  created_at: string;
  /** Free-text note, e.g. "adopted from run_c0e582cc". */
  note?: string;
}

export function watchabilityEvaluator(agentDef: {
  prompt: string;
  model: { capability: string; effort?: string; prefer_paid_reasoning?: boolean };
}): WatchabilityEvaluator {
  return {
    critic_prompt_ref: agentDef.prompt,
    critic_model_capability: agentDef.model.capability,
    critic_effort: agentDef.model.effort ?? "medium",
    critic_prefer_paid: agentDef.model.prefer_paid_reasoning === true,
    policy_version: WATCHABILITY_POLICY_VERSION,
  };
}

/**
 * Deterministic fingerprint over the immutable script content and the exact
 * evaluator. Two runs collide here only when re-grading would be a waste: the
 * same words, the same grader, the same floors.
 */
export function watchabilityFingerprint(input: WatchabilityFingerprintInput): string {
  const parts = [
    input.script_artifact_id.trim(),
    input.evaluator.critic_prompt_ref,
    input.evaluator.critic_model_capability,
    input.evaluator.critic_effort,
    String(input.evaluator.critic_prefer_paid),
    input.evaluator.policy_version,
    input.duration_profile.trim(),
  ];
  return "wf_" + createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 40);
}

export class WatchabilityLedger {
  private constructor(private readonly dir: string) {}

  static async open(dataDir: string): Promise<WatchabilityLedger> {
    const dir = path.join(dataDir, "watchability-ledger");
    await mkdir(dir, { recursive: true });
    return new WatchabilityLedger(dir);
  }

  private pathFor(fingerprint: string): string {
    return path.join(this.dir, `${fingerprint}.json`);
  }

  async get(fingerprint: string): Promise<CanonicalWatchability | null> {
    try {
      const raw = await readFile(this.pathFor(fingerprint), "utf8");
      return JSON.parse(raw) as CanonicalWatchability;
    } catch {
      return null;
    }
  }

  /** Append a raw critic report id for a fingerprint (creates the entry if new). */
  async appendRaw(input: WatchabilityFingerprintInput, reportId: string): Promise<void> {
    const fingerprint = watchabilityFingerprint(input);
    const existing = await this.get(fingerprint);
    const raw = existing?.raw_report_ids ?? [];
    if (raw.includes(reportId)) return;
    const next: CanonicalWatchability = {
      fingerprint,
      canonical_report_id: existing?.canonical_report_id ?? "",
      raw_report_ids: [...raw, reportId],
      adjudication: existing?.adjudication ?? "single",
      evaluator: input.evaluator,
      script_artifact_id: input.script_artifact_id,
      duration_profile: input.duration_profile,
      created_at: existing?.created_at ?? new Date().toISOString(),
      ...(existing?.note ? { note: existing.note } : {}),
    };
    await this.write(next);
  }

  /**
   * Record the adjudicated canonical decision. First writer wins — a
   * fingerprint's canonical decision is immutable once set, so a later
   * (differently-rolled) report can never overwrite it.
   */
  async setCanonical(
    input: WatchabilityFingerprintInput,
    reportId: string,
    adjudication: CanonicalWatchability["adjudication"],
    note?: string,
  ): Promise<CanonicalWatchability> {
    const fingerprint = watchabilityFingerprint(input);
    const existing = await this.get(fingerprint);
    if (existing?.canonical_report_id) return existing;
    const raw = existing?.raw_report_ids ?? [];
    const next: CanonicalWatchability = {
      fingerprint,
      canonical_report_id: reportId,
      raw_report_ids: raw.includes(reportId) ? raw : [...raw, reportId],
      adjudication,
      evaluator: input.evaluator,
      script_artifact_id: input.script_artifact_id,
      duration_profile: input.duration_profile,
      created_at: existing?.created_at ?? new Date().toISOString(),
      ...(note ? { note } : {}),
    };
    await this.write(next);
    return next;
  }

  async list(): Promise<CanonicalWatchability[]> {
    const files = await readdir(this.dir).catch(() => [] as string[]);
    const out: CanonicalWatchability[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try { out.push(JSON.parse(await readFile(path.join(this.dir, file), "utf8")) as CanonicalWatchability); } catch { /* skip */ }
    }
    return out;
  }

  private async write(entry: CanonicalWatchability): Promise<void> {
    const tmp = this.pathFor(entry.fingerprint) + `.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(entry, null, 2), "utf8");
    const { rename } = await import("node:fs/promises");
    await rename(tmp, this.pathFor(entry.fingerprint));
  }
}
