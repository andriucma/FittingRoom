const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const loadTs=require('./load-ts.cjs');

test('cancellation covers current work, late requests and client disconnects without affecting another attempt',()=>{
 const operations=loadTs('src/lib/server/videoOperations.ts',{}, {AbortController});
 const id=randomUUID(),other=randomUUID();
 const request=id=>new Request('http://localhost/api/videos',{headers:{'x-video-operation':id}});
 const signal=operations.videoOperationSignal(request(id));
 const independent=operations.videoOperationSignal(request(other));
 assert.equal(signal.aborted,false);operations.cancelVideoOperation(id);
 assert.equal(signal.aborted,true);assert.equal(independent.aborted,false);
 assert.equal(operations.videoOperationSignal(request(id)).aborted,true);
 const early=randomUUID();operations.cancelVideoOperation(early);
 assert.equal(operations.videoOperationSignal(request(early)).aborted,true);
 const controller=new AbortController();const disconnected=operations.videoOperationSignal(new Request('http://localhost',{signal:controller.signal}));controller.abort();assert.equal(disconnected.aborted,true);
 assert.equal(operations.cancelVideoOperation('../unsafe'),false);
});

test('client cancellation aborts fetch, sends an explicit stop, and cannot be revived; finished attempts need no cancel',async()=>{
 const calls=[];
 const {VideoOperation}=loadTs('src/lib/capture/videoOperation.ts',{}, {AbortController,Headers,crypto:{randomUUID},fetch:async(url,opts)=>{calls.push({url,...opts});return new Response('{}')}});
 const op=new VideoOperation();await op.fetch('/api/videos',{method:'POST'});
 assert.equal(calls[0].headers.get('x-video-operation'),op.id);op.cancel();op.cancel();
 assert.equal(calls[0].signal.aborted,true);assert.equal(calls.filter(c=>c.method==='DELETE').length,1);
 assert.throws(()=>op.fetch('/api/videos'),/abort/i);assert.equal(op.active,false);
 const finished=new VideoOperation();finished.finish();finished.cancel();assert.equal(calls.filter(c=>c.method==='DELETE').length,1);
});

test('cancelling preparation terminates the real ffmpeg process promptly',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fittingroom-cancel-'));
 try {
  const source=path.join(dir,'source.mp4');
  execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=blue:s=180x320:r=30:d=20','-c:v','libx264',source]);
  const ffmpeg=loadTs('src/lib/server/ffmpeg.ts',{'./config':{config:{ffmpeg:'ffmpeg',ffprobe:'ffprobe'}}});
  const controller=new AbortController();const started=Date.now();
  const pending=ffmpeg.normalizePortrait(source,path.join(dir,'normalized.mp4'),controller.signal);
  setTimeout(()=>controller.abort(),40);
  await assert.rejects(pending,e=>e.name==='AbortError');assert.ok(Date.now()-started<3000);
 } finally {await fs.rm(dir,{recursive:true,force:true});}
});
