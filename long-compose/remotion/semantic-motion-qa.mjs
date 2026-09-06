import {readFileSync,rmSync} from "fs";import {inflateSync} from "zlib";
function decode(file){const b=readFileSync(file);let p=8,w=0,h=0,c=0;const chunks=[];while(p<b.length){const n=b.readUInt32BE(p),t=b.toString("ascii",p+4,p+8),d=b.subarray(p+8,p+8+n);if(t==="IHDR"){w=d.readUInt32BE(0);h=d.readUInt32BE(4);c=d[9]}else if(t==="IDAT")chunks.push(d);else if(t==="IEND")break;p+=12+n}const channels=c===6?4:c===2?3:1,raw=inflateSync(Buffer.concat(chunks)),stride=w*channels,out=Buffer.alloc(h*stride);let q=0;for(let y=0;y<h;y++){const filter=raw[q++];for(let x=0;x<stride;x++){let v=raw[q++],a=x>=channels?out[y*stride+x-channels]:0,up=y?out[(y-1)*stride+x]:0,ul=x>=channels&&y?out[(y-1)*stride+x-channels]:0;if(filter===1)v+=a;else if(filter===2)v+=up;else if(filter===3)v+=(a+up)>>1;else if(filter===4){const pa=Math.abs(up-ul),pb=Math.abs(a-ul),pc=Math.abs(a+up-2*ul);v+=pa<=pb&&pa<=pc?a:pb<=pc?up:ul}out[y*stride+x]=v&255}}return{w,h,channels,data:out}}
function metrics(files){const imgs=files.map(decode),bg=imgs[0],left=Math.floor(bg.w*.06),right=Math.ceil(bg.w*.94),top=Math.floor(bg.h*.08),bottom=Math.ceil(bg.h*.9);const occupancy=imgs.map(img=>{let hit=0,total=0;const corner=[img.data[0],img.data[1],img.data[2]];for(let y=top;y<bottom;y+=2)for(let x=left;x<right;x+=2){const i=(y*img.w+x)*img.channels,d=Math.abs(img.data[i]-corner[0])+Math.abs(img.data[i+1]-corner[1])+Math.abs(img.data[i+2]-corner[2]);if(d>55)hit++;total++}return hit/total});const differences=[];for(let k=1;k<imgs.length;k++){let changed=0,total=0,a=imgs[k-1],b=imgs[k];for(let y=top;y<bottom;y+=3)for(let x=left;x<right;x+=3){const i=(y*a.w+x)*a.channels,d=Math.abs(a.data[i]-b.data[i])+Math.abs(a.data[i+1]-b.data[i+1])+Math.abs(a.data[i+2]-b.data[i+2]);if(d>24)changed++;total++}differences.push(changed/total)}return{occupancy,differences,emptyCanvasRatio:1-Math.max(...occupancy)}}
async function vision(files,narration,fetchImpl=fetch){const key=process.env.OPENAI_API_KEY;if(!key)return null;const content=[{type:"text",text:`Review these 20%, 55%, and 85% frames from one explainer scene. Narration: "${String(narration||"").slice(0,500)}". Score semantic_relevance, visual_specificity, causal_fidelity, progression, composition, and label_dependency from 0 to 1. label_dependency=1 means the visual depends heavily on labels and is bad. Penalize a scene reusable for an unrelated topic by changing only labels. Return JSON only with those six numbers and verdict pass|revise.`}];for(const file of files)content.push({type:"image_url",image_url:{url:`data:image/png;base64,${readFileSync(file).toString("base64")}`}});try{const base=(process.env.OPENAI_BASE_URL||"https://api.openai.com/v1").replace(/\/$/,""),res=await fetchImpl(`${base}/chat/completions`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${key}`},body:JSON.stringify({model:process.env.OPENAI_IMAGE_QA_MODEL||"gpt-5.6-luna",messages:[{role:"user",content}],max_completion_tokens:500,response_format:{type:"json_object"}})});if(!res.ok)return null;const j=await res.json();return JSON.parse(j.choices?.[0]?.message?.content||"null")}catch{return null}}
export async function reviewSemanticMotion({composition,serveUrl,inputProps,renderStill,puppeteerInstance}){const extension=inputProps?.semanticRepresentation;if(!extension)return null;const base=`${composition.id}-semantic-qa-${process.pid}-${Date.now()}`,frames=[.2,.55,.85].map(r=>Math.min(composition.durationInFrames-1,Math.max(0,Math.round((composition.durationInFrames-1)*r)))),files=frames.map((_,i)=>`${process.env.TEMP||process.env.TMP||"."}/${base}-${i}.png`);try{for(let i=0;i<frames.length;i++)await renderStill({composition,serveUrl,inputProps,frame:frames[i],output:files[i],puppeteerInstance,overwrite:true});const deterministic=metrics(files),visionReview=await vision(files,inputProps?.narration||inputProps?.keyText||extension.visualClaim);const failures=[];if(Math.max(...deterministic.occupancy)<.15)failures.push("foreground occupancy below 15%");if(deterministic.differences.some(v=>v<.0025))failures.push("semantic state progression is visually negligible");if(visionReview?.verdict==="revise")failures.push("vision critic requested revision");if(process.env.MOTION_VISUAL_QA_REQUIRED==="true"&&!visionReview)failures.push("required vision critic did not run");if(failures.length)throw new Error(`motion visual QA failed: ${failures.join("; ")}; metrics=${JSON.stringify(deterministic)}`);return{deterministic,vision:visionReview||{verdict:"not-run"}}}finally{for(const f of files)rmSync(f,{force:true})}}

/**
 * RFC 0010 pre-composition pixel gate.
 * -----------------------------------------------------------------------
 * The legacy `reviewSemanticMotion` above is advisory by explicit operator
 * decision, and it only fires on `semanticRepresentation`. That combination is
 * why five obviously-bad graphics survived to the final render of the first
 * complete RFC 0010 candidate: the beats were never checked, and the check
 * that existed could not have stopped them anyway.
 *
 * RFC 0010 scenes are different in a way that makes a hard gate safe: the
 * engine ships `rfc0010Requirements` (the concrete things a viewer must be
 * able to read off this scene, derived from its own data) AND
 * `rfc0010FallbackScene` (an honest kinetic-text rendering of the same beat).
 * So a failure here does not have to abort the render or emit a placeholder --
 * it downgrades this one beat to text, which is a real, legible visual.
 *
 * Deterministic checks run first and cost nothing; the vision critic is only
 * asked when they pass, and its absence is never treated as a failure (an
 * offline critic must not silently rewrite the episode).
 */
export async function reviewRfc0010Scene({composition, serveUrl, inputProps, renderStill, puppeteerInstance, fetchImpl = fetch}) {
    const scene = inputProps?.rfc0010SemanticScene;
    if (!scene || typeof scene !== "object") return null;

    const requirements = Array.isArray(inputProps?.rfc0010Requirements) ? inputProps.rfc0010Requirements : [];
    const base = `${composition.id}-rfc0010-qa-${process.pid}-${Date.now()}`;
    const frames = [0.35, 0.75].map((r) =>
        Math.min(composition.durationInFrames - 1, Math.max(0, Math.round((composition.durationInFrames - 1) * r))),
    );
    const tmp = process.env.TEMP || process.env.TMP || ".";
    const files = frames.map((_, i) => `${tmp}/${base}-${i}.png`);

    try {
        for (let i = 0; i < frames.length; i++) {
            await renderStill({composition, serveUrl, inputProps, frame: frames[i], output: files[i], puppeteerInstance, overwrite: true});
        }
        const deterministic = metrics(files);
        const failures = [];

        // A near-empty frame means the scene's data did not reach the canvas --
        // the exact symptom of a renderer that drew nothing because the fields
        // it wanted were absent.
        if (Math.max(...deterministic.occupancy) < 0.12) failures.push("scene canvas is essentially empty");

        // A kinetic phrase is legitimately close to static; a diagram that is
        // pixel-identical across its own span never showed its transformation.
        if (scene.kind !== "kinetic_phrase" && deterministic.differences.some((v) => v < 0.002)) {
            failures.push("explanatory graphic never visibly changes state");
        }

        let review = null;
        if (!failures.length && requirements.length) {
            review = await rfc0010Vision(files, scene, requirements, fetchImpl);
            // `review === null` is an unreachable critic, not a bad visual.
            if (review && review.verdict === "fail") {
                const missing = Array.isArray(review.missing) ? review.missing.slice(0, 3).join("; ") : "";
                failures.push(`required elements not visible${missing ? `: ${missing}` : ""}`);
            }
        }

        return {
            ok: failures.length === 0,
            failures,
            deterministic,
            vision: review || {verdict: "not-run"},
        };
    } finally {
        for (const f of files) rmSync(f, {force: true});
    }
}

/**
 * Ask the critic a checkable question -- "is each of these specific things
 * visible?" -- rather than "does this look good". The requirements come from
 * the scene's own axis/markers/values, so a diagram that drew anonymous
 * geometry fails on the elements it is actually missing.
 */
async function rfc0010Vision(files, scene, requirements, fetchImpl) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    const content = [{
        type: "text",
        text: [
            "These frames are one explanatory graphic from a narrated explainer.",
            "For EACH required element below, decide whether it is actually visible and legible in the frames.",
            "Judge only what is drawn. Do not credit an element because the topic implies it.",
            "REQUIRED ELEMENTS:",
            ...requirements.slice(0, 12).map((r, i) => `${i + 1}. ${r}`),
            "",
            'Return JSON only: {"visible":0,"required":0,"missing":["..."],"verdict":"pass|fail","reason":"one sentence"}.',
            'verdict is "fail" if any required element is missing or illegible.',
        ].join("\n"),
    }];
    for (const file of files) {
        content.push({type: "image_url", image_url: {url: `data:image/png;base64,${readFileSync(file).toString("base64")}`}});
    }
    try {
        const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
        const res = await fetchImpl(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {"content-type": "application/json", authorization: `Bearer ${key}`},
            body: JSON.stringify({
                model: process.env.OPENAI_IMAGE_QA_MODEL || "gpt-5.6-luna",
                messages: [{role: "user", content}],
                max_completion_tokens: 500,
                response_format: {type: "json_object"},
            }),
        });
        if (!res.ok) return null;
        const payload = await res.json();
        return JSON.parse(payload.choices?.[0]?.message?.content || "null");
    } catch {
        return null;
    }
}
