import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

interface PublicEntry {
 id: string;
 parentId: string | null;
 type: string;
 message?: { role: string; stopReason?: string; toolCallId?: string; content?: unknown };
}
interface PublicSessionReader {
 getSessionId(): string;
 getLeafId(): string | null;
 getCwd(): string;
 getEntries(): PublicEntry[];
}
export interface NativeCheckpointExpectation {
 nativeId: string;
 sessionFile: string;
 leaf: string;
 cwd: string;
}

/** Inspection ONLY. No inference session, extensions, host or original-file writes.
 * Parse a private byte-copy through real public SDK APIs: SDK fallback/migration
 * must never truncate/repair an owner's original native transcript on inspection.
 * The actual host must independently verify identity again under its WT lease.
 */
export function inspectNativeCheckpoint(expected: NativeCheckpointExpectation, sdk: { SessionManager: { open(file: string): PublicSessionReader } }): { sourceDigest: string; nativeId: string; leaf: string } {
 const refuse: (reason: string) => never = (reason) => { throw new Error(`Native checkpoint inspection refused: ${reason}`); };
 if (!expected.nativeId || !expected.leaf || !path.isAbsolute(expected.cwd) || fs.realpathSync(expected.sessionFile) !== expected.sessionFile) refuse("incomplete/noncanonical checkpoint");
 const fd = fs.openSync(expected.sessionFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
 let bytes: Buffer;
 try {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) refuse("nonregular/oversized native transcript");
  bytes = fs.readFileSync(fd);
  if (bytes.length > 16 * 1024 * 1024) refuse("native transcript grew beyond its bound");
 } finally { fs.closeSync(fd); }
 const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
 const sourceDigest = hash(bytes);
 const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-native-inspect-"));
 try {
  const copy = path.join(directory, "session.jsonl");
  fs.writeFileSync(copy, bytes, { mode: 0o600, flag: "wx" });
  const reader = sdk.SessionManager.open(copy);
  if (hash(fs.readFileSync(copy)) !== sourceDigest) refuse("SDK altered its inspection copy");
  if (reader.getSessionId() !== expected.nativeId || reader.getLeafId() !== expected.leaf || reader.getCwd() !== expected.cwd) refuse("genuine SDK session/leaf/cwd mismatch");
  const entries = reader.getEntries();
  if (entries.length > 4096) refuse("entry capacity exceeded");
  const index = new Map<string, PublicEntry>();
  for (const entry of entries) {
   if (!entry.id || index.has(entry.id)) refuse("duplicate/missing entry identity");
   index.set(entry.id, entry);
  }
  const branch: PublicEntry[] = [], seen = new Set<string>();
  let cursor: string | null = expected.leaf;
  while (cursor !== null) {
   if (seen.has(cursor)) refuse("cyclic native branch");
   seen.add(cursor);
   const entry = index.get(cursor);
   if (!entry || entry.parentId !== null && typeof entry.parentId !== "string") refuse("broken native branch");
   branch.push(entry); cursor = entry.parentId;
  }
  branch.reverse();
  const pending = new Set<string>(), calls = new Set<string>();
  let lastMessage: PublicEntry["message"];
  for (const entry of branch) {
   if (entry.type !== "message" || !entry.message) continue;
   const message = entry.message; lastMessage = message;
   if (message.role === "assistant" && Array.isArray(message.content)) {
    for (const raw of message.content) {
     if (!raw || typeof raw !== "object" || raw.type !== "toolCall") continue;
     const id = raw.id;
     if (typeof id !== "string" || !id || calls.has(id)) refuse("ambiguous native tool-call identity");
     calls.add(id); pending.add(id);
    }
   } else if (message.role === "toolResult") {
    if (!message.toolCallId || !pending.delete(message.toolCallId)) refuse("unmatched native tool result");
   }
  }
  if (pending.size || lastMessage?.role !== "assistant" || lastMessage.stopReason !== "stop") refuse("native model/tool work is not demonstrably settled");
  if (hash(fs.readFileSync(expected.sessionFile)) !== sourceDigest) refuse("source changed during inspection");
  return { sourceDigest, nativeId: reader.getSessionId(), leaf: expected.leaf };
 } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
