# Age

Single-file encryption at `/age/`, in the standard [age](https://age-encryption.org) v1 format. Files are encrypted and decrypted in the browser tab; nothing is uploaded and there is no backend, account or analytics. Files made here open with the `age` and `rage` command-line tools and with [Crypte](../crypte/README.md), and the reverse.

## Use it

- **Encrypt:** choose or drop a file. Protect it with a **passphrase** (entered twice), or with **public keys** (one `age1…` key per line; `#` starts a comment). Optionally choose **ASCII armor** for printable output. Select **Encrypt and save** to save `name.age`.
- **Decrypt:** choose or drop an `.age` file, binary or armored. Age reads its header and asks for the passphrase or a secret key (`AGE-SECRET-KEY-1…`, pasted or loaded from an identity file). **Unlock** checks the key before you choose where to save. Then select **Decrypt and save**.
- **Keys:** **Generate key pair** creates an X25519 identity in the `age-keygen` file format. Copy the public key for senders, then **Save identity file** somewhere safe; it is not stored and disappears when you leave the page. **Encrypt to this key** fills in the Encrypt tab.

Cancel stops an operation; nothing partial is kept.

## Security notes

- Passphrases are stretched with scrypt (work factor 18, 256 MiB, the age CLI default) and wrapped with ChaCha20-Poly1305. Use a long, unique passphrase: it is the only protection.
- Payloads use age's STREAM construction: 64 KiB ChaCha20-Poly1305 chunks with a final-chunk flag. Every chunk is authenticated before it is written, and truncation, reordering, trailing data and modified headers are rejected.
- With a Save File picker (desktop Chrome and Edge), output streams to a temporary file that is only committed when the whole operation succeeds. Other browsers assemble the output in memory, up to 128 MiB, and start the download at the end.
- age encrypts contents, not names. The output keeps the original file name with `.age` added, and its size is close to the original's.
- Decryption accepts scrypt work factors up to 20 (1 GiB of memory). Larger factors are refused before any work; use the age CLI for those.
- Passphrases and secret keys are kept only in this tab's memory while needed, and are never stored. Clipboard contents are managed by your system.

## Compatibility

Supported: passphrases (scrypt), X25519 recipients (`age1…`) and identities (`AGE-SECRET-KEY-1…`), multiple recipients, and armored and binary files. Not supported: SSH keys, plugins (such as `age-plugin-yubikey`), post-quantum hybrid keys and passphrase-protected identity files. These are reported as unsupported rather than ignored.

The format is implemented in `src/lib/age.ts`, from the specification, using the repository's existing `@noble/ciphers` and `@noble/hashes` primitives and the browser's native X25519. No age library or other dependency is added. X25519 keys need a browser with Web Crypto X25519 support (current Chrome, Edge, Firefox and Safari). Passphrases work without it.

## Development

Use the repository toolchain (see the [root README](../README.md)) and open **http://localhost:5173/age/**. `tests/unit/age.test.ts` checks files made by the reference age 1.1.1 CLI (`tests/fixtures/age/`) and many malformed inputs. When `age` is installed, it also checks that the CLI decrypts files written here. `tests/e2e/age.spec.ts` covers the page in Chromium.
