/** Standalone thumbnail: one prompt, at most two image attempts, deterministic text. */
import type { BlobRef } from "../artifact.ts";
import type { ThumbnailResult } from "../provider.ts";
import type { WorkerDef } from "../runner.ts";
export interface ThumbnailWorkerOptions { version?: string }
interface Brief { text:string; image_prompt?:string; art_prompt?:string; background_query?:string; emphasis?:string; accent:string }
export function makeThumbnailWorker(opts:ThumbnailWorkerOptions={}):WorkerDef {
  return {
    name:"thumbnail",kind:"worker",version:opts.version??"10",
    consumes:[{schema_id:"thumbnail_brief",range:"^1 || ^2",as:"brief"}],
    produces:"thumbnail",
    async execute(inputs,ctx) {
      const brief=inputs["brief"]!.payload as Brief;
      const renderer=ctx.media.renderer;
      if(!renderer)throw Error("thumbnail worker needs a renderer; none was configured");
      // Legacy fields are accepted only for existing artifacts, never emitted by the new designer.
      const prompt=(brief.image_prompt||brief.art_prompt||brief.background_query||"").trim();
      const blobs:BlobRef[]=[];
      const attempts:Array<{prompt:string; outcome:string; error?:string}>=[];
      let result:ThumbnailResult|undefined;
      const overlay={text:brief.text,accent:brief.accent,...(brief.emphasis?{emphasis:brief.emphasis}:{})};
      if(prompt && ctx.media.images) for(let attempt=0;attempt<2;attempt++){
        const sent=attempt===0?prompt:prompt+" Repair: simplify the scene and remove ALL writing, signage, letters, logos and watermarks. Keep the original subject and narrative meaning.";
        let stage:"generation"|"rendering"="generation";
        try {
          await ctx.progress({detail:`thumbnail artwork attempt ${attempt+1}/2`});
          const found=await ctx.media.images.generate({prompt:sent,aspect:"16:9",count:1});
          await ctx.progress({detail:"thumbnail image usage",usage:found.usage});
          const image=found.images[0];
          if(!image?.bytes?.length)throw Error("image provider returned no thumbnail image");
          stage="rendering";
          result=await renderer.renderThumbnail({...overlay,image:image.bytes});
          if(result.degradation_reason){
            const message=thumbnailErrorDetail(result.degradation_reason);
            attempts.push({prompt:sent,outcome:"render_service_failure",error:message});
            ctx.logger.warn(`thumbnail rendering service failed: ${message}; editor replacement required`);
            break; // A new image cannot repair a compositor outage.
          }
          // Keep the artwork whatever the renderer decided. It is the editor's
          // raw material, and discarding it on rejection meant paying for an
          // image nobody ever saw.
          blobs.push(await ctx.blobs.put(image.bytes,{role:"thumbnail_artwork",media_type:image.media_type}));
          attempts.push({prompt:sent,outcome:result.background==="supplied"?"accepted":"composited without artwork"});
          break;
        } catch (error) {
          const message=thumbnailErrorDetail(error);
          attempts.push({prompt:sent,outcome:stage==="generation"?"generation_failure":"render_service_failure",error:message});
          ctx.logger.warn(`thumbnail ${stage} failed: ${message}`);
          if(stage==="rendering")break;
        }
      }
      if(!result)result=await renderer.renderThumbnail(overlay);
      const needsReplacement=result.background!=="supplied";
      if(needsReplacement)ctx.logger.warn("THUMBNAIL NEEDS REPLACEMENT: placeholder only; notify the editor/operator before publication");
      blobs.push(await ctx.blobs.put(new TextEncoder().encode(JSON.stringify({
        image_prompt:prompt,text:brief.text,attempts,
        status:needsReplacement?"needs_editor_replacement":"candidate",
        artwork_available:!needsReplacement,
        note:"Generated illustration, not documentary evidence. Return your finished cut as final.mp4 (.mov/.m4v also accepted) and, if you make one, your thumbnail as thumbnail-final.png — both are imported automatically; leave exactly one of each."
      },null,2)),{role:"thumbnail_prompt",media_type:"application/json"}));
      const ref=await ctx.blobs.put(result.bytes,{role:"thumbnail",media_type:result.media_type});
      blobs.unshift(ref);
      return {payload:{thumbnail_uri:ref.uri,media_type:result.media_type,width:result.width,height:result.height,text:brief.text,
        ...(brief.emphasis?{emphasis:brief.emphasis}:{}),background:result.background,bytes:result.bytes.byteLength},blobs};
    }
  };
}

/** Keep actionable diagnostics bounded and redact common credential formats. */
export function thumbnailErrorDetail(error:unknown):string {
  return (error instanceof Error?error.message:String(error))
    .replace(/Bearer\s+[^\s"']+/gi,"Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|access_token|token|authorization)["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi,"$1[REDACTED]")
    .replace(/[\r\n]+/g," ").slice(0,1000);
}
