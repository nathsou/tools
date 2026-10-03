import {CanvasSink,Conversion,CustomSource,Input,Mp4OutputFormat,Output,Quality,StreamTarget,WebMOutputFormat} from 'mediabunny';
import {sha256} from '@noble/hashes/sha2.js';
import {vaultInput,LOCAL_FORMATS} from './bunny';
import type {VaultClient} from './client';
import {formatSize,type VaultEntry,type FileStamp} from './types';
import {EncryptedSpool} from './private-cache';
import {readBlob} from './previews';
import {imagePreview,nativeImage} from './images';
import {safePath} from './filesystem';
export type ConversionFormat='webm'|'mp4'|'webp'|'jpeg'|'png';
export interface ConvertSettings {format:ConversionFormat;height:number;videoBitrate:number;audioBitrate:number;quality:number;}
export interface MediaDetails {duration:number;videoTracks:number;audioTracks:number;width:number;height:number;}
export interface ConvertedMedia {spool:EncryptedSpool;name:string;mime:string;details?:MediaDetails;}
export const defaultSettings=(entry:VaultEntry):ConvertSettings=>({format:entry.kind==='image'?'webp':'webm',height:entry.kind==='image'?0:720,videoBitrate:2_000_000,audioBitrate:128_000,quality:.82});
export function estimatedSize(details:MediaDetails,settings:ConvertSettings):number {return Math.ceil(details.duration*(details.videoTracks*settings.videoBitrate+details.audioTracks*settings.audioBitrate)/8*1.04);}
export function reduction(original:number,converted:number):string {const percent=original ? (1-converted/original)*100:0;return `${formatSize(converted)} · ${Math.abs(percent).toFixed(0)}% ${percent>=0?'smaller':'larger'}`;}
export async function mediaDetails(input:Input):Promise<MediaDetails>{const video=await input.getVideoTracks(),audio=await input.getAudioTracks(),track=video[0];return {duration:await input.computeDuration(),videoTracks:video.length,audioTracks:audio.length,width:track?.displayWidth??0,height:track?.displayHeight??0};}
export async function inspectMedia(client:VaultClient,entry:VaultEntry,signal:AbortSignal){const input=vaultInput(client,entry,signal);try{const details=await mediaDetails(input);if(!Number.isFinite(details.duration)||details.duration<=0)throw new Error('Unable to determine this media’s duration.');return details;}finally{input.dispose();}}
export async function convertImage(client:VaultClient,entry:VaultEntry,settings:ConvertSettings,signal:AbortSignal):Promise<Blob>{
  const native=await nativeImage(await imagePreview(await readBlob(client,entry,64*1024*1024,signal),entry,signal),signal),canvas=document.createElement('canvas');
  const ratio=settings.height?Math.min(1,settings.height/native.height):1;canvas.width=Math.max(1,Math.round(native.width*ratio));canvas.height=Math.max(1,Math.round(native.height*ratio));
  const mime=`image/${settings.format}`;
  try{canvas.getContext('2d')!.drawImage(native.image,0,0,canvas.width,canvas.height);const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,mime,settings.quality));signal.throwIfAborted();if(!blob||blob.type!==mime)throw new Error('This browser cannot encode that image format.');return blob;}
  finally{native.close();canvas.width=canvas.height=1;}
}
export function spoolInput(spool:EncryptedSpool):Input{return new Input({formats:LOCAL_FORMATS,source:new CustomSource({getSize:()=>spool.size,maxCacheSize:4*1024*1024,read:(start,end)=>new ReadableStream({async pull(controller){try{const next=Math.min(end,start+4*1024*1024);controller.enqueue(await spool.read(start,next));start=next;if(start===end)controller.close();}catch(e){controller.error(e);}}})})});}
export async function convertMedia(client:VaultClient,entry:VaultEntry,settings:ConvertSettings,signal:AbortSignal,progress:(fraction:number)=>void,image?:Blob):Promise<ConvertedMedia>{
  const spool=new EncryptedSpool(client,signal);await spool.init();let input:Input|undefined,conversion:Conversion|undefined;const abort=()=>{void conversion?.cancel().catch(()=>{});input?.dispose();};signal.addEventListener('abort',abort,{once:true});
  try{
    let mime:string,details:MediaDetails|undefined;
    if(entry.kind==='image'){
      const blob=image??await convertImage(client,entry,settings,signal);mime=blob.type;await spool.write(new Uint8Array(await blob.arrayBuffer()),0);progress(1);
    }else{
      input=vaultInput(client,entry,signal);const original=await mediaDetails(input),target=new StreamTarget(new WritableStream({write:chunk=>spool.write(chunk.data,chunk.position)}),{chunked:true,chunkSize:1024*1024});
      const webm=settings.format==='webm',output=new Output({target,format:webm?new WebMOutputFormat():new Mp4OutputFormat({fastStart:'fragmented'})});
      conversion=await Conversion.init({input,output,tracks:'all',copy:false,showWarnings:false,
        video:track=>({codec:webm?'vp9':'avc',height:settings.height?Math.min(settings.height,track.displayHeight):undefined,quality:new Quality({bitrate:settings.videoBitrate}),hardwareAcceleration:'no-preference'}),
        audio:{codec:webm?'opus':'aac',quality:new Quality({bitrate:settings.audioBitrate})}});
      signal.throwIfAborted();if(!conversion.isValid||conversion.discardedTracks.length)throw new Error('This browser cannot convert every track to this format. Try another format; the original is kept.');
      conversion.onProgress=progress;await conversion.execute();signal.throwIfAborted();
      const check=spoolInput(spool);try{details=await mediaDetails(check);if(details.videoTracks!==original.videoTracks||details.audioTracks!==original.audioTracks||Math.abs(details.duration-original.duration)>Math.max(.5,original.duration*.02))throw new Error('The converted tracks or duration could not be verified. The original is kept.');
        if(details.videoTracks){const track=await check.getPrimaryVideoTrack();if(!track)throw new Error('Missing converted video track.');const frame=await new CanvasSink(track,{width:64,height:64,fit:'contain'}).getCanvas(Math.min(1,details.duration/2));if(!frame)throw new Error('The converted video cannot be previewed.');frame.canvas.width=frame.canvas.height=1;}
      }finally{check.dispose();}
      mime=entry.kind==='audio'?(webm?'audio/webm':'audio/mp4'):(webm?'video/webm':'video/mp4');
    }
    signal.throwIfAborted();const extension=entry.kind==='audio'?(settings.format==='webm'?'weba':'m4a'):(settings.format==='jpeg'?'jpg':settings.format);
    return {spool,name:entry.name.replace(/\.[^.]+$/,'')+` (converted).${extension}`,mime,details};
  }catch(e){await conversion?.cancel().catch(()=>{});await spool.dispose();throw e;}finally{signal.removeEventListener('abort',abort);input?.dispose();}
}
export async function sourceStamp(root:FileSystemDirectoryHandle,entry:VaultEntry,signal:AbortSignal):Promise<FileStamp&{digest:string}>{
  const parts=safePath(entry.path);let directory=root;for(const part of parts.slice(0,-1))directory=await directory.getDirectoryHandle(part);const file=await(await directory.getFileHandle(parts.at(-1)!)).getFile(),hash=sha256.create();
  try{if(file.lastModified!==entry.modified)throw new Error('The original changed. Refresh the folder before converting it.');for(let offset=0;offset<file.size;offset+=4*1024*1024){signal.throwIfAborted();hash.update(new Uint8Array(await file.slice(offset,offset+4*1024*1024).arrayBuffer()));}return {path:entry.path,size:file.size,modified:file.lastModified,digest:Array.from(hash.digest(),byte=>byte.toString(16).padStart(2,'0')).join('')};}finally{hash.destroy();}
}
