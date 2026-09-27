/**
 * Thumbnail placeholder for the editor's Drive package.
 *
 * Generated artwork was retired on 2026-09-27 (operator decision): only the
 * editor's thumbnail-final is ever published. This worker composites the
 * designer's text over a gradient as a starting point, and records the
 * designer's art direction as a note for the editor. Nothing here is uploaded
 * to YouTube.
 */
import type { WorkerDef } from "../runner.ts";
export interface ThumbnailWorkerOptions { version?: string }
interface Brief { text:string; image_prompt?:string; art_prompt?:string; background_query?:string; emphasis?:string; accent:string }
export function makeThumbnailWorker(opts:ThumbnailWorkerOptions={}):WorkerDef {
  return {
    name:"thumbnail",kind:"worker",version:opts.version??"11",
    consumes:[{schema_id:"thumbnail_brief",range:"^1 || ^2",as:"brief"}],
    produces:"thumbnail",
    async execute(inputs,ctx) {
      const brief=inputs["brief"]!.payload as Brief;
      const renderer=ctx.media.renderer;
      if(!renderer)throw Error("thumbnail worker needs a renderer; none was configured");
      // Legacy fields are accepted only for existing artifacts, never emitted by the new designer.
      const artDirection=(brief.image_prompt||brief.art_prompt||brief.background_query||"").trim();
      const result=await renderer.renderThumbnail({text:brief.text,accent:brief.accent,...(brief.emphasis?{emphasis:brief.emphasis}:{})});
      const notes=await ctx.blobs.put(new TextEncoder().encode(JSON.stringify({
        text:brief.text,
        art_direction:artDirection,
        status:"placeholder",
        note:"thumbnail.png is a text placeholder and is never published. Upload your finished thumbnail as thumbnail-final.png beside final.mp4 (.mov/.m4v also accepted) — it is the only thumbnail ever published; without it YouTube auto-picks a frame. art_direction is the designer's idea for the image, if you want a starting point."
      },null,2)),{role:"thumbnail_prompt",media_type:"application/json"});
      const ref=await ctx.blobs.put(result.bytes,{role:"thumbnail",media_type:result.media_type});
      return {payload:{thumbnail_uri:ref.uri,media_type:result.media_type,width:result.width,height:result.height,text:brief.text,
        ...(brief.emphasis?{emphasis:brief.emphasis}:{}),background:result.background,bytes:result.bytes.byteLength},blobs:[ref,notes]};
    }
  };
}
