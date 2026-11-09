# HomecoreOS firmware guide

Everything here is done in a web browser. You do not install Arduino, a compiler, Node.js or any tool on your computer, and you never need a terminal.

There are three moments in the life of a firmware release:

| Moment | Who | Where |
| --- | --- | --- |
| Build one release ZIP | GitHub does it for you | GitHub → Actions → **Firmware** |
| Store and publish it | Platform Owner | Owner Console → **Firmware management** |
| Install it on a controller | Customer, or the owner | Customer Console → **Firmware**, or **Owners → Assign** |

---

## 1. Build a release (GitHub, in the browser)

1. Open your fork of the repository on GitHub.
2. Click **Actions** in the top bar.
3. In the left-hand list click **Firmware**.
4. Click **Run workflow** (right side).
5. Fill in the fields:

   | Field | What to type |
   | --- | --- |
   | **Release version** | The version the controller will report, for example `1.3.0`. Letters, digits, dots, dashes and plus signs only, 32 characters maximum. |
   | **Channel** | `stable`, `beta` or `dev`. Customers receive `stable`. |
   | **Mark the GitHub release as a pre-release** | Leave off for a normal release. |

6. Click **Run workflow**.
7. Open the new run and watch the steps:

   | Step | What it does | Roughly |
   | --- | --- | --- |
   | Normalise the version | Checks the version text and strips a leading `fw-v` | seconds |
   | Generate the build header | Writes the version, API address and the two TLS trust anchors into the firmware | seconds |
   | Install the ESP32 core and libraries | Downloads the compiler toolchain | 2–4 min |
   | Compile the controller image | Builds the ESP32-S3 image | 1–2 min |
   | Build the release package | Merges the USB image, writes the manifest, checksums and the ZIP | seconds |
   | Verify the package the way the server will | Re-reads the ZIP exactly as the Owner Console does | seconds |

8. When the run finishes green, open it and download **`homecoreos-<version>.zip`** from the **Artifacts** section at the bottom. The same file is attached to the entry on the repository's **Releases** page, next to `homecoreos-<version>.zip.sha256`.

A red run means nothing was published. The failing step shows the exact error; the two most common ones are a version that does not match the compiled image and an image that is larger than the 3 MB application slot.

### What is inside the ZIP

| File | What it is | Used for |
| --- | --- | --- |
| `manifest.json` | Version, channel, board models, hardware configuration, filenames, sizes, checksums and flash offsets | Read by the Owner Console to validate the package |
| `homecoreos-ota.bin` | The application image | Wireless OTA updates, and USB updates at `0x10000` (`flash_offset` `65536`) |
| `homecoreos-factory.bin` | Bootloader + partition table + OTA data + the same application | First USB install and recovery, written from `0x0` (`flash_offset` `0`) |
| `SHA256SUMS.txt` | Checksums of the files above | `sha256sum -c` on any computer, or a manual comparison |

The file names are fixed, so the Owner Console and the browser installer always know
which artifact is which. There is no signature file and no `.sig` entry.

Every image is recorded in the database with the flash offset it is written at, and the
two are never the same value: `65536` for an application image and `0` for a factory image.
`manifest.json` must state the offset for both. A package that declares the wrong offset,
or none at all, is stored as a draft with the reason shown instead of being corrected
silently — an application image written at `0x0` would overwrite the bootloader.

Never unzip and re-zip a package, and never edit `manifest.json`: the checksums are checked against the files, so an edited package is refused.

### Checking the download (optional)

```sh
shasum -a 256 -c homecoreos-1.3.0.zip.sha256     # macOS
sha256sum -c homecoreos-1.3.0.zip.sha256         # Linux
```

The Owner Console does the same check on the server, so this is only a convenience.

---

## 2. Store and publish it (Owner Console)

1. Sign in as the **Platform Owner** and open **Owner console → Firmware management**.
2. Click **Upload release package**.
3. Choose the ZIP. The page shows its size and its SHA-256, calculated in your browser.
4. Choose the **Channel** and whether to **Save as draft** (recommended the first time) or **Publish now**.
5. Leave **Compatible controller models** empty to use the models named in `manifest.json`, or narrow it if this build is only meant for some of them.
6. Click **Upload and validate**.

The dialog reports each check separately:

| Check | Meaning |
| --- | --- |
| manifest.json is readable JSON | The archive is intact and from this project |
| Manifest identity | It is a `homecoreos_esp32` package with a usable version |
| OTA application image | A real ESP32-S3 application image, with its version marker |
| Application targets this board family | Chip id 9 (ESP32-S3) |
| USB factory image | Bootloader at `0x0`, partition table at `0x8000`, application at `0x10000` |
| Checksums match the files | Nothing was altered after the build |
| Board compatibility | Every model named exists in the board catalog |
| Hardware configuration | Built for 16 MB flash |

If everything passes, the package is stored — both images separately — and published if you asked for it. If anything fails, it is stored as a **draft** and the dialog lists every reason. A draft is never offered to anyone.

### Publish, archive, roll back

- Open a release and click **Publish** when its checks are clean. Publishing makes it the latest build for its compatible models.
- **Archive** stops offering it without deleting anything.
- **Assign** sends a release to chosen controllers, or to all compatible ones. A controller only installs a release that supports its board model.
- **Delete** removes the metadata and the stored file. Type `DELETE` to confirm. A release with an update in progress cannot be deleted.
- To undo a bad release, archive it and assign the previous stable build again — or use **Roll back** in the customer console for a single controller.

### The two kinds of image

- **OTA application image** — small, installable wirelessly, written at `0x10000`. Only a published, app-only release is ever offered over the air.
- **USB factory image** — the whole flash layout from `0x0`. Used by the browser installer for a first install or a recovery. The server refuses to send it as a wireless update, so a factory image can never overwrite a working controller's slots.

---

## 3. Install it on a controller

### Option A — over USB in the browser (first install or recovery)

1. Sign in and open **Firmware** in the customer console (or the same page in the owner console).
2. In **Option A**, click **Install over USB**.
3. Click **Download and verify**. This downloads the image and compares it with the published SHA-256 before anything is written.
4. Click **Connect and install** and choose the serial port in the browser dialog.
5. Follow the on-screen steps. The page shows the real progress of the write, then reads the flash back and compares it with the published SHA-256 before it says it is finished.

Requirements:

- **Chrome or Edge on a desktop or laptop.** Web Serial does not exist in Safari, Firefox or on phones.
- An **https** page (the deployed site always is).
- A **USB data cable**, plugged in directly rather than through a hub.
- If the board is not detected: hold **BOOT**, briefly press **RESET**, release **BOOT**, then click **Connect and install** again.

The installer refuses to write when the connected chip does not match the release, and it never says "installed" unless the read-back matches. What it cannot tell you is whether the controller then boots correctly — that is what the setup steps after the write are for.

### Option B — download the file

The same page offers **Save the file**, with the version, the compatible models, the size and the checksum. Use it if you want to flash with another tool, or keep a copy for a controller without internet access.

### Wireless update (after pairing)

1. Open **Firmware → Your controllers**.
2. A controller with a newer release shows **`<version>` available**. Click **Update to `<version>`**.
3. The controller downloads the image over HTTPS, verifies the SHA-256, writes it to the inactive slot and reboots.
4. It reports each stage (downloading, installing, verifying) and only reports **success** after it reconnects and states the new version. If it cannot connect on the new image, it goes back to the previous one.

A controller must be online and paired for this. Nothing is reported as installed while it is offline.

---

## 4. Integrity — the SHA-256 digest

Releases are **not signed**. Integrity comes from the SHA-256 digest of every image,
and it is checked at three independent points:

| Where | What happens |
| --- | --- |
| GitHub Actions | Computes the digest of each image and writes it into `manifest.json` and `SHA256SUMS.txt` |
| Owner Console upload | Recomputes the digest from the uploaded bytes and refuses a package whose digest does not match |
| The controller | Recomputes the digest of the image it downloads before it boots it |

Nothing has to be configured, and there is no key to generate, store or rotate. If you
previously added `FW_SIGNING_KEY`, `FW_SIGNING_PUBKEY`, `HC_FW_PUBKEY` or
`HC_FW_SIGNING_ALG` to GitHub, Cloudflare Pages or your environment, delete them:
nothing reads them any more.

An image that was changed after the build is refused: the release stays a draft and the
reason is shown on screen.

---

## 5. The board and the flash layout

Everything is built for one target:

| Item | Value |
| --- | --- |
| Board | ESP32-S3 with 16 MB flash and 8 MB octal PSRAM (`N16R8`) |
| Catalog rows | `espressif.esp32-s3-devkitc-1.n16r8` and `espressif.esp32-s3-devkitc-1.v1.1` |
| Compiler options | `PSRAM=opi, FlashSize=16M, PartitionScheme=app3M_fat9M_16MB, CDCOnBoot=cdc` |
| Assembly | `esp32:esp32:esp32s3` |

The partition layout is the built-in `app3M_fat9M_16MB` scheme:

| Region | Offset | Size |
| --- | --- | --- |
| nvs | `0x9000` | 20 KB |
| otadata | `0xE000` | 8 KB |
| app0 | `0x10000` | 3 MB |
| app1 | `0x310000` | 3 MB |
| ffat | `0x610000` | 9.875 MB |
| coredump | `0xFF0000` | 64 KB |

That is why an application image must stay under 3 MB: the two slots are what make a rollback possible. The build fails rather than producing an image that would not fit.

---

## 6. Honest limits

- No controller has been flashed through this pipeline in this environment. The build, the package, the validation and the ZIP round trip are verified; the USB write and the wireless install need a real board and a browser with Web Serial.
- The API address (`https://homecoreos.pages.dev`) and the two TLS trust anchors are compiled in at build time. If you deploy on another domain, change `HC_API_BASE` in the workflow and rebuild.
- The controller reports its firmware version from the value compiled into the image. The ESP-IDF descriptor of this Arduino core holds the core's own build hash, so it is not used as the version.

---

## 7. If something goes wrong

| What you see | What to do |
| --- | --- |
| The workflow fails at *Compile the controller image* | Open the step. A missing include or a compile error is printed with the file and line. |
| The workflow fails at *Verify the package* | The image and the version disagree, or the USB image carries a different application. Re-run with the version that was actually compiled. |
| The upload dialog says *This file is not a ZIP archive* | You selected a `.bin`, or the download was interrupted. Download the ZIP again from the run's Artifacts. |
| The upload dialog says *manifest.json is missing* | The folder was zipped instead of the files. Use the ZIP exactly as downloaded. |
| The upload dialog lists checksum problems | A file inside the ZIP was modified. Build again; never edit a package. |
| The upload dialog says the checksum does not match | The image was changed after the build, or the ZIP came from somewhere other than the GitHub Actions run. Download the release again and upload it unchanged. |
| *This version already exists in the stable channel* | Versions are unique per channel. Build a new version, or archive the old release first. |
| The install page cannot open a serial port | Use Chrome or Edge on a desktop, over https, with a data cable. |
| The controller does not appear after the install | Put it into download mode (hold **BOOT**, tap **RESET**, release **BOOT**) and install again. The read-back check proves the flash contents, not that the board booted. |
| A wireless update never leaves *downloading* | The controller is offline or was powered off. History keeps the last stage it reported. |
