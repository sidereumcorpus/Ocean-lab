import test from 'node:test';
import assert from 'node:assert/strict';
import { USBRecovery } from '../usb-recovery.js';
const instrument=(serial='JAZ-DPU')=>({vendorId:0x2457,productId:0x2000,serialNumber:serial});
function setup(t,{devices=[],attempt=async()=>{},...options}={}) {
  const listeners=new Set(),messages=[];
  const usb={getDevices:async()=>devices,
    addEventListener:(name,fn)=>listeners.add(fn),removeEventListener:(name,fn)=>listeners.delete(fn)};
  const r=new USBRecovery({usb,attempt,onStatus:m=>messages.push(m),delayMs:1,pollMs:1,maxPolls:4,maxAttempts:3,...options});
  t.after(()=>r.dispose());return {r,devices,messages,listeners};
}

test('recovery reopens same serial with copied options and integration, without device chooser',async t=>{
  const original=instrument(),reattached=instrument(),calls=[];let settled=0;
  const {r}=setup(t,{devices:[reattached],attempt:async(...args)=>calls.push(args),onSettled:()=>settled++});
  const settings={options:{profile:'auto',channel:1},integration:100000};
  r.remember(original,settings);r.setIntegration(200000);r.setModuleSerial('JAZA0863');settings.options.channel=0;
  assert.equal(await r.start(),true);assert.equal(calls.length,1);assert.equal(calls[0][0],reattached);
  assert.equal(calls[0][1].options.channel,1);assert.equal(calls[0][1].integration,200000);assert.equal(calls[0][1].moduleSerial,'JAZA0863');
  assert.equal(r.running,false);assert.equal(r.armed,false);assert.equal(settled,1);
});

test('recovery never substitutes a same-model different serial device',async t=>{
  let calls=0;const {r}=setup(t,{devices:[instrument('OTHER')],attempt:async()=>calls++});
  r.remember(instrument(),{});assert.equal(await r.start(),false);assert.equal(calls,0);
});

test('serial-less recovery requires the exact selected object, not an ambiguous replacement',async t=>{
  const selected=instrument(''),replacement=instrument('');let calls=0;
  const {r,devices}=setup(t,{devices:[replacement],attempt:async()=>calls++});
  r.remember(selected,{});assert.equal(await r.start(),false);assert.equal(calls,0);
  devices.splice(0,1,selected);assert.equal(await r.start(),true);assert.equal(calls,1);
});

test('duplicate serials do not cause automatic selection of an arbitrary device',async t=>{
  let calls=0;const {r}=setup(t,{devices:[instrument(),instrument()],attempt:async()=>calls++});
  r.remember(instrument(),{});await r.start();assert.equal(calls,0);
});

test('repeated connection failures stop after bounded fresh-session attempts',async t=>{
  let calls=0;const {r,messages}=setup(t,{devices:[instrument()],maxPolls:10,attempt:async()=>{calls++;throw new Error('0x08 handshake error');}});
  r.remember(instrument(),{});assert.equal(await r.start(),false);assert.equal(calls,3);
  assert.equal(r.armed,false);assert.ok(messages.some(m=>m.includes('0x08')));
});

test('manual forget during debounce prevents reopening and cancels future hotplug recovery',async t=>{
  let calls=0;const {r,listeners}=setup(t,{devices:[instrument()],delayMs:20,attempt:async()=>calls++});
  r.remember(instrument(),{});const pending=r.start();r.forget();await pending;
  for(const fn of listeners)fn({device:instrument()});
  assert.equal(calls,0);assert.equal(r.target,null);assert.equal(r.running,false);
});

test('manual forget aborts a connecting session before it can be reported restored',async t=>{
  let entered;const started=new Promise(resolve=>entered=resolve);
  const {r,messages}=setup(t,{devices:[instrument()],attempt:async(device,settings,signal)=>{
    entered();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
  }});
  r.remember(instrument(),{});const pending=r.start();await started;r.forget();await pending;
  assert.equal(r.running,false);assert.ok(!messages.some(m=>m.startsWith('USB restored')));
});

test('reattachment event restarts waiting recovery and concurrent start calls cannot overlap',async t=>{
  let calls=0;const {r,devices,listeners}=setup(t,{attempt:async()=>calls++});
  r.remember(instrument(),{});await r.start();assert.equal(calls,0);
  devices.push(instrument());for(const fn of listeners)fn({device:devices[0]});
  const a=r.start(),b=r.start();assert.equal(a,b);await a;assert.equal(calls,1);
});

test('busy acquisition blocks recovery attempts until its cancellation has finished',async t=>{
  let busy=true,calls=0;const {r}=setup(t,{devices:[instrument()],canAttempt:()=>!busy,attempt:async()=>calls++});
  r.remember(instrument(),{});await r.start();assert.equal(calls,0);
  busy=false;assert.equal(await r.start(),true);assert.equal(calls,1);
});
