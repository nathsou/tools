export type ByteRange = { start:number; end:number };
/** End is exclusive. Only one byte range is supported; invalid/multiple ranges return null (416). */
export function parseRange(header:string|null,size:number):ByteRange|null {
  if (!Number.isSafeInteger(size) || size < 0) return null;
  if (header === null) return { start:0, end:size };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isSafeInteger(suffix) && suffix > 0 ? { start:Math.max(0,size-suffix), end:size } : null;
  }
  const start = Number(match[1]), last = match[2] ? Number(match[2]) : size-1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(last) || start >= size || start > last) return null;
  return { start, end:Math.min(last+1,size) };
}
