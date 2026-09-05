/** fal.ai premium text-to-video provider for RFC 0010 hero beats. */

import { ProviderError } from "../provider.ts";

export interface GeneratedVideo {
  bytes: Uint8Array;
  media_type: "video/mp4";
  model: string;
  duration_sec: number;
}

export interface FalVideoOptions {
  apiKey?: string;
  model?: string;
  queueBaseUrl?: string;
  fetchImpl?: typeof fetch;
  pollMs?: number;
  timeoutMs?: number;
}

interface QueueSubmit { request_id?: string; status_url?: string; response_url?: string }
interface QueueStatus { status?: string }
interface QueueResult { video?: { url?: string; content_type?: string } }
const sleep = (ms:number)=>new Promise<void>((resolve)=>setTimeout(resolve,ms));

export class FalVideoProvider {
  readonly id:string;
  private readonly apiKey:string;
  private readonly model:string;
  private readonly queueBaseUrl:string;
  private readonly fetchImpl:typeof fetch;
  private readonly pollMs:number;
  private readonly timeoutMs:number;

  constructor(opts:FalVideoOptions={}){
    const key=opts.apiKey??process.env["FAL_KEY"];
    if(!key?.trim()) throw new ProviderError("FalVideoProvider needs FAL_KEY");
    this.apiKey=key.trim();
    // Deliberately separate from the legacy long-compose FAL_VIDEO_MODEL,
    // which is an image-to-video contract with a different input schema.
    this.model=opts.model??process.env["FAL_TEXT_TO_VIDEO_MODEL"]??"fal-ai/kling-video/v2.5-turbo/pro/text-to-video";
    this.queueBaseUrl=(opts.queueBaseUrl??"https://queue.fal.run").replace(/\/$/,"");
    this.fetchImpl=opts.fetchImpl??fetch;
    this.pollMs=opts.pollMs??2500;
    this.timeoutMs=opts.timeoutMs??10*60_000;
    this.id=`fal-video/${this.model}`;
  }

  private headers():Record<string,string>{ return {Authorization:`Key ${this.apiKey}`,"Content-Type":"application/json"}; }

  async generate(prompt:string,requestedDurationSec=5):Promise<GeneratedVideo>{
    const duration=requestedDurationSec<=5?"5":"10";
    const submitRes=await this.fetchImpl(`${this.queueBaseUrl}/${this.model}`,{
      method:"POST",headers:this.headers(),body:JSON.stringify({
        prompt:prompt.slice(0,2400),duration,aspect_ratio:"16:9",
        negative_prompt:"blur, distort, low quality, subtitles, text, watermark, logo",cfg_scale:0.5,
      }),
    });
    if(!submitRes.ok) throw new ProviderError(`${this.id} submit returned ${submitRes.status}: ${(await submitRes.text()).slice(0,500)}`);
    const submitted=await submitRes.json() as QueueSubmit;
    if(!submitted.request_id) throw new ProviderError(`${this.id} queue response missing request_id`);
    const statusUrl=submitted.status_url??`${this.queueBaseUrl}/${this.model}/requests/${submitted.request_id}/status`;
    const responseUrl=submitted.response_url??`${this.queueBaseUrl}/${this.model}/requests/${submitted.request_id}`;
    const deadline=Date.now()+this.timeoutMs;
    for(;;){
      if(Date.now()>deadline) throw new ProviderError(`${this.id} timed out waiting for ${submitted.request_id}`);
      const statusRes=await this.fetchImpl(statusUrl,{headers:this.headers()});
      if(!statusRes.ok) throw new ProviderError(`${this.id} status returned ${statusRes.status}`);
      const status=await statusRes.json() as QueueStatus; const state=String(status.status??"").toUpperCase();
      if(state==="COMPLETED") break;
      if(state==="FAILED"||state==="CANCELLED") throw new ProviderError(`${this.id} request ${state.toLowerCase()}`);
      await sleep(this.pollMs);
    }
    const resultRes=await this.fetchImpl(responseUrl,{headers:this.headers()});
    if(!resultRes.ok) throw new ProviderError(`${this.id} result returned ${resultRes.status}`);
    const result=await resultRes.json() as QueueResult; const videoUrl=result.video?.url;
    if(!videoUrl) throw new ProviderError(`${this.id} result has no video URL`);
    const dl=await this.fetchImpl(videoUrl); if(!dl.ok) throw new ProviderError(`${this.id} video download returned ${dl.status}`);
    return {bytes:new Uint8Array(await dl.arrayBuffer()),media_type:"video/mp4",model:this.model,duration_sec:Number(duration)};
  }
}
