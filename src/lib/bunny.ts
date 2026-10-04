import {MP4,QTFF,WEBM,MATROSKA,MP3,WAVE,OGG,ADTS,FLAC,MPEG_TS,CanvasSink,CustomSource,Input} from 'mediabunny';
import type {VaultClient} from './client';
import type {VaultEntry} from './types';
export const LOCAL_FORMATS=[MP4,QTFF,WEBM,MATROSKA,MP3,WAVE,OGG,ADTS,FLAC,MPEG_TS];
export function vaultInput(client:VaultClient,entry:VaultEntry,signal:AbortSignal):Input {
  const abort=()=>input.dispose();
  const input=new Input({formats:LOCAL_FORMATS,source:new CustomSource({getSize:()=>entry.size,maxCacheSize:4*1024*1024,prefetchProfile:'fileSystem',dispose:()=>signal.removeEventListener('abort',abort),read:(start,end)=>new ReadableStream({async pull(controller){try{signal.throwIfAborted();const next=Math.min(end,start+4*1024*1024),bytes=await client.read(entry,start,next);signal.throwIfAborted();controller.enqueue(bytes);start=next;if(start>=end)controller.close();}catch(e){controller.error(e);}}})})});
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)input.dispose();return input;
}
export async function videoThumbnail(client:VaultClient,entry:VaultEntry,signal:AbortSignal):Promise<Blob>{
  const timeout=AbortSignal.timeout(20000),combined=AbortSignal.any([signal,timeout]),input=vaultInput(client,entry,combined);
  try{
    const track=await input.getPrimaryVideoTrack();if(!track||!await track.canDecode())throw new Error('This browser cannot decode this video.');
    const duration=await track.computeDuration(),sink=new CanvasSink(track,{width:480,height:320,fit:'contain',poolSize:1});
    const frame=await sink.getCanvas(Math.min(30,Math.max(3,duration*.2),duration*.5));combined.throwIfAborted();if(!frame)throw new Error('No video frame.');
    const canvas=frame.canvas;try{const blob=canvas instanceof OffscreenCanvas ? await canvas.convertToBlob({type:'image/webp',quality:.8}) : await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/webp',.8));combined.throwIfAborted();if(!blob)throw new Error('No thumbnail.');return blob;}finally{canvas.width=canvas.height=1;}
  }finally{input.dispose();}
}
/** Eight sequential frames keep decoding and plaintext memory bounded. */
export async function videoFrames(client:VaultClient,entry:VaultEntry,signal:AbortSignal,onframe:(time:number,blob:Blob,duration:number)=>void):Promise<void>{
  const combined=AbortSignal.any([signal,AbortSignal.timeout(60000)]),input=vaultInput(client,entry,combined);
  try{
    const track=await input.getPrimaryVideoTrack();if(!track||!await track.canDecode())throw new Error('Unsupported video codec.');
    const duration=await track.computeDuration();if(!Number.isFinite(duration)||duration<=0)throw new Error('Unknown duration.');
    const sink=new CanvasSink(track,{width:160,height:100,fit:'contain',poolSize:1});
    for(let i=0;i<8;i++){
      combined.throwIfAborted();const time=duration*i/8,frame=await sink.getCanvas(time);if(!frame)continue;
      const canvas=frame.canvas;
      try{const blob=canvas instanceof OffscreenCanvas?await canvas.convertToBlob({type:'image/webp',quality:.7}):await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/webp',.7));combined.throwIfAborted();if(blob)onframe(time,blob,duration);}finally{canvas.width=canvas.height=1;}
    }
  }finally{input.dispose();}
}
