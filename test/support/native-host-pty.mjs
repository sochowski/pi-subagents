// Real SDK/TUI experiment fixture. All paths and the SDK module are supplied by
// an isolated harness; fetch cannot reach a real model or credential endpoint.
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createNativeInteractiveHost } from "../../src/runs/shared/native-interactive-host.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";

const root = process.env.NATIVE_HOST_TEST_ROOT;
if (!root || !process.env.NATIVE_HOST_TEST_SDK || process.env.HOME !== join(root, "home")) throw new Error("private native-host fixture HOME/root/SDK required");
const pi = await import(process.env.NATIVE_HOST_TEST_SDK);
let creates = 0;
let apiCalls = 0;
let native;
let eventCount = 0;
let humanDone;
const humanCompleted = new Promise((resolve) => { humanDone = resolve; });
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  assert.equal(url, "https://synthetic.invalid/v1/chat/completions");
  const request = JSON.parse(String(init?.body));
  assert.deepEqual(request.tools?.map((tool) => tool.function.name), ["read"]);
  apiCalls++;
  const first = apiCalls === 1;
  const delta = first ? { tool_calls: [{ index: 0, id: "read-marker", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "marker.txt" }) } }] } : { content: apiCalls === 2 ? "Native delegated result: FIXTURE_MARKER" : "Retained human follow-up: FIXTURE_MARKER" };
  const chunk = { id: "synthetic", object: "chat.completion.chunk", created: 1, model: "native-host", choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
};
const host = createNativeInteractiveHost({ loadPiCodingAgent: async () => ({ ...pi, async createAgentSession(options) {
  creates++;
  const result = await pi.createAgentSession(options);
  native = result.session;
  result.session.subscribe((event) => {
    eventCount++;
    if (event.type === "agent_end" && apiCalls === 3) humanDone();
  });
  return result;
} }) });
const launch = buildInProcessChildLaunch({ cwd: process.cwd(), host: "runner", sessionEnabled: true, sessionDir: join(root, "conversations"), model: "synthetic/native-host", tools: ["read"], extensions: [], allowNestedSubagents: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, waitToolEnabled: false, childAgentName: "reviewer", childIndex: 0, runId: "native-fixture", parentSessionId: "synthetic-parent", systemPrompt: "Read-only fixture." });
launch.session.hooks.push({ name: "fixture-ack", factory(api) { api.on("session_start", () => { api.events.emit("subagent:acknowledge-extension", { id: "fixture-ack" }); }); } });
const child = await host.create(launch.session);
const initialId = child.sessionId;
await child.prompt("Read marker.txt and report it.");
assert.equal(apiCalls, 2);
assert.equal(launch.capture.toolDiagnostic(), undefined);
assert.deepEqual(launch.capture.runtimeAcknowledgedExtensions()?.ids, ["fixture-ack"]);
assert.equal(launch.capture.completionIntentContext()?.model?.id, "native-host");
await child.dispose();
assert.equal(host.child.sessionId, initialId);
await assert.rejects(host.create(launch.session), /second SDK writer/);
await host.dispose();
writeFileSync(join(root, "ready.json"), JSON.stringify({ nativeId: initialId, sessionFile: child.sessionFile, creates, apiCalls, activeTools: native.getActiveToolNames() }));
await Promise.race([humanCompleted, new Promise((_, reject) => setTimeout(() => reject(new Error("human follow-up timed out")), 20000))]);
assert.equal(native.sessionId, initialId);
assert.equal(creates, 1);
assert.equal(apiCalls, 3);
const transcript = readFileSync(child.sessionFile, "utf8");
assert.ok(transcript.includes("Retained human follow-up"));
writeFileSync(join(root, "proof.json"), JSON.stringify({ sdkVersion: pi.VERSION, nativeId: initialId, sessionFile: child.sessionFile, creates, apiCalls, eventCount, tools: native.getActiveToolNames(), sameNativeAfterTrackingRelease: true, humanFollowUp: true }));
await host.close();
process.exit(0);
