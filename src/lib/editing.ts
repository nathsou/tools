export const TEXT_EDIT_LIMIT=2*1024*1024;
export interface TextFormat {encoding:'utf-8'|'utf-16le'|'utf-16be';bom:boolean;newline:'\n'|'\r\n'|'\r';}
export function editableText(bytes:Uint8Array):{text:string;format:TextFormat} {
  if(bytes.length>TEXT_EDIT_LIMIT)throw new Error('Text editing is limited to 2 MiB.');
  const encoding=bytes[0]===0xff&&bytes[1]===0xfe?'utf-16le':bytes[0]===0xfe&&bytes[1]===0xff?'utf-16be':'utf-8';
  const bom=encoding!=='utf-8'||bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf;
  let text:string;
  try{text=new TextDecoder(encoding,{fatal:true}).decode(bytes);}catch{throw new Error('This text encoding cannot be edited safely. UTF-8 and BOM-marked UTF-16 are supported.');}
  if(text.includes('\0'))throw new Error('This file contains binary data and cannot be edited as text.');
  const endings=text.match(/\r\n|\r|\n/g)??[],counts=new Map<string,number>();
  for(const ending of endings)counts.set(ending,(counts.get(ending)??0)+1);
  const newline=[...counts].sort((a,b)=>b[1]-a[1])[0]?.[0] as TextFormat['newline']|undefined;
  return {text:text.replace(/\r\n?/g,'\n'),format:{encoding,bom,newline:newline??'\n'}};
}
export function encodeEdit(text:string,format:TextFormat):Uint8Array<ArrayBuffer> {
  if(text.length>TEXT_EDIT_LIMIT)throw new Error('The edited file exceeds the 2 MiB limit.');
  if(text.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text))throw new Error('The text contains invalid Unicode or binary data.');
  text=text.replace(/\r\n?/g,'\n').replace(/\n/g,format.newline);
  let bytes:Uint8Array<ArrayBuffer>;
  if(format.encoding==='utf-8'){
    const body=new TextEncoder().encode(text);bytes=new Uint8Array(body.length+(format.bom?3:0));
    if(format.bom)bytes.set([0xef,0xbb,0xbf]);bytes.set(body,format.bom?3:0);body.fill(0);
  }else{
    bytes=new Uint8Array(text.length*2+2);const view=new DataView(bytes.buffer),little=format.encoding==='utf-16le';
    view.setUint16(0,0xfeff,little);for(let i=0;i<text.length;i++)view.setUint16(2+i*2,text.charCodeAt(i),little);
  }
  if(bytes.length>TEXT_EDIT_LIMIT){bytes.fill(0);throw new Error('The edited file exceeds the 2 MiB limit.');}
  return bytes;
}
