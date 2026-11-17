import test from "node:test";
import assert from "node:assert/strict";
import { OceanOBPSpectrometer } from "../ocean-obp.js";

const view = packet => new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
function response(driver, type, bytes, flags = 1, id = 1) {
  return driver._buildOBPPacket(type, bytes, flags, id);
}
function transport(driver, getResponse) {
  let chunks = [];
  const device = {
    opened: true,
    async transferOut(endpoint, packet) {
      chunks = getResponse(packet);
      return { status:"ok", bytesWritten:packet.length };
    },
    async transferIn() {
      const bytes = chunks.shift();
      if (!bytes) throw new Error("Unexpected read.");
      return { status:"ok", data:view(bytes) };
    },
    async close() { this.opened = false; }
  };
  driver.device = device;
  driver._in = 1; driver._out = 1;
  return device;
}

test("immediate data is little endian, with request-ACK bit and zero checksum", () => {
  const d = new OceanOBPSpectrometer();
  const payload = Uint8Array.of(0x40,0x0d,3,0);
  const p = d._buildOBPPacket(0x00110010, payload, 4, 42);
  assert.equal(p.length, 64);
  assert.deepEqual([...p.slice(0,2)], [0xc1,0xc0]);
  assert.equal(view(p).getUint16(2,true), 0x1100);
  assert.equal(view(p).getUint16(4,true), 4);
  assert.equal(view(p).getUint32(12,true), 42);
  assert.equal(view(p).getUint32(40,true), 20);
  assert.equal(p[23], 4);
  assert.deepEqual(p.slice(24,28), payload);
  assert.ok(p.slice(44,60).every(v => v === 0));
  assert.deepEqual([...p.slice(-4)], [0xc5,0xc4,0xc3,0xc2]);
});

test("16-byte immediate boundary and external payload with DataView offset", () => {
  const d = new OceanOBPSpectrometer();
  assert.equal(d._buildOBPPacket(1,new Uint8Array(16)).length,64);
  const payload = Uint8Array.from({length:17},(_,i) => i);
  const p = response(d,1,payload);
  assert.equal(p.length,81);
  assert.equal(p[23],0);
  assert.equal(view(p).getUint32(40,true),37);
  const padded = new Uint8Array(p.length+11); padded.set(p,7);
  assert.deepEqual(d._parseOBPResponse(new DataView(padded.buffer,7,p.length)).payload,payload);
});

test("parser rejects corrupt magic, footer, lengths, errors and checksum types", () => {
  const d = new OceanOBPSpectrometer();
  for (const mutate of [
    p => { p[0] = 0; },
    p => { p[p.length-1] = 0; },
    p => { view(p).setUint32(40,19,true); },
    p => { view(p).setUint16(6,2,true); },
    p => { view(p).setUint16(4,8,true); },
    p => { p[22] = 1; },
    p => { p[23] = 17; }
  ]) {
    const p = response(d,1,Uint8Array.of(3));
    mutate(p);
    assert.throws(() => d._parseOBPResponse(view(p)));
  }
});

test("spectrum reassembles split header and a frame larger than 8192 bytes", async () => {
  const d = new OceanOBPSpectrometer();
  const payload = new Uint8Array(10000);
  for (let i=0;i<5000;i++) view(payload).setUint16(i*2,(i*19)%65536,true);
  transport(d, request => {
    const p = response(d,0x00101000,payload,1,view(request).getUint32(12,true));
    return [p.slice(0,13),p.slice(13,8192),p.slice(8192)];
  });
  const spectrum = await d.getSpectrum();
  assert.equal(spectrum.length,5000);
  assert.equal(spectrum[4999],(4999*19)%65536);
});

test("integration setter consumes ACK and spectrum queries do not request ACK", async () => {
  const d = new OceanOBPSpectrometer();
  const flags = [];
  transport(d, request => {
    const v = view(request), type = v.getUint32(8,true);
    flags.push(v.getUint16(4,true));
    if (type === 0x00110010) {
      assert.equal(v.getUint32(24,true),123456);
    }
    return [response(d,type,type === 0x00110010
      ? new Uint8Array(0) : Uint8Array.of(0x34,0x12),
      type === 0x00110010 ? 2 : 1,v.getUint32(12,true))];
  });
  await d.setIntegrationTime(123456);
  const spectrum = await d.getSpectrum();
  assert.deepEqual(flags,[4,0]);
  assert.equal(spectrum[0],0x1234);
});

test("wavelengths query indexed float32 coefficients and evaluate zero-based pixels", async () => {
  const d = new OceanOBPSpectrometer();
  const coefficients = [350,0.5,0.01];
  d.pixelCount = 4;
  transport(d, request => {
    const v = view(request), type = v.getUint32(8,true);
    let payload;
    if (type === 0x00180100) payload = Uint8Array.of(3);
    else {
      assert.equal(type,0x00180101);
      assert.equal(request[23],1);
      payload = new Uint8Array(4);
      view(payload).setFloat32(0,coefficients[request[24]],true);
    }
    return [response(d,type,payload,1,v.getUint32(12,true))];
  });
  const wavelengths = await d.getWavelengths();
  assert.equal(wavelengths[0],350);
  assert.ok(Math.abs(wavelengths[3]-351.59)<1e-6);
});

test("request mismatch closes session instead of reusing an untrusted response", async () => {
  const d = new OceanOBPSpectrometer();
  const device = transport(d, () => [response(d,99,Uint8Array.of(0,0),1,999)]);
  await assert.rejects(d.getSpectrum(),/does not match/);
  assert.equal(d.connected,false);
  assert.equal(device.opened,false);
});

test("a timeout cancels a blocked transaction by closing USB", async () => {
  const d = new OceanOBPSpectrometer({timeoutMs:5});
  let cancelRead;
  const device = {
    opened:true,
    async transferOut(ep,packet) { return {status:"ok",bytesWritten:packet.length}; },
    transferIn() { return new Promise((resolve,reject) => { cancelRead = reject; }); },
    async close() { this.opened=false; if(cancelRead) cancelRead(new Error("closed")); }
  };
  d.device=device;
  await assert.rejects(d.getSpectrum(),/timed out/);
  assert.equal(device.opened,false);
  assert.equal(d.connected,false);
});


test('late OUT completion from an old session cannot read from the reopened same USBDevice',async()=>{
  const d=new OceanOBPSpectrometer({timeoutMs:100});
  let finishOut,readCount=0,entered;
  const started=new Promise(resolve=>entered=resolve);
  const device={opened:true,
    transferOut(ep,packet){entered();return new Promise(resolve=>finishOut=()=>resolve({status:'ok',bytesWritten:packet.length}));},
    async transferIn(){readCount++;throw new Error('Old session read');},
    async close(){this.opened=false;}
  };
  d.device=device;d._in=1;d._out=1;
  const pending=d.getSpectrum();const rejected=assert.rejects(pending,/disconnected|session changed/);
  await started;await d.disconnect();await rejected;
  device.opened=true;d.device=device; // Model browser reusing USBDevice after reopen.
  finishOut();await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(readCount,0);assert.equal(d.connected,true);
  await d.disconnect();
});
