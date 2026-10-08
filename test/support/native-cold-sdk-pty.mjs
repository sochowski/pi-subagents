// Actual public SDK + InteractiveMode/PTY cold-open seam. WT ledger admission
// is represented by counters here; this is NOT compiled-WT recovery proof.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
const root = process.env.NATIVE_HOST_TEST_ROOT;
if (!root || process.env.HOME !== join(root,"home") || process.env.PI_CODING_AGENT_DIR !== join(root,"agent") || !process.env.NATIVE_HOST_TEST_SDK) throw new Error("private HOME/agent-dir/SDK required");
fs.mkdirSync(join(root,"agent"),{recursive:true});
let requests=0, opens=0, creates=0, binds=0, claims=0, finishes=0;
function crashAt(phase){
 if(process.env.NATIVE_COLD_WT_CONTROL_FILE && process.env.NATIVE_COLD_CRASH_PHASE===phase){
  fs.writeFileSync(join(root,"crash-phase.json"),JSON.stringify({phase,pid:process.pid,opens,creates,binds,claims,finishes,requests}));
  process.kill(process.pid,"SIGKILL");
 }
}
const server=createServer(async(req,res)=>{
 try {
  assert.equal(req.url,"/v1/chat/completions");assert.equal(req.method,"POST");
  let raw="";for await(const part of req){raw+=part;assert.ok(raw.length<1024*1024);}
  const body=JSON.parse(raw);
  assert.ok(JSON.stringify(body.messages).includes("Only the new cold instruction"));
  assert.deepEqual(body.tools.map(tool=>tool.function.name),["read"]);
  requests++;crashAt("model");
  const chunk={id:"synthetic",object:"chat.completion.chunk",created:1,model:"native-host",choices:[{index:0,delta:{content:"Synthetic cold result"},finish_reason:"stop"}]};
  res.writeHead(200,{"content-type":"text/event-stream"});res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
 } catch(error){console.error(error);res.writeHead(500);res.end("private fixture assertion failure");}
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
fs.writeFileSync(join(root,"agent","models.json"),JSON.stringify({providers:{synthetic:{baseUrl,apiKey:"fixture-only",models:[{id:"native-host",name:"native-host",api:"openai-completions",reasoning:false,input:["text"],contextWindow:128000,maxTokens:512,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
// The provider uses a loopback-only synthetic endpoint. Never let auxiliary
// global fetch calls escape the isolated fixture.
globalThis.fetch=async(input)=>{throw new Error(`Fixture forbids auxiliary fetch: ${String(input instanceof Request ? input.url : input)}`);};
// Install the synthetic boundary before importing libraries that capture fetch.
const { createNativeInteractiveHost }=await import("../../src/runs/shared/native-interactive-host.ts");
const { buildInProcessChildLaunch }=await import("../../src/runs/shared/child-launch.ts");
const { inspectNativeCheckpoint }=await import("../../src/runs/shared/native-checkpoint-inspection.ts");
const pi=await import(process.env.NATIVE_HOST_TEST_SDK);
const control=process.env.NATIVE_COLD_WT_CONTROL_FILE ? JSON.parse(fs.readFileSync(process.env.NATIVE_COLD_WT_CONTROL_FILE,"utf8")) : undefined;
const manager=control ? pi.SessionManager.open(control.expected.sessionFile) : pi.SessionManager.create(root,join(root,"sessions"));
if (!control) {
manager.appendModelChange("synthetic","native-host");manager.appendThinkingLevelChange("off");
manager.appendMessage({role:"user",content:"Settled historical fixture, never execute this as a new prompt",timestamp:Date.now()});
manager.appendMessage({role:"assistant",content:[{type:"text",text:"Settled fixture result"}],api:"openai-completions",provider:"synthetic",model:"native-host",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:Date.now()});
}
const expected={nativeId:manager.getSessionId(),sessionFile:manager.getSessionFile(),leaf:manager.getLeafId(),cwd:manager.getCwd()};
if(control) assert.deepEqual(expected,control.expected);
const source=fs.readFileSync(expected.sessionFile);
const sourceDigest=inspectNativeCheckpoint(expected,pi).sourceDigest;
const recordFile=`${expected.sessionFile}.native-host.json`;
if(!control) fs.writeFileSync(recordFile,JSON.stringify({fixture:"SDK seam only; not authoritative WT ownership"}),{mode:0o600});
const recovery={version:1,leaseId:"a".repeat(64),expected,sourceDigest,sidecarDigest:createHash("sha256").update(fs.readFileSync(recordFile)).digest("hex"),modelId:"synthetic/native-host",thinking:"off",async authorizeOpen(){opens++;assert.equal(opens,1);assert.deepEqual(fs.readFileSync(expected.sessionFile),source);}};
let binding={version:1,provider:"fixture",ownerSessionId:"fixture-owner",parentSessionId:"fixture-parent",runId:"fixture-cold-operation",jobId:"fixture-job",turnId:"fixture-new-turn",previousTurnId:"fixture-settled-turn",configDigest:"fixture-contract",nativeId:expected.nativeId,sessionFile:expected.sessionFile};
let driver={version:1,recovery,async bind(child){binds++;assert.equal(child.sessionId,expected.nativeId);assert.equal(child.nativeLeaf,expected.leaf);assert.equal(requests,0);},async claim(child,prompt){claims++;assert.equal(prompt,"Only the new cold instruction");assert.equal(requests,0);},async finish(){finishes++;},async failStartup(error){throw new Error(`Unexpected SDK seam failure: ${error}`);}};
if(control){
 binding=control.binding;
 const {createNativeHostDriver}=await import(control.driverModule);
 const actual=createNativeHostDriver(binding);
 const authorize=actual.recovery.authorizeOpen.bind(actual.recovery);
 actual.recovery.authorizeOpen=async()=>{opens++;await authorize();assert.equal(opens,1);crashAt("open");};
 const bind=actual.bind.bind(actual);actual.bind=async(child)=>{binds++;await bind(child);assert.equal(requests,0);crashAt("bind");};
 const claim=actual.claim.bind(actual);actual.claim=async(child,prompt)=>{claims++;await claim(child,prompt);assert.equal(requests,0);crashAt("claim");};
 const finish=actual.finish.bind(actual);actual.finish=async(child,error)=>{finishes++;await finish(child,error);};
 driver=actual;
}
const host=createNativeInteractiveHost({binding,driver,loadPiCodingAgent:async()=>({...pi,async createAgentSession(options){creates++;return pi.createAgentSession(options);}})});
try {
 const launch=buildInProcessChildLaunch({cwd:root,host:"runner",sessionEnabled:true,sessionFile:expected.sessionFile,model:"synthetic/native-host",tools:["read"],extensions:[],allowNestedSubagents:false,inheritProjectContext:false,inheritGlobalContext:false,inheritSkills:false,waitToolEnabled:false,childAgentName:"fixture-reviewer",childIndex:0,runId:binding.runId,parentSessionId:"fixture-parent",systemPrompt:"Private read-only SDK fixture. Do not replay prior work."});
 const child=await host.create(launch.session);
 assert.equal(child.sessionId,expected.nativeId);assert.equal(child.sessionFile,expected.sessionFile);
 assert.equal(requests,0);assert.equal(creates,1);assert.equal(opens,1);assert.equal(binds,1);
 await child.prompt("Only the new cold instruction");
 assert.equal(requests,1);assert.equal(claims,1);assert.equal(finishes,1);
 await assert.rejects(child.prompt("Never duplicate dispatch"),/already dispatched/);
 const reopened=pi.SessionManager.open(expected.sessionFile);
 assert.equal(reopened.getSessionId(),expected.nativeId);
 assert.notEqual(reopened.getLeafId(),expected.leaf);
 const record=JSON.parse(fs.readFileSync(recordFile,"utf8"));
 assert.equal(record.hostPid,process.pid);assert.equal(record.nativeId,expected.nativeId);assert.equal(record.coldEpoch.leaseId,driver.recovery.leaseId);
 await host.close();server.close();
 fs.writeFileSync(join(root,"proof.json"),JSON.stringify({scope:control ? "compiled WT controls + SDK/PTY seam; launcher NOT covered" : "actual SDK/PTY seam; NOT compiled WT",sdkVersion:pi.VERSION,opens,creates,binds,claims,finishes,requests,nativeId:expected.nativeId,pid:process.pid}));
 process.exit(0);
} catch(error){console.error(error);await host.close();server.close();process.exit(1);}
