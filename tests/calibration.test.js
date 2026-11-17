import test from 'node:test';
import assert from 'node:assert/strict';
import {findLinePeak,wavelengthAt,gridSignature,validateCalibration,matchesCalibration,alignGrid} from '../calibration.js';
import {normalizeFrame,encodeBackup,decodeBackup,datasetCSV} from '../datasets.js';
const grid=Float64Array.from({length:101},(_,i)=>400+i*0.5);
const intensities=Float64Array.from({length:101},(_,i)=>10000-30*(i-50.25)**2);
const context={serial:'USB4TEST',source:'hardware',deviceProfile:'usb4000',pixelCount:101,factorySignature:'a'.repeat(64)};
const p={kind:'single-line-offset',version:1,id:'cal-test',name:'Mercury',...context,
  referenceNm:426,measuredNm:425.125,peakPixel:50.25,offsetNm:0.875,createdAt:'2026-11-17T12:00:00.000Z'};
function frame(){return {captureId:'aligned-capture',label:'sample',source:'hardware',profile:'usb4000',serial:'USB4TEST',
  integration:100000,mode:'device-counts',timestamp:'2026-11-17T12:01:00.000Z',
  intensities:Uint16Array.from({length:101},(_,i)=>100+i),wavelengths:alignGrid(grid,p,context),factoryWavelengths:grid,calibration:p};}

test('parabolic interpolation recovers a fractional peak and its factory wavelength',()=>{
  const peak=findLinePeak(intensities,grid,49,10);
  assert.ok(Math.abs(peak.pixel-50.25)<1e-10);
  assert.ok(Math.abs(peak.measuredNm-425.125)<1e-10);
  assert.equal(wavelengthAt(grid,50.5),425.25);
});
test('search uses selected local line rather than an unrelated global maximum',()=>{
  const values=Float64Array.from(intensities);values[10]=60000;
  assert.ok(Math.abs(findLinePeak(values,grid,50,10).pixel-50.25)<1e-10);
});
test('flat, saturated, boundary peaks and invalid selection are rejected',()=>{
  assert.throws(()=>findLinePeak(new Uint16Array(101),grid,50),/boundary|distinct/);
  const saturated=Float64Array.from(intensities);saturated[50]=65535;
  assert.throws(()=>findLinePeak(saturated,grid,50),/saturated/);
  assert.throws(()=>findLinePeak(intensities,grid,2,2),/boundary/);
  assert.throws(()=>findLinePeak(intensities,grid,50.5),/pixel/);
  assert.throws(()=>findLinePeak(intensities,grid,50,0),/radius/);
});
test('alignment shifts only wavelengths and preserves factory grid',()=>{
  const before=grid.slice();const result=alignGrid(grid,p,context);
  assert.deepEqual(grid,before);assert.notEqual(result,grid);
  assert.equal(result[0],400.875);assert.equal(result[100],450.875);
});
test('profile reuse requires serial, source, device profile, size and factory grid',()=>{
  assert.ok(matchesCalibration(p,context));
  for(const change of [{serial:''},{serial:'OTHER'},{source:'simulated'},{deviceProfile:'obp'},
    {pixelCount:100},{factorySignature:'b'.repeat(64)}]){
    assert.equal(matchesCalibration(p,{...context,...change}),false);
    assert.throws(()=>alignGrid(grid,p,{...context,...change}),/does not match/);
  }
  assert.throws(()=>validateCalibration({...p,offsetNm:1}),/metadata/);
});
test('factory signatures are deterministic and detect individual pixel changes',async()=>{
  assert.equal(await gridSignature(grid),await gridSignature(grid.slice()));
  const altered=grid.slice();altered[50]+=0.0001;
  assert.notEqual(await gridSignature(grid),await gridSignature(altered));
});
test('dataset backup round-trips calibration snapshot and original factory grid',()=>{
  const f=frame(),d={name:'Calibration trace',notes:'',createdAt:f.timestamp};
  const decoded=decodeBackup(encodeBackup(d,[f]));
  assert.deepEqual(decoded.frames[0],f);
  const csv=datasetCSV(d,[f]);assert.match(csv,/calibration_id/);assert.match(csv,/cal-test/);
  assert.match(csv,/"0.875"/);assert.match(csv,/"400"/);
});
test('stored spectrum rejects mismatched or tampered calibration provenance',()=>{
  assert.throws(()=>normalizeFrame({...frame(),serial:'OTHER'}),/provenance/);
  const f=frame();f.wavelengths[20]+=1;
  assert.throws(()=>normalizeFrame(f),/provenance/);
  assert.throws(()=>normalizeFrame({...frame(),factoryWavelengths:null}),/provenance/);
});
test('uncalibrated legacy backup remains readable without calibration fields',()=>{
  const f=frame();delete f.calibration;delete f.factoryWavelengths;
  const result=normalizeFrame(f);assert.equal(result.calibration,undefined);assert.equal(result.factoryWavelengths,undefined);
});

test('identical wavelength grids with different readout conventions cannot reuse profiles',async()=>{
  const grid=Float64Array.of(350,351,352);
  const old=await gridSignature(grid);
  const corrected=await gridSignature(grid,'usb4000:oceanview:raw0:3648:v1');
  assert.notEqual(corrected,old);
  assert.equal(corrected,await gridSignature(grid,'usb4000:oceanview:raw0:3648:v1'));
});
