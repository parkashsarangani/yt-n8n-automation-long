import { readEnvFile } from "../src/config.ts";
import { driveTokenFactory } from "../src/drive-auth.ts";
import { DriveProvider } from "../src/providers/drive.ts";
import { localParts } from "../src/delivery-time.ts";
import type { RunView } from "../src/service.ts";

const api = async (path: string, method = "GET") => {
  const res = await fetch("http://127.0.0.1:4321/api/"+path, {method, headers:{Host:"localhost"}, signal:AbortSignal.timeout(95*60_000)});
  if(!res.ok) throw Error(`Engine ${path}: ${res.status}`);
  return res.json();
};
console.log(JSON.stringify(await api("schedule")));
if(process.env.VERIFY_PRODUCE==="true") {
  const schedule=await api("schedule");
  if(!schedule.jobs.find((j:any)=>j.id==="produce")?.running) await api("schedule/produce/run","POST");
  await api("schedule/editor_delivery/run","POST");
}
const deadline=Date.now()+(process.env.VERIFY_PRODUCE==="true"?90*60_000:0);
let run:RunView|undefined;
do {
  const {runs}=await api("runs");
  const today=localParts(Date.now()).date;
  run=runs.filter((r:RunView)=>r.kind==="production" && localParts(Date.parse(r.created_at)).date===today)
    .sort((a:RunView,b:RunView)=>b.created_at.localeCompare(a.created_at))[0];
  console.log(JSON.stringify(run?{run_id:run.run_id,status:run.status,waiting:run.waiting.map(w=>w.node_id),failures:run.failures}: {episode:"missing"}));
  if(run?.waiting.some(w=>w.node_id==="editor_review") || run?.status==="completed") break;
  if(run?.status==="blocked" || Date.now()>=deadline) break;
  if(run?.waiting.some(w=>w.node_id==="editor_delivery")) {
    if(localParts(Date.now()).hour<5) break;
    await api("schedule/editor_delivery/run","POST");
  }
  await new Promise(resolve=>setTimeout(resolve,30_000));
} while(Date.now()<deadline);
const handoffId=run?.nodes.find(n=>n.node_id==="editor_package")?.artifact_id;
if(!handoffId) throw Error("No completed Drive handoff for today's episode yet");
const {artifact}=await api("artifacts/"+encodeURIComponent(handoffId));
const saved=await readEnvFile(process.env.AMOS_ENV_FILE||"/data/.env");
const env=(key:string)=>saved[key]?.trim()||process.env[key]?.trim()||"";
const drive=new DriveProvider({accessToken:driveTokenFactory({clientId:env("DRIVE_CLIENT_ID"),clientSecret:env("DRIVE_CLIENT_SECRET"),refreshToken:env("DRIVE_REFRESH_TOKEN")})});
const files=await drive.listFiles(artifact.payload.drive_folder_id);
console.log(JSON.stringify({drive_folder_url:artifact.payload.drive_folder_url,files:files.map(f=>f.name)}));
for(const name of ["draft.mp4","captions.srt","package.md","credits.json"]) if(!files.some(f=>f.name===name)) throw Error("Drive package missing "+name);
const srt=new TextDecoder().decode(await drive.downloadFile(files.find(f=>f.name==="captions.srt")!.id));
if(!srt.includes(" --> ")) throw Error("Uploaded captions contain no timed cues");
console.log(JSON.stringify({verified:true,caption_cues:srt.split(" --> ").length-1}));
