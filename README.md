# Ocean Lab

A dependency-free, browser-based Ocean Optics / Ocean Insight spectrometer dashboard.
Academic dark mode, native canvas spectrum plot, single and continuous acquisition,
indexed wavelength calibration, and CSV export. USB4000 and Jaz legacy USB plus the existing OBP profile are supported. Demo data is always labeled simulated.

## Publish on GitHub Pages

GitHub Pages is configured to deploy from the main branch root. Each push
automatically updates https://sidereumcorpus.github.io/Ocean-lab/.

To reproduce the configuration, open
[Settings → Pages](https://github.com/sidereumcorpus/Ocean-lab/settings/pages),
choose **Deploy from a branch**, select **main** and **/(root)**, then save.

The separate **Verify Ocean Lab** workflow checks JavaScript syntax and runs
mocked OBP tests. Branch-based Pages publication runs independently of these
checks; verification is not a deployment gate. No package install or build is required.
Alternatively, serve the root folder with any local HTTP server.
Do not open index.html through file://: ES module loading needs an HTTP origin.

## Compact workspace (version 1.4)

The spectrum, capture/live/stop controls, frame saving and frame CSV export stay
visible while tabs switch the adjacent workspace:

- **Acquire**: integration, sample labels, autosave and optional live recording.
- **Datasets**: capture history, dataset details, backups and collection exports.
- **Calibrate**: separate New alignment and Saved profiles subviews.
- **Activity**: session log.

Device settings and the driver-help guide open in dialogs from the header.
The page fits the viewport on desktop; only the active pane or capture history
scrolls when necessary. On narrow screens the plot sits above the tabbed controls.
Arrow keys, Home and End navigate tabs; active tabs persist for the current browser
session. Switching views never stops a live run or clears forms, profiles or data.

## Single-line wavelength alignment (version 1.3)

1. Connect your spectrometer and illuminate it with an isolated spectral line
   whose wavelength is known accurately. Set a nonsaturating integration time.
2. Choose **Capture reference**. This reads the factory grid and acquires a
   reference spectrum without automatically adding it to a dataset.
3. Enter the **Known line wavelength** in nm. Click the intended peak on the
   plot, or enter its approximate zero-based detector pixel. The search radius
   limits detection to that neighborhood rather than choosing another source line.
4. Choose **Preview alignment**. The app reports fractional peak position,
   factory wavelength, known/aligned wavelength, and proposed offset.
5. Name the profile and choose **Save & use for new captures**. New captures
   use factory wavelength + offset at each pixel; intensities are never resampled.
6. **Use factory calibration** disables alignment for subsequent captures.

The peak center uses three-point parabolic interpolation around the selected
local maximum. Saturated, flat and search-boundary peaks are rejected. This is
an offset-only alignment: one line does not determine wavelength scale or
curvature. Multiple known lines would be required for polynomial recalibration.
Displayed fractional digits do not establish measurement accuracy.

Profiles are stored locally and tied to serial number, hardware/demo source,
instrument protocol, readout size and SHA-256 signature of the factory grid.
An instrument with no serial can preview an offset but cannot save/apply a
persistent profile. After reconnecting, load factory wavelengths (or capture a
reference), then choose a matching saved profile explicitly. Profiles are not
silently enabled at connection. Demo profiles can never align hardware data.

A newly captured spectrum stores a full snapshot of its active calibration,
along with the untouched factory wavelength grid and the aligned wavelength
array. Dataset and individual CSV exports carry calibration ID/name, offset,
reference wavelength, peak pixel and factory wavelength; JSON backups preserve
the full profile snapshot. Importing a dataset does not install or activate
its calibration profiles. Existing version-1 dataset backups still load.

**Existing measurements are not rewritten** when a profile changes. Loading
factory wavelengths now prepares the axis for NEW captures; capture again to
use it. The previous behavior of attaching calibration to an already-saved
capture has been removed. Reference runs never write factory coefficients,
EEPROM or firmware. IndexedDB upgrades preserve existing datasets and frames.

## Datasets (version 1.2)

- **Device not found?** opens an in-app guide for the Windows 10 WinUSB setup,
  using the verified USB4000 VID/PID and official Zadig download.
- Name a dataset and add experiment notes. The active dataset stays selected
  during acquisition. If none exists, saving creates a dated dataset.
- Single captures save automatically by default; uncheck **Save single captures**
  for preview-only work. Demo entry itself is not automatically saved.
- Add a sample label before capturing. **Save current frame** also saves a
  preview or updates the label/calibration of that same capture without duplicates.
- Live mode is preview-only by default. Enable **Record live frames** to save
  at the chosen interval and stop at the frame limit. Integration and storage
  time can make the actual interval longer. Recording never queues USB requests.
- Capture history shows source, integration and peak counts; **Review** displays
  an archived spectrum even when disconnected. Calibration of archived captures
  from another session is disabled; new captures return to the current instrument.
- Loading factory wavelengths or switching alignment prepares NEW captures.
  Previously saved spectra retain their original wavelength axis and metadata.
- **Export dataset CSV** writes long-form rows, one row per pixel per capture,
  with source/profile/serial/settings so different grids remain unambiguous.
- **Backup JSON** preserves notes, spectra, calibration and timestamps. **Import
  JSON** validates the backup and adds a new dataset without replacing existing
  collections. Imports are atomic. Up to 2000 frames per dataset and 256 MB
  per imported backup are supported; the table shows the newest 100 captures.
- Dataset and capture deletion require confirmation. Export a backup first.

Collections use IndexedDB in the current browser/profile on this device. They
survive page refreshes but do not sync between computers. Clearing site data or
using private browsing can remove them; keep JSON backups for important work.
No spectra are uploaded. Storage failures stop recording and leave the displayed
frame available for individual CSV export.

## Use

- Select **Try demo** to explore the interface without hardware.
- On a WebUSB-capable desktop browser, choose **Connect USB** and select the instrument.
- On Windows, bind the appropriate instrument interface to WinUSB using Zadig first.
- Leave **Instrument profile → Auto** for USB4000; its USB ID selects the legacy driver automatically.
- Set integration time in microseconds. USB4000 offers device counts; OBP offers corrected or raw data.
- **Capture** acquires one frame. **Start live** serializes repeated frames.
- **Stop** finishes the pending frame. **Disconnect** cancels USB immediately.
- **Load wavelengths** reads calibration coefficients from the instrument.
- **Export CSV** exports the displayed frame and its acquisition metadata.
  Wavelength cells remain blank until calibration is loaded.

All acquisition and processing occur locally in the browser. The app has no analytics,
external scripts, external fonts, server APIs, or runtime dependencies.

## USB4000 quick start

For the silver USB4000 (VID 0x2457, PID 0x1022):

1. Refresh the page to load version 1.5.1, then leave **Instrument profile → Auto**.
2. Choose **Connect USB** and select the USB4000.
3. Leave all endpoint fields blank; USB4000 uses its model-defined endpoint roles.
4. Start with **100000 µs** integration and choose **Capture**.
5. Factory wavelengths load automatically before capture is enabled. USB4000 electric dark correction is always on; no checkbox setup is needed.

Normal trigger mode is set at connection. Supported exposure times are
3800–65535000 µs in 10 µs increments. Shorter shutter-mode exposures are
not implemented. Status readback verifies each integration-time command.

The full USB wire readout contains **3840 uint16 samples**. To match
OceanView's factory export, new captures return the **first 3648 readout
samples**, `raw.slice(0,3648)`, and wavelengths `P(0)` through `P(3647)`.
This includes the initial dummy/black region; it is not a physical-active-only
crop. The USB4000 manufacturer's physical active region starts at raw index
21, but OceanView's exported pixel convention starts at zero. Cropping that
prefix caused the observed 21-sample displacement. The 1.5.1 wavelength-only
fix did not fix sample numbering; 1.5.2 fixes both together.
Optical black remains `raw.slice(5,18)` and is extracted before windowing.
Old saved captures keep their original data and processing metadata. Recreate
alignment profiles for the changed factory grid; signatures prevent automatic
reuse of profiles from an incompatible grid.

High-speed USB reads the first 2048 bytes on IN endpoint 6, the remaining
5632 bytes on IN endpoint 2, then consumes and checks the 0x69 synchronization
byte. Full-speed status selects all 7680 bytes plus sync on IN endpoint 2.
Commands and EEPROM replies use OUT endpoint 1 and IN endpoint 1. A bad sync
clears host buffers, attempts USB reset to flush device FIFOs, and closes the
session; reconnect is required. Reset failure is followed by close, never an
unbounded drain read or automatic command retry.

EEPROM slot 0 provides serial text; slots 1–4 provide ASCII wavelength
coefficients. Reads validate command/slot echoes, handle 17- or 18-byte short
replies, remove nulls, and reject partial/nonfinite coefficient parses.
`getFactoryCalibration()` additionally reads stray light (5) and eight
nonlinearity coefficients (6–13), without implicitly applying them.
The driver never writes EEPROM or firmware.

Slot 17 stores binary autonulling information. Its saturation uint16 is at
**full response bytes 6–7**, little endian, not the first two data bytes.
Active counts are scaled by 65535/level, rounded to uint16 and clamped at
65535; an unprogrammed zero level uses unity gain. The raw 3840-sample frame
and black samples remain accessible as `lastRawSpectrum` and
`opticalDarkPixels`. New saved captures retain saturation level, readout start
and normalized optical-black mean in JSON and CSV processing metadata.

In **Acquire → Dark, reference & spectroscopy**, capture dark with the source
blocked and a light reference without the sample. Select Absorbance or %T.
Derived views and always-on USB4000 optical-black subtraction are session-only;
archives/exports retain normalized counts and processing metadata. Optical
black subtraction uses floating point so negative noise does not wrap.
Nonpositive dark-corrected sample/reference values and nonfinite results
produce plot gaps, rather than infinities or fabricated epsilon values.
Changing integration time or spectrum mode, connecting, or disconnecting
clears both reference captures. Stored references also require matching
serial, source, protocol, exposure, spectrum type and readout size.

All public driver transactions are serialized. Commands are rejected during
connection initialization, and disconnect cancels both pending and queued
work. Generation tokens prevent old completions from using a re-opened
USBDevice. Live acquisition awaits each scan and save before requesting the
next scan; there is no setInterval acquisition timer.

See [AUDIT.md](AUDIT.md) for findings, source details and hardware acceptance
checks. Tests use mocked USB; physical hardware validation remains required.

[USB4000 vendor data sheet](https://spectrecology.com/wp-content/uploads/2020/11/USB4000-Data-Sheet.pdf)

## Hardware scope

Vendor-only selection uses USB VID 0x2457. This does **not** establish protocol
compatibility: not every Ocean instrument uses OBP or this spectrum encoding.
USB4000 PID 0x1022 selects its dedicated legacy driver. Other legacy-protocol
Flame/USB-family variants are not supported by merely selecting them.

The OBP STS profile uses:
- Corrected uint16 spectrum: 0x00101000
- Raw uint16 spectrum: 0x00101100
- Set integration time: 0x00110010
- Wavelength coefficient count: 0x00180100
- Indexed float32 wavelength coefficient: 0x00180101

These spectrum command labels intentionally follow the STS manual, correcting
the reversed labels in the original brief. Advanced settings allow command and
endpoint overrides; changing commands cannot add support for float32 spectra,
model-specific metadata or a different protocol.

[STS vendor data sheet](https://oceanoptics.jp/technical/oem_datasheet_STS.pdf)

Use a full, contiguous, unbinned detector readout. Pixel count is inferred from
a full spectrum, and wavelength polynomial indices start at zero. Partial spectra,
binning, streaming, external triggering and multi-scan modes need model-specific
handling. Firmware enforces integration-time limits.

USB descriptors do not identify application protocols. The first suitable interface
is selected; ambiguous IN/OUT endpoint lists require explicit endpoint numbers
in advanced settings. Provide endpoint **numbers**, not addresses such as 0x81.

## OBP driver behavior

- Little-endian framing: 44-byte header, optional external payload, 20-byte footer.
- Up to 16 bytes use the immediate-data area.
- ACK request is bit 2 (0x0004); query requests do not generate extra ACKs.
- Reassembles responses across transfers, including frames larger than 8192 bytes.
- Validates magic, length, error flags and request correlation.
- Checksum type 0 only; other types are rejected rather than silently ignored.
- Complete transactions are serialized to prevent response mixing.
- Errors and timeouts close the session. Reconnect and explicitly restore settings;
  commands are never automatically retried.
- The timeout extends for a single integration; adjust the minimum for longer
  device operations. WebUSB supplies no transfer AbortSignal, so timeout recovery
  closes the USB device.

## Verification

Run with Node 22 or newer:

```sh
npm run check
npm test
```

Tests cover immediate/external payload boundaries, endian encoding, DataView offsets,
corrupt frames, fragmented large responses, ACK consumption, indexed wavelength
calibration, request mismatches and timeout cleanup. USB4000 tests cover
profile selection, both USB speeds, fragmented spectrum transfers, synchronization,
EEPROM reply variants, calibration parsing, integration readback, cancellation
and timeout cleanup.

Mocked protocol tests are not a substitute for physical instrument validation.
Hardware compatibility and real USB behavior require testing with the target model.

## Files

- index.html / style.css — responsive dashboard
- app.js — UI, acquisition controls, plotting and export
- ocean-obp.js — reusable ES6 OBP WebUSB driver
- usb4000.js — legacy USB4000 driver
- spectrometer.js — vendor-only chooser and USB4000 protocol detection
- datasets.js / dataset-ui.js — IndexedDB collections, capture history and portable exports
- calibration.js / calibration-ui.js — single-line peak alignment and persistent calibration profiles
- tests/*.test.js — dependency-free protocol tests
- .github/workflows/pages.yml — protocol and syntax checks; Pages uses the main branch root


Factory loading introduced in version 1.5.1 automatically loads factory wavelengths on connection (including demo).
Use Reload factory wavelengths under device details only when needed. Previously
saved captures retain their original axes; recapture affected measurements and
recreate any alignment profiles made with the old, shifted factory grid. Grid
signatures prevent those profiles from being applied to the corrected axis.

Version 1.5.2 supersedes the 1.5.1 shifted-window convention: both sample p and
factory wavelength P(p) now use original raw pixel p, matching OceanView.

## Jaz USB support (1.6.0)

Leave the profile on **Auto** and select the Jaz (`2457:2000`). Factory
wavelengths load automatically and electric-dark subtraction stays on. Windows
requires WinUSB bound to the Jaz, just as for USB4000. Help now lists both IDs.

For a multi-spectrometer Jaz stack, choose **Device settings → Jaz channel**
before connecting (zero-based, default 0). The driver queries spectrometer count
with C0, rejects empty stacks/out-of-range channels, and selects C1/channel before
reading module serial/calibration. One channel per connection is supported;
disconnect to change it. The count is not a count of unrelated lamp/battery
modules. Module serial and channel are retained in saved data; calibration grid
signatures and dark/reference state distinguish channels. No simultaneous
multi-channel acquisition or Ethernet support is implemented.

Jaz uses legacy EP1 OUT commands and EP1 IN EEPROM replies. Spectrum command 09
reads exactly **4096 bytes / 2048 uint16 LE pixels on EP2**, at both high and full
speed. There is **no sync byte**, no USB4000 split onto EP6, no USB4000 FE status
query and no OBP framing. Wavelengths use EEPROM slots 1–4 at original pixel
indices 0–2047. Slot 17 reply offsets 6–7 supply saturation scaling; zero uses
unity gain. Optical black uses raw indices 2–23, matching SeaBreeze JAZ.
Jaz ASCII replies terminate at the first null; later garbage is ignored.

Integration changes are cached by Jaz's processor and take effect at the next
spectrum request; no ACK or undocumented status read is expected. A known
100000 µs exposure is established on connection. The OEM clock has four
significant digits and at best 10 µs resolution. Ocean Lab rejects values that
cannot be represented: 10 µs steps below 100000; 100 µs below 1000000; 1000 µs
below 10000000; and 10000 µs thereafter. The supported representable range is
1000–65530000 µs. No lamp, strobe, EEPROM or firmware writes are performed.

Factory loading, capture/live, datasets, CSV/JSON backup, dark/reference views
and wavelength alignment are integrated. Stored intensity arrays remain scaled
counts; electric-dark/absorbance/transmittance views remain session processing.
Jaz support is verified using mocked USB transports; compare the selected module
against OceanView before relying on physical measurements.

Sources: [Jaz OEM data sheet 013-RD000-000-05-201109, USB pp.14–23](https://www.rktech.hu/dokumentaciok/OceanOptics/Spectrometers/Jaz%20OEM%20Data%20Sheet.pdf)
and [SeaBreeze JAZ configuration](https://python-seabreeze.readthedocs.io/en/latest/_modules/seabreeze/pyseabreeze/devices.html).

### Jaz startup troubleshooting (1.6.1)

Jaz must finish booting to its menu before USB acquisition. The driver now retries
only a valid zero-valued C0 module-count reply, up to 20 queries separated by
500 ms, under the transaction deadline. It reports startup progress in Session
activity and reports the actual decimal/hex byte on failure. Unexpected bytes
and extra reply data fail immediately rather than being guessed or ignored.
Disconnect cancels the startup delay. No channel/EEPROM/spectrum command is sent
unless a valid nonzero count has been received.

If zero persists, restart Jaz, allowing 10–15 seconds off before powering it on,
wait for the menu, and reconnect. Additional stack modules can require the
approved Jaz external supply. A zero count is not proof that the module is
broken, nor does retrying guarantee recovery. See the vendor's troubleshooting
section: https://www.oceanoptics.com/wp-content/uploads/2024/12/Jaz-Installation-and-Operation-Instructions.pdf

### Jaz C0 response framing (1.6.2)

A field screenshot showed startup returning byte C0 (192) while the Jaz was
already at its menu. That byte equals the request command; it is not a valid
module count. The parser now accepts either [count] or [C0, count], including
an echo and data delivered by separate USB transfers. The latter is a
compatibility hypothesis supported by the observed prefix, not a confirmed
complete capture of this unit's firmware response. After C0, the driver waits
at most 2 seconds for a count; an echo alone fails with an explicit diagnostic,
closes the session and issues no channel/acquisition commands. Extra bytes,
repeated echoes and counts outside 0–15 are rejected. Valid zero counts still
use the bounded boot retry path. This does not bypass module discovery.

The on-device stack position (e.g. Module #2) is not automatically the zero-based
USB spectrometer channel. Module serial numbers are read from EEPROM; no serial
or firmware values from photographs are hard-coded into the driver.
