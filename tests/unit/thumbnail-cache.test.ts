import { expect,test } from 'bun:test';
import { ThumbnailCache } from '../../src/lib/thumbnail-cache';

test('thumbnail cache evicts least recently used blobs within its byte and entry bounds',()=>{
  const cache=new ThumbnailCache(6,2),blob=new Blob(['abc']);
  cache.put('a',blob);cache.put('b',blob);expect(cache.get('a')).toBe(blob);
  cache.put('c',blob);expect(cache.get('b')).toBeUndefined();expect(cache.get('a')).toBe(blob);
  cache.put('d',new Blob(['12345']));expect(cache.get('a')).toBeUndefined();expect(cache.get('c')).toBeUndefined();
  expect(cache.get('d')?.size).toBe(5);cache.clear();
});
test('replacing cached thumbnails accounts for size and oversized blobs are not retained',()=>{
  const cache=new ThumbnailCache(5,5);
  cache.put('a',new Blob(['1234']));cache.put('a',new Blob(['1']));cache.put('b',new Blob(['1234']));
  expect(cache.get('a')?.size).toBe(1);expect(cache.get('b')?.size).toBe(4);
  cache.put('b',new Blob(['123456']));expect(cache.get('b')).toBeUndefined();expect(cache.get('a')).toBeDefined();cache.clear();
});
test('eviction retains displayed thumbnail URLs, while lock clears every URL and blob',async()=>{
  const cache=new ThumbnailCache(3,1),blob=new Blob(['abc']);cache.put('a',blob);
  const url=cache.createURL(blob);cache.put('b',new Blob(['def']));
  expect(cache.get('a')).toBeUndefined();expect(await(await fetch(url)).text()).toBe('abc');
  cache.clear();expect(cache.get('b')).toBeUndefined();expect(cache.controller.signal.aborted).toBe(true);
  await expect(fetch(url)).rejects.toThrow();
  expect(()=>cache.createURL(blob)).toThrow();expect(()=>cache.put('c',blob)).toThrow();cache.clear();
});
test('releasing a thumbnail revokes its URL without dropping its cached blob',async()=>{
  const cache=new ThumbnailCache(),blob=new Blob(['abc']);cache.put('a',blob);
  const url=cache.createURL(blob);cache.releaseURL(url);
  await expect(fetch(url)).rejects.toThrow();expect(cache.get('a')).toBe(blob);cache.clear();
});

test('deleting entries invalidates matching blobs and restores cache capacity',()=>{
  const cache=new ThumbnailCache(8,2);cache.put('deleted',new Blob(['1234']));cache.put('kept',new Blob(['5678']));cache.invalidate(key=>key==='deleted');expect(cache.get('deleted')).toBeUndefined();cache.put('new',new Blob(['abcd']));expect(cache.get('kept')).toBeDefined();expect(cache.get('new')).toBeDefined();cache.clear();
});
