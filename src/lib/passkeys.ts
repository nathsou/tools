import { fromBase64, random, toBase64, toBase64Url, type Bytes } from './bytes';
import type { PasskeyRecord, VaultInfo } from './types';
interface PRFInput { prf:{ eval:{ first:Bytes } }; }
interface PRFOutput { prf?:{ enabled?:boolean; results?:{ first:ArrayBuffer } }; }
function extensionResult(credential:PublicKeyCredential):Bytes|undefined {
  const result = (credential.getClientExtensionResults() as PRFOutput).prf?.results?.first;
  return result ? new Uint8Array(result) : undefined;
}
function verifyClient(credential:PublicKeyCredential,challenge:Bytes,type:'webauthn.create'|'webauthn.get'):void {
  const response = credential.response;
  const client = JSON.parse(new TextDecoder().decode(response.clientDataJSON));
  if (client.type !== type || client.origin !== location.origin || client.crossOrigin === true || client.challenge !== toBase64Url(challenge)) throw new Error('Passkey response did not match this unlock request.');
  if (response instanceof AuthenticatorAssertionResponse) {
    const data = new Uint8Array(response.authenticatorData);
    if (data.length < 37 || !(data[32] & 1) || !(data[32] & 4)) throw new Error('The authenticator must verify you to unlock the vault.');
  }
}
export async function passkeysAvailable():Promise<boolean> {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) return false;
  try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch { return false; }
}
async function evaluate(credentialId:Bytes,salt:Bytes,signal?:AbortSignal):Promise<Bytes> {
  const challenge = random(32);
  const credential = await navigator.credentials.get({
    publicKey:{ challenge, rpId:location.hostname, allowCredentials:[{ type:'public-key', id:credentialId }], userVerification:'required', timeout:60000, extensions:{ prf:{ eval:{ first:salt } } } as PRFInput }, signal
  }) as PublicKeyCredential|null;
  if (!credential) throw new Error('Passkey unlock was cancelled.');
  if (toBase64Url(new Uint8Array(credential.rawId)) !== toBase64Url(credentialId)) throw new Error('The selected passkey does not match this vault.');
  verifyClient(credential,challenge,'webauthn.get');
  const output = extensionResult(credential);
  if (!output || output.length !== 32) throw new Error('This browser or passkey does not support secure vault unlock (WebAuthn PRF). Use the vault password.');
  return output;
}
export async function registerPasskey(info:VaultInfo,signal?:AbortSignal):Promise<{ prf:Bytes; record:Omit<PasskeyRecord,'iv'|'ciphertext'> }> {
  const salt = random(32), challenge = random(32);
  const credential = await navigator.credentials.create({ publicKey:{
    challenge,
    rp:{ name:'Crypte', id:location.hostname },
    user:{ id:random(32), name:`${info.name} · ${info.id.slice(0,8)}`, displayName:info.name },
    pubKeyCredParams:[{ type:'public-key', alg:-7 },{ type:'public-key', alg:-257 }],
    authenticatorSelection:{ authenticatorAttachment:'platform', residentKey:'required', userVerification:'required' },
    attestation:'none', timeout:60000,
    extensions:{ prf:{ eval:{ first:salt } } } as PRFInput
  }, signal }) as PublicKeyCredential|null;
  if (!credential) throw new Error('Passkey setup was cancelled.');
  verifyClient(credential,challenge,'webauthn.create');
  const credentialId = toBase64Url(new Uint8Array(credential.rawId));
  let prf = extensionResult(credential);
  if (!prf) prf = await evaluate(new Uint8Array(credential.rawId),salt,signal);
  if (prf.length !== 32) throw new Error('This passkey did not provide a usable encryption key.');
  return { prf, record:{ version:1, vaultId:info.id, credentialId, salt:toBase64(salt), origin:location.origin, created:Date.now() } };
}
export async function authenticatePasskey(record:PasskeyRecord,signal?:AbortSignal):Promise<Bytes> {
  if (record.version !== 1 || record.origin !== location.origin) throw new Error('This passkey was set up at another app address. Use your vault password.');
  return evaluate(fromBase64(record.credentialId),fromBase64(record.salt),signal);
}
export function friendlyPasskeyError(error:unknown):string {
  if (error instanceof DOMException && ['NotAllowedError','AbortError'].includes(error.name)) return 'Passkey request cancelled or unavailable. You can still use your vault password.';
  return error instanceof Error ? error.message : 'Unable to use this passkey.';
}
