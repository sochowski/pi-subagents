import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { inspectNativeCheckpoint } from "../../src/runs/shared/native-checkpoint-inspection.ts";

// Opt-in ACTUAL published SDK reader probe. No AgentSession, model, extension or
// InteractiveMode is constructed. Payload messages are labelled fixture data.
const sdkPath = process.env.WT_NATIVE_SDK_TEST_MODULE;
async function fixture(t: TestContext) {
 const sdk = await import(pathToFileURL(sdkPath!).href);
 const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"native-reader-fixture-"));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const manager = sdk.SessionManager.create(dir,path.join(dir,"sessions"));
 manager.appendMessage({role:"user",content:"Private SDK reader fixture; no inference",timestamp:Date.now()});
 const assistant = {role:"assistant",content:[{type:"text",text:"Fixture complete"}],api:"openai-responses",provider:"fixture",model:"fixture",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:Date.now()};
 manager.appendMessage(assistant);
 const expected = {nativeId:manager.getSessionId(),sessionFile:manager.getSessionFile(),leaf:manager.getLeafId(),cwd:manager.getCwd()};
 return {sdk,manager,expected,assistant};
}
test("actual public SDK reads its genuine settled UUID/leaf without modifying original bytes",{skip:!sdkPath},async t=>{
 const {sdk,expected}=await fixture(t),before=fs.readFileSync(expected.sessionFile);
 const proof=inspectNativeCheckpoint(expected,sdk);
 assert.equal(proof.nativeId,expected.nativeId);assert.equal(proof.leaf,expected.leaf);
 assert.equal(proof.sourceDigest.length,64);assert.deepEqual(fs.readFileSync(expected.sessionFile),before);
});
test("actual public SDK inspection rejects changed genuine identity",{skip:!sdkPath},async t=>{
 const {sdk,expected}=await fixture(t),before=fs.readFileSync(expected.sessionFile);
 assert.throws(()=>inspectNativeCheckpoint({...expected,nativeId:"not-the-recorded-native-session"},sdk),/genuine SDK session/);
 assert.deepEqual(fs.readFileSync(expected.sessionFile),before);
});
test("actual public SDK inspection refuses an unfinished tool branch",{skip:!sdkPath},async t=>{
 const {sdk,manager,expected,assistant}=await fixture(t);
 manager.appendMessage({...assistant,content:[{type:"toolCall",id:"fixture-tool",name:"read",arguments:{path:"fixture-only"}}],stopReason:"toolUse"});
 const pending={...expected,leaf:manager.getLeafId()},before=fs.readFileSync(expected.sessionFile);
 assert.throws(()=>inspectNativeCheckpoint(pending,sdk),/not demonstrably settled/);
 assert.deepEqual(fs.readFileSync(expected.sessionFile),before);
});
test("actual public SDK fallback can never repair/truncate the original corrupt file",{skip:!sdkPath},async t=>{
 const {sdk,expected}=await fixture(t);
 fs.writeFileSync(expected.sessionFile,"corrupt native fixture\n");
 const before=fs.readFileSync(expected.sessionFile);
 assert.throws(()=>inspectNativeCheckpoint(expected,sdk),/not a valid pi session/);
 assert.deepEqual(fs.readFileSync(expected.sessionFile),before);
});
