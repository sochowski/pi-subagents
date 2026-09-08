import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { registerNativeExecutionProviderListener, requireNativeExecutionProvider, type NativeExecutionBinding, type NativeExecutionProvider } from "../../src/api/native-execution-provider.ts";
import { nativeRunnerConversationContract } from "../../src/runs/background/native-runner-route.ts";
import { installSingleExecutionHooks, makeExecutor, tempDir } from "../support/single-execution-fixture.ts";
import { createEventBus, makeAgent, makeMinimalCtx } from "../support/helpers.ts";

type EmittedConfig = {
	id: string;
	asyncDir: string;
	runnerProcessInstanceId: string;
	nativeExecution: NativeExecutionBinding;
	steps: Array<{ agent: string; model?: string; thinking?: string; sessionFile?: string; definitionDigest: string; launchBindingTask: string; launchContractDigest: string }>;
};

describe("native public resume declared definition identity", () => {
	installSingleExecutionHooks();
	it("emits second and third turns with the verified declaration, but rejects a changed role before prepare", async () => {
		const agent = makeAgent("worker", { tools: ["read"], extensions: [], thinking: "high" });
		const events = createEventBus();
		const pi = { events };
		const listener = registerNativeExecutionProviderListener(pi, () => ({ ownerSessionId: "session-123", parentSessionId: "session-123" }));
		const configs: EmittedConfig[] = [];
		let prepares = 0, launches = 0, publications = 0;
		const provider: NativeExecutionProvider = {
			name: "public-definition-fixture", version: 1,
			prepare(input) {
				prepares++;
				return input.previous
					? { ...input.previous, runId: input.runId, configDigest: input.configDigest, previousTurnId: input.previous.turnId, turnId: `turn-${prepares}` }
					: { version: 1, provider: this.name, ownerSessionId: input.ownerSessionId, parentSessionId: input.parentSessionId, runId: input.runId, configDigest: input.configDigest, jobId: "retained-job", turnId: "turn-1", driverModule: path.join(tempDir, "unused-driver.mjs"), controlPath: path.join(String(input.config.asyncDir), "control.json") };
			},
			launch({ binding }) {
				launches++;
				configs.push(JSON.parse(fs.readFileSync(path.join(path.dirname(binding.controlPath!), "native-runner.json"), "utf8")));
				return { pid: process.pid };
			},
			continue({ config }) {
				publications++;
				configs.push(JSON.parse(fs.readFileSync(path.join(String(config.asyncDir), "native-runner.json"), "utf8")));
				return { pid: process.pid, publication: "published" };
			},
		};
		const registration = requireNativeExecutionProvider(pi, provider);
		const executor = makeExecutor([agent], {}, false, undefined, true, new Map(), undefined, undefined, events);
		const ctx = makeMinimalCtx(tempDir);
		ctx.model = { provider: "mock", id: "pinned" };
		ctx.modelRegistry.getAvailable = () => [{ provider: "mock", id: "pinned" }];
		const sessionFile = path.join(tempDir, "retained-native.jsonl");
		// Only the provider transport/completion is simulated. Admission, public
		// resume, recovery materialization and serialized runner config are real.
		function complete(config: EmittedConfig) {
			if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: "fixture-native", timestamp: new Date().toISOString(), cwd: tempDir }) + "\n");
			const live = { ...config.nativeExecution, hostPid: process.pid, nativeId: "fixture-native", sessionFile };
			fs.writeFileSync(`${sessionFile}.native-host.json`, JSON.stringify(live));
			const statusFile = path.join(config.asyncDir, "status.json");
			const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
			fs.writeFileSync(statusFile, JSON.stringify({ ...status, state: "complete", completedAt: Date.now(), sessionFile, steps: [{ ...status.steps[0], status: "complete", sessionFile, model: config.steps[0]!.model, thinking: config.steps[0]!.thinking }] }));
			fs.writeFileSync(path.join(config.asyncDir, "native-tracking-release.json"), JSON.stringify({ ...live, runnerProcessInstanceId: config.runnerProcessInstanceId, hostRetained: true }));
		}
		try {
			const first = await executor.execute("initial", { agent: "worker", task: "Read the fixture marker without changes.", context: "fresh", async: true, acceptance: { level: "none", reason: "This fixture tests public admission and config emission, not model output." } }, new AbortController().signal, undefined, ctx);
			assert.notEqual(first.isError, true, JSON.stringify(first));
			assert.equal(configs.length, 1);
			complete(configs[0]!);
			for (const turn of [2, 3]) {
				const previous = configs.at(-1)!;
				const request: Parameters<typeof executor.execute>[1] = { action: "resume", id: previous.id, message: `Read the marker for fresh turn ${turn}.` };
				if (turn === 2) request.acceptance = "auto";
				const resumed = await executor.execute(`resume-${turn}`, request, new AbortController().signal, undefined, ctx);
				assert.notEqual(resumed.isError, true, JSON.stringify(resumed));
				assert.equal(configs.length, turn, "public resume must reach config emission and provider continuation");
				const emitted = configs.at(-1)!;
				assert.equal(nativeRunnerConversationContract(emitted), nativeRunnerConversationContract(configs[0]!));
				assert.equal(emitted.nativeExecution.previousTurnId, previous.nativeExecution.turnId);
				complete(emitted);
			}
			assert.ok(configs.every(config => config.steps[0]!.definitionDigest === configs[0]!.steps[0]!.definitionDigest), "all turns retain the verified declared role identity");
			assert.equal(launches, 1, "continuation cannot start another host");
			assert.equal(publications, 2);
			agent.systemPrompt = "Actually changed declared role instructions";
			const changed = await executor.execute("changed-role", { action: "resume", id: configs.at(-1)!.id, message: "Read again." }, new AbortController().signal, undefined, ctx);
			assert.equal(changed.isError, true);
			assert.match(JSON.stringify(changed), /Native retained role definition changed/);
			assert.equal(prepares, 3, "changed declaration rejected before queue/preparation");
			assert.equal(publications, 2);
		} finally {
			registration.dispose(); listener();
			for (const config of configs) fs.rmSync(config.asyncDir, { recursive: true, force: true });
		}
	});
});
