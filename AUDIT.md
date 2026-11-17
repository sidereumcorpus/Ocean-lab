# USB4000 / OBP hardware audit — 2026-11-17

Audited baseline: e0ba9bcd18e0557a9c7b74c81acef3df4bd6269a. Updated application: 1.5.0.

## Findings and disposition

| Area | Baseline finding | Resolution |
| --- | --- | --- |
| Protocol selection | USB4000 correctly uses legacy commands, not OBP | Retained VID-only chooser and PID 1022 routing. No OBP frame reaches USB4000. |
| Command/EEPROM endpoints | Correct EP1 OUT/IN | Retained endpoint number 1 in WebUSB; direction selects address 0x01 vs 0x81. |
| High/full speed | Correct split selected by status byte 14 | High: 2048 bytes EP6, 5632 bytes EP2. Full: 7680 bytes EP2. No unsafe fallback/retry after partial high-speed acquisition. |
| Synchronization | 0x69 checked, but no device FIFO reset attempt | Read sync from EP2 after all spectral bytes. Mismatch clears host buffers, attempts USB reset, then closes; reconnect required. If reset fails, close is still attempted; device-side flush cannot then be guaranteed. |
| Pixel interpretation | 3840 samples plotted, including dummy/black/tail | Consume all 7680 bytes, preserve raw frame, expose 3648 active pixels. See index correction below. |
| Optical black | Not exposed | Preserve black samples independently; always-on floating-point baseline subtraction in the USB4000 plot. |
| EEPROM | Wavelengths only, serial fallback; first-null termination | Serial always read from slot 0. ASCII nulls removed, strict finite numeric parsing. Public queued getFactoryCalibration() reads 1–4 wavelength, 5 stray light, 6–13 nonlinearity. No EEPROM writes. |
| Autoscale | Missing | Binary slot 17 full-response bytes 6–7, uint16 LE. Scale 65535/level, round and clamp to uint16. Zero/unprogrammed uses unity gain. |
| Wavelengths | 3840-element extrapolated grid | Corrected in 1.5.1: 3648 elements evaluated at original raw coordinates 21..3668. The earlier reset to active coordinate zero caused the observed 21-pixel left shift. |
| Spectroscopy | No absorbance/%T workflow existed | Added session-only dark/reference acquisition and derived views. Nonpositive corrected signals/denominators and nonfinite results are invalid gaps, never Infinity/epsilon artifacts. |
| Reference validity | No dark/reference state existed | Clear on exposure/mode changes and connection transitions; require matching source, serial, profile, exposure, mode, size and optical-dark setting. |
| Queue | Public transactions already serialized; connection exposed device before initialization ended | Reject public operations while connecting; immutable per-transaction generation tokens protect reconnects using the same USBDevice. |
| Disconnect | Listener existed, but callers depended on outstanding USB promises settling | Session cancellation promptly rejects pending/queued callers, removes listeners, clears calibration and connection state. Late completions cannot issue further old-session reads. |
| Polling | Already awaited scans and dataset writes; no setInterval | Retained completion-driven loop. USB spectrum read itself waits for hardware integration. No integration-time sleep is added after a completed scan. |
| Long sessions | Naive cancellation races could retain callbacks | Abort listeners are removed at transaction completion. No per-frame permanent pending-promise listeners. |
| OBP | Framing, ACK bit, message types already correct | Retained response/ACK distinction, bounded reassembly, IDs and error checks. Added generation check after OUT and across reads. |
| Data provenance | No host scaling metadata | Save active start, raw pixel count, autoscale level and optical-black mean in JSON/CSV. Archived counts stay counts; session-only derived plots are explicitly labeled. |

## Index correction to the proposed checklist

The vendor pixel-definition table numbers pixels **one-based**:

| Vendor pixels | JavaScript indices | Extraction |
| --- | --- | --- |
| 6–18 optical black | 5–17 inclusive | raw.slice(5,18), 13 values |
| 19–21 transition | 18–20 inclusive | excluded |
| 22–3669 optical active | 21–3668 inclusive | raw.slice(21,3669), 3648 values |

Consequently the proposed inclusive raw black indices 5..18 include a transition
pixel, and active slicing after 22 samples would discard the first active pixel
and include a trailing non-active pixel. The implementation follows the vendor
table. The same document also describes software display/readout conventions
imprecisely; the full wire readout is preserved for independent hardware checks.
Python-SeaBreeze exposes a 3840-sample readout with its own narrower black-pixel
subset; it is used here to cross-check transfers and binary saturation layout,
not as evidence for the active-pixel crop.

## EEPROM and saturation details

A host receive capacity of 64 bytes accommodates the EP1 short packet. Replies
must contain 17 or 18 actual bytes and echo [0x05, slot]. Asking for 64 bytes does
not mean firmware must send 64, or that a second read should fill the short reply.

Slot 17 is binary, not ASCII. The first two reply bytes are the command echo;
USB4000 saturation is at reply offsets 6–7, i.e. slot data offsets 4–5. Stray-light
and nonlinearity coefficients are read-only diagnostics; no scientifically
unvalidated correction formula is silently applied.

## Validation and limitations

52 local Node tests pass, including fragmented high/full-speed reads, DataView
offsets, repeated scans/sync, active boundary sentinels, binary gain and clamping,
EEPROM echoes and ancillary slots, concurrent acquisition/setter/EEPROM commands,
timeouts, physical/manual disconnect, same-USBDevice late OBP completion,
spectroscopy invalid inputs, reference compatibility, and metadata backup/CSV.
All ES modules pass syntax checks. These are mocked transport tests, not a
certification of real instrument timing, firmware or absolute wavelength accuracy.

Hardware acceptance remains: compare factory wavelengths and a known isolated
lamp line; verify first/last usable pixels, level scaling and optical-dark mean;
run repeated long-exposure high-speed scans; repeat through a full-speed hub;
unplug during integration and reconnect. Old saved 3840-sample captures are kept
readable. Their alignment profiles require a new capture for the changed grid.

## Sources

- Ocean Optics USB4000 Data Sheet, 211-00000-000-05-201210: pixel definition p. 8; USB endpoints/commands, EEPROM and spectrum format pp. 16–22; status layout p. 29. https://spectrecology.com/wp-content/uploads/2020/11/USB4000-Data-Sheet.pdf
- Python-SeaBreeze primary implementation: FPGA4K split reads and USB4000 saturation mixin (response[6:8]). https://python-seabreeze.readthedocs.io/en/latest/_modules/seabreeze/pyseabreeze/features/spectrometer.html
- Ocean Optics STS OEM data sheet / OBP commands (STS profile only): https://oceanoptics.jp/technical/oem_datasheet_STS.pdf

## 1.5.1 field correction

User comparison with OceanView found an exact 21-pixel displacement. The 1.5.0
audit incorrectly accepted restarting the EEPROM polynomial at zero after
cropping. Wavelengths now evaluate P(activeIndex+21), through P(3668). Tests
compare every retained wavelength against the original coordinate polynomial.
Factory loading is automatic before capture. USB4000 optical-black subtraction
is enforced for both sample and spectroscopy references, independently of the
read-only checkbox. It remains a per-frame black mean, not a claim of exact
OceanView 15-scan temporal filtering. Old archives are preserved, not rewritten.
