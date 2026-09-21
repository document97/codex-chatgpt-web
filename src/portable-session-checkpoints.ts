import { copyFileSync, constants, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SUMMARY_PREFIX } from "./responses/compaction";

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function localReasoning(value: unknown): value is RecordValue {
  return record(value)
    && typeof value.type === "string"
    && value.type.toLowerCase() === "reasoning"
    && typeof value.id === "string"
    && /^rs_[0-9a-f]{32,64}$/i.test(value.id)
    && (value.encrypted_content == null || typeof value.encrypted_content !== "string");
}

function bridgeReasoning(value: unknown): value is RecordValue {
  return record(value)
    && typeof value.type === "string"
    && value.type.toLowerCase() === "reasoning"
    && typeof value.encrypted_content === "string"
    && value.encrypted_content.startsWith("ocxr1:");
}

function preserveLineByteLength(originalBody: string, serialized: string): string {
  const originalBytes = Buffer.byteLength(originalBody, "utf8");
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  if (serializedBytes > originalBytes) {
    throw new Error(`Session repair would expand a JSONL row by ${serializedBytes - originalBytes} bytes; file left unchanged`);
  }
  return serialized + " ".repeat(originalBytes - serializedBytes);
}

// Only bridge-owned summary envelopes are portable. Never attempt to decode official ciphertext.
function portableItem(value: unknown): unknown {
  if (!record(value)) return value;
  if (value.type === "compaction"
    && typeof value.encrypted_content === "string" && value.encrypted_content.startsWith("ocx1:")) {
    const encoded = value.encrypted_content.slice(5);
    const bytes = Buffer.from(encoded, "base64");
    if (!encoded || bytes.toString("base64") !== encoded) throw new Error("Malformed bridge checkpoint; session left unchanged");
    const summary = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n\n${summary}` }] };
  }
  if (!localReasoning(value) && !bridgeReasoning(value)) return value;
  const clean = { ...value };
  delete clean.id;
  if (bridgeReasoning(value)) delete clean.encrypted_content;
  else if (clean.encrypted_content === null) delete clean.encrypted_content;
  if (bridgeReasoning(value) && !Array.isArray(clean.summary) && !Array.isArray(clean.content)) return null;
  return clean;
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
    if (!line.includes("ocx1:") && !line.includes('"rs_')) return line;
    const row: unknown = JSON.parse(line);
    if (!record(row) || !record(row.payload)) return line;
    const before = converted;
    if (row.type === "response_item") row.payload = convert(row.payload);
    else if (row.type === "event_msg" && record(row.payload) && row.payload.type === "item_completed") {
      row.payload.item = convert(row.payload.item);
    }
    else if (row.type === "compacted") {
      for (const key of ["replacement_history", "guardian_history"]) {
        const items = row.payload[key];
        if (Array.isArray(items)) row.payload[key] = items.map(convert);
      }
      const retained = row.payload.retained_context;
      if (record(retained)) {
        for (const key of ["user_messages", "verified_answers"]) {
          const items = retained[key];
          if (Array.isArray(items)) retained[key] = items.map(convert);
        }
      }
    }
    if (before === converted) return line;
    const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const body = ending ? line.slice(0, -ending.length) : line;
    return preserveLineByteLength(body, JSON.stringify(row)) + ending;
  }).join("");
  if (Buffer.byteLength(text, "utf8") !== Buffer.byteLength(source, "utf8")) {
    throw new Error("Session repair changed the rollout byte length; file left unchanged");
  }
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
