import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createChildHostContextHook } from "../../src/runs/shared/child-host-context.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";

for (const extensionPolicy of ["extensions-empty", "deny-extensions"] as const) {
	for (const mode of ["append", "replace"] as const) {
		for (const tools of [[], ["read", "grep", "find", "ls"], ["read", "bash", "edit", "write"]]) {
			it(`host context preserves disabled skills, role and actual launch contract: ${extensionPolicy}/${mode}/${tools.join(",") || "no tools"}`, async () => {
				const launch = buildInProcessChildLaunch({
					cwd: process.cwd(), host: "runner", sessionEnabled: false, tools,
					...(extensionPolicy === "extensions-empty" ? { extensions: [] } : { capabilityCeiling: { version: 1, denyExtensions: true, sources: ["test"] } }),
					inheritSkills: false, inheritGlobalContext: false, inheritProjectContext: false,
					allowNestedSubagents: false, waitToolEnabled: false, childAgentName: "worker", childIndex: 0,
					systemPrompt: "Exact role", systemPromptMode: mode, model: "fixture/model:high", thinkingCeiling: "high",
				});
				const before = JSON.stringify(launch.session);
				assert.deepEqual(launch.session.tools, tools);
				assert.equal(launch.session.noSkills, true);
				assert.equal(launch.session.ambientExtensions, false);
				assert.deepEqual(launch.session.extensionPaths, []);
				const role = mode === "replace" ? launch.session.systemPrompt : launch.session.appendSystemPrompt;
				assert.equal(role, '<active_agent name="worker"/>\n\nExact role');
				let handler: ((event: any, ctx: any) => Promise<any>) | undefined;
				// SAFETY: This tool-free hook uses only on and getActiveTools, both implemented below.
				createChildHostContextHook(input => {
					assert.equal(input.cwd, launch.session.cwd);
					assert.deepEqual(input.tools, tools);
					return "HOST orientation only";
				}).factory({
					on(name: string, fn: typeof handler) { assert.equal(name, "before_agent_start"); handler = fn; },
					getActiveTools: () => [...tools],
				} as ExtensionAPI);
				assert.deepEqual(await handler!({ systemPrompt: role }, { cwd: launch.session.cwd }), { systemPrompt: `${role}\n\nHOST orientation only` });
				assert.equal(JSON.stringify(launch.session), before, "no role/tools/model/thinking/ceilings/provenance mutation");
			});
		}
	}
}

it("a host without a context provider injects nothing; effective runtime tools are observed anew", async () => {
	let handler: ((event: any, ctx: any) => Promise<any>) | undefined;
	let tools: string[] = [];
	let enabled = false;
	const hook = createChildHostContextHook(input => enabled ? input.tools.join(",") : undefined);
	// SAFETY: This hook uses only the two implemented ExtensionAPI methods.
	hook.factory({ on(_name: string, fn: typeof handler) { handler = fn; }, getActiveTools: () => tools } as ExtensionAPI);
	assert.equal(await handler!({ systemPrompt: "Role" }, { cwd: "/cwd" }), undefined);
	enabled = true; tools = ["read"];
	assert.deepEqual(await handler!({ systemPrompt: "Role" }, { cwd: "/cwd" }), { systemPrompt: "Role\n\nread" });
});
