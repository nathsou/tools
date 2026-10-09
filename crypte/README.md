# Crypte

A local Cryptomator and Unified Vault Format (UVF) manager built with Svelte 5. Browse, import, organize, and delete files locally. Files and passwords stay in your browser. The production output is static HTML, CSS, and JavaScript; there is no application backend, account, telemetry, or external asset service.

## Run

Node and Bun are pinned in `mise.toml`. Install [mise](https://mise.jdx.dev/getting-started.html) if needed, then run from the repository root:

```sh
mise trust
mise install
mise exec -- bun install --frozen-lockfile
mise run dev
```

Open **http://localhost:5173/crypte/**. On the machine where this project was created, mise is installed at `~/.local/bin/mise`; use that full path if it is not on your shell's PATH. No Rust toolchain is required.

For the production build:

```sh
mise run build
mise run preview
```

Open **http://localhost:4173/crypte/**. `dist/` can be served by any static host over HTTPS, including a subdirectory. Host only trusted tools on the same origin. Loading `crypte/index.html` through `file://` does not work: Web Crypto, workers, file handles, WebAuthn, and service workers require an HTTP secure context. Localhost is accepted for development. Production offline caching is ready after the page shows “Media streaming ready”; the development server is intended for connected development.

## Create a vault

Choose **Create new vault**, select **Cryptomator** (the default) or **UVF**, give it a name, choose a parent location, and enter and confirm a password. Crypte creates a **new named folder on disk** containing a password-protected Cryptomator **format 8 / SIV_GCM** or **UVF v1** vault. Existing files and folders are never intentionally replaced. Native read/write folder access is required (currently Chrome/Edge and other compatible Chromium browsers). Firefox/Safari can still open existing vaults using the read-only file-input fallback.

Keys and salts are randomly generated. Password derivation and key wrapping run in the vault worker. Cryptomator uses scrypt N=32768/r=8/p=1 and AES-KW; the signed vault configuration and encrypted empty-root directory-ID backup are written and checked before opening. Only wrapped keys and encrypted metadata are saved. Remembering the vault uses the same optional IndexedDB handle storage as opening an existing vault; the vault itself remains at your chosen disk location and survives cleared browser storage. A remembered vault is restored **locked** after reload. Unsupported handle storage or renewed permissions require selecting the folder again.

New UVF vaults use a `PBES2-HS512+A256KW` password recipient (600,000 PBKDF2 iterations, random 16-byte salt), `A256GCM` JWE metadata, and a random initial seed. The independently encrypted root directory metadata is written before `vault.uvf`. Both formats are reopened and authenticated before browsing.

Keep the password safe: Crypte does not yet generate recovery keys or reset forgotten passwords. Failed creation attempts clean up the new folder when possible and report cleanup failures. As with other writes, pause external writers; a browser crash can leave an incomplete new folder requiring inspection.

## Migrate between formats

Choose **Migrate vault** while a vault is unlocked with native folder access. A Cryptomator source produces a UVF v1 destination; a UVF source produces a Cryptomator format 8 / SIV_GCM destination. This is a complete, verified copy into a **new folder outside the source vault**, with a separate password. The source is never deleted or rewritten by migration. Pause external writers and allow enough disk space for the encrypted copy.

1. Choose a name, location and password for the new vault.
2. Review the preflight report. Crypte traverses the full tree, including hidden files and empty folders, authenticates source contents, and checks destination name limits, collisions and directory identities. No destination is created at this stage. Resolve every reported issue before continuing.
3. Create the copy. File contents are decrypted and re-encrypted in bounded memory; only ciphertext is staged on disk. Symbolic links are copied as links, never followed. Their target strings are preserved.
4. Crypte reopens the destination, authenticates its contents, compares every plaintext file's SHA-256 digest and checks names, types, sizes and folder structure. Source and destination ciphertext snapshots detect changes during copying and verification. Only then is the new vault marked complete.

**UVF names:** the current format has no long-name shortening mechanism. Crypte enforces a portable 255-byte ciphertext component limit, allowing at most **172 UTF-8 bytes** per plaintext filename. Long Cryptomator names, non-NFC names, non-normalized UVF symlink targets and case-insensitive collisions are reported before copying. Nothing is silently renamed or skipped. Fix names in the source first and update any affected symbolic links yourself.

**Progress and optional source scan:** checking first discovers the directory tree, showing a running entry count, then shows a byte-based progress bar once the amount of scan work is known. Copying and each verification pass also show progress. To reduce source reads, select **Skip full source scan** before reviewing. Names, structure, format limits and symlink targets are still checked. File contents (including empty-file headers) are authenticated as they are copied, and destination verification is always performed. With this option, source payload changes are detected using size and modification timestamps instead of ciphertext hashes; changes that preserve both can go undetected. Corruption may be discovered only after creating a partial copy. Keep external writers paused. Full scanning remains the default.

**Cancellation and failures:** cancel from the dialog or lock the vault. A destination already created is retained with `.crypte-migration-incomplete`; Crypte refuses to open it as a finished vault. Remove that incomplete folder before retrying with the same name. There is no automatic resume or automatic source deletion. Browser shutdowns retain the same marker. A failed copy does not authorize deleting the source.

Filenames, file bytes, empty directories, hierarchy and symlink targets are preserved. Browser filesystem APIs do not preserve original modification timestamps, permissions or extended attributes. Application caches, local passkey records and orphaned/unreachable encrypted objects are not migrated. The new vault can be remembered and enrolled with a passkey separately. Preflight and verification read the vault several times, so large vaults can take a while.

### Convert on disk with Bun

From a checkout of this repository, install its existing dependencies and run:

```sh
bun install --frozen-lockfile
bun run convert:uvf /path/to/cryptomator-vault /path/to/new-uvf-vault
```

The CLI prompts for the source password without echoing it. The new UVF vault uses the same password unless you add `--new-password`, which prompts for a new password twice. No browser, server, mounted Cryptomator drive, or plaintext staging directory is needed. Point the script at the **encrypted vault directory** containing `masterkey.cryptomator`, not the unlocked drive. Both Cryptomator format 8 ciphers and legacy format 7 are supported.

Use `--dry-run` to authenticate all source contents and check UVF compatibility without creating files. Add `--skip-source-scan` to check source metadata without scanning all file contents:

```sh
bun run convert:uvf --skip-source-scan /path/to/source /path/to/new-uvf
```

The same tradeoffs as the browser option above apply: source content is authenticated during copying, source payload change checks use size/timestamps, and destination verification stays mandatory. With `--dry-run --skip-source-scan`, only metadata/compatibility is checked; file contents are not certified. The CLI uses an updating progress bar in a terminal and periodic plain-text progress lines when redirected. Percentages describe the current pass, not the entire migration.

For unattended use, supply passwords through environment variables populated by your secret manager or shell's hidden-input prompt:

```sh
bun run convert:uvf --password-env SOURCE_PASSWORD --new-password-env UVF_PASSWORD /path/to/source /path/to/new-uvf
```

Do not put literal passwords in command arguments or shell history. Omit `--new-password-env` to reuse the source password. Run `bun run convert:uvf --help` for all options.

The destination must not exist, its parent directory must exist, and it must be outside the source. Pause other vault writers and sync clients for the entire conversion and verification; allow space for a complete encrypted copy. Files are read in bounded batches and encrypted directly into the destination. The script reopens it, checks every logical path, entry kind and size, compares decrypted SHA-256 hashes, and checks that the source inventory stayed unchanged (ciphertext hashes by default, payload size/timestamps when skipping the source scan) before removing the incomplete marker. Empty files/folders, hidden files, Unicode names and encrypted symlink entries are preserved; symlinks are never followed. Filesystem timestamps and permissions are not copied. Native filesystem symlinks within the encrypted storage are rejected.

UVF-incompatible names (including names exceeding 172 UTF-8 bytes), ambiguous names and invalid symlink targets fail preflight without creating the destination. With the default full scan, damaged file contents also fail preflight; when the scan is skipped, they fail during copying. Nothing is silently renamed or skipped. Only reachable vault contents are converted; unrelated files and orphaned ciphertext are not copied. The source is never deleted or modified. Cancellation, interrupted writes or failed verification retain the encrypted partial destination with `.crypte-migration-incomplete`, which Crypte refuses to open normally. Remove the partial folder before retrying; there is no resume mode. Keep the source until you have independently confirmed the new vault meets your needs.


## Open a vault

Choose the **encrypted vault root**, containing `vault.uvf`, or `vault.cryptomator` and `masterkey.cryptomator` (or only `masterkey.cryptomator` for format 7), and enter its password. Crypte detects the format automatically; roots containing both formats are rejected. The unlock screen shows the format and whether native write access is available. The native directory picker requests read/write access for vault management and encrypted thumbnail caching. A directory-file-input fallback supports browsers without that picker, but you must select the folder again after reloading. The fallback cannot discover an empty encrypted directory with no files or directory-ID backup.

With “Remember this vault” enabled and native directory-handle storage supported, the app automatically restores the last remembered vault on startup when its read permission is still granted. It remains locked until password or passkey unlock. If the browser requires renewed permission, use the recent-vault button to approve access. Folder selection grants local access; it does not upload or copy the vault into the app. See [browser permission states](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemHandle/queryPermission).

Chromium 153 has a [filesystem-handle/IndexedDB crash in private contexts](https://issuetracker.google.com/issues/564001201). Crypte conservatively remembers vault metadata without storing handles on that major version, so reopening requires selecting the folder again. It does not attempt to detect private browsing. Other versions can retain the native handle, subject to renewed read permission.

macOS AppleDouble sidecars (`._*`) and `.DS_Store` files on the **encrypted filesystem** are ignored when scanning vault entries and validating entry metadata. These OS metadata files are not Cryptomator ciphertext, even when their names end in `.c9r` or `.c9s`. Browsing does not delete them, and they are not copied as vault payloads during moves. This rule does not hide real decrypted dotfiles or suppress damaged encrypted entries.

Dot-prefixed files and folders **inside the decrypted vault**, such as `.DS_Store`, are hidden by default. Toggle **Preferences → Hide dotfiles** to show them. This preference is remembered on the device and applies to gallery/list views, search, counts, and opened-folder navigation.

Features include gallery and list views, breadcrumbs, folder search, filters, sorting, image and video thumbnails, image zoom/pan, a video thumbnail timeline, text reading with search and line numbers, audio/video playback and seeking, System/Light/Dark appearance, and decrypted export. Search and type filters apply to the current folder. Symbolic links show their target as text and are never followed. HTML, Markdown, SVG source files, and other documents are not executed as documents in the app.

**Back and Forward:** folder visits, the Conversions tab, file previews (including previous/next file), type filters, and Preferences use the browser [History API](https://developer.mozilla.org/en-US/docs/Web/API/History_API/Working_with_the_History_API). Navigation restores the folder search, sort order, gallery/list layout, expanded preview, and explorer scroll position. Closing a preview or Preferences returns to its preceding view when possible; refreshing a folder does not add a history entry. The app keeps view details only in memory and stores random identifiers in browser history, with no decrypted names or paths in the URL or history state. Returning from the vault root to the unlock screen locks the vault. Locking, changing vaults, closing, and reloading clear the private navigation data; Back/Forward cannot restore an unlocked session. Browser navigation during an import cancels the active import and cleans up its incomplete ciphertext; already completed files remain.

Text previews show up to 2 MiB, image previews accept up to 64 MiB, and thumbnail source images up to 24 MiB. Supported media codecs depend on the browser. Video and audio normally stream authenticated chunks through a service worker. If it is unavailable, in-memory media previews are limited to 128 MiB. Export streams to a user-selected destination where the save picker is supported; the download fallback is limited to 128 MiB. Export creates a plaintext copy at the chosen destination.

**Large video/audio previews:** local streaming has no application file-size cap and decrypts requested ranges in 256 KiB response packets instead of constructing a complete plaintext Blob. The player waits for streaming startup and automatically opens when it becomes ready. If setup fails, the preview explains the browser error and offers **Retry streaming**; an already-open failed preview recovers after streaming is enabled. The footer shows **Starting media streaming**, **Media streaming ready**, or **In-memory previews**. HTTPS or localhost and service-worker support are required. A browser window that blocks service workers must use the bounded fallback or export the file. Codec support and browser/device playback resources still apply.

Thumbnails are generated near the visible viewport, with at most two concurrent jobs. Mediabunny decodes a video frame roughly 20% into the clip, between 3 and 30 seconds; clips shorter than 6 seconds use their midpoint. It reads authenticated vault ranges directly, without a service worker or a whole-file size limit. Unsupported browser codecs retain the file icon. Source images retain the 24 MiB and 40 megapixel limits.

Completed image/video thumbnails are persisted as AES-GCM ciphertext in **`.crype_cache/v1/` at the selected vault root** when native write access is granted. The folder name follows the requested spelling. Cache keys derive from the vault master material with a separate HKDF context; records authenticate the encrypted source path, size and timestamp. Opaque hashes identify files and content directories, without plaintext filenames. These are Crypte cache records, outside Cryptomator's visible contents; Cryptomator does not need to understand them, and the folder can be removed to regenerate thumbnails. Invalid/corrupted cache records are ignored and regenerated. Refresh detects changed source sizes/timestamps. Deleting media removes its thumbnail; recursive folder deletion removes descendant cache groups; moving/renaming a file discards its old cache entry.

A bounded memory cache holds 256 thumbnails or 16 MiB for fast reuse. Offscreen components release display URLs. Locking, changing vaults, closing or reloading aborts generation and clears plaintext thumbnails and URLs; encrypted disk thumbnails survive for the next unlock. The vault picker requests read/write access for caching and management. Read-only/fallback vaults use memory caching, and remembered handles without granted write access skip disk writes. No thumbnails enter IndexedDB or the service worker's offline cache.

**HEIC/HEIF** files support thumbnails and image previews. Native browser decoding is tried first; [Safari supports HEIC](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/). Other browsers use a self-hosted [libheif-js](https://github.com/catdad-experiments/libheif-js) WebAssembly decoder in a disposable worker. It renders the primary image as WebP for viewing; originals and exported files remain HEIC. The decoder has no additional package dependencies and adds about 1.99 MB to the static build (692 KB gzip). It executes only when needed; its static asset is precached so first use can work offline. HEIC decoding and thumbnail generation are limited to 40 megapixels. Color/HDR fidelity, image sequences, and metadata presentation are not guaranteed.

**RTF** opens in the text reader as extracted plain text, including common ANSI code pages, Unicode escapes, paragraphs, tabs, and link labels. Formatting, metadata, hidden text, embedded pictures/objects, and link instructions are omitted. Extraction never creates HTML or follows links. Incomplete or oversized RTF documents show an error rather than raw control codes; RTF previews require the complete document within 2 MiB. Export retains the original RTF bytes. Additional text extensions, common extensionless source/configuration files, and BOM-marked UTF-16 text are recognized.

Keyboard shortcuts: **⌘/Ctrl K** focuses folder search; **Escape** closes preferences or the preview; **←/→** moves between files; **Space** expands the preview. Auto-lock defaults to five minutes of inactivity and one minute in a background tab. Preferences accepts custom minute values (0–1440, including fractions) independently for each timer; 0 disables that timer. **Keep unlocked during conversions** pauses both automatic timers while a job is queued, converting, or saving, and restarts them when processing stops. Jobs waiting for settings/review do not pause locking. Manual lock always works. Closing or reloading the page also ends its vault session.

### Download files and folders

Open an item's **…** menu in gallery or list view and choose **Download file** or **Download folder (.zip)**. File previews also have a **Download file** button (or **Download original** while editing). Downloads work with native folder access and read-only vaults.

Files are downloaded as decrypted originals. A folder becomes one uncompressed ZIP containing its full hierarchy, hidden files and empty folders. Symbolic links become ordinary text files containing their target, using their original names; links are never followed or recreated. ZIP timestamps are not preserved. Downloads are unencrypted copies; the progress panel shows bytes processed and offers **Cancel download**. Locking also cancels active downloads.

Save-file-picker browsers stream output to disk in bounded batches. Other browsers buffer authenticated output before starting a download, with a 128 MiB limit. Folder ZIPs must be smaller than 4 GiB and contain at most 65,534 entries; download smaller subfolders separately for larger trees. Damaged content, ambiguous paths or non-portable archive names fail the download rather than silently omitting entries. No additional runtime dependencies are used for ZIP creation.

## Manage files and folders

Open the destination folder and choose **New folder**, **Add files**, or **Add folder**. Each entry's **…** menu offers **Rename**, **Move to…**, and **Delete**. The menu button appears on hover or keyboard focus and remains visible while open; touchscreen devices show it persistently. Selection checkboxes appear on hover/focus, or after **Select items** for touch and keyboard use. The selection toolbar appears only in selection mode. Clicking an item in that mode toggles selection; **⌘/Ctrl-click** toggles an item and **Shift-click** extends a range. **⌘/Ctrl A** selects visible items; **Done selecting** or **Escape** exits. Completed batch actions also exit selection. Select several entries to move or delete them together; **Select all visible** respects search, filters, and the dotfile preference. Drag an entry or the checked selection onto a folder to move it there. The move dialog can browse all visible destination folders. Moving a folder into itself or a descendant is rejected.

All changes require a vault opened with the native directory picker and browser write permission. Directory-file-input fallback vaults remain read-only. Chromium browsers currently provide the native directory picker needed for management; password, preview, and export functionality remains available through the fallback.

**Folders:** new folders receive a fresh directory ID and encrypted directory-ID backup according to the [Cryptomator vault format](https://docs.cryptomator.org/security/vault/). Moving or renaming a folder preserves its ID and encrypted contents. Folder operations support normal and shortened names in formats 7 and 8. Browser history updates renamed/moved breadcrumbs and redirects visits to deleted folders to their surviving ancestor.

**Folder imports:** Add folder preserves nested paths and empty folders when the native source picker is available. Existing destination folders are merged; duplicate files receive numbered names. Source files and folders are retained. The encrypted vault itself, or a source containing it, cannot be imported. Source enumeration is cancelable and limited to 100,000 items and 128 nested levels. A file-input source fallback preserves file paths but cannot discover empty source folders.

**Deletion:** the confirmation names the selected items. Deleting a folder also deletes every descendant, including hidden files, and removes their encrypted storage. Deletion is permanent, with no trash or undo. Folder moves and recursive deletion validate the reachable directory graph first; unreadable entries, duplicate directory IDs, or cycles must be resolved before these operations can proceed.

**Moves and renames:** the browser copies ciphertext in batches of at most 4 MiB and verifies SHA-256 checksums of the copied payload and source before removing the original. File contents are not decrypted for a move. Destination collisions are rejected without intentionally overwriting an existing item. If removing the source fails after verification, the verified destination is retained and the error explains that both folders need refreshing. File modification timestamps can change because the browser writes a new file. Large file moves require copy and verification I/O; folder moves copy only the directory entry metadata.

Canceling or locking before a move commits removes its incomplete destination and retains the source. Once removal of the original starts, the verified destination is retained; recursive deletion finishes encrypted-storage cleanup after unlinking its entry, even if the session locks. Bulk changes and folder imports preserve earlier completed items when a later item fails or the operation is canceled.

Pause other Cryptomator clients and external writers during any change. The app coordinates its own tabs with a shared Web Lock and rechecks sources/destinations, but the browser API has no portable atomic rename or exclusive-create operation across external applications. An unexpected browser shutdown can leave incomplete encrypted copies or orphaned directory storage. Cleanup failures are reported. Keep a backup of valuable vaults. Crypte does not mount an operating-system drive.

### File imports

Open the destination folder in the unlocked vault and choose **Add files**. Select one or several files; Crypte encrypts their contents and names locally using the vault's existing cipher. Original source files are retained. Existing names receive numbered copies such as `Notes (2).txt`; imports never intentionally replace existing entries. Empty files, long filenames, format 7, and both format 8 ciphers are supported. Dot-prefixed imports follow the visibility preference.

Encryption runs in the vault worker in batches of at most 4 MiB of plaintext. Only ciphertext is staged in a temporary file before the completed file is copied into its Cryptomator entry. Locking cancels and cleans up the active import; earlier completed files remain in the vault.

An unexpected browser shutdown during an import can leave an ignored `.crypte-import-*.tmp` ciphertext file or an incomplete destination entry. Importing a duplicate creates a numbered copy; use the text editor to change an existing text file.

## Edit text

Open a plain text file and choose **Edit text**. **Save changes** or **⌘/Ctrl S** encrypts and replaces that file's contents in place with fresh encryption; its encrypted filename and shortened-name mapping remain unchanged. **Cancel edit** discards the draft. The editor requires native directory handles and write permission, supports complete files up to 2 MiB, and preserves UTF-8/BOM or BOM-marked UTF-16 byte order. It uses the original dominant line-ending style for edited content. Unsupported encodings, binary data, invalid Unicode, and oversized drafts are rejected. RTF and symbolic links remain read-only previews.

The text editor highlights common source formats using locally bundled Highlight.js (JavaScript/TypeScript, JSON, Python, HTML/XML/Svelte, CSS, shell, Markdown, Rust, SQL, YAML/TOML/INI, C/C++, Java and Go). Source markup is escaped before display and remains literal text; highlighting never executes code. Unsupported formats and drafts above 256 KiB use plain text coloring while retaining the 2 MiB editing limit. Highlighting does not change saved bytes or the existing encoding/newline handling.

Drafts exist only in memory. Closing or navigating away from a dirty editor asks whether to discard the draft, including browser Back/Forward. Reload/close uses the browser's unsaved-change prompt where supported. Locking immediately clears drafts without delaying the security action; unsaved changes are lost. Exporting from an editor exports the original saved file.

Saving compares the original ciphertext fingerprint against the current file and refuses to overwrite external changes. It stages only encrypted bytes, verifies their checksum, and creates a verified encrypted `.crypte-edit-*.bak` recovery copy before publishing. The recovery copy is removed only after the new ciphertext is verified. Failed publishing/verification attempts restore the original; if restoration fails, the error identifies the retained encrypted recovery file. Canceling or locking before publishing preserves the original. Once publishing starts, verification or recovery completes even after locking, using ciphertext only. A browser crash can leave encrypted `.crypte-edit-*.tmp`/`.bak` files for cleanup/recovery. Pause external writers during saves as with other vault changes.

## Image controls and video scrubbing

Image previews offer **Zoom in**, **Zoom out**, and **Fit image**, plus wheel zoom, drag panning, and two-pointer pinch zoom. Zoom ranges from fit (100%) to 800%. Transforms stay within the preview and reset when it closes.

Video previews retain native player controls and add a keyboard-accessible **Scrub video** slider and eight clickable thumbnails sampled at different timestamps. Hovering over the slider shows the nearest sampled frame. Frames decode sequentially from authenticated ranges with bounded caching, including large files. Timeline thumbnails live only in memory; closing, navigating away or locking cancels decoding and revokes their URLs. Unsupported decoding retains normal playback and explains that timeline thumbnails are unavailable.

## Convert pictures, videos and audio

Choose **… → Convert…** on an image, video or audio file. Native vault handles and write permission are required. Image conversion offers WebP, JPEG and lossless PNG, quality adjustment, and optional downsizing. Its estimate comes from a trial encode with those settings. HEIC decoding uses the existing native/libheif fallback. Conversion creates a still image, so animated/multi-image sources retain one frame and embedded metadata is omitted. Input images retain the 64 MiB/40 megapixel limits.

Video/audio conversion uses **Mediabunny 1.61.0** and browser WebCodecs, with WebM (VP9/Opus) or MP4 (H.264/AAC), selectable bitrate and video height. Audio-only output uses .weba or .m4a. Size estimates use the duration and target bitrates with container overhead and are explicitly approximate; actual size and reduction appear after conversion. Lower bitrate/resolution may reduce size, but recompression may also enlarge an already efficient file. Browser codec availability determines whether conversion is possible; a conversion that would discard a detected track is refused. Output track counts and duration are checked, and a video frame is decoded before review. HDR/color fidelity, animation and all original metadata are not guaranteed—inspect the result before replacing valuable originals.

**Continue browsing** leaves a job in the sidebar’s **Conversions** tab. The tab lists queued, processing, failed and review-ready jobs with progress, **Open/Review**, and **Cancel** controls. Up to eight pending jobs are kept in the current unlocked session. Encoding runs one job at a time; canceled waiting jobs are removed from the queue. Completed output stays in encrypted temporary storage until review/save/cancel. Returning to review requires checking the preview again before removing an original. Saves target the folder where the job was started even after browsing elsewhere; moving/deleting its source or deleting its destination cancels the affected job. Closing or locking clears every pending job; reload does not resume conversions.

Conversion reads authenticated input ranges and spools output in encrypted 256 KiB blocks in browser OPFS, with bounded caching, random-access writes and backpressure. Media output does not need a complete plaintext memory buffer or a plaintext disk file. An unlocked worker derives the cache key and authenticates each temporary block against its random conversion session and block index. Review plays the staged output through local range streaming; service-worker support is required for video/audio review. Still-image previews use a bounded complete image Blob. Cancel, lock and successful completion remove temporary encrypted blocks. A crash may leave encrypted conversion directories in browser storage until site storage is cleared.

**Save copy** writes a separate encrypted vault entry and retains the original by default; name collisions create numbered copies. **Remove original after saving** becomes available only after the preview loads and **I have checked the converted preview** is explicitly checked. Before removing the source, Crypte verifies the published ciphertext against the encryption stream's checksum and compares the source's full ciphertext fingerprint captured before conversion. Changed sources or failed verification retain the original. Removal runs after the verified copy is committed. Cancellation/locking before that point preserves the original; a completed copy can remain if cancellation or removal fails afterward. The shared vault write lock coordinates Crypte tabs; pause external writers during changes.

WebP is a practical choice for photographs; PNG retains decoded pixels without another lossy image encode. MP4 is a container: codec, resolution and bitrate determine most video size. This implementation uses available browser codecs without FFmpeg or a backend. The Mediabunny library is bundled locally and precached for offline use.

## Touch ID and passkeys

Unlock with the vault password first, then open **Preferences → Set up passkey**. Crypte requests a platform authenticator with user verification and the [WebAuthn PRF extension](https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API/WebAuthn_extensions#prf). A compatible combination of macOS, browser, and platform passkey provider can use Touch ID. Ordinary WebAuthn/Touch ID availability alone does not establish PRF support; unsupported combinations show an error and retain password unlock.

The PRF output derives an AES-GCM wrapping key using HKDF. The worker encrypts the vault's masterkeys, and only this encrypted record is stored in IndexedDB. Enrollment does not store the password, a plaintext vault key, or a key derived from an authenticator signature. Unlock requests require user verification and validate their challenge, origin, credential ID, and presence/verification flags. A server is not needed because the passkey supplies key material for local decryption.

Passkeys are associated with the app address and a local encrypted record. Keep the same origin, including protocol and port. Clearing site data, losing that record, changing the vault password/masterkey file, or moving the app to another address requires password unlock and enrollment again. Keep the vault password for recovery. “Remove local unlock” removes Crypte's record; deleting the credential itself is managed in your platform password/passkey settings. “Forget” on the welcome page removes both the recent-vault record and its local unlock record.

Actual WebAuthn create/get/PRF flows are tested with Chromium's virtual platform authenticator, including rejection when PRF is absent. A physical Touch ID interaction has not been tested in this environment.

## Format support and cryptography

Supports password-protected Cryptomator formats **7 and 8**, `SIV_GCM` and `SIV_CTRMAC`, shortened `.c9s` entries, directory IDs, and symlinks. Format 8 configurations support HS256, HS384, and HS512 signatures. Hub-managed key retrieval, rich-text/media editing, older formats, and unrecognized future formats are not supported.

**Cryptomator:** implementation follows [Cryptomator's architecture](https://docs.cryptomator.org/security/architecture/) and [vault cryptography](https://docs.cryptomator.org/security/vault/). Passwords are normalized to NFC and processed by scrypt. AES-KW unwraps encryption/MAC masterkeys; the vault JWT and masterkey version MAC are verified before browsing. AES-SIV decrypts filenames with their parent directory ID as associated data; directory paths are derived from base32(SHA-1(AES-SIV(directory ID))). GCM or CTR+HMAC file headers and every 32 KiB file chunk are authenticated before plaintext is returned. CTR/HMAC authenticates before decrypting. Malformed metadata, path traversal, oversized reads, and KDF memory requirements above 256 MiB are rejected.

**UVF:** follows [Unified Vault Format v1, revision `ed54be8`](https://github.com/encryption-alliance/unified-vault-format/tree/ed54be8d9d4b85f325f7abffad158d3ddf6521c2). Supports JWE JSON serialization with password recipients using `PBES2-HS512+A256KW`, protected metadata using `A256GCM`, `HKDF-SHA512`, `AES-SIV-512-B64URL` names and `AES-256-GCM-32k` contents. PBES2 passwords use their exact UTF-8 bytes, unlike Cryptomator's NFC normalization. Other recipient types, raw-key input, branded metadata filenames, Hub/Katta key retrieval, recipient administration and initiating key rotation are not supported. Unknown critical fields and unsupported versions/algorithms fail closed; authenticated vendor payload fields may be present.

All recorded seed generations are supported. Files use the seed named in their authenticated header; directories retain their immutable seed and 32-byte identity. New content uses `latestSeed`. A changed `vault.uvf` requires locking and reopening before further writes. Directory links and recovery copies are encrypted independently. Content uses 32,740-byte plaintext chunks and 32-bit block indices; a terminal empty block is required for empty files and exact multiples. Reads authenticate the final block before returning even a partial range, then authenticate each requested chunk. Imports buffer across 4 MiB transport batches and explicitly finalize the trailing block. Parser limits include 1 MiB metadata, 64 recipients, 1,024 seeds, two million PBKDF2 iterations per password recipient and four million total iterations across password recipients.

UVF passkey records wrap the metadata content key, rather than a stale seed bundle, and authenticate metadata again at unlock. Their record version and vault fingerprint are separate from Cryptomator's existing records. Metadata changes invalidate local unlock enrollment. UVF preview/conversion cache material uses a dedicated derivation context from the latest seed. These features introduce no runtime or development dependencies.

The shared `Vault` orchestrator uses `vault-format.ts` to dispatch cryptography and layout to `crypto.ts` (Cryptomator) or `uvf.ts`. Filesystem writes remain on the page so cancellation can finish cleanup after terminating workers. Migration orchestration lives in `migration.ts` and obtains authenticated inventories through the worker. No new plaintext filesystem persistence is introduced.

The two cryptographic runtime packages exist because Web Crypto does not expose scrypt or AES-SIV. One additional package provides HEIC decoding in browsers without native support:

| Runtime dependency | Purpose |
| --- | --- |
| `svelte` | Interface |
| `@noble/hashes` | scrypt and incremental ciphertext-copy verification |
| `@noble/ciphers` | RFC 5297 AES-SIV |
| `libheif-js` | Local HEIC/HEIF decoding when native decoding fails |
| `highlight.js` | Escaped syntax highlighting in the text editor |

AES-GCM, AES-CTR, AES-KW, PBKDF2, HMAC, HKDF, SHA-1, SHA-256 and SHA-512 use native Web Crypto. Incremental move verification uses the existing hashes package to keep memory bounded. Vite, TypeScript, Svelte tooling, and Playwright are development dependencies. The application does not load packages from a CDN.

## Data lifecycle

Vault keys and cryptographic work live in a dedicated worker. HEIC image workers receive only decrypted image bytes and are terminated after a conversion, cancellation, or timeout; they do not receive vault keys. Lock terminates the vault worker, cancels pending thumbnail/HEIC jobs, drops the file listing/text state, revokes preview URLs, and ends the media session. Byte buffers are cleared where practical; JavaScript strings and browser-internal buffers cannot offer guaranteed memory zeroization. An unlocked app and its host origin must be trusted: this is not a defense against compromised app JavaScript or a compromised browser/device. The complete app has not had an independent security audit.

IndexedDB contains optional remembered vault names/handles and encrypted passkey records. Local storage contains appearance, auto-lock, and dotfile visibility preferences. System appearance is the default and follows device theme changes. The service worker caches only static app assets. Private vault content, decrypted previews, and vault passwords are never added to that offline cache. Private media URLs carry random session/file tokens and require the unlocking page's client; another tab cannot use them. Range responses are `no-store`, and the worker can restart without retaining private content.

## Validation

```sh
mise run check
mise run test
mise exec -- bunx playwright install chromium
mise run e2e
```

The suite covers cryptography, local persistence, filesystem management, previews and conversion workflows. UVF tests use an independent Node/OpenSSL fixture and decoder, covering mixed seeds, directory metadata, empty/exact/multi-batch files, truncation, malformed metadata, passkeys, cache separation, creation and cancellation. Browser tests cover bidirectional migration, unchanged source ciphertext, long-name preflight failures, source changes, altered destination contents, incomplete-copy markers and mobile format selection. No external UVF client has been exercised as part of this test suite. Tests cover both file cipher combinations, legacy format 7, independent Node/OpenSSL-generated vault fixtures and decoding of imported files, RFC 5297 and Cryptomator reference vectors, corrupted metadata/content, wrong passwords, passkey binding, byte ranges, actual browser media playback/seek, worker restart, offline reload, native directory handles, both export paths, virtual WebAuthn PRF, tab isolation, auto-lock, and mobile layout. History checks cover Back/Forward through folders, previews, Preferences and filters, restored view state, rapid traversal, forward-branch replacement, media URL revocation, locked/reloaded sessions, opaque history state, and import cancellation. Thumbnail checks verify later video sampling, reuse across gallery/list views and folder navigation without repeat decryption, invalidation after file changes, bounded cache eviction, lock-time URL revocation, and hover/focus/touch menu access. Media checks exercise video and audio files over 128 MiB, delayed startup, recovery after registration failure, bounded fallback, actual video thumbnails, a synthetic HEIC image decoded in Chromium, first-use HEIC decoding offline, worker cancellation, RTF Unicode/code-page extraction, escaped rendering, and unchanged RTF export. Import checks include collisions, empty files, long names, nested destinations, encryption across 4 MiB batches, write-permission denial, and cancellation cleanup. Management checks cover creation, rename, move, and recursive deletion for all supported ciphers; normal/shortened names; independent directory-backup decoding; unchanged ciphertext and masterkey files; nested/empty folder imports; folder merging; bulk selection and drag-and-drop; symlink moves without following targets; history after mutations; cancellation cleanup; corrupted-copy rejection; and retaining the verified destination when source removal fails. Editing checks cover fresh encrypted in-place saves for all ciphers, empty/shortened files, unchanged name mappings and masterkeys, UTF-8/UTF-16 and newline preservation, rejected invalid/oversized content, external-edit conflicts, unsaved-draft history guards, cancellation/lock cleanup, and rollback of corrupted published ciphertext. Handle persistence is verified in a regular profile; the Chromium 153 compatibility branch is checked separately in an isolated context. Creation checks independently unwrap new keys, authenticate configuration/version metadata and locate/decrypt the empty root backup; browser checks cover remembered creation/reopening, name collisions and failed-write cleanup. Preview checks cover zoom/pan, escaped source highlighting with unchanged saved bytes, timeline timestamps/seeking and lock-time cleanup. Conversion checks cover background jobs, original destinations, queuing/cancellation and custom automatic-lock behavior. Codec-dependent MP4 tests validate rejection and preserved originals when the browser cannot encode all tracks. Browser tools are test dependencies; only mise-managed Node/Bun are needed to build the app.

`mise exec -- bun run fixtures` regenerates the synthetic fixtures. The fixtures live under `tests/` and are never shipped in the app. Without the optional `.tools/flower.mp4` source, regeneration preserves the committed encrypted CC0 test video. `mise run inspect`, with the production preview running, writes desktop/mobile review screenshots to `.tools/screenshots/`.

## Performance and WASM

Start `mise run dev` in one terminal and run `mise run benchmark` in another. The benchmark uses synthetic 16 MiB files through the actual vault worker, including authenticated chunks, File slices, plaintext verification/clearing, and transferable buffers. It measures memory-backed browser File objects, not disk latency or real-world large-folder scans.

Measured on the development Mac in headless Chromium 153 on 2026-10-02:

| Operation | Median |
| --- | --- |
| Password unlock, scrypt N=32768/r=8/p=1 | 112 ms |
| List 10 synthetic entries | 0.4 ms |
| GCM full-file reads | 90.1 MiB/s |
| CTR+HMAC full-file reads | 87.1 MiB/s |

These are five-sample measurements, with file-read warmup excluded. They are not comparisons against a Rust/WASM implementation. Keep native Web Crypto for bulk file decryption; a complete rewrite adds code, build, review, and memory-copy costs without demonstrated benefit here. If profiling a target workload identifies high-cost scrypt or AES-SIV in very large folders as a bottleneck, benchmark an isolated WASM implementation of that primitive behind the existing worker API. Passwordless PRF unlock already bypasses scrypt.

## Source layout

`src/lib/crypto.ts` implements the crypto protocol, `vault.ts` maps the encrypted filesystem and encrypts imports, `filesystem.ts` adapts browser file access, `creation.ts` persists newly generated vault metadata, and `vault.worker.ts` isolates keys. `imports.ts` stages and publishes encrypted files through native directory handles and coordinates vault writes. `writes.ts` executes validated creation/move/delete plans; `folder-import.ts` enumerates and imports source hierarchies. `editing.ts` preserves supported text encodings; `replacement.ts` stages, verifies, publishes, and recovers encrypted text saves. `history.ts` keeps private navigation snapshots in memory and reconciles them after changes. `passkeys.ts` handles WebAuthn, `database.ts` stores local metadata, and `media.ts`/`service-worker.ts` bridge authenticated byte-range playback. `images.ts`/`image.worker.ts` handle HEIC decoding, `previews.ts` generates thumbnails, `thumbnail-cache.ts` bounds memory caching; `private-cache.ts` encrypts persisted thumbnails and conversion staging, while `bunny.ts` and `conversion.ts` handle authenticated range inputs, frame extraction and conversion, and `text.ts` extracts readable RTF. `App.svelte` and `src/components/` implement the interface. Synthetic fixture creation and independent decoding are isolated in `scripts/`.

## Remaining Cryptomator feature gaps

Compared with the [Cryptomator desktop documentation](https://docs.cryptomator.org/desktop/), Crypte still lacks:

- **Mounted filesystem/drive access:** FUSE, WinFsp and WebDAV volume types, mount locations, and opening vault files directly in arbitrary desktop applications. Crypte provides a browser file manager and explicit plaintext export.
- **Password and recovery management:** changing vault passwords, showing/generating recovery keys, and password resets using recovery keys.
- **Vault repair and migrations:** Cryptomator's Vault Recovery/health workflows, recovery of missing directory metadata and automated migration of old vault formats. Crypte validates format 7/8 data and reports failures.
- **Cryptomator Hub integration:** managed/team vault key retrieval, access management, and Hub file-in-use coordination.
- **Desktop integration:** OS keychain password saving, launch/login automation, OS sleep/session-lock detection, drive/mount options and command-line integration. Crypte's local passkeys and configurable timers cover browser sessions.
- **Events/conflict tooling:** a vault event log and integrated diagnostics/recovery for cloud synchronization conflicts. Crypte reports operation errors and rejects stale writes but has no conflict-resolution interface.

Cryptomator desktop also relies on external cloud synchronization software; direct cloud syncing is not a built-in desktop feature missing from Crypte. Rich media previews, conversion jobs and syntax-highlighted text editing are Crypte-specific conveniences rather than Cryptomator parity requirements.

Crypte is an independent app and is not an official Cryptomator product. See `LICENSE` and `NOTICE.md` for licensing and sample provenance.
