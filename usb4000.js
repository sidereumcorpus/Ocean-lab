import { OceanOBPSpectrometer } from './ocean-obp.js';

/**
 * USB4000 legacy USB driver (VID 2457, PID 1022).
 * Reference: Ocean Optics USB4000 Data Sheet 211-00000-000-05-201210,
 * USB command descriptions, pp. 16–22 and status format p. 29.
 *
 * Inherits only the session lifecycle and transaction queue from the OBP
 * driver. Every USB4000 command and response uses the legacy wire format.
 * No EEPROM writes, gain normalization, dark subtraction or nonlinearity
 * correction are performed. Values are unchanged device counts.
 */
export class USB4000Spectrometer extends OceanOBPSpectrometer {
  constructor(options = {}) {
    super(options);
    this.profile = 'usb4000';
    this.pixelCount = 3840; // Complete wire readout, including non-active samples.
    this.minIntegrationTime = 3800; // Normal mode; shorter exposures need shutter mode.
    this.maxIntegrationTime = 65535000;
    this.serialNumber = '';
    this.highSpeed = null;
    this._buffers = new Map();
  }

  async connect(selectedDevice = null) {
    if (typeof navigator === 'undefined' || !navigator.usb || !globalThis.isSecureContext) {
      throw new Error('WebUSB requires a supported browser and HTTPS or localhost.');
    }
    if (this.device || this._connecting || this._closing) {
      throw new Error('A connection operation is already active.');
    }
    this._usb = navigator.usb;
    this._connecting = true;
    const generation = this._generation;
    const check = () => {
      if (generation !== this._generation) throw new Error('Connection cancelled.');
    };
    let device, claimed = null;
    try {
      device = selectedDevice || await this._usb.requestDevice({ filters: [{ vendorId: 0x2457 }] });
      if (device.vendorId !== 0x2457 || device.productId !== 0x1022) {
        throw new Error('The USB4000 profile requires VID 2457 / PID 1022.');
      }
      check();
      await device.open();
      check();
      if (!device.configuration) {
        const configuration = device.configurations[0];
        if (!configuration) throw new Error('Device has no USB configuration.');
        await device.selectConfiguration(configuration.configurationValue);
      }
      check();
      // USB4000 roles are model-defined. Do not guess among its three IN
      // endpoints using the generic OBP endpoint override fields.
      const candidates = [];
      for (const iface of device.configuration.interfaces) {
        if (this.options.interfaceNumber !== null &&
            iface.interfaceNumber !== this.options.interfaceNumber) continue;
        for (const alt of iface.alternates) {
          if (this.options.alternateSetting !== null &&
              alt.alternateSetting !== this.options.alternateSetting) continue;
          const find = (direction, number) => alt.endpoints.find(ep =>
            ep.type === 'bulk' && ep.direction === direction && ep.endpointNumber === number);
          if (find('out',1) && find('in',1) && find('in',2)) {
            candidates.push({ iface, alt, find });
          }
        }
      }
      candidates.sort((a,b) => a.iface.interfaceNumber - b.iface.interfaceNumber ||
        a.alt.alternateSetting - b.alt.alternateSetting);
      const chosen = candidates[0];
      if (!chosen) throw new Error('USB4000 command and spectrum endpoints are unavailable. Check WinUSB binding.');
      await device.claimInterface(chosen.iface.interfaceNumber);
      claimed = chosen.iface.interfaceNumber;
      check();
      if (chosen.iface.alternate.alternateSetting !== chosen.alt.alternateSetting) {
        await device.selectAlternateInterface(claimed, chosen.alt.alternateSetting);
      }
      await new Promise(resolve => setTimeout(resolve, this.options.startupDelayMs));
      check();
      this.device = device;
      this._buffers.clear();
      this._usb.addEventListener('disconnect', this._removed);
      this._endpoints = new Map(chosen.alt.endpoints.filter(ep =>
        ep.type === 'bulk' && ep.direction === 'in').map(ep => [ep.endpointNumber,ep.packetSize]));
      await this._transaction(async session => {
        await this._write(session, Uint8Array.of(0x01)); // Initialize.
        await this._write(session, Uint8Array.of(0x0a,0,0)); // Normal trigger mode.
        const status = await this._status(session);
        this.highSpeed = status[14] === 0x80;
        if (![0,0x80].includes(status[14])) throw new Error('Unknown USB4000 USB speed status.');
        if (this.highSpeed && !chosen.find('in',6)) {
          throw new Error('High-speed USB4000 requires bulk IN endpoint 6.');
        }
        this.integrationTime = new DataView(status.buffer, status.byteOffset).getUint32(2,true);
        this.serialNumber = device.serialNumber || await this._readSlot(session,0);
      });
      check();
      this.pixelCount = 3840;
      return this;
    } catch (error) {
      if (this.device === device) this._invalidate();
      if (device && device.opened) {
        if (claimed !== null) {
          try { await device.releaseInterface(claimed); } catch (_) {}
        }
        try { await device.close(); } catch (_) {}
      }
      throw error;
    } finally {
      this._connecting = false;
    }
  }

  _invalidate() {
    super._invalidate();
    if (this._buffers) this._buffers.clear();
    this.serialNumber = '';
    this.highSpeed = null;
  }

  async _write(device, bytes) {
    this._checkSession(device);
    const result = await device.transferOut(1, bytes);
    this._checkSession(device);
    if (result.status !== 'ok' || result.bytesWritten !== bytes.length) {
      throw new Error('USB4000 command transfer failed: ' + result.status);
    }
  }

  _checkSession(device) {
    if (!device || this.device !== device || !device.opened) throw new Error('USB4000 session closed.');
  }

  /** Preserve any bytes after the requested logical unit, e.g. the sync byte. */
  async _readBytes(device, endpoint, count) {
    this._checkSession(device);
    let buffer = this._buffers.get(endpoint) || new Uint8Array(0);
    const packetSize = this._endpoints.get(endpoint);
    if (!packetSize) throw new Error('Missing USB4000 endpoint ' + endpoint);
    while (buffer.length < count) {
      const needed = count - buffer.length;
      const length = Math.ceil(needed / packetSize) * packetSize;
      const result = await device.transferIn(endpoint, length);
      this._checkSession(device);
      if (result.status !== 'ok' || !result.data) {
        throw new Error('USB4000 IN endpoint ' + endpoint + ' failed: ' + result.status);
      }
      const bytes = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
      if (!bytes.length) throw new Error('USB4000 returned an empty/truncated response. Reconnect the device.');
      if (buffer.length + bytes.length > 8192) throw new Error('USB4000 response exceeds buffer limit.');
      const combined = new Uint8Array(buffer.length + bytes.length);
      combined.set(buffer); combined.set(bytes,buffer.length); buffer = combined;
    }
    this._buffers.set(endpoint,buffer.slice(count));
    return buffer.slice(0,count);
  }

  async _status(device) {
    await this._write(device,Uint8Array.of(0xfe));
    const status = await this._readBytes(device,1,16);
    const pixels = new DataView(status.buffer).getUint16(0,true);
    // Some revisions report physical pixel count rather than wire count.
    if (pixels !== 3840 && pixels !== 3648) {
      throw new Error('Unsupported USB4000 pixel count: ' + pixels);
    }
    return status;
  }

  async _readSlot(device,index) {
    await this._write(device,Uint8Array.of(0x05,index));
    // Firmware replies are a single short USB packet, usually 17 or 18 bytes
    // total. Do not wait for byte 18 on revisions returning only 17 bytes.
    const result = await device.transferIn(1,64);
    this._checkSession(device);
    if (result.status !== 'ok' || !result.data ||
        ![17,18].includes(result.data.byteLength)) {
      throw new Error('Invalid USB4000 EEPROM reply length/status.');
    }
    const bytes = new Uint8Array(result.data.buffer,result.data.byteOffset,result.data.byteLength);
    if (bytes[0] !== 0x05 || bytes[1] !== index) {
      throw new Error('USB4000 EEPROM response does not match slot ' + index);
    }
    const text = new TextDecoder('ascii').decode(bytes.slice(2));
    return text.split('\0')[0].trim();
  }

  async setIntegrationTime(microseconds) {
    if (!Number.isInteger(microseconds) || microseconds < this.minIntegrationTime ||
        microseconds > this.maxIntegrationTime) {
      throw new RangeError('USB4000 normal-mode integration time must be 3800–65535000 µs.');
    }
    // Resolution above the shutter-mode threshold is 10 µs. Avoid silently
    // exporting an integration time different from the one sent to hardware.
    if (microseconds % 10) throw new RangeError('USB4000 integration time must use 10 µs increments.');
    return this._enqueue(() => this._transaction(async device => {
      const bytes = new Uint8Array(5); bytes[0] = 0x02;
      new DataView(bytes.buffer).setUint32(1,microseconds,true);
      await this._write(device,bytes); // No OBP frame and no USB ACK response.
      const status = await this._status(device);
      const actual = new DataView(status.buffer).getUint32(2,true);
      if (actual !== microseconds) {
        throw new Error('USB4000 did not accept integration time (reported ' + actual + ' µs).');
      }
      this.integrationTime = actual;
    }));
  }

  async getSpectrum({raw = true} = {}) {
    if (!raw) throw new Error('USB4000 supports device counts; OBP corrected mode is unavailable.');
    return this._enqueue(() => this._transaction(async device => {
      await this._write(device,Uint8Array.of(0x09));
      const data = new Uint8Array(7680);
      if (this.highSpeed) {
        data.set(await this._readBytes(device,6,2048));
        data.set(await this._readBytes(device,2,5632),2048);
      } else {
        data.set(await this._readBytes(device,2,7680));
      }
      const sync = await this._readBytes(device,2,1);
      if (sync[0] !== 0x69) throw new Error('USB4000 spectrum synchronization failed. Reconnect.');
      if ([...this._buffers.values()].some(bytes => bytes.length)) {
        throw new Error('Unexpected trailing USB4000 data. Reconnect.');
      }
      const result = new Uint16Array(3840), view = new DataView(data.buffer);
      for (let p = 0; p < result.length; p++) result[p] = view.getUint16(p*2,true);
      this.pixelCount = result.length;
      return result;
    }));
  }

  async getWavelengths() {
    return this._enqueue(() => this._transaction(async device => {
      if (!this._coefficients) {
        const coefficients = [];
        for (let slot = 1; slot <= 4; slot++) {
          const text = await this._readSlot(device,slot);
          // Reject partial parses, erased EEPROM and non-finite values.
          if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(text)) {
            throw new Error('Invalid USB4000 wavelength coefficient in EEPROM slot ' + slot);
          }
          const value = Number(text);
          if (!Number.isFinite(value)) throw new Error('Non-finite wavelength calibration.');
          coefficients.push(value);
        }
        if (coefficients.slice(1).every(value => value === 0)) {
          throw new Error('USB4000 wavelength calibration is constant/invalid.');
        }
        this._coefficients = coefficients;
      }
      const wavelengths = new Float64Array(3840);
      for (let p = 0; p < wavelengths.length; p++) {
        const c = this._coefficients;
        wavelengths[p] = ((c[3]*p+c[2])*p+c[1])*p+c[0];
        if (!Number.isFinite(wavelengths[p])) throw new Error('Invalid wavelength polynomial.');
      }
      return wavelengths;
    }));
  }

  async _transaction(operation) {
    const device = this.device;
    this._checkSession(device);
    let timer;
    const timeoutMs = Math.max(this.options.timeoutMs,
      this.integrationTime === null ? 0 : this.integrationTime/1000+5000);
    const timeout = new Promise((_,reject) => {
      timer = setTimeout(() => reject(new Error('USB4000 transaction timed out. Reconnect to continue.')),timeoutMs);
    });
    // Pass the captured session into every transfer to prevent late work from
    // crossing a disconnect/reconnect boundary. Never retry legacy commands.
    const work = Promise.resolve().then(() => operation(device));
    try { return await Promise.race([work,timeout]); }
    catch (error) {
      if (this.device === device) {
        try { await this.disconnect(); } catch (_) {}
      }
      throw error;
    } finally { clearTimeout(timer); }
  }
}
