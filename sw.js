const C='sf-v1';const PRE=["./", "index.html", "patient.html", "doctor.html", "pharm.html", "manifest.json", "manifest-patient.json", "manifest-doctor.json", "manifest-pharm.json", "config.js", "icon-192.png", "icon-512.png", "icon-180.png"];
const SDK=/^https:\/\/www\.gstatic\.com\/firebasejs\//;
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(PRE)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);
  if(SDK.test(r.url)){e.respondWith(caches.match(r).then(m=>m||fetch(r).then(res=>{const cp=res.clone();caches.open(C).then(c=>c.put(r,cp));return res;})));return;}
  if(u.origin!==location.origin)return;
  e.respondWith(fetch(r).then(res=>{if(res.ok){const cp=res.clone();caches.open(C).then(c=>c.put(r,cp));}return res;}).catch(()=>caches.match(r,{ignoreSearch:true})));
});
