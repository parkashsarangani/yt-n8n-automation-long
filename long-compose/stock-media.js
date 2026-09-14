// Optional editorial suggestions. No API/download failure may block narration.
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
const tokens = value => String(value || '').toLowerCase().match(/[a-z]{3,}/g) || [];
const stop = new Set('the and you your with that this for from then them they what when into have will was were are not but his her she him who how can just about would could should said says say there their one'.split(' '));
// Concrete situations beat searches for abstract traits such as confidence.
const contexts = [
  [/\b(meetings?|colleagues?|coworkers?|managers?|offices?|boss(?:es)?)\b/i, 'office meeting'],
  [/\b(phones?|text(?:s|ed|ing)?|messages?|reply|replies|replied|replying|notifications?)\b/i, 'phone message'],
  [/\b(coffee|cafes?|cafeterias?)\b/i, 'coffee conversation'],
  [/\b(dinners?|restaurants?|waiters?)\b/i, 'restaurant conversation'],
  [/\b(friends?|invitations?|invites?|inviting|party|parties)\b/i, 'friends talking'],
  [/\b(family|families|parents?|kitchens?)\b/i, 'family conversation'],
  [/\b(interviews?|interviewers?)\b/i, 'job interview'],
  [/\b(presentations?|audiences?|speech|speeches)\b/i, 'presentation audience'],
];
function sceneQuery(scene) {
  if (scene.is_outro) return '';
  const narration = String(scene.narration || '');
  // An explicit home-meal setting is more specific than generic "dinner".
  if (/\b(?:family|home)\s+dinners?\b|\bdinners?\s+(?:at\s+home|with\s+(?:(?:your|my|the|her|his)\s+)?(?:family|parents))\b/i.test(narration)) return 'family conversation';
  for (const [pattern, query] of contexts) if (pattern.test(narration)) return query;
  // No names, dialogue quotations or entire scripts are sent to stock services.
  return '';
}
const hosts = {
  pexels: ['api.pexels.com', 'images.pexels.com', 'videos.pexels.com', 'player.vimeo.com', 'vimeocdn.com'],
  pixabay: ['pixabay.com'],
  unsplash: ['api.unsplash.com', 'images.unsplash.com'],
};
function allowedUrl(raw, provider, source = false) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !(source ? {pexels:['pexels.com'],pixabay:['pixabay.com'],unsplash:['unsplash.com']}[provider] : hosts[provider])?.some(host => url.hostname === host || url.hostname.endsWith('.' + host)))
    throw Error('Unapproved stock URL');
  return url;
}
async function request(raw, provider, {fetchImpl = fetch, headers = {}, limit = 2*1024*1024, signal} = {}) {
  let url = allowedUrl(raw, provider);
  const timeout = AbortSignal.timeout(20_000);
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetchImpl(url.toString(), {headers, signal: bounded, redirect:'manual'});
    if ([301,302,303,307,308].includes(res.status)) {
      await res.body?.cancel();
      const next = allowedUrl(new URL(res.headers.get('location'), url).toString(), provider);
      if (next.origin !== url.origin) headers = {};
      url = next;
      continue;
    }
    if (!res.ok) { await res.body?.cancel(); throw Error(`Stock HTTP ${res.status}`); }
    if (Number(res.headers.get('content-length')) > limit) { await res.body?.cancel(); throw Error('Stock file too large'); }
    const chunks = []; let size = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const {done,value} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) throw Error('Stock file too large');
        chunks.push(value);
      }
    } catch (error) { await reader.cancel().catch(()=>{}); throw error; }
    finally { reader.releaseLock(); }
    return Buffer.concat(chunks);
  }
  throw Error('Too many stock redirects');
}
function normalize(provider, kind, data) {
  const results = provider === 'pexels' ? (kind === 'video' ? data.videos : data.photos)
    : provider === 'pixabay' ? data.hits : data.results;
  return (Array.isArray(results) ? results : []).flatMap(a => {
    let media, width, height, source, creator, description, download;
    if (provider === 'pexels') {
      media = kind === 'video' ? (a.video_files || []).filter(v => v.file_type === 'video/mp4' && v.width >= 960 && v.width <= 1920 && v.width > v.height)
        .sort((a,b) => Math.abs(a.width-1280)-Math.abs(b.width-1280))[0] : null;
      width = media?.width || a.width; height = media?.height || a.height;
      media = kind === 'video' ? media?.link : a.src?.large2x;
      source = a.url; creator = a.photographer || a.user?.name;
      description = `${a.alt || ''} ${String(a.url || '').split('/').at(-2)?.replace(/-/g,' ') || ''}`;
    } else if (provider === 'pixabay') {
      media = kind === 'video' ? [a.videos?.medium,a.videos?.small,a.videos?.large].find(v => v?.width >= 960 && v.width <= 1920 && v.width > v.height) : null;
      width = media?.width || a.imageWidth; height = media?.height || a.imageHeight;
      media = kind === 'video' ? media?.url : a.largeImageURL;
      source = a.pageURL; creator = a.user; description = a.tags;
    } else {
      width = a.width; height = a.height; media = a.urls?.regular;
      source = a.links?.html; creator = a.user?.name;
      description = `${a.alt_description || ''} ${a.description || ''} ${(a.tags || []).map(t => t.title).join(' ')}`;
      download = a.links?.download_location;
      if (!download) return [];
      if (source) source += `${source.includes('?')?'&':'?'}utm_source=vidgen&utm_medium=referral`;
    }
    if (!media || !source || !creator || width < 960 || width <= height || (kind === 'video' && !(a.duration >= 3))) return [];
    try { allowedUrl(media,provider); allowedUrl(source,provider,true); } catch { return []; }
    const license = provider === 'pexels' ? 'https://www.pexels.com/license/' : provider === 'pixabay' ? 'https://pixabay.com/service/license-summary/' : 'https://unsplash.com/license';
    return [{id:`${provider}-${kind}-${a.id}`,provider,kind,url:media,description,download,duration:a.duration,
      credit:{id:`${provider}-${kind}-${a.id}`,creator,source_url:source,license_url:license,credit:`${kind === 'video' ? 'Video' : 'Photo'} by ${creator} on ${provider}`,needs_review:true}}];
  });
}
function relevance(asset, query) {
  const terms = new Set(tokens(asset.description).filter(w => !stop.has(w)));
  return tokens(query).filter(w => terms.has(w)).length;
}
function searchUrl(provider, kind, query, key) {
  const base = provider === 'pexels' ? `https://api.pexels.com/v1/${kind === 'video' ? 'videos/search' : 'search'}`
    : provider === 'pixabay' ? `https://pixabay.com/api/${kind === 'video' ? 'videos/' : ''}` : 'https://api.unsplash.com/search/photos';
  const url = new URL(base);
  url.searchParams.set(provider === 'pixabay' ? 'q' : 'query',query);
  url.searchParams.set('per_page','8');
  if (provider === 'pixabay') {
    url.searchParams.set('key',key); url.searchParams.set('safesearch','true');
    url.searchParams.set(kind === 'video' ? 'video_type' : 'image_type',kind === 'video' ? 'film' : 'photo');
    if (kind === 'photo') url.searchParams.set('orientation','horizontal');
  } else url.searchParams.set('orientation','landscape');
  if (provider === 'unsplash') url.searchParams.set('content_filter','high');
  return url.toString();
}
async function search(provider, kind, query, key, options) {
  const file = path.join(options.cacheDir,hash(`${provider}:${kind}:${query}`)+'.json');
  try { const cache = JSON.parse(await fs.readFile(file,'utf8')); if (Date.now()-cache.time < 86400_000) return normalize(provider,kind,cache.data); } catch {}
  const headers = provider === 'pexels' ? {Authorization:key} : provider === 'unsplash' ? {Authorization:`Client-ID ${key}`,'Accept-Version':'v1'} : {};
  const data = JSON.parse((await request(searchUrl(provider,kind,query,key),provider,{...options,headers})).toString());
  // Atomic 24-hour metadata cache. Keys never appear in filenames or cached data.
  const temp = file+'.'+randomUUID();
  await fs.writeFile(temp,JSON.stringify({time:Date.now(),data})); await fs.rename(temp,file);
  return normalize(provider,kind,data);
}
async function planStock(scenes, durations, directory, options = {}) {
  const env = options.env || process.env;
  const keys = {pexels:env.PEXELS_API_KEY,pixabay:env.PIXABAY_API_KEY,unsplash:env.UNSPLASH_ACCESS_KEY};
  const providers = Object.keys(keys).filter(p => keys[p]?.trim());
  options.warn?.(`Stock sources configured: ${providers.join(', ') || 'none'}`);
  const shots = []; if (!providers.length) return shots;
  const cacheDir = options.cacheDir || env.STOCK_CACHE_DIR || path.join(directory,'stock-cache');
  await fs.mkdir(cacheDir,{recursive:true});
  const signal = AbortSignal.timeout(120_000);
  const opts = {...options,cacheDir,signal};
  const seed = options.seed || hash(JSON.stringify(scenes.map(s=>[s.scene_index,s.narration])));
  const creditLimit = options.creditLimit ?? 2800;
  const used = new Set(), disabled = new Set(), results = new Map(), downloaded = new Map();
  let previousId;
  let offset = 0, searches = 0, creditChars = 0;
  // Max 12 unique assets, 24 API searches, 300 MB/run; bounded even for a long script.
  for (let i=0;i<scenes.length;i++) {
    const start = offset; offset += durations[i];
    const query = sceneQuery(scenes[i]);
    if (!query || signal.aborted || !(durations[i]>0)) continue;
    if (!results.has(query)) {
      const candidates = [];
      for (const provider of providers) for (const kind of provider === 'unsplash' ? ['photo'] : ['video','photo']) {
        if (disabled.has(provider) || searches >= 24 || signal.aborted) continue;
        searches++;
        try { candidates.push(...await search(provider,kind,query,keys[provider],opts)); }
        catch { disabled.add(provider); options.warn?.(`Stock ${provider} unavailable; continuing with other sources or background`); }
      }
      results.set(query,candidates);
    }
    const preferredKind = i%3===2?'photo':'video';
    const ranked = results.get(query).filter(a=>!used.has(a.id) && (a.kind!=='video'||a.duration>=Math.min(durations[i],8))
        && creditChars+creditLength(a.credit)<=creditLimit)
      .map(a=>({a,score:relevance(a,query)})).filter(x=>x.score>0)
      .sort((a,b)=>b.score-a.score || Number(b.a.kind===preferredKind)-Number(a.a.kind===preferredKind) || hash(seed+a.a.id).localeCompare(hash(seed+b.a.id)));
    // Reuse only within the same search context after exhausting the asset
    // budget. Prefer a different image from the preceding scene.
    const reusable = [...downloaded.values()].filter(s=>s.credit.query===query && (s.kind!=='video'||s.sourceDuration>=Math.min(durations[i],8)))
      .sort((a,b)=>Number(a.credit.id===previousId)-Number(b.credit.id===previousId));
    if ((used.size >= 12 || !ranked.length) && reusable.length) {
      const shot = {...reusable[0],scene_index:scenes[i].scene_index,start,duration:durations[i]};
      shots.push(shot); previousId=shot.credit.id; continue;
    }
    for (const {a} of ranked.slice(0,2)) {
      if (used.size >= 12 || signal.aborted) break;
      used.add(a.id);
      try {
        const attributionLength = creditLength(a.credit);
        if (a.provider === 'unsplash') {
          // Record the selection/export event; image bytes use the API-returned CDN URL.
          const tracking = allowedUrl(a.download,'unsplash');
          if (tracking.origin !== 'https://api.unsplash.com') throw Error('Invalid download tracking URL');
          await request(tracking.toString(),'unsplash',{...opts,headers:{Authorization:`Client-ID ${keys.unsplash}`,'Accept-Version':'v1'}});
        }
        const bytes = await request(a.url,a.provider,{...opts,limit:25*1024*1024});
        const file = path.join(directory,`stock-${hash(a.id).slice(0,16)}.${a.kind==='video'?'mp4':'jpg'}`);
        await fs.writeFile(file,bytes);
        const shot = {scene_index:scenes[i].scene_index,start,duration:durations[i],start_sec:0,file,kind:a.kind,sourceDuration:a.duration,
          credit:{...a.credit,query,sha256:hash(bytes)}};
        shots.push(shot); downloaded.set(a.id,shot); previousId=a.id; creditChars+=attributionLength;
        break;
      } catch { options.warn?.(`Stock ${a.provider} asset unavailable; trying another candidate`); }
    }
  }
  return shots;
}
function creditLength(c) { return c.credit.length+c.source_url.length+c.license_url.length+16; }
module.exports = {planStock, sceneQuery, normalize, relevance, allowedUrl, request};
