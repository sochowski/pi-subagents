import type { ChildHookExtension } from "./child-session.ts";

/** Data-only host briefing: observes effective tools; cannot register or enable any. */
export interface ChildHostContextInput {
	cwd: string;
	tools: readonly string[];
	/** Chained prompt, for host-owned briefing deduplication only. */
	systemPrompt: string;
}
export type ChildHostContext = (input: ChildHostContextInput) => Promise<string | undefined> | string | undefined;

/** Per-turn system context, never a persistent message or part of the role contract. */
export function createChildHostContextHook(context: ChildHostContext): ChildHookExtension {
	return {
		name: "pi-subagents:host-context",
		factory(pi) {
			pi.on("before_agent_start", async (event, ctx) => {
				const text = await context({ cwd: ctx.cwd, tools: pi.getActiveTools(), systemPrompt: event.systemPrompt });
				if (text) return { systemPrompt: `${event.systemPrompt}\n\n${text}` };
			});
		},
	};
}
