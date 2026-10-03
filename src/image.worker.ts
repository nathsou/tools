/// <reference lib="webworker" />
import factory from 'libheif-js/libheif-wasm/libheif-bundle.mjs';
const MAX_PIXELS=40_000_000;
self.onmessage=async({data}:{data:{bytes:ArrayBuffer;maxDimension:number}})=>{
  const bytes=new Uint8Array(data.bytes);
  try {
    const heif=await factory({print:()=>{},printErr:()=>{}}),decoder=new heif.HeifDecoder();
    const images=decoder.decode(bytes),image=images.find(image=>image.is_primary())??images[0];
    if(!image)throw new Error('This HEIC/HEIF image is damaged or uses an unsupported codec.');
    try {
      const width=image.get_width(),height=image.get_height();
      if(width<1||height<1||width*height>MAX_PIXELS)throw new Error('Image exceeds the 40 megapixel preview limit.');
      const pixels=new ImageData(width,height);
      await new Promise<void>((resolve,reject)=>image.display(pixels,result=>result?resolve():reject(new Error('Unable to decode this HEIC/HEIF image.'))));
      const full=new OffscreenCanvas(width,height);full.getContext('2d')!.putImageData(pixels,0,0);
      const ratio=Math.min(1,data.maxDimension/Math.max(width,height)),canvas=new OffscreenCanvas(Math.max(1,Math.round(width*ratio)),Math.max(1,Math.round(height*ratio)));
      canvas.getContext('2d')!.drawImage(full,0,0,canvas.width,canvas.height);pixels.data.fill(0);full.width=full.height=1;
      const blob=await canvas.convertToBlob({type:'image/webp',quality:0.92});canvas.width=canvas.height=1;
      self.postMessage({blob});
    }finally{for(const image of images)image.free();}
  }catch(e){self.postMessage({error:e instanceof Error?e.message:'Unable to decode this HEIC/HEIF image.'});}
  finally{bytes.fill(0);}
};
