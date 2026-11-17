import test from 'node:test';
import assert from 'node:assert/strict';
import { USB4000Spectrometer } from '../usb4000.js';
import { OceanOBPSpectrometer } from '../ocean-obp.js';
import { createSpectrometerForDevice, selectSpectrometer } from '../spectrometer.js';

const view = bytes => new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);

function instrument({highSpeed=true,chunkSize=Infinity,eepromLength=17,badSync=false,
  badEEPROM=false,badCoefficient=false,wrongTime=false,missingEP6=false,stall=false} = {}) {
  const packets = new Map([[1,[]],[2,[]],[6,[]]]), writes=[], reads=[];
  const listeners = new Set();
  let integration=100000, rejectRead;
  const endpoints = [
    {type:'bulk',direction:'out',endpointNumber:1,packetSize:64},
    {type:'bulk',direction:'in',endpointNumber:1,packetSize:64},
    {type:'bulk',direction:'in',endpointNumber:2,packetSize:highSpeed?512:64},
    ...missingEP6 ? [] : [{type:'bulk',direction:'in',endpointNumber:6,packetSize:highSpeed?512:64}]
  ];
  const alternate = {alternateSetting:0,endpoints};
  const values = Uint16Array.from({length:3840},(_,i)=>(i*17+256)%65536);
  const spectrum = new Uint8Array(7680);
  values.forEach((v,i)=>view(spectrum).setUint16(i*2,v,true));
  const device = {
    vendorId:0x2457,productId:0x1022,productName:'USB4000',serialNumber:'',opened:false,
    configuration:{configurationValue:1,interfaces:[{interfaceNumber:0,alternate,alternates:[alternate]}]},
    async open(){this.opened=true;},
    async claimInterface(number){assert.equal(number,0);},
    async releaseInterface(){},
    async close(){this.opened=false;if(rejectRead)rejectRead(new Error('Closed'));},
    async transferOut(ep,bytes){
      assert.equal(ep,1); writes.push([...bytes]);
      switch(bytes[0]) {
        case 0x01: assert.equal(bytes.length,1); break;
        case 0x0a: assert.deepEqual([...bytes],[0x0a,0,0]);break;
        case 0x02: integration=view(bytes).getUint32(1,true);break;
        case 0xfe: {
          const status=new Uint8Array(16);
          view(status).setUint16(0,3840,true);
          view(status).setUint32(2,wrongTime?1234:integration,true);
          status[14]=highSpeed?0x80:0; packets.get(1).push(status);break;
        }
        case 0x05: {
          const slot=bytes[1], reply=new Uint8Array(eepromLength);
          reply[0]=badEEPROM?0x06:0x05;reply[1]=slot;
          const text=['USB4TEST','350','0.5','0.0001','-1e-8'][slot];
          const value=badCoefficient&&slot===2?'1.2garbage':text;
          reply.set(new TextEncoder().encode(value),2);packets.get(1).push(reply);break;
        }
        case 0x09: {
          if(stall) break;
          if(highSpeed) packets.get(6).push(spectrum.slice(0,2048));
          const rest=highSpeed?spectrum.slice(2048):spectrum;
          const withSync=new Uint8Array(rest.length+1);
          withSync.set(rest);withSync[rest.length]=badSync?0x68:0x69;
          packets.get(2).push(withSync);break;
        }
        default: throw new Error('Unexpected command '+bytes[0]);
      }
      return {status:'ok',bytesWritten:bytes.length};
    },
    async transferIn(ep,length){
      reads.push({ep,length});
      if(stall&&ep!==1) return new Promise((resolve,reject)=>{rejectRead=reject;});
      const queue=packets.get(ep), packet=queue.shift();
      if(!packet) throw new Error('Unexpected read from endpoint '+ep);
      // EEPROM/status fit a single packet and do not use spectrum chunking.
      const size=Math.min(packet.length,length,ep===1?Infinity:chunkSize);
      const part=packet.slice(0,size);
      if(size<packet.length)queue.unshift(packet.slice(size));
      const padded=new Uint8Array(part.length+9);padded.set(part,5);
      return {status:'ok',data:new DataView(padded.buffer,5,part.length)};
    }
  };
  const usb={
    async requestDevice(filters){assert.deepEqual(filters,{filters:[{vendorId:0x2457}]});return device;},
    addEventListener(name,fn){listeners.add(fn);},
    removeEventListener(name,fn){listeners.delete(fn);}
  };
  return {device,usb,writes,reads,values,listeners};
}

async function connect(t,config={}) {
  const mock=instrument(config);
  const nav=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  const secure=Object.getOwnPropertyDescriptor(globalThis,'isSecureContext');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{usb:mock.usb}});
  Object.defineProperty(globalThis,'isSecureContext',{configurable:true,value:true});
  const d=new USB4000Spectrometer({startupDelayMs:0,timeoutMs:30});
  t.after(async()=>{
    await d.disconnect();
    if(nav)Object.defineProperty(globalThis,'navigator',nav);else delete globalThis.navigator;
    if(secure)Object.defineProperty(globalThis,'isSecureContext',secure);else delete globalThis.isSecureContext;
  });
  await d.connect(mock.device);
  return {d,...mock};
}

test('vendor-only selection routes USB4000 to legacy and STS to OBP before commands', async()=>{
  assert.ok(createSpectrometerForDevice({vendorId:0x2457,productId:0x1022}) instanceof USB4000Spectrometer);
  assert.ok(createSpectrometerForDevice({vendorId:0x2457,productId:0x4000}) instanceof OceanOBPSpectrometer);
  assert.throws(()=>createSpectrometerForDevice({vendorId:0x2457,productId:0x1022},{profile:'obp'}),/legacy/);
  assert.throws(()=>createSpectrometerForDevice({vendorId:0x2457,productId:0x4000},{profile:'usb4000'}),/not a USB4000/);
  assert.throws(()=>createSpectrometerForDevice({vendorId:1,productId:2}),/Not an Ocean/);
});

test('initialization claims primary interface, sets normal mode, detects speed and reads serial',async t=>{
  const {d,writes,listeners}=await connect(t);
  assert.equal(d.connected,true);assert.equal(d.highSpeed,true);assert.equal(d.serialNumber,'USB4TEST');
  assert.deepEqual(writes,[[1],[10,0,0],[254],[5,0]]);
  assert.equal(listeners.size,1);
});

for(const highSpeed of [true,false]) {
  test((highSpeed?'high':'full')+'-speed spectra preserve pixel order, endian values and consume sync across frames',async t=>{
    const {d,reads,values}=await connect(t,{highSpeed,chunkSize:137});
    for(let n=0;n<2;n++)assert.deepEqual(await d.getSpectrum(),values);
    const spectral=reads.filter(r=>r.ep!==1);
    assert.equal(spectral.some(r=>r.ep===6),highSpeed);
    assert.ok(spectral.every(r=>r.length%(highSpeed?512:64)===0));
    assert.equal(d.pixelCount,3840);
  });
}

test('integration setter writes 32-bit LE legacy operand and verifies status, without ACK read',async t=>{
  const {d,writes}=await connect(t);
  await d.setIntegrationTime(200000);
  assert.deepEqual(writes.slice(-2),[[2,0x40,0x0d,3,0],[254]]);
  assert.equal(d.integrationTime,200000);
  const before=writes.length;
  await assert.rejects(d.setIntegrationTime(1000),/3800/);
  await assert.rejects(d.setIntegrationTime(3801),/increments/);
  await assert.rejects(d.setIntegrationTime(65535010),/3800/);
  await assert.rejects(d.getSpectrum({raw:false}),/corrected mode/);
  assert.equal(writes.length,before);
});

for(const eepromLength of [17,18]) {
  test('calibration accepts '+eepromLength+'-byte EEPROM replies and indexes slots 1–4',async t=>{
    const {d,writes}=await connect(t,{eepromLength});
    const wavelengths=await d.getWavelengths();
    assert.equal(wavelengths.length,3840);assert.equal(wavelengths[0],350);
    assert.ok(Math.abs(wavelengths[100]-(350+50+1-.01))<1e-9);
    assert.deepEqual(writes.slice(-4),[[5,1],[5,2],[5,3],[5,4]]);
    const count=writes.length;await d.getWavelengths();assert.equal(writes.length,count);
    assert.ok(writes.every(w=>w[0]!==6)); // Never write EEPROM.
  });
}

test('invalid sync terminates session instead of reusing stale bytes',async t=>{
  const {d,device}=await connect(t,{badSync:true});
  await assert.rejects(d.getSpectrum(),/synchronization/);
  assert.equal(d.connected,false);assert.equal(device.opened,false);
});

test('malformed coefficient rejects partial numeric parsing and disconnects',async t=>{
  const {d}=await connect(t,{badCoefficient:true});
  await assert.rejects(d.getWavelengths(),/coefficient/);
  assert.equal(d.connected,false);
});

test('spectrum timeout closes USB and cancels the pending read',async t=>{
  const {d,device}=await connect(t,{stall:true});
  d.integrationTime=null; // Exercise the configured 30 ms deadline.
  await assert.rejects(d.getSpectrum(),/timed out/);
  assert.equal(device.opened,false);
});

test('concurrent calls stay serialized and manual disconnect cancels the read',async t=>{
  const {d,device}=await connect(t,{stall:true});
  const pending=d.getSpectrum();
  const rejection=assert.rejects(pending,/Closed|session closed/);
  await new Promise(resolve=>setTimeout(resolve,5));
  const queued=d.getWavelengths();
  const queuedRejection=assert.rejects(queued,/disconnected|session changed/);
  await d.disconnect();
  await Promise.all([rejection,queuedRejection]);
  assert.equal(device.opened,false);
});

test('unaccepted integration time closes the session with a readback error',async t=>{
  const {d}=await connect(t,{wrongTime:true});
  await assert.rejects(d.setIntegrationTime(100000),/did not accept/);
  assert.equal(d.connected,false);
});

test('bad EEPROM echoes fail connection and release the device',async t=>{
  const mock=instrument({badEEPROM:true});
  const nav=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  const secure=Object.getOwnPropertyDescriptor(globalThis,'isSecureContext');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{usb:mock.usb}});
  Object.defineProperty(globalThis,'isSecureContext',{configurable:true,value:true});
  t.after(()=>{
    if(nav)Object.defineProperty(globalThis,'navigator',nav);else delete globalThis.navigator;
    if(secure)Object.defineProperty(globalThis,'isSecureContext',secure);else delete globalThis.isSecureContext;
  });
  const d=new USB4000Spectrometer({startupDelayMs:0});
  await assert.rejects(d.connect(mock.device),/does not match slot/);
  assert.equal(mock.device.opened,false);assert.equal(d.connected,false);
  assert.equal(mock.listeners.size,0);
});
