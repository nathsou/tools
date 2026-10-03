import { expect,test } from 'bun:test';
import { parseRange } from '../../src/lib/ranges';
for(const [header,size,expected] of [
  [null,100,{start:0,end:100}],['bytes=0-9',100,{start:0,end:10}],['bytes=20-',100,{start:20,end:100}],['bytes=-10',100,{start:90,end:100}],['bytes=-999',100,{start:0,end:100}],['bytes=95-999',100,{start:95,end:100}],
  ['bytes=100-',100,null],['bytes=10-5',100,null],['bytes=0-0',0,null],['bytes=-0',100,null],['bytes=0-1,4-5',100,null],['bytes=9007199254740992-',100,null],['bytes=-',100,null],[null,0,{start:0,end:0}]
] as const)test(`Range ${header} / ${size}`,()=>expect(parseRange(header,size)).toEqual(expected));
