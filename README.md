# Ocean Lab

A dependency-free, browser-based Ocean Optics / Ocean Insight spectrometer dashboard.
Academic dark mode, native canvas spectrum plot, single and continuous acquisition,
indexed wavelength calibration, and CSV export. Demo data is always labeled simulated.

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
- Set integration time in microseconds and choose corrected or raw data.
- **Capture** acquires one frame. **Start live** serializes repeated frames.
- **Stop** finishes the pending frame. **Disconnect** cancels USB immediately.
- **Load wavelengths** reads calibration coefficients from the instrument.
- **Export CSV** exports the displayed frame and its acquisition metadata.
  Wavelength cells remain blank until calibration is loaded.

All acquisition and processing occur locally in the browser. The app has no analytics,
external scripts, external fonts, server APIs, or runtime dependencies.

## Hardware scope

Vendor-only selection uses USB VID 0x2457. This does **not** establish protocol
compatibility: not every Ocean instrument uses OBP or this spectrum encoding.
Legacy-protocol Flame/USB-family variants are not supported by merely selecting them.

The default STS profile uses:
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

## Driver behavior

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
calibration, request mismatches and timeout cleanup.

Mocked protocol tests are not a substitute for physical instrument validation.
Hardware compatibility and real USB behavior require testing with the target model.

## Files

- index.html / style.css — responsive dashboard
- app.js — UI, acquisition controls, plotting and export
- ocean-obp.js — reusable ES6 WebUSB driver
- tests/obp.test.js — dependency-free protocol tests
- .github/workflows/pages.yml — protocol and syntax checks; Pages uses the main branch root
