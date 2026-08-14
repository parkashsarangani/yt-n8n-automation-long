/**
 * Prompt store (RFC 0003: "prompts live outside code").
 *
 * Prompts are versioned files referenced as `name@version`. A run pins the
 * version it used, so editing a prompt never changes the meaning of past runs.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export class PromptError extends Error {
  override name = "PromptError";
}

/** A `{{name}}` placeholder. Deliberately the whole templating language. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export interface PromptRef {
  name: string;
  version: string;
}

export function parsePromptRef(ref: string): PromptRef {
  const at = ref.lastIndexOf("@");
  if (at <= 0 || at === ref.length - 1) {
    throw new PromptError(`prompt reference must be "name@version", got "${ref}"`);
  }
  return { name: ref.slice(0, at), version: ref.slice(at + 1) };
}

export class PromptStore {
  private constructor(private readonly texts: Map<string, string>) {}

  /** Load every `<dir>/<name>/<version>.md`. */
  static async load(dir: string): Promise<PromptStore> {
    const texts = new Map<string, string>();
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      throw new PromptError(`cannot read prompt directory ${dir}: ${String(err)}`);
    }
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      for (const file of await readdir(path.join(dir, d.name))) {
        if (!file.endsWith(".md")) continue;
        const version = file.replace(/\.md$/, "");
        texts.set(`${d.name}@${version}`, await readFile(path.join(dir, d.name, file), "utf8"));
      }
    }
    return new PromptStore(texts);
  }

  has(ref: string): boolean {
    return this.texts.has(ref);
  }

  raw(ref: string): string {
    const text = this.texts.get(ref);
    if (text === undefined) throw new PromptError(`unknown prompt "${ref}"`);
    return text;
  }

  /**
   * Substitute `{{name}}` placeholders. Unknown placeholders and unused
   * variables both throw: a silently-empty placeholder is a prompt that quietly
   * lost half its input, which is very hard to notice in output.
   */
  render(ref: string, vars: Record<string, string>): string {
    const template = this.raw(ref);
    const used = new Set<string>();
    const out = template.replace(PLACEHOLDER, (_match, key: string) => {
      if (!(key in vars)) {
        throw new PromptError(`prompt "${ref}" references {{${key}}}, which was not supplied`);
      }
      used.add(key);
      return vars[key]!;
    });
    const unused = Object.keys(vars).filter((k) => !used.has(k));
    if (unused.length > 0) {
      throw new PromptError(
        `prompt "${ref}" ignores supplied variables: ${unused.join(", ")}`,
      );
    }
    return out;
  }
}
