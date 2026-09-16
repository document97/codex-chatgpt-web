import { copyFileSync, constants, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SUMMARY_PREFIX } from "./responses/compaction";

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Only bridge-owned summary envelopes are portable. Never attempt to decode official ciphertext.
function portableItem(value: unknown): unknown {
  if (!record(value) || value.type !== "compaction"
    || typeof value.encrypted_content !== "string" || !value.encrypted_content.startsWith("ocx1:")) return value;
  const encoded = value.encrypted_content.slice(5);
  const bytes = Buffer.from(encoded, "base64");
  if (!encoded || bytes.toString("base64") !== encoded) throw new Error("Malformed bridge checkpoint; session left unchanged");
  const summary = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n\n${summary}` }] };
}

export function portableSessionCheckpoints(source: string): { text: string; converted: number } {
  let converted = 0;
  const convert = (item: unknown): unknown => {
    const result = portableItem(item);
    if (result !== item) converted++;
    return result;
  };
  // Preserve every unaffected line byte-for-byte, including line endings and final newline.
  const text = source.split(/(?<=\n)/).map(line => {
    if (!line.includes("ocx1:")) return line;
    const row: unknown = JSON.parse(line);
    if (!record(row) || !record(row.payload)) return line;
    const before = converted;
    if (row.type === "response_item") row.payload = convert(row.payload);
    else if (row.type === "compacted") {
      for (const key of ["replacement_history", "guardian_history"]) {
        const items = row.payload[key];
        if (Array.isArray(items)) row.payload[key] = items.map(convert);
      }
    }
    if (before === converted) return line;
    const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    return JSON.stringify(row) + ending;
  }).join("");
  return { text, converted };
}

export function repairSessionCheckpoints(file: string, assertOffline: () => void): { converted: number; backup?: string } {
  assertOffline();
  const original = readFileSync(file, "utf8");
  const result = portableSessionCheckpoints(original);
  if (!result.converted) return { converted: 0 };
  const suffix = randomUUID();
  const backup = `${file}.before-portable-${suffix}.bak`;
  const temporary = `${file}.${suffix}.tmp`;
  try {
    // Abort if a writer appeared; backups are unique and never overwritten.
    assertOffline();
    copyFileSync(file, backup, constants.COPYFILE_EXCL);
    if (readFileSync(backup, "utf8") !== original) throw new Error("Session changed during backup; repair aborted");
    writeFileSync(temporary, result.text, { flag: "wx", mode: 0o600 });
    assertOffline();
    if (readFileSync(file, "utf8") !== original) throw new Error("Session changed during repair; repair aborted");
    renameSync(temporary, file);
    return { converted: result.converted, backup };
  } finally {
    rmSync(temporary, { force: true });
  }
}
