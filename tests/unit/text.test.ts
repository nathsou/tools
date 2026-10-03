import {describe,expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {decodeText,rtfText} from '../../src/lib/text';
import {classify} from '../../src/lib/types';
const rtf=(source:string)=>rtfText(new TextEncoder().encode(source));
describe('readable text formats',()=>{
  test('extracts actual RTF body text without metadata, embedded objects, instructions or markup execution',async()=>{
    const content=rtfText(await readFile('tests/assets/notes.rtf'));
    expect(content).toContain('RTF NOTES\nThis is readable text with café and Ω Unicode.');
    expect(content).toContain('😀 A smile.');expect(content).toContain('Escaped braces: {example} and a backslash: \\.');
    expect(content).toContain('Link label only');expect(content).toContain('<img src=x onerror=alert(1)> shown as literal text.');
    for(const hidden of ['Metadata','Helvetica','red0','HYPERLINK','89504e47','01020304','Hidden destination','\\rtf1'])expect(content).not.toContain(hidden);
  });
  test('honors group-scoped unicode fallback lengths, signed escapes and escaped characters',()=>{
    expect(rtf(String.raw`{\rtf1\uc1\u233? {\uc2\u937\'3f?} \u945? \uc0\u946}`)).toBe('é Ω α β');
    expect(rtf(String.raw`{\rtf1 A\tab B\line C\emdash D\~E\_F\par}`)).toBe('A\tB\nC—D\u00a0E\u2011F\n');
  });
  test('skips byte-counted binary data even when it contains braces and backslashes',()=>{
    expect(rtf(String.raw`{\rtf1 before{\pict\bin5 {\}ab}after}`)).toBe('beforeafter');
    expect(()=>rtf(String.raw`{\rtf1\bin99 short}`)).toThrow('binary');
  });
  test('decodes ANSI code pages and font-specific character sets',()=>{
    expect(rtf(String.raw`{\rtf1\ansi\ansicpg1251 \'cf\'f0\'e8\'e2\'e5\'f2}`)).toBe('Привет');
    expect(rtf(String.raw`{\rtf1\ansi{\fonttbl{\f0\fcharset0 Arial;}{\f1\fcharset204 Other;}}\f1 \'cf\'f0\'e8\'e2\'e5\'f2\f0 caf\'e9}`)).toBe('Приветcafé');
    expect(rtf(String.raw`{\rtf1\ansicpg65001 \'c3\'a9}`)).toBe('é');
    expect(rtf(String.raw`{\rtf1\deff1{\fonttbl{\f1\fcharset204 Font;}}\'cf\'f0\'e8\'e2\'e5\'f2}`)).toBe('Привет');
  });
  test('hides hidden text and supports tables',()=>{
    expect(rtf(String.raw`{\rtf1 visible{\v hidden}\v secret\v0 shown\cell next\row}`)).toBe('visibleshown\tnext\n');
  });
  test('retains multibyte characters across parser buffer boundaries',()=>{
    const prefix='a'.repeat(8191);expect(rtf(String.raw`{\rtf1\ansicpg65001 `+prefix+String.raw`\'c3\'a9}`)).toBe(prefix+'é');
  });
  test('rejects invalid, incomplete, oversized or deeply nested RTF',()=>{
    for(const source of ['plain text',String.raw`{\rtf1 incomplete`,String.raw`{\rtf1 bad\'xx}`,String.raw`{\rtf1}`+'}'])expect(()=>rtf(source)).toThrow();
    expect(()=>rtf(String.raw`{\rtf1`+'{'.repeat(257)+'}'.repeat(258))).toThrow('nesting');
    expect(()=>rtfText(new Uint8Array(2*1024*1024+1))).toThrow('limit');
  });
  test('recognizes HEIC/HEIF, RTF and common textual formats case-insensitively',()=>{
    for(const name of ['Photo.HEIC','Photo.heif'])expect(classify(name).kind).toBe('image');
    expect(classify('Notes.RTF')).toEqual({kind:'text',mime:'application/rtf'});
    for(const name of ['README','Dockerfile','app.tsx','notes.text','settings.conf','Cargo.lock.env','change.patch','.gitignore'])expect(classify(name).kind).toBe('text');
    expect(classify('archive.zip').kind).toBe('file');
  });
  test('decodes UTF-8 and BOM-marked UTF-16 plain text',()=>{
    expect(decodeText(new TextEncoder().encode('café Ω'),'text/plain')).toBe('café Ω');
    expect(decodeText(new Uint8Array([255,254,65,0,169,3]),'text/plain')).toBe('AΩ');
    expect(decodeText(new Uint8Array([254,255,0,65,3,169]),'text/plain')).toBe('AΩ');
  });
});
