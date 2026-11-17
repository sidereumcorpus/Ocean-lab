/**
 * Browser-only Ocean Binary Protocol driver; no runtime dependencies.
 * Defaults are the STS uint16 profile, not a universal Ocean device driver.
 * Endpoint numbers are discovered from descriptors; ambiguous bulk endpoints
 * require explicit selection because descriptors do not identify OBP roles.
 */
export class OceanOBPSpectrometer {
  constructor(options = {}) {
    this.options = Object.assign({
      protocolVersion: 0x1100,
      interfaceNumber: null,
      alternateSetting: null,
      inEndpoint: null,
      outEndpoint: null,
      correctedSpectrumType: 0x00101000,
      rawSpectrumType: 0x00101100,
      timeoutMs: 15000,
      startupDelayMs: 1000,
      maxPacketBytes: 1048576
    }, options);
    const integer = (name, min, max, nullable = false) => {
      const v = this.options[name];
      if (nullable && v === null) return;
      if (!Number.isInteger(v) || v < min || v > max) {
        throw new RangeError(name + " is outside its allowed integer range.");
      }
    };
    integer("protocolVersion", 0, 0xffff);
    integer("interfaceNumber", 0, 255, true);
    integer("alternateSetting", 0, 255, true);
    integer("inEndpoint", 1, 15, true);
    integer("outEndpoint", 1, 15, true);
    integer("correctedSpectrumType", 0, 0xffffffff);
    integer("rawSpectrumType", 0, 0xffffffff);
    integer("timeoutMs", 1, 0x7fffffff);
    integer("startupDelayMs", 0, 0x7fffffff);
    integer("maxPacketBytes", 64, 67108864);
    this.device = null;
    this._in = null;
    this._out = null;
    this._packetSize = 64;
    this._tail = Promise.resolve();
    this._generation = 0;
    this._sequence = 0;
    this._connecting = false;
    this._closing = null;
    this._rx = new Uint8Array(0);
    this._coefficients = null;
    this.pixelCount = null;
    this.integrationTime = null;
    this.onDisconnect = null;
    this._usb = null;
    this._removed = event => {
      if (event.device !== this.device) return;
      this._invalidate();
      if (this.onDisconnect) this.onDisconnect();
    };
  }

  get connected() {
    return Boolean(this.device && this.device.opened && !this._closing);
  }

  /** Invoke directly from a user gesture to preserve USB chooser activation. */
  async connect(selectedDevice = null) {
    if (typeof navigator === "undefined" || !navigator.usb ||
        !globalThis.isSecureContext) {
      throw new Error("WebUSB requires a supported browser and HTTPS or localhost.");
    }
    if (this.device || this._connecting || this._closing) {
      throw new Error("A connection operation is already active.");
    }
    this._usb = navigator.usb;
    this._connecting = true;
    const generation = this._generation;
    let device;
    let claimed = null;
    const check = () => {
      if (generation !== this._generation) throw new Error("Connection cancelled.");
    };
    try {
      device = selectedDevice || await this._usb.requestDevice({ filters: [{ vendorId: 0x2457 }] });
      if (device.vendorId !== 0x2457) throw new Error("Not an Ocean Optics device.");
      if (device.productId === 0x1022) {
        throw new Error("USB4000 requires the legacy driver; select Auto or USB4000.");
      }
      check();
      await device.open();
      check();
      if (!device.configuration) {
        const config = device.configurations[0];
        if (!config) throw new Error("No USB configuration available.");
        await device.selectConfiguration(config.configurationValue);
      }
      check();
      const candidates = [];
      for (const iface of device.configuration.interfaces) {
        if (this.options.interfaceNumber !== null &&
            iface.interfaceNumber !== this.options.interfaceNumber) continue;
        for (const alt of iface.alternates) {
          if (this.options.alternateSetting !== null &&
              alt.alternateSetting !== this.options.alternateSetting) continue;
          const ins = alt.endpoints.filter(e =>
            e.type === "bulk" && e.direction === "in");
          const outs = alt.endpoints.filter(e =>
            e.type === "bulk" && e.direction === "out");
          if (ins.length && outs.length) candidates.push({ iface, alt, ins, outs });
        }
      }
      candidates.sort((a,b) =>
        a.iface.interfaceNumber - b.iface.interfaceNumber ||
        a.alt.alternateSetting - b.alt.alternateSetting);
      const chosen = candidates[0];
      if (!chosen) throw new Error("No matching bulk IN/OUT interface found.");
      const endpoint = (items, number, direction) => {
        if (number !== null) {
          const found = items.find(e => e.endpointNumber === number);
          if (!found) throw new Error("Requested bulk " + direction + " endpoint absent.");
          return found;
        }
        if (items.length !== 1) {
          throw new Error("Multiple bulk " + direction +
            " endpoints. Specify the OBP endpoint number in advanced settings.");
        }
        return items[0];
      };
      const input = endpoint(chosen.ins, this.options.inEndpoint, "IN");
      const output = endpoint(chosen.outs, this.options.outEndpoint, "OUT");
      await device.claimInterface(chosen.iface.interfaceNumber);
      claimed = chosen.iface.interfaceNumber;
      check();
      if (chosen.iface.alternate.alternateSetting !== chosen.alt.alternateSetting) {
        await device.selectAlternateInterface(claimed, chosen.alt.alternateSetting);
      }
      // Allow STS-class instruments to finish startup baseline measurements.
      await new Promise(resolve => setTimeout(resolve, this.options.startupDelayMs));
      check();
      this.device = device;
      this._in = input.endpointNumber;
      this._out = output.endpointNumber;
      this._packetSize = input.packetSize;
      this._usb.addEventListener("disconnect", this._removed);
      return this;
    } catch (error) {
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
    if (this._usb) this._usb.removeEventListener("disconnect", this._removed);
    this._generation++;
    this.device = null;
    this._rx = new Uint8Array(0);
    this._coefficients = null;
    this.pixelCount = null;
    this.integrationTime = null;
  }

  /** Close immediately rather than waiting behind a possibly blocked read. */
  async disconnect() {
    if (this._closing) return this._closing;
    const device = this.device;
    this._invalidate();
    if (!device) return;
    this._closing = (async () => {
      // close releases claimed interfaces and cancels outstanding transfers.
      if (device.opened) await device.close();
    })();
    try { await this._closing; }
    finally { this._closing = null; }
  }

  _enqueue(operation) {
    const generation = this._generation;
    const result = this._tail.then(() => {
      if (!this.connected || generation !== this._generation) {
        throw new Error("Device disconnected or session changed.");
      }
      return operation();
    });
    this._tail = result.catch(() => {});
    return result;
  }

  async setIntegrationTime(microseconds) {
    if (!Number.isInteger(microseconds) ||
        microseconds < 1 || microseconds > 0xffffffff) {
      throw new RangeError("Integration time must be an integer 1..4294967295 µs.");
    }
    return this._enqueue(async () => {
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setUint32(0, microseconds, true);
      // Setters normally have no response; request and consume their ACK.
      await this._exchange(0x00110010, bytes, true);
      this.integrationTime = microseconds;
    });
  }

  async getSpectrum({ raw = false } = {}) {
    return this._enqueue(() => this._getSpectrum(raw));
  }

  async _getSpectrum(raw) {
    const reply = await this._exchange(raw
      ? this.options.rawSpectrumType : this.options.correctedSpectrumType);
    const bytes = reply.payload;
    if (!bytes.length || bytes.length % 2) {
      throw new Error("Expected a nonempty uint16 spectrum payload.");
    }
    const count = bytes.length / 2;
    if (this.pixelCount !== null && this.pixelCount !== count) {
      throw new Error("Detector output length changed. Reconnect after changing binning.");
    }
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = new Uint16Array(count);
    for (let i = 0; i < count; i++) result[i] = data.getUint16(i * 2, true);
    this.pixelCount = count;
    return result;
  }

  async getWavelengths() {
    return this._enqueue(async () => {
      if (!this._coefficients) {
        const response = await this._exchange(0x00180100);
        if (response.payload.length !== 1 || !response.payload[0]) {
          throw new Error("Invalid wavelength coefficient count.");
        }
        const coefficients = new Float64Array(response.payload[0]);
        for (let i = 0; i < coefficients.length; i++) {
          const reply = await this._exchange(0x00180101, Uint8Array.of(i));
          if (reply.payload.length !== 4) {
            throw new Error("Coefficient " + i + ": expected float32.");
          }
          const value = new DataView(
            reply.payload.buffer, reply.payload.byteOffset, 4
          ).getFloat32(0, true);
          if (!Number.isFinite(value)) throw new Error("Invalid calibration coefficient.");
          coefficients[i] = value;
        }
        this._coefficients = coefficients;
      }
      // Coefficients do not reveal detector count. Infer it from a full frame.
      if (this.pixelCount === null) await this._getSpectrum(false);
      const result = new Float64Array(this.pixelCount);
      for (let p = 0; p < result.length; p++) {
        let wavelength = 0;
        for (let j = this._coefficients.length - 1; j >= 0; j--) {
          wavelength = wavelength * p + this._coefficients[j];
        }
        if (!Number.isFinite(wavelength)) throw new Error("Invalid wavelength polynomial.");
        result[p] = wavelength;
      }
      return result;
    });
  }

  /** 44-byte header + optional external data + 20-byte footer, little endian. */
  _buildOBPPacket(type, payload = new Uint8Array(0), flags = 0, regarding = 0) {
    if (!Number.isInteger(type) || type < 0 || type > 0xffffffff) {
      throw new RangeError("Invalid OBP message type.");
    }
    if (!(payload instanceof Uint8Array)) throw new TypeError("Expected Uint8Array.");
    const immediate = payload.length <= 16;
    const external = immediate ? 0 : payload.length;
    if (64 + external > this.options.maxPacketBytes) throw new Error("Packet too large.");
    const packet = new Uint8Array(64 + external);
    const view = new DataView(packet.buffer);
    packet.set([0xc1,0xc0]);
    view.setUint16(2, this.options.protocolVersion, true);
    view.setUint16(4, flags, true);
    view.setUint32(8, type, true);
    view.setUint32(12, regarding, true);
    // New allocations zero error, reserved bytes, checksum type and checksum.
    packet[23] = immediate ? payload.length : 0;
    packet.set(payload, immediate ? 24 : 44);
    view.setUint32(40, external + 20, true);
    packet.set([0xc5,0xc4,0xc3,0xc2], packet.length - 4);
    return packet;
  }

  /** Parse one complete frame, including non-zero DataView byte offsets. */
  _parseOBPResponse(view) {
    if (!(view instanceof DataView) || view.byteLength < 64) {
      throw new Error("Truncated OBP response.");
    }
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const remaining = view.getUint32(40, true);
    if (bytes[0] !== 0xc1 || bytes[1] !== 0xc0) throw new Error("Invalid OBP start.");
    if (remaining < 20 || 44 + remaining !== bytes.length ||
        bytes.length > this.options.maxPacketBytes) throw new Error("Invalid OBP length.");
    const end = bytes.length - 4;
    if (![0xc5,0xc4,0xc3,0xc2].every((v,i) => bytes[end+i] === v)) {
      throw new Error("Invalid OBP footer.");
    }
    if (bytes[22] !== 0) throw new Error("Checksummed responses are unsupported.");
    if (bytes[23] > 16) throw new Error("Invalid immediate-data length.");
    const flags = view.getUint16(4, true);
    const errorNumber = view.getUint16(6, true);
    if (errorNumber || (flags & 0x18)) {
      throw new Error("OBP device error " + errorNumber +
        "; flags 0x" + flags.toString(16) + ".");
    }
    return {
      flags,
      messageType: view.getUint32(8, true),
      regarding: view.getUint32(12, true),
      payload: remaining > 20
        ? bytes.slice(44, bytes.length - 20)
        : bytes.slice(24, 24 + bytes[23])
    };
  }

  /** USB packet/transfer boundaries are independent of OBP frame boundaries. */
  async _readOBPFrame(device) {
    let expected = null;
    while (true) {
      if (this.device !== device) throw new Error("USB session closed.");
      if (expected === null && this._rx.length >= 44) {
        if (this._rx[0] !== 0xc1 || this._rx[1] !== 0xc0) {
          throw new Error("Invalid OBP receive stream.");
        }
        const remaining = new DataView(
          this._rx.buffer, this._rx.byteOffset, this._rx.byteLength
        ).getUint32(40, true);
        expected = 44 + remaining;
        if (remaining < 20 || expected > this.options.maxPacketBytes) {
          throw new Error("Invalid or excessive response length.");
        }
      }
      if (expected !== null && this._rx.length >= expected) {
        if (this._rx.length !== expected) {
          throw new Error("Unexpected extra USB data; streaming mode may be enabled.");
        }
        const frame = this._rx;
        this._rx = new Uint8Array(0);
        return new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      }
      const needed = expected === null ? 8192 : Math.min(8192, expected-this._rx.length);
      // A full USB packet must fit in the host's receive buffer.
      const length = Math.ceil(needed / this._packetSize) * this._packetSize;
      const result = await device.transferIn(this._in, length);
      if (this.device !== device) throw new Error("USB session closed.");
      if (result.status !== "ok" || !result.data) {
        throw new Error("USB IN failed: " + result.status + ".");
      }
      const chunk = new Uint8Array(
        result.data.buffer, result.data.byteOffset, result.data.byteLength);
      if (!chunk.length) continue; // Zero-length packet; transaction deadline still applies.
      if (this._rx.length + chunk.length > this.options.maxPacketBytes) {
        throw new Error("Receive buffer limit exceeded.");
      }
      const combined = new Uint8Array(this._rx.length + chunk.length);
      combined.set(this._rx);
      combined.set(chunk, this._rx.length);
      this._rx = combined;
    }
  }

  async _exchange(type, payload = new Uint8Array(0), ack = false) {
    if (!this.connected) throw new Error("Spectrometer is disconnected.");
    const device = this.device;
    const id = this._sequence = (this._sequence + 1) >>> 0;
    // ACK requested is bit 2 (0x0004), not the response bit (0x0001).
    const packet = this._buildOBPPacket(type, payload, ack ? 0x0004 : 0, id);
    const timeoutMs = Math.max(
      this.options.timeoutMs, this.integrationTime === null ? 0 : this.integrationTime / 1000 + 5000);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("USB transaction timed out.")), timeoutMs);
    });
    const operation = (async () => {
      const written = await device.transferOut(this._out, packet);
      if (written.status !== "ok" || written.bytesWritten !== packet.length) {
        throw new Error("USB OUT failed: " + written.status + ".");
      }
      const reply = this._parseOBPResponse(await this._readOBPFrame(device));
      if (reply.messageType !== type || reply.regarding !== id) {
        throw new Error("OBP response does not match request.");
      }
      if (ack ? !(reply.flags & 2) : !(reply.flags & 1) || (reply.flags & 2)) {
        throw new Error(ack ? "Expected ACK." : "Expected query response.");
      }
      return reply;
    })();
    try {
      return await Promise.race([operation, timeout]);
    } catch (error) {
      // WebUSB has no transfer AbortSignal. Closing prevents an orphaned read
      // from consuming a later response. Never automatically retry a setter.
      if (this.device === device) {
        try { await this.disconnect(); } catch (_) {}
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

