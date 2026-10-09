#!/usr/bin/env bun
import {createInterface} from 'node:readline';
import {Writable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {progressReporter} from './lib/progress';
import {convertCryptomatorToUvf} from './lib/convert-vault';

const help = `Convert a Cryptomator format 7/8 vault to a new UVF v1 vault on disk.

Usage: bun run convert:uvf [options] <source-vault> <new-uvf-directory>

  --password-env NAME      Read the source password from this environment variable
  --new-password           Prompt for a different destination password (twice)
  --new-password-env NAME  Read the destination password from this environment variable
  --dry-run                Authenticate and check compatibility without creating files
  --skip-source-scan       Check metadata only; authenticate contents during copying
  --help                   Show this help

By default, both vaults use the source password. Interactive passwords are hidden.
The destination must not exist, its parent must exist, and it must be outside the
source. Pause other writers/sync clients. The source is never modified. Failed or
interrupted copies are retained with an incomplete marker; they cannot be resumed.
`;

function parse(args: string[]) {
  const paths: string[] = [], values = new Map<string, string>();
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!positional && arg === '--') { positional = true; continue; }
    if (!positional && arg.startsWith('-')) {
      if (!['--password-env', '--new-password-env', '--new-password', '--dry-run', '--skip-source-scan', '--help'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
      if (values.has(arg)) throw new Error(`Repeated option: ${arg}`);
      const value = arg.endsWith('-env') ? args[++i] : '';
      if (value === undefined || (arg.endsWith('-env') && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))) throw new Error(`${arg} requires an environment variable name.`);
      values.set(arg, value);
    } else paths.push(arg);
  }
  if (values.has('--help')) return {paths, values};
  if (paths.length !== 2) throw new Error('Provide a source vault and a new destination directory. Use --help for usage.');
  if (values.has('--new-password') && values.has('--new-password-env')) throw new Error('Choose either --new-password or --new-password-env.');
  return {paths, values};
}

function environment(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`Environment variable ${name} is not set.`);
  delete process.env[name];
  return value;
}

async function passwordPrompt(label: string, controller: AbortController): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('A terminal is required to prompt for passwords. Use --password-env (and optionally --new-password-env) for unattended runs.');
  const signal = controller.signal;
  signal.throwIfAborted();
  // readline still handles editing/raw mode, but its output never reaches the terminal.
  const muted = new Writable({write(_chunk, _encoding, done) { done(); }});
  const reader = createInterface({input: process.stdin, output: muted, terminal: true, historySize: 0});
  process.stderr.write(label);
  try {
    return await new Promise<string>((resolve, reject) => {
      const abort = () => reject(new Error('Conversion cancelled.'));
      signal.addEventListener('abort', abort, {once: true});
      reader.once('SIGINT', () => controller.abort());
      reader.once('close', () => reject(new Error('Password input closed.')));
      reader.question('', answer => { signal.removeEventListener('abort', abort); resolve(answer); });
      reader.once('close', () => signal.removeEventListener('abort', abort));
    });
  } finally { reader.close(); muted.destroy(); process.stderr.write('\n'); }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const controller = new AbortController();
  let exitCode = 1;
  const progress = progressReporter(process.stderr);
  const interrupt = () => { exitCode = 130; controller.abort(); };
  const terminate = () => { exitCode = 143; controller.abort(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const {paths, values} = parse(args);
    if (values.has('--help')) { process.stdout.write(help); return; }
    // Read both variables before removing them so a shared variable name also works.
    const sourceEnv = values.get('--password-env'), targetEnv = values.get('--new-password-env');
    const targetPassword = targetEnv === undefined ? undefined : process.env[targetEnv];
    const password = sourceEnv === undefined ? await passwordPrompt('Source password: ', controller) : environment(sourceEnv);
    let destinationPassword: string | undefined;
    if (targetEnv !== undefined) {
      if (targetPassword === undefined) throw new Error(`Environment variable ${targetEnv} is not set.`);
      destinationPassword = targetPassword; delete process.env[targetEnv];
    } else if (values.has('--new-password')) {
      destinationPassword = await passwordPrompt('New UVF password: ', controller);
      if (destinationPassword !== await passwordPrompt('Repeat UVF password: ', controller)) throw new Error('The new passwords do not match.');
    }
    if (destinationPassword === '') throw new Error('The destination password cannot be empty.');
    const skipSourceScan = values.has('--skip-source-scan');
    if (skipSourceScan) process.stderr.write('Skipping the full source scan: contents are authenticated during copying. Source change detection uses size/timestamps; destination verification remains mandatory.\n');
    const result = await convertCryptomatorToUvf({source: paths[0], destination: paths[1], password, destinationPassword, dryRun: values.has('--dry-run'), skipSourceScan, signal: controller.signal, progress: value => progress.update(value)});
    progress.finish();
    process.stdout.write(`${result.dryRun ? skipSourceScan ? 'Metadata check passed; file contents were not scanned. No files created.' : 'Preflight passed; no files created.' : `Verified UVF vault: ${JSON.stringify(result.destination)}`}\n${result.files} files/symlinks, ${result.folders} folders, ${result.bytes} bytes. Source retained unchanged.\n`);
  } catch (error) {
    progress.finish();
    // Escape terminal control characters that might occur in filesystem names.
    const message = (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
    process.stderr.write(`Error: ${message}\n`); process.exitCode = controller.signal.aborted && exitCode === 1 ? 130 : exitCode;
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
