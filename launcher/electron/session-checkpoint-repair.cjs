const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

function localReasoning(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && typeof value.type === "string" && value.type.toLowerCase() === "reasoning"
    && typeof value.id === "string"
    && /^rs_[0-9a-f]{32,64}$/i.test(value.id)
    && (value.encrypted_content == null || typeof value.encrypted_content !== "string");
}

function bridgeReasoning(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && typeof value.type === "string" && value.type.toLowerCase() === "reasoning"
    && typeof value.encrypted_content === "string"
    && value.encrypted_content.startsWith("ocxr1:");
}

function bridgeCompaction(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && value.type === "compaction" && typeof value.encrypted_content === "string"
    && value.encrypted_content.startsWith("ocx1:");
}

function convertItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return { item, changed: false };
  if (bridgeCompaction(item)) {
    const encoded = item.encrypted_content.slice("ocx1:".length);
    const summary = Buffer.from(encoded, "base64").toString("utf8");
    if (!encoded || Buffer.from(summary, "utf8").toString("base64") !== encoded) {
      throw new Error("Invalid bridge compaction checkpoint");
    }
    return {
      changed: true,
      item: {
        type: "message", role: "user",
        content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n\n${summary}` }],
      },
    };
  }
  if (!localReasoning(item) && !bridgeReasoning(item)) return { item, changed: false };
  const clean = { ...item };
  delete clean.id;
  const wasBridge = bridgeReasoning(clean);
  if (wasBridge) delete clean.encrypted_content;
  else if (clean.encrypted_content === null) delete clean.encrypted_content;
  if (wasBridge && !Array.isArray(clean.summary) && !Array.isArray(clean.content)) {
    return { item: null, changed: true };
  }
  return { item: clean, changed: true };
}

function rewriteKnownItems(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return 0;
  let changed = 0;
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return 0;
  const rewrite = (items) => {
    if (!Array.isArray(items)) return;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const result = convertItem(items[index]);
      if (result.changed) {
        if (result.item === null) items.splice(index, 1);
        else items[index] = result.item;
        changed += 1;
      }
    }
  };
  if (record.type === "response_item") {
    const result = convertItem(payload);
    if (result.changed) { record.payload = result.item; changed += 1; }
  } else if (record.type === "event_msg" && payload.type === "item_completed") {
    const result = convertItem(payload.item);
    if (result.changed) {
      if (result.item === null) delete payload.item;
      else payload.item = result.item;
      changed += 1;
    }
  } else if (record.type === "compacted") {
    rewrite(payload.replacement_history);
    rewrite(payload.guardian_history);
    rewrite(payload.retained_context);
  }
  return changed;
}

function preserveLineByteLength(originalBody, serialized) {
  const originalBytes = Buffer.byteLength(originalBody, "utf8");
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  if (serializedBytes > originalBytes) {
    throw new Error(`Session repair would expand a JSONL row by ${serializedBytes - originalBytes} bytes; file left unchanged`);
  }
  return serialized + " ".repeat(originalBytes - serializedBytes);
}

function repairSessionFile(file, { backup = true } = {}) {
  const original = fs.readFileSync(file, "utf8");
  let changed = 0;
  const lines = original.split(/(?<=\n)/).map((line) => {
    if (!line.includes("ocx1:") && !line.includes('"rs_')) return line;
    const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const body = ending ? line.slice(0, -ending.length) : line;
    const record = JSON.parse(body);
    const count = rewriteKnownItems(record);
    if (!count) return line;
    changed += count;
    return preserveLineByteLength(body, JSON.stringify(record)) + ending;
  }).join("");
  if (!changed) return { changed: 0 };
  if (Buffer.byteLength(lines, "utf8") !== Buffer.byteLength(original, "utf8")) {
    throw new Error("Session repair changed the rollout byte length; file left unchanged");
  }
  const suffix = crypto.randomUUID();
  const backupPath = `${file}.before-native-${suffix}.bak`;
  const temporary = `${file}.${suffix}.tmp`;
  if (backup) fs.copyFileSync(file, backupPath, fs.constants.COPYFILE_EXCL);
  try {
    fs.writeFileSync(temporary, lines, { flag: "wx", mode: 0o600 });
    if (fs.readFileSync(file, "utf8") !== original) throw new Error("Codex session changed during repair");
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return { changed, backup: backupPath };
}

function listSessionFiles(codexHome) {
  const root = path.join(codexHome, "sessions");
  const files = [];
  const visit = (directory, depth) => {
    if (depth > 4 || !fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    }
  };
  visit(root, 0);
  return files;
}

function repairCodexSessions(codexHome, logger = console) {
  const repaired = [];
  for (const file of listSessionFiles(codexHome)) {
    try {
      const result = repairSessionFile(file);
      if (result.changed) repaired.push({ file, ...result });
    } catch (error) {
      logger.warn?.("session.checkpoint_repair_failed", { file, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return repaired;
}

module.exports = { repairCodexSessions, repairSessionFile, listSessionFiles, preserveLineByteLength };
