import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFrame,framePeak,encodeBackup,decodeBackup,datasetCSV } from '../datasets.js';
const dataset={name:'Filter lab',notes:'450 nm source\nTrial 1',createdAt:'2026-11-17T12:00:00.000Z'};
const frame={captureId:'test-1',label:'Red filter',intensities:Uint16Array.of(12,300,40),
  wavelengths:Float64Array.of(400,500,600),integration:100000,mode:'device-counts',
  profile:'usb4000',source:'hardware',serial:'USB4TEST',timestamp:'2026-11-17T12:01:00.000Z'};

test('JSON backup round-trips full samples, calibration, provenance and experiment notes',()=>{
  const decoded=decodeBackup(encodeBackup(dataset,[frame]));
  assert.deepEqual(decoded.dataset,dataset);
  assert.deepEqual(decoded.frames[0],frame);
});
test('saved frames are independent copies of acquisition buffers',()=>{
  const input={...frame,intensities:Uint16Array.of(1,2),wavelengths:Float64Array.of(400,500)};
  const saved=normalizeFrame(input);input.intensities[0]=999;input.wavelengths[0]=999;
  assert.equal(saved.intensities[0],1);assert.equal(saved.wavelengths[0],400);
});
test('malformed backup version, lengths, ranges and partial provenance are rejected',()=>{
  const backup=JSON.parse(encodeBackup(dataset,[frame]));
  assert.throws(()=>decodeBackup({...backup,version:9}),/Unsupported/);
  for(const changes of [{intensities:[1.5]}, {intensities:[65536]}, {wavelengths:[1]},
    {wavelengths:[1,Infinity,3]}, {integration:0}, {source:'simulated'}, {timestamp:'nonsense'}]) {
    assert.throws(()=>normalizeFrame({...frame,...changes}));
  }
});
test('uncalibrated spectra retain null wavelengths rather than inventing a wavelength grid',()=>{
  const result=decodeBackup(encodeBackup(dataset,[{...frame,wavelengths:null}]));
  assert.equal(result.frames[0].wavelengths,null);
});
test('dataset CSV supports mixed pixel counts and retains capture metadata',()=>{
  const second={...frame,captureId:'test-2',intensities:Uint16Array.of(5),wavelengths:null,
    source:'simulated',profile:'demo',serial:'DEMO'};
  const csv=datasetCSV(dataset,[frame,second]);
  assert.equal(csv.split('\r\n').length,5);assert.match(csv,/simulated/);assert.match(csv,/test-2/);
  assert.match(csv,/'?"100000"/);assert.match(csv,/"0","","5"/);
});
test('CSV escapes quoted names and spreadsheet formulas without altering numeric wavelengths',()=>{
  const csv=datasetCSV({name:'=HYPERLINK("x")'},[{...frame,label:'@SUM(A1)',wavelengths:Float64Array.of(-1,2,3)}]);
  assert.ok(csv.includes('"\'=HYPERLINK(""x"")"'));
  assert.ok(csv.includes('"\'@SUM(A1)"'));
  assert.ok(csv.includes('"0","-1","12"'));
});
test('peak metadata uses the wavelength at the strongest detector sample',()=>{
  assert.deepEqual(framePeak(frame),{index:1,intensity:300,wavelength:500});
});

test('USB4000 processing metadata survives JSON and CSV and is validated',()=>{
  const f={captureId:'audit',label:'test',timestamp:new Date().toISOString(),source:'hardware',
    serial:'USB4',profile:'usb4000',mode:'device-counts',integration:100000,
    intensities:new Uint16Array(3648).fill(100),wavelengths:null,
    detector:{activeStart:21,rawPixelCount:3840,autoscaleLevel:32768,opticalDarkMean:12.5}};
  const dataset={name:'Audit',notes:'',createdAt:new Date().toISOString()};
  const restored=decodeBackup(encodeBackup(dataset,[f])).frames[0];
  assert.deepEqual(restored.detector,f.detector);
  assert.ok(datasetCSV(dataset,[f]).includes('optical_dark_mean_counts'));
  assert.throws(()=>normalizeFrame({...f,detector:{...f.detector,activeStart:22}}),/metadata/);
});
