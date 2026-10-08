/**
 * Child session factory for the detached async runner.
 *
 * The runner imports `@earendil-works/pi-coding-agent` like the parent does;
 * the parent aliases that specifier (and the other host peer packages) to the
 * installed pi package through `JITI_ALIAS` when it spawns the runner, see
 * `runner-aliases.ts`. Tests replace the factory with a scripted one by
 * naming a module in the runner config.
 */
import { REQUIRED_NATIVE_PROVIDER_ENV, type NativeExecutionBinding } from "../../api/native-execution-provider.ts";
import { createNativeInteractiveHost, type NativeHostDriver } from "../shared/native-interactive-host.ts";
import { validateNativeExecutionBinding } from "./native-runner-route.ts";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createDefaultChildSessionFactory, type ChildSessionFactory } from "../shared/child-session.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";

export interface RunnerChildSessionConfig {
	nativeExecution?: NativeExecutionBinding;
	nativeColdRecovery?: boolean;
	asyncDir?: string;
	runnerProcessInstanceId?: string;
	/** Test seam: module whose default export is a `ChildSessionFactory`, or a function returning one. */
	childSessionFactoryModule?: string;
}

function isChildSessionFactory(value: unknown): value is ChildSessionFactory {
	return Boolean(value) && typeof value === "object" && typeof (value as ChildSessionFactory).create === "function" && typeof (value as ChildSessionFactory).dispose === "function";
}

export async function loadRunnerChildSessionFactory(config: RunnerChildSessionConfig): Promise<ChildSessionFactory> {
	const required = process.env[REQUIRED_NATIVE_PROVIDER_ENV];
	if (config.nativeExecution) {
		const binding = config.nativeExecution;
		validateNativeExecutionBinding(config as unknown as Record<string, unknown>, binding);
		if (required !== binding.provider || config.childSessionFactoryModule) throw new Error("Native host bootstrap mismatch or incompatible test factory; headless fallback is forbidden.");
		const driver = await loadNativeHostDriver(binding);
		if (config.nativeColdRecovery === true) {
			if (!binding.coldRecovery || !driver.recovery || !config.asyncDir || !path.isAbsolute(config.asyncDir) || !config.runnerProcessInstanceId || binding.controlPath !== path.join(config.asyncDir, "native-control.json")) throw new Error("Cold native publication requires its exact new runner/SDK ownership route.");
			const claim = driver.claim!.bind(driver);
			const publicationFile = path.join(config.asyncDir, "native-publication-observed.json");
			driver.claim = async (child, prompt) => {
				await claim(child, prompt);
				if (child.sessionId !== binding.nativeId || child.sessionFile !== binding.sessionFile) throw new Error("Actual cold SDK identity changed at dispatch publication.");
				// Only the actual SDK owner, after authoritative one-shot claim,
				// can attest acceptance. Launch alone never promotes uncertainty.
				writePrivateAtomicJson(publicationFile, { ...binding, runnerProcessInstanceId: config.runnerProcessInstanceId, publication: "published", pid: process.pid, runtime: process.env.WT_RUNTIME_ID, nativeId: child.sessionId, sessionFile: child.sessionFile });
			};
		}
		return createNativeInteractiveHost({ binding, driver });
	}
	if (required) throw new Error("Required native provider runner binding is missing; default and test factories are forbidden.");
	if (!config.childSessionFactoryModule) return createDefaultChildSessionFactory();
	const loaded = await import(pathToFileURL(path.resolve(config.childSessionFactoryModule)).href) as { default?: unknown };
	const candidate = typeof loaded.default === "function" ? (loaded.default as () => unknown)() : loaded.default;
	if (!isChildSessionFactory(candidate)) {
		throw new Error(`Child session factory module '${config.childSessionFactoryModule}' must default-export a ChildSessionFactory or a function returning one.`);
	}
	return candidate;
}

export async function loadNativeHostDriver(binding: NativeExecutionBinding): Promise<NativeHostDriver> {
	const loaded = await import(pathToFileURL(binding.driverModule).href) as { createNativeHostDriver?: (binding: NativeExecutionBinding) => NativeHostDriver };
	const driver = loaded.createNativeHostDriver?.(binding);
	if (driver?.version !== 1 || typeof driver.bind !== "function" || typeof driver.claim !== "function" || typeof driver.finish !== "function") throw new Error("Native host driver must implement protocol v1 binding, claim, and completion.");
	return driver;
}
