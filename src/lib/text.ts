/** Plain-text extraction only: never creates HTML or opens embedded RTF objects. */
const destinations=new Set(['fonttbl','colortbl','stylesheet','info','pict','object','objdata','filetbl','revtbl','rsidtbl','listtable','listoverridetable','datastore','themedata','colorschememapping','generator','xmlopen','xmlclose','fldinst','header','headerl','headerr','footer','footerl','footerr','annotation']);
const charsetPages:Record<number,number>={0:1252,128:932,129:949,134:936,136:950,161:1253,162:1254,163:1258,177:1255,178:1256,186:1257,204:1251,222:874,238:1250};
const pageLabels:Record<number,string>={932:'shift_jis',936:'gbk',949:'euc-kr',950:'big5',874:'windows-874',65001:'utf-8',10000:'macintosh',437:'ibm437'};
interface State {skip:boolean;fontTable:boolean;hidden:boolean;uc:number;page:number;font:number;starred:boolean;}
export function rtfText(bytes:Uint8Array):string {
  if(bytes.length>2*1024*1024)throw new Error('RTF preview exceeds the 2 MB limit.');
  let source='';for(let i=0;i<bytes.length;i+=8192)source+=String.fromCharCode(...bytes.subarray(i,i+8192));
  if(!/^\s*\{\\rtf\d/.test(source))throw new Error('This file is not a valid RTF document.');
  let state:State={skip:false,fontTable:false,hidden:false,uc:1,page:1252,font:0,starred:false},fallback=0,defaultFont=0;
  const stack:State[]=[],fonts=new Map<number,number>(),output:string[]=[],run:number[]=[];
  const decoder=(page:number)=>{try{return new TextDecoder(pageLabels[page]??`windows-${page}`);}catch{return new TextDecoder('windows-1252');}};
  let current=decoder(1252);
  const flush=(stream=false)=>{if(run.length||!stream){output.push(current.decode(new Uint8Array(run),{stream}));run.length=0;}};
  const changePage=()=>{flush();current=decoder(fonts.get(state.font)??state.page);};
  const emit=(value:string)=>{if(fallback){fallback--;return;}if(!state.skip&&!state.hidden){flush();output.push(value);}};
  const byte=(value:number)=>{if(fallback){fallback--;return;}if(!state.skip&&!state.hidden){run.push(value);if(run.length>=8192)flush(true);}};
  for(let i=0;i<source.length;) {
    const char=source[i++];
    if(char==='{'){flush();if(stack.length>=256)throw new Error('RTF nesting is too deep.');stack.push({...state});fallback=0;continue;}
    if(char==='}'){flush();if(!stack.length)throw new Error('Invalid RTF groups.');state=stack.pop()!;changePage();fallback=0;continue;}
    if(char==='\r'||char==='\n')continue;
    if(char!=='\\'){byte(char.charCodeAt(0));continue;}
    const symbol=source[i++];if(!symbol)break;
    if(symbol==="'") {
      const hex=source.slice(i,i+2);if(!/^[\da-f]{2}$/i.test(hex))throw new Error('Invalid RTF character escape.');i+=2;byte(parseInt(hex,16));continue;
    }
    if(!/[a-z]/i.test(symbol)) {
      if(symbol==='*')state.starred=true;
      else if(symbol==='\\'||symbol==='{'||symbol==='}')byte(symbol.charCodeAt(0));
      else if(symbol==='~')emit('\u00a0');else if(symbol==='-')emit('\u00ad');else if(symbol==='_')emit('\u2011');
      continue;
    }
    let word=symbol;while(i<source.length&&/[a-z]/i.test(source[i]))word+=source[i++];
    let value='';if(source[i]==='-'||/[\d]/.test(source[i]??'')){value+=source[i++];while(/[\d]/.test(source[i]??''))value+=source[i++];}
    const n=value?Number(value):undefined;if(source[i]===' ')i++;
    if(word==='bin'){if(n===undefined||!Number.isSafeInteger(n)||n<0||i+n>source.length)throw new Error('Invalid RTF binary data.');i+=n;continue;}
    if(destinations.has(word)||state.starred){flush();state.skip=true;if(word==='fonttbl')state.fontTable=true;state.starred=false;}
    if(word==='ansicpg'&&n!==undefined){state.page=n;changePage();}
    else if(word==='deff'&&n!==undefined){defaultFont=n;state.font=n;changePage();}
    else if(word==='plain'){state.hidden=false;state.font=defaultFont;changePage();}
    else if(word==='f'&&n!==undefined){state.font=n;changePage();}
    else if(word==='fcharset'&&n!==undefined&&state.fontTable){fonts.set(state.font,n===0?state.page:charsetPages[n]??state.page);}
    else if(word==='cpg'&&n!==undefined&&state.fontTable){fonts.set(state.font,n);}
    else if(word==='uc'&&n!==undefined)state.uc=Math.max(0,Math.min(n,32));
    else if(word==='u'&&n!==undefined){fallback=0;emit(String.fromCharCode(n&0xffff));fallback=state.uc;}
    else if(word==='v'){flush();state.hidden=n!==0;}
    else if(word==='par'||word==='line'||word==='row')emit('\n');
    else if(word==='tab'||word==='cell')emit('\t');
    else if(word==='emdash')emit('—');else if(word==='endash')emit('–');else if(word==='bullet')emit('•');
    else if(word==='lquote')emit('‘');else if(word==='rquote')emit('’');else if(word==='ldblquote')emit('“');else if(word==='rdblquote')emit('”');
  }
  flush();if(stack.length)throw new Error('RTF document is incomplete. Export it to open the full document.');
  return output.join('').replace(/\r\n?/g,'\n');
}
export function decodeText(bytes:Uint8Array,mime:string):string {
  if(mime==='application/rtf')return rtfText(bytes);
  if(bytes[0]===0xff&&bytes[1]===0xfe)return new TextDecoder('utf-16le').decode(bytes);
  if(bytes[0]===0xfe&&bytes[1]===0xff)return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder().decode(bytes);
}
