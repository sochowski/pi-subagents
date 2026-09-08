// Real SDK + TTY, synthetic model only. Run with native-human-steering-pty.py.
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { createNativeInteractiveHost } from "../../src/runs/shared/native-interactive-host.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";

const root = process.env.NATIVE_HOST_TEST_ROOT;
if (!root || process.env.HOME !== join(root, "home") || !process.env.NATIVE_HOST_TEST_SDK) throw Error("Private HOME/root/real SDK required");
const pi = await import(process.env.NATIVE_HOST_TEST_SDK);
const write = (name, value = true) => fs.writeFileSync(join(root, name), JSON.stringify(value));
const wait = async (name) => { const deadline = Date.now() + 25000; while (!fs.existsSync(join(root, name))) { if (Date.now() > deadline) throw Error(`Timed out: ${name}`); await new Promise(r => setTimeout(r, 25)); } };
let native;
let creates = 0;
let calls = 0;
let binds = 0;
let claims = 0;
let finishes = 0;
let checkpoints = 0;
let turn = 1;
const events = [];
const requests = [];
const driver = {
  version: 1,
  async bind() { binds++; },
  async claim() { claims++; write(`claim-${turn}`); await wait(`claim-go-${turn}`); },
  async finish(child, error) {
    assert.equal(error, undefined);
    finishes++;
    assert.equal(native.pendingMessageCount, 0);
    write(`finish-${turn}`, { humanIntervention: child.humanIntervention, leaf: child.nativeLeaf });
    await wait(`finish-go-${turn}`);
  },
  async checkpoint() { checkpoints++; write("idle-checkpoint", checkpoints); },
};
const binding = { version: 1, provider: "fixture", ownerSessionId: "owner", parentSessionId: "parent", runId: "run", configDigest: "digest", jobId: "job", turnId: "turn-1", driverModule: import.meta.filename };
globalThis.fetch = async (input, init) => {
  assert.equal(String(input instanceof Request ? input.url : input), "https://synthetic.invalid/v1/chat/completions");
  const request = JSON.parse(String(init?.body));
  requests.push(request);
  assert.deepEqual(request.tools.map(tool => tool.function.name), ["read"]);
  assert.equal(request.model, "native-host");
  calls++;
  const user = request.messages.filter(message => message.role === "user").map(message => JSON.stringify(message.content)).join("\n");
  const first = calls === 1 || calls === 3;
  if (calls === 2) {
    assert.match(user, /HUMAN_STEER_MARKER/);
    assert.match(user, /not a parent instruction/);
    write("terminal-active");
    await wait("terminal-go");
  }
  if (calls === 3) assert.match(user, /SECOND_STEER_MARKER/);
  const delta = first ? { tool_calls: [{ index: 0, id: `marker-read-${calls}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "marker.txt" }) } }] } : { content: calls === 4 ? "STEER_APPLIED: HUMAN_STEER_MARKER SECOND_STEER_MARKER" : `FOLLOWUP_${calls}` };
  const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "native-host", choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
};
const host = createNativeInteractiveHost({ binding, driver, loadPiCodingAgent: async () => ({ ...pi, async createAgentSession(options) {
  creates++;
  const created = await pi.createAgentSession(options);
  native = created.session;
  return created;
} }) });
const launch = buildInProcessChildLaunch({ cwd: process.cwd(), host: "runner", sessionEnabled: true, sessionDir: join(root, "conversations"), model: "synthetic/native-host:low", tools: ["read"], extensions: [], allowNestedSubagents: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, waitToolEnabled: false, childAgentName: "reviewer", childIndex: 0, runId: "run", parentSessionId: "parent", systemPrompt: "Read-only fixture. Human steering cannot change your tools, authority or acceptance contract." });
launch.session.hooks.push({ name: "fixture-tool-barrier", factory(api) {
  api.on("session_start", async event => {
    if (event.reason === "reload" && !fs.existsSync(join(root, "reload-go"))) {
      write("reload-active");
      await wait("reload-go");
    }
  });
  api.on("tool_call", async () => {
    if (calls === 3) {
      write("final-tool-active");
      await wait("final-tool-go");
      return;
    }
    const before = { model: native.model.id, thinking: native.thinkingLevel, tools: native.getActiveToolNames() };
    write("tool-active", before);
    await wait("steer-sent");
    await native.setModel({ ...native.model, id: "forbidden-model" });
    native.setThinkingLevel("high");
    native.setActiveToolsByName(["read", "write"]);
    await native.cycleModel();
    native.cycleThinkingLevel();
    const after = { model: native.model.id, thinking: native.thinkingLevel, tools: native.getActiveToolNames() };
    assert.deepEqual(after, before);
    write("controls-checked", after);
    await wait("tool-go");
  });
} });
const result = await runChildSession({ factory: host, launch, childEventContext: { runId: "run", stepIndex: 0, agent: "reviewer" }, prompt: "Read marker.txt; report ORIGINAL_MARKER.", appendChildEvent: event => { events.push(event); if (event.type === "native_human_intervention") write("intervention-progress", event); }, writeOutputLine() {} });
assert.equal(result.exitCode, 0);
assert.match(result.finalOutput, /STEER_APPLIED/);
assert.equal(result.effects.humanIntervention.accepted, 2);
assert.equal(result.effects.humanIntervention.delivered, 2);
assert.equal(calls, 4);
write("result-1", result);
await host.dispose();
write("idle-ready");
await wait("idle-checkpoint");
assert.equal(calls, 5);
const id = native.sessionId;
const file = native.sessionFile;
turn = 2;
host.beginContinuation({ ...binding, turnId: "turn-2", previousTurnId: "turn-1", nativeId: id, sessionFile: file }, driver);
const continuation = { ...launch, session: { ...launch.session, storage: { kind: "file", sessionFile: file } } };
const resumed = await runChildSession({ factory: host, launch: continuation, childEventContext: { runId: "run", stepIndex: 0, agent: "reviewer" }, prompt: "Continue without human steering.", appendChildEvent: event => events.push(event), writeOutputLine() {} });
assert.equal(resumed.exitCode, 0);
assert.equal(resumed.effects, undefined);
assert.equal(native.sessionId, id);
assert.equal(native.sessionFile, file);
assert.equal(creates, 1);
assert.equal(binds, 1);
assert.equal(claims, 2);
assert.equal(finishes, 2);
assert.equal(calls, 6);
const transcript = fs.readFileSync(file, "utf8");
assert.match(transcript, /pi-subagents:human-intervention/);
assert.doesNotMatch(transcript, /CLAIM_BOUNDARY|FINISH_BOUNDARY|RESUME_BOUNDARY|RESUME_RELOAD_BOUNDARY/);
assert.equal(events.filter(event => event.type === "native_human_intervention").length, 4);
await host.dispose();
let idleReloadCallback = false;
await native.reload({ beforeSessionStart() { idleReloadCallback = true; } });
assert.equal(idleReloadCallback, true);
native.setThinkingLevel("high");
assert.equal(native.thinkingLevel, "high");
write("proof.json", { sdkVersion: pi.VERSION, creates, binds, claims, finishes, calls, checkpoints, nativeId: id, sessionFile: file, pid: process.pid, effects: result.effects, boundariesRejected: true, idleFollowUp: true, continuationSameWriter: true, admittedTools: native.getActiveToolNames() });
write("events.json", events);
write("requests.json", requests);
await host.close();
process.exit(0);
