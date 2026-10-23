export type AgentAsset = { source: string; stillSource: string; rendering: 'mask' | 'color'; imageRendering: 'auto' | 'pixelated' };
/** APNG's default image is frame zero. Hosts choose it when reduced motion is enabled. */
export function stillAgentPng(bytes: Buffer): Buffer {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return bytes;
  const parts = [bytes.subarray(0,8)]; let offset = 8;
  while (offset + 12 <= bytes.length) {
    const end = offset + 12 + bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (end > bytes.length) break;
    if (!['acTL','fcTL','fdAT'].includes(type)) parts.push(bytes.subarray(offset,end));
    offset = end;
    if (type === 'IEND' && end === bytes.length) return Buffer.concat(parts);
  }
  throw new Error('The agent icon is incomplete.');
}

/** Only bounded inline bytes cross into the host. Never fetch the icon URL. */
export function inlineAgentAsset(value: unknown): AgentAsset | null {
  if (!value || typeof value !== 'object') return null;
  const icon = value as Record<string, any>, idle = icon.idle;
  if (!['mask','color'].includes(icon.rendering) || !idle || !['image/png','image/svg+xml'].includes(idle.mime)
    || typeof idle.bytes !== 'string' || !idle.bytes.length || idle.bytes.length > 699052
    || idle.bytes.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(idle.bytes)) return null;
  try {
    const bytes = Buffer.from(idle.bytes, 'base64');
    if (!bytes.length || bytes.length > 524288 || bytes.toString('base64') !== idle.bytes) return null;
    const uri = (data: Buffer) => `data:${idle.mime};base64,${data.toString('base64')}`;
    return { source: uri(bytes), stillSource: uri(idle.mime === 'image/png' ? stillAgentPng(bytes) : bytes),
      rendering: icon.rendering, imageRendering: icon.imageRendering === 'pixelated' ? 'pixelated' : 'auto' };
  } catch { return null; }
}
