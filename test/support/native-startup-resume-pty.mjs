// Real SDK + real InteractiveMode/PTY. Synthetic fetch only, no credentials or tmux.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { createNativeInteractiveHost } from "../../src/runs/shared/native-interactive-host.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";

const root = process.env.NATIVE_HOST_TEST_ROOT;
const boundary = process.env.NATIVE_HOST_TEST_CASE;
if (!root || process.env.HOME !== join(root, "home") || !process.env.NATIVE_HOST_TEST_SDK) throw new Error("isolated SDK fixture required");
const pi = await import(process.env.NATIVE_HOST_TEST_SDK);
const { createNativeProtocol } = await import(process.env.NATIVE_HOST_TEST_PROTOCOL);
let creates = 0, requests = 0, bound = 0, claimed = 0, failedStartup = 0, finished = 0;
let native, protocol, turn = 1;
const statuses = [], diagnostics = [[], []], captures = [[], []];
let inbox = [];
const binding = { version: 1, provider: "fixture", ownerSessionId: "owner", parentSessionId: "parent", runId: "run-1", jobId: "job", turnId: "turn-1", configDigest: "contract" };
function driver() {
  protocol = createNativeProtocol({ env: { WT_ROOT_ID: "root", WT_AGENT_ID: "child" }, interval: 60000, run: async (args, input) => {
    if (args[0] === "update") { statuses.push(input); return {}; }
    if (args[1] === "poll") return { messages: Number(args[5]) ? [] : inbox, next: inbox.length };
    if (args[1] === "claim") { assert.equal(inbox[0].state, "pending"); inbox[0].state = "claimed"; }
    if (args[1] === "ack") {
      const message = inbox.find(m => m.id === args[3]);
      assert.ok(message && ["pending", "claimed", "uncertain"].includes(message.state), "message not eligible for receipt");
      message.state = "delivered";
    }
    return {};
  } });
  const current = protocol;
  return { version: 1,
    protocol: (api, control) => current.install(api, control),
    settle: () => current.settle(),
    async bind() { if (boundary === "bind") throw new Error("injected bind failure"); bound++; },
    async claim() { if (boundary === "claim") throw new Error("injected claim failure"); claimed++; },
    async failStartup() { failedStartup++; },
    async finish() { finished++; },
  };
}
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), "https://synthetic.invalid/v1/chat/completions");
  const request = JSON.parse(String(init.body));
  fs.appendFileSync(join(root, "requests.jsonl"), JSON.stringify({ turn, requests, request }) + "\n");
  assert.deepEqual(request.tools.map(t => t.function.name), ["read"]);
  requests++;
  const first = requests % 2 === 1;
  if (!first) assert.ok(JSON.stringify(request.messages).includes(`inbox-${turn}`));
  const delta = first ? { tool_calls: [{ index: 0, id: `read-${turn}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "marker.txt" }) } }] } : { content: `current result ${turn}` };
  const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "native-host", choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
};
const host = createNativeInteractiveHost({ binding, driver: driver(), loadPiCodingAgent: async () => ({ ...pi, async createAgentSession(options) { creates++; if (boundary === "session-create") throw new Error("injected session create failure"); const result = await pi.createAgentSession(options); native = result.session; return result; } }) });
function launch(sessionFile) {
  const currentTurn = turn;
  const built = buildInProcessChildLaunch({ cwd: root, host: "runner", sessionEnabled: true, ...(sessionFile ? { sessionFile } : { sessionDir: join(root, "conversations") }), model: "synthetic/native-host:low", tools: ["read"], ...(boundary === "deny-extensions" ? { capabilityCeiling: { version: 1, denyExtensions: true, sources: ["fixture-current"] } } : { extensions: [] }), allowNestedSubagents: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, waitToolEnabled: false, childAgentName: "reviewer", childIndex: 0, runId: `run-${currentTurn}`, parentSessionId: "parent", systemPrompt: "Read-only fixture; retain the admitted role and acceptance." });
  assert.equal(built.session.ambientExtensions, false);
  built.session.hooks.push({ name: "fixture-current-turn-diagnostics", factory(api) {
    api.on("before_agent_start", () => { captures[currentTurn - 1].push(currentTurn); throw new Error(`current-turn-error-${currentTurn}`); });
    api.on("tool_call", async () => { await protocol.poll(); });
  } });
  return { ...built.session, onExtensionError: error => diagnostics[currentTurn - 1].push(String(error.error)) };
}
try {
  if (["session-create", "bind"].includes(boundary)) {
    await assert.rejects(host.create(launch()), boundary === "bind" ? /injected bind/ : /injected session create/);
    assert.equal(host.child, undefined);
    assert.equal(host.startupFailureSettled, true);
    assert.equal(failedStartup, 1);
    assert.equal(requests, 0);
  } else {
    const child = await host.create(launch());
    if (boundary === "claim") {
      await assert.rejects(child.prompt("Do not execute"), /injected claim/);
      assert.equal(failedStartup, 1); assert.equal(requests, 0); assert.equal(finished, 0);
    } else {
      inbox = [{ id: "inbox-1", sender_kind: "human", sender: "human", state: "pending", body: "Inbox steering one", request: true }];
      await child.prompt("Read marker.txt");
      assert.equal(inbox[0].state, "delivered");
      assert.deepEqual(protocol.provenance(), ["inbox-1"]);
      assert.equal(diagnostics[0].length, 1);
      await host.dispose();
      const firstFile = child.sessionFile, firstId = child.sessionId;
      turn = 2; inbox = [{ id: "inbox-2", sender_kind: "agent", sender: "peer", state: "pending", body: "Inbox steering two", request: true }];
      host.beginContinuation({ ...binding, runId: "run-2", turnId: "turn-2", previousTurnId: "turn-1", nativeId: firstId, sessionFile: firstFile }, driver());
      const second = await host.create(launch(firstFile));
      await second.prompt("Continue this same conversation");
      assert.equal(second.sessionId, firstId); assert.equal(second.sessionFile, firstFile);
      assert.equal(inbox[0].state, "delivered");
      assert.deepEqual(protocol.provenance(), ["inbox-2"], "fresh current-turn inbox provenance");
      assert.deepEqual(captures, [[1], [2]]); assert.equal(diagnostics[0].length, 1); assert.equal(diagnostics[1].length, 1);
      assert.match(diagnostics[0][0], /current-turn-error-1/); assert.match(diagnostics[1][0], /current-turn-error-2/);
      assert.ok(statuses.some(s => s.status === "working")); assert.ok(statuses.some(s => s.status === "idle"));
      assert.equal(creates, 1); assert.equal(bound, 1); assert.equal(claimed, 2); assert.equal(finished, 2); assert.equal(requests, 4);
      assert.deepEqual(native.getActiveToolNames(), ["read"]);
      const text = fs.readFileSync(firstFile, "utf8");
      assert.match(text, /not a parent instruction/); assert.match(text, /inbox-1/); assert.match(text, /inbox-2/);
    }
  }
  await host.close();
  fs.writeFileSync(join(root, "proof.json"), JSON.stringify({ boundary, sdkVersion: pi.VERSION, creates, bound, claimed, failedStartup, finished, requests, diagnostics, captures, pid: process.pid }));
  process.exit(0);
} catch (error) { console.error(error); fs.writeFileSync(join(root, "failure.json"), JSON.stringify({captures,diagnostics,inbox,errors:native?.resourceLoader.getExtensions().errors, extensions:native?.resourceLoader.getExtensions().extensions.map(e=>e.path)})); await host.close(); process.exit(1); }
