import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
const lab = process.env.ORACLE_LAB;
let realRpc;
let date = "2026-11-20";
if (lab) {
  const { api, publicKey, password, teams } = JSON.parse(await readFile(join(lab, "test-settings.json"), "utf8"));
  const origin = new URL(api);
  assert.ok(["localhost", "127.0.0.1"].includes(origin.hostname) && origin.protocol === "http:");
  const baseDate = (await readFile(join(lab, "work-date"), "utf8")).trim();
  date = new Date(Date.parse(baseDate) + 86400000).toISOString().slice(0, 10);
  const headers = { apikey: publicKey, "content-type": "application/json" };
  const login = await fetch(new URL("/auth/v1/token?grant_type=password", origin), {
    method: "POST", redirect: "error", headers, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ email: "oracle-tech@example.test", password }),
  });
  assert.equal(login.status, 200);
  const { access_token: token } = await login.json();
  assert.ok(token);
  realRpc = async (name, input) => {
    assert.ok(["cc_import_oracle_agenda", "cc_my_appointments", "cc_my_ignored_interventions"].includes(name));
    assert.equal(input.p_work_date, date);
    if (name === "cc_import_oracle_agenda") input.p_team_id = teams[0];
    const response = await fetch(new URL("/rest/v1/rpc/" + name, origin), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { ...headers, authorization: "Bearer " + token }, body: JSON.stringify(input),
    });
    const body = await response.json();
    return response.ok ? { status: response.status, data: body } : { status: response.status, error: { code: body.code } };
  };
}
const source = await readFile("app.js", "utf8");
const page = await readFile("index.html", "utf8");
const markup = page.slice(page.indexOf('<section id="appointmentsPanel"'), page.indexOf('<section id="personalSettingsPanel"'));
const fixture = await readFile("oracle-import-flow.test.mjs", "utf8");
const sample = fixture.slice(fixture.indexOf("const source = ["), fixture.indexOf("function setup("));
const handler = source.slice(source.indexOf("const oracleImportErrors"),source.indexOf("async function loadMasterAppointments()"));
let finish;
const done = new Promise(resolve => { finish = resolve; });
const modules = new Set(["agenda-parser.mjs","agenda-parity.mjs","my-routes-ui.mjs","my-routes.mjs","my-routes-autocomplete.mjs"]);
const server = createServer(async (req,res) => {
  const path=new URL(req.url,"http://127.0.0.1").pathname.slice(1);
  if (path==="lab-rpc" && realRpc && req.method==="POST") {
    res.setHeader("Content-Type","application/json");
    try {
      const { name, input } = JSON.parse((await Array.fromAsync(req)).join(""));
      res.end(JSON.stringify(await realRpc(name, input)));
    } catch { res.end(JSON.stringify({ status: 500, error: { code: "XXXXX" } })); }
    return;
  }
  if(path==="result") { finish((await Array.fromAsync(req)).join("")); res.end("ok"); return; }
  if(path===""){ res.setHeader("Content-Type","text/html"); res.end('<iframe src="/mobile" width="393" height="800" style="border:0"></iframe>'); return; }
  if(path==="mobile"){
    res.setHeader("Content-Type","text/html; charset=utf-8");
    res.end('<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="/agenda.css">'+markup+'<script type="module" src="/probe.mjs"></script>');
  } else if(path==="probe.mjs"){
    res.setHeader("Content-Type","text/javascript; charset=utf-8");
    res.end(`
import {parseOracleInstallations,stableSourceKey} from "./agenda-parser.mjs";
import {compareImportedAppointment} from "./agenda-parity.mjs";
import {mountMyRoutes} from "./my-routes-ui.mjs";
${sample}
const $ = id => document.getElementById(id);
const setVisible = (id,show) => $(id).hidden=!show;
const appointmentNotice = (message,kind) => { $("appointmentNotice").textContent=message; $("appointmentNotice").dataset.kind=kind; };
const loadOwnAppointments = async () => true;
const activeUser={id:"synthetic",role:"technician"}, appointmentDate=${JSON.stringify(date)}, selectedAppointmentTeam="team";
const live=${Boolean(realRpc)};
const appointmentTeams=[{id:"team"}], appointmentPreferences={}, appointmentIdentityIndex=[], importChangesBySource=new Map();
const matchesAppointment=()=>false;
let fakeDatabase, writes=0;
const supabase={async rpc(name,input){
 if(name!=="cc_import_oracle_agenda" || input.p_installations.length!==2 || input.p_ignored.length!==4) throw Error("rpc");
 writes++;
 if (live) return labRpc(name,input);
 fakeDatabase={appointments:input.p_installations.map(row=>({...row,id:row.source_key,scheduled_end_time:row.end_time})),ignored:input.p_ignored};
 return { status:200,data:fakeDatabase.appointments.length };
}};
async function labRpc(name,input) {
 return (await fetch("/lab-rpc",{method:"POST",body:JSON.stringify({name,input})})).json();
}
async function readActivities() {
 if (!live) return fakeDatabase;
 const input={p_work_date:appointmentDate};
 const [a,b]=await Promise.all([labRpc("cc_my_appointments",input),labRpc("cc_my_ignored_interventions",input)]);
 if(a.status!==200 || b.status!==200 || a.data.length!==2 || b.data.length!==4) throw Error("read");
 if(!a.data.every(row=>row.scheduled_end_time) || !b.data.every(row=>row.end_time)) throw Error("end");
 return {appointments:a.data,ignored:b.data};
}
${handler}
try {
 const panel=$("appointmentsPanel");
 panel.classList.remove("hidden");
 $("manualImport").classList.remove("hidden");
 $("processOracle").addEventListener("click",processOracleText);
 const routes=mountMyRoutes({panel,agenda:$("myRoutesAgenda"),getActor:()=>activeUser,getDate:()=>appointmentDate,
 loadActivities:readActivities,preferencesStore:{ clear(){}, read:async()=>({margin:10}) }});
 routes.sync();
 $("oracleText").value=source;
 $("processOracle").click();
 for(let i=0;i<100 && $("appointmentNotice").dataset.kind!=="success";i++) await new Promise(r=>setTimeout(r,10));
 if(writes!==1 || $("oracleText").value) throw Error("import");
 $("myRoutesTab").click();
 for(let i=0;i<100 && $("myRoutesList").querySelectorAll("h3").length<6;i++) await new Promise(r=>setTimeout(r,10));
 const cards=[...$("myRoutesList").querySelectorAll("h3")].slice(0,6);
 if(cards.map(x=>x.textContent.slice(-5)).join(",")!=="08:00,09:00,10:00,11:00,12:00,13:00") throw Error("order");
 if(!cards.every(card=>card.getBoundingClientRect().height>0)) throw Error("visibility");
 if(!$("myRoutesList").textContent.includes("Pausa sin desplazamiento")) throw Error("pause");
 if(innerWidth!==393) throw Error("viewport");
 await fetch("/result",{method:"POST",body:"PASS Chrome 393px, six routes, "+(live?"real test JWT":"mock RPC")});
} catch(error) { await fetch("/result",{method:"POST",body:"FAIL "+error.message}); }
`);
  } else if (modules.has(path) || path==="agenda.css") {
    res.setHeader("Content-Type",path.endsWith(".css")?"text/css":"text/javascript; charset=utf-8");
    res.end(await readFile(path));
  } else { res.statusCode=404; res.end(); }
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const profile=await mkdtemp(join(tmpdir(),"oracle-chrome-"));
let chrome;
try {
  chrome=spawn(process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",[
    "--headless=new","--no-first-run","--disable-background-networking","--no-default-browser-check",
    "--user-data-dir="+profile,"--window-size=393,873","--force-device-scale-factor=1",
    "http://127.0.0.1:"+server.address().port+"/",
  ],{windowsHide:true,stdio:"ignore"});
  chrome.on("error",()=>finish("FAIL Chrome process"));
  const result=await Promise.race([done,new Promise((resolve)=>{setTimeout(()=>resolve("FAIL timeout"),18000).unref();})]);
  assert.match(result,/^PASS/);
  console.log(result);
} finally {
  if (chrome?.pid && chrome.exitCode===null) {
    const exited=new Promise(resolve=>chrome.once("exit",resolve));
    chrome.kill();
    await exited;
  }
  server.close();
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
