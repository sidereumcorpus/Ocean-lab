# Ocean Lab

A dependency-free, browser-based Ocean Optics / Ocean Insight spectrometer dashboard.
Academic dark mode, native canvas spectrum plot, single and continuous acquisition,
indexed wavelength calibration, and CSV export. USB4000 legacy USB and the existing OBP profile are supported. Demo data is always labeled simulated.

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

1. Refresh the page to load version 1.1, then leave **Instrument profile → Auto**.
2. Choose **Connect USB** and select the USB4000.
3. Leave all endpoint fields blank; USB4000 uses its model-defined endpoint roles.
4. Start with **100000 µs** integration and choose **Capture**.
5. Choose **Load wavelengths** to read the instrument's EEPROM calibration.

Normal trigger mode is set at connection. Supported exposure times are
3800–65535000 µs in 10 µs increments. Shorter shutter-mode exposures are
not implemented. Status readback verifies each integration-time command.

The full USB wire readout contains **3840 uint16 samples**, including
non-active detector regions; the physical sensor has 3648 active elements.
No samples are silently cropped or shifted. The calibration polynomial uses
zero-based readout indices, and the plot and CSV use matching array indices.
Wavelengths assigned to non-active samples are polynomial extrapolations,
not additional usable detector area. Check the instrument's calibrated usable
range when analyzing data.

High-speed USB reads the first 2048 bytes on IN endpoint 6, the remaining
5632 bytes on IN endpoint 2, then consumes and checks the 0x69 synchronization
byte. Full-speed USB reads all 7680 bytes plus sync on IN endpoint 2.
Commands and EEPROM replies use OUT endpoint 1 and IN endpoint 1.

EEPROM slots 1–4 provide ASCII wavelength coefficients; reads validate
command/slot echoes and handle 17- or 18-byte firmware replies. Slot 0
provides a serial fallback when the USB descriptor has no serial number.
The driver never writes EEPROM or firmware.

USB4000 output is labeled **device counts**. No software dark subtraction,
nonlinearity correction, saturation scaling, or separate OBP corrected mode
is implied. This protocol support has mocked tests; physical hardware
validation is still required with your instrument and firmware.

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
- tests/*.test.js — dependency-free protocol tests
- .github/workflows/pages.yml — protocol and syntax checks; Pages uses the main branch root

