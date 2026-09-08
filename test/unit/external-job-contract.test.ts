import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { registerExternalJobProvider, type ExternalJobStartInput } from "../../src/api/external-job-provider.ts";
import { registerSubagentCapabilityCeiling } from "../../src/api/capability-ceiling.ts";
import { admitExternalJob, bindExternalJobLaunch, externalJobContractPath, persistExternalJobContract, readExternalJobContract } from "../../src/runs/shared/external-job-contract.ts";
import { resolvePiLaunchToolPlan } from "../../src/runs/shared/child-tool-plan.ts";
import { externalJobPromptDigest, runExternalJob } from "../../src/runs/shared/external-job-runner.ts";
import { requestExternalJobOperation, serviceExternalJobBridgeRequests } from "../../src/runs/shared/external-job-bridge.ts";
import { stableJsonDigest } from "../../src/shared/launch-contract.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
function setup(planInput = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "external-contract-"));
	cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	const agent = { name: "peer", filePath: "peer.md", runner: { type: "external-job", provider: "contract" } } as any;
	const admission = admitExternalJob({ agent, plan: resolvePiLaunchToolPlan(planInput), ownerSessionId: "owner", runId: "run", cwd: dir, systemPrompt: "profile" });
	return { dir, input: { admission, provider: "contract", agent: "peer", runId: "run", cwd: dir, sessionId: "owner", stepIndex: 0, prompt: "prompt", systemPrompt: "profile", asyncDir: dir,
		onExternalJob: (externalJob: unknown) => fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ steps: [{ externalJob }] })) } };
}
function provider(options: { legacy?: boolean; ack?: boolean; reject?: boolean } = {}) {
	const calls: string[] = [];
	const callback = (op: string, id: string, contract: any) => {
		calls.push(op);
		return { providerJobId: id, state: "completed" as const, ...(options.ack === false ? {} : { launchRequirementsDigest: contract.digest }) };
	};
	cleanup.push(registerExternalJobProvider({ name: "contract", ...(options.legacy ? {} : { launchRequirementsVersion: 1 as const }),
		start: (input) => { if (options.reject) throw new Error("This provider cannot enforce tools"); return callback("start", "job", input.launchRequirements); },
		followUp: (input) => callback("followUp", "next-job", input.launchRequirements),
		status: (id, context) => callback("status", id, context.launchRequirements),
		result: (id, context) => callback("result", id, context.launchRequirements),
		reattach: (id, context) => callback("reattach", id, context.launchRequirements),
	}));
	return calls;
}
async function service<T>(dir: string, promise: Promise<T>): Promise<T> {
	const timer = setInterval(() => serviceExternalJobBridgeRequests(dir), 5);
	try { return await promise; } finally { clearInterval(timer); }
}
function resign(value: any) { const { digest: _digest, ...body } = value; return { ...body, digest: stableJsonDigest(body) }; }

describe("external-job launch contract fail-closed round trips", () => {
	for (const change of [
		{ admission: undefined }, { sessionId: "other-owner" }, { runId: "other-run" }, { cwd: "/other" }, { agent: "other-profile" }, { provider: "other-provider" }, { options: { changed: true } }, { systemPrompt: "other-profile-prompt" },
	]) it(`rejects a missing admission or mismatched input: ${JSON.stringify(change)}`, async () => {
		const calls = provider(); const { dir, input } = setup();
		const result = await service(dir, runExternalJob({ ...input, ...change }));
		assert.equal(result.exitCode, 1); assert.deepEqual(calls, []);
	});

	for (const mutation of [
		(c: any) => { delete c.digest; },
		(c: any) => { c.version = 99; },
		(c: any) => { c.admission.version = 99; },
		(c: any) => { c.admission.requirements.unknownRequiredPolicy = true; c.admission = resign(c.admission); },
		(c: any) => { c.admission.definitionDigest = "b".repeat(64); c.admission = resign(c.admission); },
		(c: any) => { c.admission.cwd = "/other"; c.admission = resign(c.admission); },
		(c: any) => { c.admission.ownerSessionId = "other"; c.admission = resign(c.admission); },
		(c: any) => { c.stepIndex = 1; },
		(c: any) => { c.promptDigest = "c".repeat(64); },
		(c: any) => { c.lineage = { sourceRunId: "source", sourceStepIndex: 0, parentProviderJobId: "parent", requestId: "request", requestDigest: "d".repeat(64), parentRequirementsDigest: "e".repeat(64) }; },
	]) it(`rejects changed recovery contract (${mutation.toString()}) before callbacks`, async () => {
		const calls = provider(); const { dir, input } = setup({ tools: ["read"], extensions: [] });
		const started = await service(dir, runExternalJob(input)); assert.equal(started.exitCode, 0);
		calls.length = 0;
		const changed = structuredClone(started.externalJob.launchRequirements!);
		mutation(changed);
		const contract = Object.hasOwn(changed, "digest") ? resign(changed) : changed;
		await assert.rejects(service(dir, requestExternalJobOperation(dir, { provider: "contract", operation: "reattach", providerJobId: "job", context: { launchRequirements: contract } })), /requirements|version|ENOENT|fields|mismatch/i);
		assert.deepEqual(calls, []);
	});

	it("refuses legacy persisted jobs without reconstructing an admission from current defaults", async () => {
		const calls = provider(); const { dir, input } = setup();
		fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ steps: [{ externalJob: { provider: "contract", providerJobId: "job", promptDigest: externalJobPromptDigest(input.prompt), options: {}, state: "running" } }] }));
		const result = await service(dir, runExternalJob(input));
		assert.equal(result.externalJob.failureCode, "recovery-mismatch"); assert.deepEqual(calls, []);
	});
	it("recovers the exact admitted snapshot after ceilings disappear", async () => {
		const calls = provider();
		const { dir, input } = setup({ inheritedCapabilityCeiling: { version: 1, allowedTools: [], denyExtensions: true, sources: ["inherited-disposed"] } });
		const started = await service(dir, runExternalJob(input)); assert.equal(started.exitCode, 0);
		const recovered = await service(dir, runExternalJob(input)); assert.equal(recovered.exitCode, 0);
		assert.deepEqual(recovered.externalJob.launchRequirements, started.externalJob.launchRequirements);
		assert.deepEqual(calls, ["start", "result", "reattach", "result"]);
	});
	it("rejects a newly conflicting ceiling at bridge dispatch", async () => {
		const calls = provider(); const { dir, input } = setup();
		const pending = runExternalJob(input);
		const ceiling = registerSubagentCapabilityCeiling({ sessionId: "owner", source: "new", ceiling: { allowedTools: [] } }); cleanup.push(() => ceiling.dispose());
		const result = await service(dir, pending); assert.equal(result.exitCode, 1); assert.deepEqual(calls, []);
	});
	it("never downgrades a restricted admission when a legacy provider replaces the capable registration", async () => {
		provider(); const { dir, input } = setup({ tools: [], extensions: [] });
		const calls = provider({ legacy: true });
		const result = await service(dir, runExternalJob(input)); assert.equal(result.exitCode, 1); assert.deepEqual(calls, []);
	});
	it("lets a negotiated provider reject unsupported restrictions before launching", async () => {
		const calls = provider({ reject: true }); const { dir, input } = setup({ tools: ["read"] });
		const result = await service(dir, runExternalJob(input)); assert.equal(result.exitCode, 1); assert.deepEqual(calls, []);
	});
	it("requires exact acknowledgements and durable provider job identity", async () => {
		const calls = provider({ ack: false }); const { dir, input } = setup({ tools: [] });
		const result = await service(dir, runExternalJob(input));
		assert.equal(result.externalJob.failureCode, "launch-requirements-unacknowledged"); assert.deepEqual(calls, ["start"]);
	});
	it("denies a changed provider job id on recovery before calling the provider", async () => {
		const calls = provider(); const { dir, input } = setup();
		const result = await service(dir, runExternalJob(input)); calls.length = 0;
		await assert.rejects(service(dir, requestExternalJobOperation(dir, { provider: "contract", operation: "result", providerJobId: "different", context: { launchRequirements: result.externalJob.launchRequirements! } })), /identity/);
		assert.deepEqual(calls, []);
	});
	it("does not replace a persisted contract on a duplicate with a different step prompt", async () => {
		const calls = provider(); const { dir, input } = setup();
		const first = await service(dir, runExternalJob(input)); calls.length = 0;
		const result = await service(dir, runExternalJob({ ...input, prompt: "changed" }));
		assert.equal(result.exitCode, 1); assert.deepEqual(calls, []);
		assert.equal(readExternalJobContract(dir, 0).digest, first.externalJob.launchRequirements!.digest);
	});
	it("rejects missing recovery context and unknown persisted versions", async () => {
		const calls = provider(); const { dir, input } = setup();
		const started = await service(dir, runExternalJob(input)); calls.length = 0;
		await assert.rejects(service(dir, requestExternalJobOperation(dir, { provider: "contract", operation: "status", providerJobId: "job" })), /Missing/);
		const changed = { ...started.externalJob.launchRequirements, version: 7 };
		fs.writeFileSync(externalJobContractPath(dir, 0), JSON.stringify(changed));
		const result = await service(dir, runExternalJob(input)); assert.equal(result.exitCode, 1); assert.deepEqual(calls, []);
	});
	it("rejects newly closed extension requirements conflicting with inherited configured extensions", () => {
		const calls = provider(); const { input } = setup({ extensions: ["/required-extension.ts"] });
		const inherited = bindExternalJobLaunch(input.admission, 0, externalJobPromptDigest(input.prompt), null);
		assert.throws(() => admitExternalJob({ agent: { name: "peer", filePath: "peer.md", runner: { type: "external-job", provider: "contract" } } as any, plan: resolvePiLaunchToolPlan({ extensions: [] }), ownerSessionId: "owner", runId: "next", cwd: input.cwd, systemPrompt: "profile", inherited }), /extensions conflict/);
		assert.deepEqual(calls, []);
	});
	it("does not dispatch a manually queued contract without durable admission", async () => {
		const calls = provider(); const { dir, input } = setup();
		const contract = bindExternalJobLaunch(input.admission, 0, externalJobPromptDigest(input.prompt), null);
		const start: ExternalJobStartInput = { ...input, options: {}, promptDigest: contract.promptDigest, launchRequirements: contract };
		await assert.rejects(service(dir, requestExternalJobOperation(dir, { provider: "contract", operation: "start", start })), /ENOENT/);
		assert.deepEqual(calls, []);
		persistExternalJobContract(dir, contract);
	});
});
