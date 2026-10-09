import {afterEach, describe, expect, test} from 'bun:test';
import {createDecipheriv, createHash, pbkdf2Sync} from 'node:crypto';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {type Scheme} from '../../scripts/generate-fixtures';
import {decryptUvfReference} from '../../scripts/reference-uvf';
import {convertCryptomatorToUvf as convert} from '../../scripts/lib/convert-vault';
import {DiskStorage} from '../../scripts/lib/disk-vault';
import {Vault} from '../../src/lib/vault';
import {MIGRATION_MARKER} from '../../src/lib/filesystem';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, {recursive: true, force: true}))); });
const password = 'crypte-demo';
async function fixture(scheme: Scheme = 'SIV_GCM', legacy = false, long = false, large = false) {
  const root = await mkdtemp(join(tmpdir(), 'crypte-convert-')); temporary.push(root);
  const source = join(root, 'source'), destination = join(root, 'converted');
  const extras = [{name: 'a'.repeat(150), bytes: Buffer.from('A supported shortened name')}, {name: 'café.txt', bytes: Buffer.from('Unicode content 🌍')}, {name: 'Exact.bin', bytes: Buffer.alloc(32740, 4)}];
  const generated = spawnSync('node', ['--input-type=module', '-e', `
    import {makeVault} from './scripts/generate-fixtures.ts';
    import {writeFileSync} from 'node:fs';
    const [scheme, legacy, large, extras] = JSON.parse(process.argv[1]);
    const files = makeVault(scheme, legacy, large ? Buffer.alloc(4 * 1024 * 1024 + 73, 17) : undefined, extras.map(e => ({name:e.name, bytes:Buffer.from(e.bytes)})));
    writeFileSync(1, JSON.stringify([...files].map(([path, bytes]) => [path, bytes.toString('base64')])));
  `, JSON.stringify([scheme, legacy, large, extras.map(e => ({name:e.name, bytes:[...e.bytes]}))])], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  if (generated.status !== 0) throw new Error(generated.stderr);
  const files = new Map<string, Buffer>(JSON.parse(generated.stdout).map(([path, bytes]: string[]) => [path, Buffer.from(bytes, 'base64')]));
  if (!long) for (const [path, bytes] of [...files]) if (path.endsWith('/name.c9s') && bytes.length > 260) {
    const prefix = path.slice(0, -'name.c9s'.length);
    for (const key of files.keys()) if (key.startsWith(prefix)) files.delete(key);
  }
  for (const [path, bytes] of files) { await mkdir(dirname(join(source, path)), {recursive: true}); await writeFile(join(source, path), bytes); }
  return {root, source, destination, files};
}
async function opened(path: string, pass = password, incomplete = false) {
  const vault = new Vault(await DiskStorage.at(path)); await vault.prepare(incomplete); await vault.unlock(pass); return vault;
}
async function contents(path: string, pass = password) {
  const vault = await opened(path, pass);
  try {
    const inventory = await vault.migrationInventory('uvf'); expect(inventory.issues).toEqual([]);
    const items = [];
    for (const item of inventory.items) items.push({path: item.path, kind: item.entry.kind, bytes: item.entry.kind === 'folder' ? null : Buffer.from(await vault.read(item.entry.id, 0, item.entry.size)).toString('base64')});
    return items.sort((a, b) => a.path.localeCompare(b.path));
  } finally { vault.lock(); }
}
async function fingerprint(path: string) {
  const hash = createHash('sha256');
  async function walk(relative = '') { for (const entry of (await readdir(join(path, relative), {withFileTypes: true})).sort((a,b) => a.name.localeCompare(b.name))) {
    const name = join(relative, entry.name); hash.update(name);
    if (entry.isDirectory()) await walk(name); else hash.update(await readFile(join(path, name)));
  } }
  await walk(); return hash.digest('hex');
}
async function oracle(path: string, pass: string) {
  const meta = JSON.parse(await readFile(join(path, 'vault.uvf'), 'utf8')), recipient = meta.recipients[0], h = recipient.header;
  const decode = (s: string) => Buffer.from(s, 'base64url');
  const kek = pbkdf2Sync(pass, Buffer.concat([Buffer.from(h.alg), Buffer.alloc(1), decode(h.p2s)]), h.p2c, 32, 'sha512');
  const unwrapped = spawnSync('node', ['-e', `
    const {createDecipheriv} = require('node:crypto');
    const d = createDecipheriv('id-aes256-wrap', Buffer.from(process.argv[1], 'hex'), Buffer.alloc(8, 0xa6));
    require('node:fs').writeFileSync(1, Buffer.concat([d.update(Buffer.from(process.argv[2], 'base64url')), d.final()]).toString('hex'));
  `, kek.toString('hex'), recipient.encrypted_key], {encoding: 'utf8'});
  if (unwrapped.status !== 0) throw new Error(unwrapped.stderr);
  const cek = Buffer.from(unwrapped.stdout, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', cek, decode(meta.iv)); decipher.setAAD(Buffer.from(meta.protected)); decipher.setAuthTag(decode(meta.tag));
  const payload = JSON.parse(Buffer.concat([decipher.update(decode(meta.ciphertext)), decipher.final()]).toString());
  // The reference decoder indexes by the numeric four-byte seed ID. A sparse object
  // supports random generated IDs without allocating a multi-billion-element array.
  const seeds: Record<number, Buffer> = {};
  for (const [id, value] of Object.entries(payload.seeds)) seeds[decode(id).readUInt32BE()] = decode(value as string);
  return (bytes: Buffer) => decryptUvfReference(bytes, seeds as unknown as Buffer[], decode(payload.kdfSalt));
}

describe('on-disk Cryptomator to UVF conversion', () => {
  for (const [scheme, legacy] of [['SIV_GCM', false], ['SIV_CTRMAC', false], ['SIV_CTRMAC', true]] as const) {
    test(`verified ${scheme}, format ${legacy ? 7 : 8}, with independent output decoding`, async () => {
      const f = await fixture(scheme, legacy, false, !legacy && scheme === 'SIV_GCM'), before = await fingerprint(f.source);
      const expected = await contents(f.source), pass = 'new destination password';
      const result = await convert({...f, password, destinationPassword: pass});
      expect(result.dryRun).toBe(false); expect(result.files).toBeGreaterThan(10);
      expect(await contents(f.destination, pass)).toEqual(expected);
      expect(await fingerprint(f.source)).toBe(before);
      await expect(readFile(join(f.destination, MIGRATION_MARKER))).rejects.toThrow();
      const destination = await opened(f.destination, pass), decode = await oracle(f.destination, pass);
      try {
        const inventory = await destination.migrationInventory('uvf');
        for (const item of inventory.items.filter(i => i.entry.kind !== 'folder')) {
          const payload = item.entry.path;
          const decoded = decode(await readFile(join(f.destination, payload)));
          expect(decoded.toString('base64')).toBe(expected.find(i => i.path === item.path)!.bytes);
        }
      } finally { destination.lock(); }
    }, 30000);
  }
  test('dry run authenticates the source and creates nothing', async () => {
    const f = await fixture(); expect((await convert({...f, password, dryRun: true})).dryRun).toBe(true);
    expect(await readdir(f.root)).toEqual(['source']);
  });
  test('wrong passwords and unsupported names fail before output creation', async () => {
    const f = await fixture(); await expect(convert({...f, password: 'wrong'})).rejects.toThrow();
    const long = await fixture('SIV_GCM', false, true); await expect(convert({...long, password})).rejects.toThrow('Source preflight');
    expect(await readdir(f.root)).toEqual(['source']); expect(await readdir(long.root)).toEqual(['source']);
  });
  test('corrupt source data fails before creating output', async () => {
    const f = await fixture(), path = [...f.files.keys()].find(p => p.endsWith('contents.c9r'))!, bytes = Buffer.from(f.files.get(path)!); bytes[bytes.length - 1] ^= 1;
    await writeFile(join(f.source, path), bytes);
    await expect(convert({...f, password})).rejects.toThrow('Source preflight'); expect(await readdir(f.root)).toEqual(['source']);
  });
  test('refuses existing destinations, nested destinations and native symlinks', async () => {
    const f = await fixture(); await mkdir(f.destination); await writeFile(join(f.destination, 'keep'), 'keep');
    await expect(convert({...f, password})).rejects.toThrow('already exists'); expect(await readFile(join(f.destination, 'keep'), 'utf8')).toBe('keep');
    await expect(convert({...f, destination: join(f.source, 'nested'), password})).rejects.toThrow('non-nested');
    await symlink(f.source, join(f.root, 'alias'));
    await expect(convert({...f, destination: join(f.root, 'alias', 'nested'), password})).rejects.toThrow('non-nested');
    const vault = await opened(f.source), entry = (await vault.list('')).entries.find(e => e.kind === 'file')!; vault.lock();
    await rm(join(f.source, entry.path)); await symlink(join(f.destination, 'keep'), join(f.source, entry.path));
    await expect(convert({...f, destination: join(f.root, 'new'), password})).rejects.toThrow('symlink');
  });
  test('cancellation retains marked ciphertext and an unchanged source', async () => {
    const f = await fixture(), before = await fingerprint(f.source), controller = new AbortController();
    await expect(convert({...f, password, signal: controller.signal, progress(value) { if (value.stage === 'copying' && value.bytes! > 0) controller.abort(); }})).rejects.toThrow('cancelled');
    expect(await readFile(join(f.destination, MIGRATION_MARKER), 'utf8')).toContain('Incomplete');
    const pending = new Vault(await DiskStorage.at(f.destination)); await expect(pending.prepare()).rejects.toThrow('incomplete migration');
    expect(await fingerprint(f.source)).toBe(before);
  }, 15000);
  test('source changes during copying cannot produce a finished vault', async () => {
    const f = await fixture(); let changed = false;
    await expect(convert({...f, password, async progress(value) {
      if (value.stage === 'verifying' && !changed) {
        changed = true; const path = [...f.files.keys()].find(p => p.endsWith('contents.c9r'))!, bytes = Buffer.from(f.files.get(path)!); bytes[bytes.length - 1] ^= 1;
        await writeFile(join(f.source, path), bytes);
      }
    }})).rejects.toThrow();
    expect(await readFile(join(f.destination, MIGRATION_MARKER), 'utf8')).toContain('Incomplete');
  }, 15000);
  test('destination corruption fails verification and retains its marker', async () => {
    const f = await fixture(); let changed = false;
    await expect(convert({...f, password, async progress(value) {
      if (value.stage === 'verifying' && !changed) {
        changed = true; const vault = await opened(f.destination, password, true), entry = (await vault.list('')).entries.find(e => e.kind === 'file' && e.size > 0)!; vault.lock();
        const path = join(f.destination, entry.path), bytes = await readFile(path); bytes[bytes.length - 1] ^= 1; await writeFile(path, bytes);
      }
    }})).rejects.toThrow('Destination verification');
    expect(await readFile(join(f.destination, MIGRATION_MARKER), 'utf8')).toContain('Incomplete');
  }, 15000);
  test('Bun CLI accepts environment passwords without printing them', async () => {
    const f = await fixture();
    const run = (args: string[], env = {}) => spawnSync(process.execPath, ['scripts/cryptomator-to-uvf.ts', ...args], {encoding: 'utf8', env: {...process.env, ...env}});
    const help = run(['--help']); expect(help.status).toBe(0); expect(help.stdout).toContain('Usage:');
    const missing = run(['--password-env', 'CRYPTE_UNSET_TEST_PASSWORD', f.source, f.destination]); expect(missing.status).toBe(1); expect(missing.stderr).toContain('not set');
    const noTerminal = run([f.source, f.destination]); expect(noTerminal.status).toBe(1); expect(noTerminal.stderr).toContain('terminal');
    const result = run(['--password-env', 'CRYPTE_TEST_PASSWORD', '--new-password-env', 'CRYPTE_TEST_NEW_PASSWORD', f.source, f.destination], {CRYPTE_TEST_PASSWORD: password, CRYPTE_TEST_NEW_PASSWORD: 'another secret'});
    expect(result.status).toBe(0); expect(result.stdout).toContain('Verified UVF vault');
    expect(result.stdout + result.stderr).not.toContain(password); expect(result.stdout + result.stderr).not.toContain('another secret');
    expect(await contents(f.destination, 'another secret')).toEqual(await contents(f.source));
  }, 15000);
});
