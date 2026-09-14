const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {planStock,sceneQuery,normalize,relevance,allowedUrl,request} = require('../stock-media');

test('plural and irregular narration selects concrete contexts',()=>{
  for (const [narration,query] of [
    ['Your colleagues keep interrupting.','office meeting'],
    ['She raised it in meetings twice.','office meeting'],
    ['Your friends stopped inviting you.','friends talking'],
    ['He ignored your messages.','phone message'],
    ['Two coworkers presented your slides.','office meeting'],
    ['You give presentations weekly.','presentation audience'],
    ['Families wait for replies after parties.','phone message'],
    ['You replied to her text an hour later.','phone message'],
    ['He texted again.','phone message'],
    ['Your boss interrupted.','office meeting'],
    ['At the family dinner nobody spoke.','family conversation'],
    ['Dinner with your parents was quiet.','family conversation'],
    ['Dinner at the restaurant was quiet.','restaurant conversation'],
  ]) assert.equal(sceneQuery({narration}),query,narration);
});

test('source URLs must belong to the credited provider',()=>{
  const photo={id:1,width:1920,height:1080,photographer:'Test',alt:'office',src:{large2x:'https://images.pexels.com/a.jpg'}};
  for (const url of ['https://evil.example/phishing','https://pexels.com.evil.example/a','https://user:password@pexels.com/a'])
    assert.deepEqual(normalize('pexels','photo',{photos:[{...photo,url}]}),[]);
});

test('streaming size overflow explicitly cancels the response body',async()=>{
  let cancelled=false;
  const body=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(10));},cancel(){cancelled=true;}});
  await assert.rejects(()=>request('https://images.pexels.com/a.jpg','pexels',{
    limit:5,fetchImpl:async()=>new Response(body),
  }),/too large/);
  assert.equal(cancelled,true);
});

test('short motion is eligible, credit saturation reuses without downloads, and episode seeds vary ties',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stock-budget-test-'));
  let downloads=0;
  const fetchImpl=async raw=>{
    const u=new URL(raw);
    if (u.hostname==='videos.pexels.com'){downloads++;return new Response(new Uint8Array([1,2,3]));}
    return Response.json({photos:[],videos:u.pathname.includes('/videos/')?Array.from({length:8},(_,i)=>({
      id:i,duration:8,user:{name:'Test'},url:`https://www.pexels.com/video/office-meeting-${i}/`,
      video_files:[{file_type:'video/mp4',width:1280,height:720,link:`https://videos.pexels.com/${i}.mp4`}],
    })):[]});
  };
  try {
    const scenes=Array.from({length:18},(_,scene_index)=>({scene_index,narration:'Your colleagues are speaking in meetings.'}));
    const opts={env:{PEXELS_API_KEY:'test'},fetchImpl,creditLimit:210,seed:'episode-a'};
    const shots=await planStock(scenes,scenes.map(()=>32),dir,opts);
    assert.equal(shots.length,18);
    assert.equal(downloads,1,'credit-only skips cannot consume asset slots or redownload');
    assert.equal(shots[0].kind,'video');
    assert.equal(shots[0].sourceDuration,8);
    const firsts=new Set();
    for(let i=0;i<8;i++) {
      const s=await planStock(scenes.slice(0,1),[32],dir,{...opts,seed:'episode-'+i});
      firsts.add(s[0].credit.id);
    }
    assert.ok(firsts.size>1,'different episode seeds vary equally relevant assets');
    const retry=await planStock(scenes.slice(0,1),[32],dir,opts);
    assert.equal(retry[0].credit.id,shots[0].credit.id,'retry is stable for one episode');
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('queries use concrete situations; abstract or outro scenes stay on background',()=>{
  assert.equal(sceneQuery({narration:'Your colleague starts speaking in the meeting.'}),'office meeting');
  assert.equal(sceneQuery({narration:'Be more confident.'}),'');
  assert.equal(sceneQuery({narration:'A meeting.',is_outro:true}),'');
  assert.throws(()=>allowedUrl('https://127.0.0.1/private','pexels'));
  assert.throws(()=>allowedUrl('https://images.pexels.com.attacker.example/file','pexels'));
  assert.equal(relevance({description:'ocean sunset beach'},'office meeting'),0);
});

test('Pexels video chooses a usable landscape MP4 and Pixabay supplies photos and videos',()=>{
  const p=normalize('pexels','video',{videos:[{id:1,url:'https://www.pexels.com/video/office-meeting-1/',user:{name:'Creator'},duration:20,
    video_files:[{file_type:'video/mp4',width:3840,height:2160,link:'https://videos.pexels.com/a.mp4'},
      {file_type:'video/mp4',width:1280,height:720,link:'https://videos.pexels.com/b.mp4'}]}]});
  assert.equal(p[0].url,'https://videos.pexels.com/b.mp4');
  const hit={id:2,pageURL:'https://pixabay.com/photos/office-2/',user:'Creator',tags:'office meeting',imageWidth:1920,imageHeight:1080,
    largeImageURL:'https://cdn.pixabay.com/a.jpg',duration:30,videos:{medium:{url:'https://cdn.pixabay.com/a.mp4',width:1280,height:720}}};
  assert.equal(normalize('pixabay','photo',{hits:[hit]})[0].kind,'photo');
  assert.equal(normalize('pixabay','video',{hits:[hit]})[0].kind,'video');
});

test('missing keys cause no network traffic',async()=>{
  assert.deepEqual(await planStock([{narration:'office meeting'}],[5],'.',{env:{},fetchImpl:()=>{throw Error('network');}}),[]);
});

test('provider outage falls through to Unsplash, tracks export, preserves attribution and caches searches',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stock-api-test-'));
  const calls=[];
  const fetchImpl=async(raw,opts)=>{
    const u=new URL(raw); calls.push(u);
    if(u.hostname==='api.pexels.com')return new Response('',{status:429});
    if(u.pathname==='/search/photos'){
      assert.equal(opts.headers.Authorization,'Client-ID unsplash-test');
      return Response.json({results:[{id:'test',width:1920,height:1080,alt_description:'office meeting',user:{name:'Example'},
        urls:{regular:'https://images.unsplash.com/test?ixid=keep'},links:{html:'https://unsplash.com/photos/test',download_location:'https://api.unsplash.com/photos/test/download'}}]});
    }
    if(u.pathname==='/photos/test/download')return Response.json({url:'unused'});
    assert.equal(opts.headers.Authorization,undefined,'API credentials must not reach CDN');
    assert.equal(u.searchParams.get('ixid'),'keep');
    return new Response(new Uint8Array([1,2,3]));
  };
  try{
    const opts={env:{PEXELS_API_KEY:'pexels-test',UNSPLASH_ACCESS_KEY:'unsplash-test'},cacheDir:path.join(dir,'cache'),fetchImpl};
    const shots=await planStock([{scene_index:0,narration:'An office meeting.'}],[6],dir,opts);
    assert.equal(shots.length,1);
    assert.match(shots[0].credit.credit,/Example on unsplash/);
    assert.equal(shots[0].credit.needs_review,true);
    assert.match(shots[0].credit.sha256,/^[a-f0-9]{64}$/);
    assert.equal(calls.filter(u=>u.hostname==='api.pexels.com').length,1);
    assert.equal(calls.filter(u=>u.pathname.endsWith('/download')).length,1);
    await planStock([{scene_index:0,narration:'An office meeting.'}],[6],dir,opts);
    assert.equal(calls.filter(u=>u.pathname==='/search/photos').length,1,'metadata is cached for 24 hours');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('unrelated search results and oversized downloads leave a background fallback',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stock-reject-test-'));
  try{
    const fetchImpl=async raw=>{
      if(new URL(raw).hostname==='cdn.pixabay.com')return new Response('x',{headers:{'content-length':String(30*1024*1024)}});
      return Response.json({hits:[{id:1,user:'Test',pageURL:'https://pixabay.com/photos/1/',tags:'office meeting',imageWidth:1920,imageHeight:1080,largeImageURL:'https://cdn.pixabay.com/a.jpg'}]});
    };
    assert.deepEqual(await planStock([{scene_index:0,narration:'Office meeting.'}],[6],dir,{env:{PIXABAY_API_KEY:'test'},fetchImpl}),[]);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
