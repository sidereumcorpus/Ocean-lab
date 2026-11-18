import test from 'node:test';
import assert from 'node:assert/strict';
import { JazSpectrometer } from '../jaz.js?v=jaz-1';
import { createSpectrometerForDevice } from '../spectrometer.js';
import { USB4000Spectrometer } from '../usb4000.js?v=jaz-1';

function mockJaz({highSpeed=true,chunk=Infinity,count=2,autoscale=65535,badEcho=false,stall=false}={}) {
  const queues=new Map([[1,[]],[2,[]]]),writes=[],reads=[],listeners=new Set();
  let channel=0,rejectRead;
  const packet=highSpeed?512:64;
  const endpoints=[{type:'bulk',direction:'out',endpointNumber:1,packetSize:packet},
    ...[1,2].map(endpointNumber=>({type:'bulk',direction:'in',endpointNumber,packetSize:packet}))];
  const alternate={alternateSetting:0,endpoints};
  const values=Uint16Array.from({length:2048},(_,i)=>(i*37+1000)%65536);
  values[2047]=0x6969; // These bytes are intensities, not a sync marker.
  const device={vendorId:0x2457,productId:0x2000,opened:false,
    productName:'Jaz',serialNumber:'DPU-NOT-MODULE',
    configuration:{configurationValue:1,interfaces:[{interfaceNumber:0,alternate,alternates:[alternate]}]},
    async open(){this.opened=true;},async claimInterface(){},async releaseInterface(){},
    async close(){this.opened=false;rejectRead?.(new Error('closed'));},
    async transferOut(ep,bytes){
      assert.equal(ep,1);writes.push([...bytes]);
      switch(bytes[0]) {
        case 0xc0: queues.get(1).push(Uint8Array.of(count));break;
        case 0xc1: channel=bytes[1];assert.ok(channel<count);break;
        case 0x02: assert.equal(bytes.length,5);break; // No ACK or status reply.
        case 0x05: {
          const slot=bytes[1],reply=new Uint8Array(17);reply[0]=badEcho?4:5;reply[1]=slot;
          if(slot===17)new DataView(reply.buffer).setUint16(6,autoscale,true);
          else {
            const value=slot===0?'MODULE-'+channel:['','350','0.5','0.0001','-1e-8'][slot];
            const text=new TextEncoder().encode(value);reply.set(text,2);
            // Datasheet: garbage after ASCII terminator must be ignored.
            reply.fill(0x78,3+text.length);
          }
          queues.get(1).push(reply);break;
        }
        case 0x09: {
          if(stall)break;
          const data=new Uint8Array(4096),v=new DataView(data.buffer);
          values.forEach((n,i)=>v.setUint16(i*2,n,true));queues.get(2).push(data);break;
        }
        default:throw new Error('Unsupported Jaz command '+bytes[0].toString(16));
      }
      return {status:'ok',bytesWritten:bytes.length};
    },
    async transferIn(ep,length){
      reads.push({ep,length});
      if(stall&&ep===2)return new Promise((resolve,reject)=>rejectRead=reject);
      const queue=queues.get(ep),bytes=queue.shift();
      if(!bytes)throw new Error('Unexpected extra read on EP'+ep);
      const n=Math.min(bytes.length,length,ep===2?chunk:Infinity);
      if(n<bytes.length)queue.unshift(bytes.slice(n));
      const padded=new Uint8Array(n+7);padded.set(bytes.slice(0,n),3);
      return {status:'ok',data:new DataView(padded.buffer,3,n)};
    }
  };
  const usb={async requestDevice(arg){assert.deepEqual(arg,{filters:[{vendorId:0x2457}]});return device;},
    addEventListener(name,fn){listeners.add(fn);},removeEventListener(name,fn){listeners.delete(fn);}};
  return {device,usb,writes,reads,values,listeners};
}
async function setup(t,config={},options={}) {
  const mock=mockJaz(config),nav=Object.getOwnPropertyDescriptor(globalThis,'navigator'),secure=Object.getOwnPropertyDescriptor(globalThis,'isSecureContext');
  Object.defineProperty(globalThis,'navigator',{value:{usb:mock.usb},configurable:true});
  Object.defineProperty(globalThis,'isSecureContext',{value:true,configurable:true});
  const d=new JazSpectrometer({startupDelayMs:0,timeoutMs:25,...options});
  t.after(async()=>{await d.disconnect();if(mock.device.opened)await mock.device.close();
    if(nav)Object.defineProperty(globalThis,'navigator',nav);else delete globalThis.navigator;
    if(secure)Object.defineProperty(globalThis,'isSecureContext',secure);else delete globalThis.isSecureContext;});
  return {d,...mock};
}

test('Jaz auto-routing cannot be overridden with USB4000 or OBP',()=>{
  const device={vendorId:0x2457,productId:0x2000};
  assert.ok(createSpectrometerForDevice(device) instanceof JazSpectrometer);
  assert.throws(()=>createSpectrometerForDevice(device,{profile:'obp'}),/legacy/);
  assert.throws(()=>createSpectrometerForDevice(device,{profile:'usb4000'}),/not a USB4000/);
  assert.throws(()=>createSpectrometerForDevice({vendorId:0x2457,productId:0x1022},{profile:'jaz'}),/not a Jaz/);
  assert.ok(createSpectrometerForDevice({vendorId:0x2457,productId:0x1022}) instanceof USB4000Spectrometer);
});

test('Jaz counts modules before commands, selects requested channel and reads module serial',async t=>{
  const {d,device,writes}=await setup(t,{}, {channel:1});await d.connect(device);
  assert.deepEqual(writes.slice(0,4),[[0xc0],[0xc1,1],[5,0],[5,17]]);
  assert.equal(writes[4][0],2);assert.equal(d.serialNumber,'MODULE-1');
  assert.equal(d.channelCount,2);assert.equal(d.integrationTime,100000);
  assert.throws(()=>{d.channel=0;},TypeError);
  assert.ok(writes.every(w=>![0x01,0xfe,0x0a].includes(w[0])));
});
for(const highSpeed of [true,false])test('Jaz '+(highSpeed?'high':'full')+' speed reconstructs EP2-only scans without sync reads',async t=>{
  const {d,device,values,reads}=await setup(t,{highSpeed,chunk:137});await d.connect(device);
  for(let n=0;n<3;n++)assert.deepEqual(await d.getSpectrum(),values);
  assert.equal(d.highSpeed,highSpeed);assert.deepEqual(d.opticalDarkPixels,values.slice(2,24));
  assert.deepEqual(d.lastRawSpectrum,values);
  assert.ok(reads.every(r=>[1,2].includes(r.ep)));
  assert.ok(reads.filter(r=>r.ep===2).every(r=>r.length%(highSpeed?512:64)===0));
});

test('Jaz wavelengths use module ASCII coefficients and raw pixels 0..2047, ignoring null garbage',async t=>{
  const {d,device,writes}=await setup(t);await d.connect(device);
  const wave=await d.getWavelengths();assert.equal(wave.length,2048);
  for(let p=0;p<2048;p++)assert.ok(Math.abs(wave[p]-(350+.5*p+.0001*p*p-1e-8*p*p*p))<1e-9);
  assert.deepEqual(writes.slice(-4),[[5,1],[5,2],[5,3],[5,4]]);
  const count=writes.length;await d.getWavelengths();assert.equal(writes.length,count);
});

test('Jaz integration setter queues LE operand without ACK/status and enforces actual clock resolution',async t=>{
  const {d,device,writes,reads}=await setup(t);await d.connect(device);
  const count=reads.length;await d.setIntegrationTime(200000);
  assert.deepEqual(writes.at(-1),[2,0x40,0x0d,3,0]);assert.equal(reads.length,count);
  assert.equal(d.integrationTime,200000);
  for(const value of [999,1001,100010,1000100,65535000,65540000])await assert.rejects(d.setIntegrationTime(value),RangeError);
  for(const value of [1000,99990,100000,999900,1000000,65530000])await d.setIntegrationTime(value);
});
for(const autoscale of [0,32768])test('Jaz slot 17 gain '+autoscale+' is normalized and clamped',async t=>{
  const {d,device,values}=await setup(t,{autoscale});await d.connect(device);
  const output=await d.getSpectrum(),gain=autoscale?65535/autoscale:1;
  for(let p=0;p<2048;p++)assert.equal(output[p],Math.min(65535,Math.round(values[p]*gain)));
});
for(const config of [{count:0},{count:1,channel:1},{badEcho:true}])test('invalid Jaz startup safely closes '+JSON.stringify(config),async t=>{
  const {d,device,writes}=await setup(t,config,{channel:config.channel||0});
  await assert.rejects(d.connect(device));assert.equal(device.opened,false);assert.equal(d.connected,false);
  if(config.count===0)assert.deepEqual(writes,[[0xc0]]);
});

test('Jaz acquisition, exposure changes and EEPROM cannot interleave',async t=>{
  const {d,device,writes}=await setup(t);await d.connect(device);
  const original=device.transferIn.bind(device);let release,entered;
  const started=new Promise(resolve=>entered=resolve);let paused=false;
  device.transferIn=async(ep,length)=>{if(ep===2&&!paused){paused=true;entered();await new Promise(resolve=>release=resolve);}return original(ep,length);};
  const scan=d.getSpectrum();await started;const count=writes.length;
  const setter=d.setIntegrationTime(200000),wave=d.getWavelengths();
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(writes.length,count);
  release();await Promise.all([scan,setter,wave]);assert.equal(writes[count][0],2);
  assert.deepEqual(writes.slice(count+1),[[5,1],[5,2],[5,3],[5,4]]);
});

test('Jaz disconnect cancels scan and queued operations and resets channel state',async t=>{
  const {d,device,listeners}=await setup(t,{stall:true});await d.connect(device);
  let notified=0;d.onDisconnect=()=>notified++;
  const scan=assert.rejects(d.getSpectrum(),/disconnected|session changed/);
  await new Promise(resolve=>setTimeout(resolve,5));
  const queued=assert.rejects(d.setIntegrationTime(200000),/disconnected|session changed/);
  for(const fn of listeners)fn({device});await Promise.all([scan,queued]);
  assert.equal(notified,1);assert.equal(d.channelCount,null);assert.equal(d.connected,false);
});

test('Jaz blocked reads time out and close the USB session',async t=>{
  const {d,device}=await setup(t,{stall:true});await d.connect(device);d.integrationTime=null;
  await assert.rejects(d.getSpectrum(),/timed out/);assert.equal(device.opened,false);
});
