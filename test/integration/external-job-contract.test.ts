import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { registerExternalJobProvider } from "../../src/api/external-job-provider.ts";
import { registerSubagentCapabilityCeiling } from "../../src/api/capability-ceiling.ts";
import { serviceExternalJobBridgeRequests } from "../../src/runs/shared/external-job-bridge.ts";
import { buildAsyncRunnerSteps } from "../../src/runs/background/async-execution.ts";
import { installSingleExecutionHooks, makeExecutor, tempDir } from "../support/single-execution-fixture.ts";
import { makeAgent, makeMinimalCtx } from "../support/helpers.ts";

const profile = (overrides = {}) => makeAgent("peer", { runner: { type: "external-job", provider: "contract-test" }, ...overrides } as any);
async function settle(result: any): Promise<any> {
	if (result.isError || !result.details.asyncDir) return result;
	const dir = result.details.asyncDir;
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		serviceExternalJobBridgeRequests(dir);
		try {
			const status = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
			if (["complete", "failed", "stopped"].includes(status.state)) return status;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out: ${dir}`);
}

describe("external-job admitted requirements public routing", () => {
	installSingleExecutionHooks();
	for (const ceiling of [{ allowedTools: ["read"] }, { allowedTools: [] }, { denyExtensions: true }]) {
		it(`never dispatches a legacy provider under ${JSON.stringify(ceiling)}`, async () => {
			let starts = 0;
			const handle = () => ({ providerJobId: "legacy", state: "completed" as const });
			const dispose = registerExternalJobProvider({ name: "contract-test", start: () => { starts++; return handle(); }, status: handle, result: handle, reattach: handle });
			const restriction = registerSubagentCapabilityCeiling({ sessionId: "session-123", source: "test", ceiling });
			try {
				const result = await makeExecutor([profile()]).execute("restricted", { agent: "peer", task: "inspect", async: true }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
				restriction.dispose(); // Admission, not current bridge registrations, is authoritative.
				await settle(result);
				assert.equal(starts, 0);
			} finally { restriction.dispose(); dispose(); }
		});
	}
	for (const override of [{ tools: ["read"] }, { tools: [] }, { excludeTools: ["bash"] }, { extensions: [] }, { model: "mock/pinned" }, { thinking: "high" }, { skills: ["missing"] }, { mcpDirectTools: ["server/tool"] }]) {
		it(`rejects unsupported profile requirements in single and chain: ${JSON.stringify(override)}`, async () => {
			const h = () => ({ providerJobId: "unused", state: "completed" as const });
			const dispose = registerExternalJobProvider({ name: "contract-test", start: h, status: h, result: h, reattach: h });
			const agent = profile(override);
			const result = await makeExecutor([agent]).execute("unsupported", { agent: "peer", task: "inspect", async: true }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(result.isError, true);
			const chain = buildAsyncRunnerSteps("chain", { chain: [{ agent: "peer", task: "inspect" }], agents: [agent] as any, ctx: { cwd: tempDir, currentSessionId: "session-123" }, asyncDir: path.join(tempDir, "chain"), maxSubagentDepth: 1 });
			assert.ok("error" in chain);
			dispose();
		});
	}
});

import { ASYNC_DIR } from "../../src/shared/types.ts";
import { readExternalJobContract } from "../../src/runs/shared/external-job-contract.ts";
import { requestExternalJobOperation } from "../../src/runs/shared/external-job-bridge.ts";
import { createEventBus } from "../support/helpers.ts";
import { registerSubagentRpcBridge, SUBAGENT_RPC_REQUEST_EVENT, subagentRpcReplyEvent } from "../../src/extension/rpc.ts";

function pumpBridge() {
	return setInterval(() => {
		if (!fs.existsSync(ASYNC_DIR)) return;
		for (const entry of fs.readdirSync(ASYNC_DIR, { withFileTypes: true })) if (entry.isDirectory()) serviceExternalJobBridgeRequests(path.join(ASYNC_DIR, entry.name));
	}, 10);
}

describe("external-job negotiated callbacks and RPC workflow", () => {
	installSingleExecutionHooks();
	it("persists before start; sends exact context on status/result/recovery and retains follow-up identity", async () => {
		const calls: Array<{ op: string; input: any }> = [];
		const handle = (op: string, id: string, input: any) => {
			const contract = input.launchRequirements;
			assert.ok(Object.isFrozen(contract));
			assert.deepEqual(readExternalJobContract(path.join(ASYNC_DIR, contract.admission.runId), contract.stepIndex), contract);
			calls.push({ op, input });
			return { providerJobId: id, state: op === "start" ? "running" as const : "completed" as const, launchRequirementsDigest: contract.digest, ...(op === "result" ? { output: "checked" } : {}) };
		};
		const dispose = registerExternalJobProvider({ name: "contract-test", launchRequirementsVersion: 1,
			start: (input) => handle("start", "original", input), followUp: (input) => handle("followUp", "continuation", input),
			status: (id, input) => handle("status", id, input), result: (id, input) => handle("result", id, input), reattach: (id, input) => handle("reattach", id, input),
		});
		const restriction = registerSubagentCapabilityCeiling({ sessionId: "session-123", source: "disposed", ceiling: { allowedTools: ["read"], denyExtensions: true } });
		const executor = makeExecutor([profile()]);
		const pump = pumpBridge();
		try {
			const launched = await executor.execute("positive", { agent: "peer", task: "inspect", async: true }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.notEqual(launched.isError, true, JSON.stringify(launched));
			restriction.dispose();
			const status = await settle(launched);
			assert.equal(status.state, "complete", JSON.stringify(status));
			const first = calls.find((call) => call.op === "start")!.input;
			assert.deepEqual(first.launchRequirements.admission.requirements.tools.allowlist, ["read"]);
			assert.equal(first.launchRequirements.admission.requirements.extensions.disableAmbient, true);
			assert.equal(first.launchRequirements.admission.ownerSessionId, "session-123");
			assert.equal(first.launchRequirements.admission.cwd, tempDir);
			assert.deepEqual(calls.map((call) => call.op), ["start", "status", "result"]);
			const recovered = await requestExternalJobOperation(launched.details.asyncDir, { operation: "reattach", provider: "contract-test", providerJobId: "original", context: { launchRequirements: first.launchRequirements } });
			assert.equal(recovered.state, "completed");
			assert.equal(calls.at(-1)!.op, "reattach");
			await new Promise((resolve) => setTimeout(resolve, 100));
			const continued = await executor.execute("resume", { action: "resume", id: launched.details.asyncId, message: "inspect again" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.notEqual(continued.isError, true, JSON.stringify(continued));
			assert.equal((await settle(continued)).state, "complete");
			const follow = calls.find((call) => call.op === "followUp")!.input;
			assert.equal(follow.parentProviderJobId, "original");
			assert.equal(follow.launchRequirements.lineage.parentRequirementsDigest, first.launchRequirements.digest);
			assert.deepEqual(follow.launchRequirements.admission.requirements, first.launchRequirements.admission.requirements);
			const duplicate = await executor.execute("duplicate", { action: "resume", id: launched.details.asyncId, message: "inspect again" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.notEqual(duplicate.isError, true, JSON.stringify(duplicate));
			assert.equal(duplicate.details.asyncId, continued.details.asyncId);
			assert.equal(calls.filter((call) => call.op === "followUp").length, 1);
		} finally { clearInterval(pump); restriction.dispose(); dispose(); }
	});

	it("routes a real RPC workflow through admission and denies a legacy provider", async () => {
		let starts = 0;
		const handle = () => ({ providerJobId: "legacy", state: "completed" as const });
		const dispose = registerExternalJobProvider({ name: "contract-test", start: () => { starts++; return handle(); }, status: handle, result: handle, reattach: handle });
		const events = createEventBus();
		const executor = makeExecutor([profile({ tools: [], extensions: [] })]);
		const bridge = registerSubagentRpcBridge({ events, getContext: () => makeMinimalCtx(tempDir) as any, execute: executor.execute });
		const pump = pumpBridge();
		try {
			const reply = new Promise<any>((resolve) => events.on(subagentRpcReplyEvent("contract-workflow"), resolve));
			events.emit(SUBAGENT_RPC_REQUEST_EVENT, { version: 1, requestId: "contract-workflow", method: "spawn", params: { workflowScript: `return await runs.run("peer-step", { agent: "peer", task: "inspect" });` } });
			const result = await reply;
			assert.equal(result.success, true, JSON.stringify(result));
			const status = await settle(result.data);
			assert.equal(status.state, "failed", JSON.stringify(status));
			assert.equal(starts, 0);
		} finally { clearInterval(pump); bridge.dispose(); dispose(); }
	});
});


describe("review regression: inherited skills and durable continuation identity", () => {
	installSingleExecutionHooks();
	it("rejects chain-level skills selected by the launch plan", () => {
		const chain = buildAsyncRunnerSteps("chain", {
			chain: [{ agent: "peer", task: "inspect" }], agents: [profile()] as any,
			chainSkills: ["fixture-skill"], ctx: { cwd: tempDir, currentSessionId: "session-123" },
			asyncDir: path.join(tempDir, "skilled-chain"), maxSubagentDepth: 1,
		});
		assert.ok("error" in chain);
		assert.match(JSON.stringify(chain), /does not support: skills/);
	});
	it("rejects public append-step with inherited top-level skill before appending", async () => {
		let starts = 0;
		const handle = () => ({ providerJobId: "held", state: "running" as const });
		const dispose = registerExternalJobProvider({ name: "contract-test", start: () => { starts++; return handle(); }, status: handle, result: handle, reattach: handle });
		const executor = makeExecutor([profile()]);
		const runId = "append-skills-review-fixture";
		const dir = path.join(ASYNC_DIR, runId);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ runId, sessionId: "session-123", mode: "chain", state: "running", startedAt: Date.now(), lastUpdate: Date.now(), cwd: tempDir, steps: [{ agent: "peer", status: "running" }] }));
		try {
			const appended = await executor.execute("append", { action: "append-step", id: runId, step: { agent: "peer", task: "inspect" }, skill: "fixture-skill" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(appended.isError, true, JSON.stringify(appended));
			assert.match(JSON.stringify(appended.content), /does not support: skills/);
			assert.equal(starts, 0);
		} finally {
			dispose(); fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	for (const binding of ["wrong-job", undefined]) {
		it(`rejects public resume with ${binding ?? "missing"} durable parent job binding`, async () => {
			let follows = 0;
			const handle = (id: string, input: any) => ({ providerJobId: id, state: "completed" as const, launchRequirementsDigest: input.launchRequirements.digest });
			const dispose = registerExternalJobProvider({ name: "contract-test", launchRequirementsVersion: 1,
				start: input => handle("original", input), followUp: input => { follows++; return handle("continued", input); },
				status: handle, result: (id, input) => ({ ...handle(id, input), output: "done" }), reattach: handle,
			});
			const pump = pumpBridge();
			try {
				const executor = makeExecutor([profile()]);
				const launched = await executor.execute("source", { agent: "peer", task: "inspect", async: true }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
				assert.equal((await settle(launched)).state, "complete");
				const file = path.join(launched.details.asyncDir, "external-job-0.requirements.json");
				const saved = JSON.parse(fs.readFileSync(file, "utf8"));
				if (binding === undefined) delete saved.providerJobId; else saved.providerJobId = binding;
				fs.writeFileSync(file, JSON.stringify(saved));
				const resumed = await executor.execute("bad-resume", { action: "resume", id: launched.details.asyncId, message: "continue" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
				assert.equal(resumed.isError, true, JSON.stringify(resumed));
				assert.match(JSON.stringify(resumed.content), /provider job identity/);
				assert.equal(follows, 0);
			} finally { clearInterval(pump); dispose(); }
		});
	}
});

describe("external-job explicit unsupported arguments", () => {
	installSingleExecutionHooks();
	for (const params of [{ model: "mock/pinned" }, { model: "mock/pinned:high" }, { skill: "missing" }, { context: "fork" }, { fast: true }, { outputSchema: { type: "object" } }, { acceptance: { level: "checked" } }, { toolBudget: { hard: 1 } }]) {
		it(`rejects public single and workflow child args: ${JSON.stringify(params)}`, async () => {
			let starts = 0;
			const h = () => ({ providerJobId: "unused", state: "completed" as const });
			const dispose = registerExternalJobProvider({ name: "contract-test", start: () => { starts++; return h(); }, status: h, result: h, reattach: h });
			const pump = pumpBridge();
			try {
				const executor = makeExecutor([profile()]);
				const single = await executor.execute("explicit", { agent: "peer", task: "inspect", async: true, ...params }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
				assert.equal(single.isError, true, JSON.stringify(single));
				const workflow = await executor.execute("explicit-workflow", { async: true, workflowScript: `return await runs.run("peer-step", ${JSON.stringify({ agent: "peer", task: "inspect", ...params })});` }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
				const status = await settle(workflow);
				assert.ok(status.isError || status.state === "failed", JSON.stringify(status));
				assert.equal(starts, 0);
			} finally { clearInterval(pump); dispose(); }
		});
	}
	it("resolves native-session ceilings even when run ownership uses a session file", async () => {
		const h = () => ({ providerJobId: "unused", state: "completed" as const });
		const dispose = registerExternalJobProvider({ name: "contract-test", start: () => assert.fail("restricted provider dispatched"), status: h, result: h, reattach: h });
		const ceiling = registerSubagentCapabilityCeiling({ sessionId: "session-123", source: "native-id", ceiling: { allowedTools: [] } });
		try {
			const ctx = makeMinimalCtx(tempDir);
			ctx.sessionManager.getSessionFile = () => path.join(tempDir, "parent.jsonl");
			const result = await makeExecutor([profile()]).execute("persistent-owner", { agent: "peer", task: "inspect", async: true }, new AbortController().signal, undefined, ctx);
			assert.equal(result.isError, true, JSON.stringify(result));
		} finally { ceiling.dispose(); dispose(); }
	});
});
