import test from 'node:test';
import assert from 'node:assert/strict';
import { spectroscopy,signalCounts,SpectroscopySession } from '../spectroscopy.js';

test('absorbance and percent transmittance use dark-corrected ratios',()=>{
  assert.deepEqual([...spectroscopy([60,110],[10,10],[110,110])],[50,100]);
  const a=spectroscopy([60,110],[10,10],[110,110],'absorbance');
  assert.ok(Math.abs(a[0]-Math.log10(2))<1e-14);assert.equal(a[1],-0);
});
test('zero/negative signals, references and nonfinite inputs become plot gaps',()=>{
  for(const mode of ['transmittance','absorbance']) {
    const result=spectroscopy([10,9,20,20,NaN,Infinity],[10,10,10,10,0,0],[20,20,10,9,20,20],mode);
    assert.ok([...result].every(Number.isNaN));
  }
  assert.throws(()=>spectroscopy([1],[0],[1,2]),/matching/);
});
test('optical dark subtraction retains negative fractional noise without uint16 wrapping',()=>{
  assert.deepEqual([...signalCounts({intensities:[10,20],detector:{opticalDarkMean:10.5}},true)],[-.5,9.5]);
  assert.throws(()=>signalCounts({intensities:[10]},true),/unavailable/);
});
const frame=(extra={})=>({intensities:Uint16Array.of(10,20),integration:100000,
  serial:'USB4',profile:'usb4000',source:'hardware',mode:'device-counts',...extra});
test('references are copies and cannot cross exposure/mode/device/grid boundaries',()=>{
  const session=new SpectroscopySession(),f=frame();
  session.capture('dark',f);session.capture('reference',frame({intensities:Uint16Array.of(20,30)}));
  f.intensities[0]=999;
  assert.equal(session.dark.values[0],10);
  assert.deepEqual([...session.process(frame({intensities:[15,25]}),'transmittance')],[50,50]);
  for(const extra of [{integration:200000},{mode:'raw'},{serial:'other'},{source:'simulated'},
    {profile:'obp'},{intensities:[1]}])assert.throws(()=>session.process(frame(extra),'absorbance'),/matching/);
  session.clear();assert.equal(session.dark,null);assert.equal(session.reference,null);
});

test('USB4000 counts automatically subtract optical black without a UI toggle',()=>{
  const f=frame({intensities:Uint16Array.of(10,20),detector:{opticalDarkMean:10.5}});
  const session=new SpectroscopySession();
  assert.deepEqual([...signalCounts(f)],[-.5,9.5]);
  assert.deepEqual([...session.process(f,'counts')],[-.5,9.5]);
  assert.deepEqual([...f.intensities],[10,20]); // Preserve archive counts.
});
test('automatic optical black policy is identical for dark, light reference and sample',()=>{
  const session=new SpectroscopySession();
  session.capture('dark',frame({intensities:[10,10],detector:{opticalDarkMean:5}}));
  session.capture('reference',frame({intensities:[110,110],detector:{opticalDarkMean:15}}));
  const sample=frame({intensities:[60,60],detector:{opticalDarkMean:10}});
  assert.deepEqual([...session.process(sample,'transmittance')],[50,50]);
});
