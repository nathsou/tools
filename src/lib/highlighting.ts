import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import bash from 'highlight.js/lib/languages/bash';
import markdown from 'highlight.js/lib/languages/markdown';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import ini from 'highlight.js/lib/languages/ini';
import cpp from 'highlight.js/lib/languages/cpp';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
for(const [name,language] of Object.entries({javascript,typescript,json,python,css,xml,bash,markdown,rust,sql,yaml,ini,cpp,java,go}))hljs.registerLanguage(name,language);
const languages:Record<string,string>={js:'javascript',jsx:'javascript',mjs:'javascript',cjs:'javascript',ts:'typescript',tsx:'typescript',json:'json',jsonl:'json',py:'python',css:'css',scss:'css',html:'xml',htm:'xml',xml:'xml',svg:'xml',svelte:'xml',vue:'xml',sh:'bash',bash:'bash',zsh:'bash',md:'markdown',markdown:'markdown',rs:'rust',sql:'sql',yaml:'yaml',yml:'yaml',toml:'ini',ini:'ini',c:'cpp',h:'cpp',cpp:'cpp',hpp:'cpp',java:'java',go:'go'};
export function syntaxLanguage(name:string):string|undefined {return languages[name.toLowerCase().split('.').at(-1)!];}
export const escapeCode=(code:string):string=>code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
/** No auto-detection. Bound work on large drafts; library output escapes source. */
export function highlightCode(code:string,name:string):string {
  const language=syntaxLanguage(name);
  if(!language||code.length>256*1024)return escapeCode(code);
  try{return hljs.highlight(code,{language,ignoreIllegals:true}).value;}catch{return escapeCode(code);}
}
