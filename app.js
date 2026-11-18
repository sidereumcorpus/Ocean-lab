import { USBRecovery } from './usb-recovery.js?v=recovery-1';
import { SpectroscopySession, signalCounts, usesOpticalDark } from './spectroscopy.js?v=recovery-1';
import { initializeWorkspace } from "./ui.js";
import { selectSpectrometer, createSpectrometerForDevice } from "./spectrometer.js?v=recovery-1";
import { DatasetPanel, downloadFile } from "./dataset-ui.js?v=recovery-1";
import { datasetCSV } from "./datasets.js?v=recovery-1";
import { gridSignature, alignGrid } from "./calibration.js?v=recovery-1";
import { CalibrationPanel } from "./calibration-ui.js?v=recovery-1";

const $ = id => document.getElementById(id);
const state = {
  driver: null, demo: false, busy: false, live: false,
  closing: false, epoch: 0, frame: null, wavelengths: null, frames: 0, reviewing: false, factorySignature: null
};
const canvas = $("plot");
const ctx = canvas.getContext("2d");
let plotBox = null;
let collections;
let calibration;
let recovery;
const spectroscopySession = new SpectroscopySession();
let displayValues = null;
function resetSpectroscopy() {
  spectroscopySession.clear();
  $("spectroscopyStatus").textContent="Dark/reference cleared. Capture both again after changing exposure or spectrum mode.";
}
function refreshSpectroscopy() {
  displayValues=null;
  if (!state.frame) return;
  try {
    displayValues=spectroscopySession.process(state.frame,$("displayMode").value);
    const invalid=Array.from(displayValues).filter(v=>!Number.isFinite(v)).length;
    $("spectroscopyStatus").textContent=(spectroscopySession.dark?"Dark ready. ":"Dark missing. ")+
      (spectroscopySession.reference?"Reference ready. ":"Reference missing. ")+
      (invalid?invalid+" invalid pixels shown as gaps.":"");
  } catch(error) { $("spectroscopyStatus").textContent=error.message; }
}


function notify(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
}
function log(message) {
  const lines = $("log").textContent.split("\n");
  lines.push(new Date().toLocaleTimeString() + "  " + message);
  $("log").textContent = lines.slice(-100).join("\n");
  $("log").scrollTop = $("log").scrollHeight;
}
function active() {
  return state.demo || Boolean(state.driver && state.driver.connected);
}
function update() {
  const connected = active();
  const recovering=Boolean(recovery?.running);
  $("deviceInfo").title = $("deviceInfo").textContent;
  const dataBusy = Boolean(collections?.busy);
  const legacy = connected && !state.demo && ['usb4000','jaz'].includes(state.driver.profile);
  const jaz=legacy && state.driver.profile==='jaz';
  const corrected = document.querySelector('#mode option[value="corrected"]');
  const raw = document.querySelector('#mode option[value="raw"]');
  corrected.disabled = legacy;
  raw.textContent = legacy ? 'Device counts ('+state.driver.modelName+')' : 'Raw ADC';
  if (legacy) $('mode').value = 'raw';
  $('integration').min = legacy ? String(state.driver.minIntegrationTime) : '1';
  $('integration').max = legacy ? String(state.driver.maxIntegrationTime) : '4294967295';
  $('integration').step = jaz ? String(state.driver.integrationStep(Number($('integration').value))) : legacy ? '10' : '1';
  $('deviceNote').textContent = jaz
    ? 'Jaz: 2048 pixels, channel '+state.driver.channel+' of '+state.driver.channelCount+' modules (zero-based). Factory scaling and electric dark correction are on. Exposure uses 4 significant digits, at best 10 µs resolution.'
    : legacy
    ? 'USB4000: 3840 wire samples → OceanView-compatible pixels 0–3647. Counts use factory saturation scaling. Electric dark correction is always on. Normal mode: 3800–65535000 µs, 10 µs increments.'
    : 'Wavelengths assume a full, unbinned detector readout.';
  $("status").textContent = state.closing ? "Disconnecting…"
    : recovering ? "Reconnecting USB…"
    : state.demo ? "Demo · simulated"
    : state.driver && state.driver.connected ? "USB connected"
    : state.busy ? "Working…" : "Disconnected";
  $("connect").disabled = connected || state.busy || dataBusy || state.closing || recovering ||
    !navigator.usb || !window.isSecureContext;
  $("demo").disabled = connected || state.busy || dataBusy || state.closing || recovering;
  $("disconnect").disabled = (!connected && !recovering && !recovery?.armed) || state.closing;
  $("retryUSB").disabled = !recovery?.target || connected || recovering || state.busy || state.closing || dataBusy;
  ["capture","live","calibrate"].forEach(id => {
    $(id).disabled = !connected || state.busy || dataBusy || state.live || state.closing;
  });
  if(state.reviewing) $("calibrate").disabled=true;
  $("stop").disabled = !state.live;
  $("export").disabled = !state.frame;
  $("integration").disabled = state.busy || state.live || state.closing || recovering;
  $("mode").disabled = state.busy || state.live || state.closing || recovering;
  $("settings").disabled = connected || state.busy || dataBusy || state.closing || recovering;
  for(const id of ['captureDark','captureWhite']) $(id).disabled=!connected||state.busy||state.live||state.closing||dataBusy;
  // This is a read-only status indicator, never a processing toggle.
  $('opticalDark').disabled=true;
  $('opticalDark').checked=legacy || Boolean(state.frame && usesOpticalDark(state.frame));
  $('acquisitionDefaults').textContent=!connected ? 'Connect to load factory wavelengths automatically.'
    : !state.wavelengths ? 'Loading factory wavelengths…'
    : (calibration?.active ? 'Custom wavelength alignment active.' : 'Factory wavelengths loaded automatically.') +
      (legacy ? ' Electric dark correction: always on.' : '');
  if(collections) collections.update();
  if(calibration) calibration.update();
}
function clearFrame() {
  resetSpectroscopy();
  state.frame = null;
  state.reviewing = false;
  state.wavelengths = null;
  state.factorySignature=null;
  if(calibration)calibration.reset();
  state.frames = 0;
  $("pixels").textContent = "—";
  $("peak").textContent = "—";
  $("position").textContent = "—";
  $("frameInfo").textContent = "No frame captured";
  $("legend").textContent = "Awaiting acquisition";
  $("cursor").textContent = "Move over the plot to inspect a sample.";
  draw();
}
function integerInput(id, min, max, optional = false) {
  const element = $(id), text = element.value.trim();
  if (optional && text === "") return null;
  const value = Number(text);
  if (text === "" || !Number.isInteger(value) || value < min || value > max) {
    const label = document.querySelector('label[for="' + id + '"]');
    throw new Error(label.textContent + ": enter " + min + "–" + max + ".");
  }
  return value;
}
function hexInput(id, max) {
  const text = $(id).value.trim().replace(/^0x/i, "");
  if (!/^[0-9a-f]+$/i.test(text)) throw new Error("Invalid hexadecimal value: " + id);
  const value = parseInt(text, 16);
  if (value > max) throw new Error("Hexadecimal value out of range: " + id);
  return value;
}
function driverOptions() {
  return {
    profile: $("profile").value,
    channel: integerInput("jazChannel",0,14),
    protocolVersion: hexInput("protocol", 0xffff),
    interfaceNumber: integerInput("iface", 0, 255, true),
    alternateSetting: integerInput("alternate", 0, 255, true),
    inEndpoint: integerInput("epIn", 1, 15, true),
    outEndpoint: integerInput("epOut", 1, 15, true),
    correctedSpectrumType: hexInput("corrected", 0xffffffff),
    rawSpectrumType: hexInput("raw", 0xffffffff),
    timeoutMs: integerInput("timeout", 1, 3600) * 1000
  };
}
function settings() {
  return {
    integration: integerInput("integration", 1, 0xffffffff),
    raw: $("mode").value === "raw",
    label: $("sampleLabel").value.trim()
  };
}
async function run(task) {
  if (state.busy || state.closing || collections?.busy) return;
  const epoch = state.epoch;
  state.busy = true;
  update();
  try { await task(); }
  catch (error) {
    state.live = false;
    // Expected cancellation after manual disconnect should not replace its notice.
    if (epoch === state.epoch) {
      notify(error.message, true);
      log(error.message);
      if (!active()) $("deviceInfo").textContent = "Disconnected · reconnect to continue";
    }
  } finally {
    state.busy = false;
    update();
  }
}

async function openHardwareSession(driver,device,{recovered=false,integration=null,moduleSerial='',signal=null}={}) {
  state.driver = driver;
  driver.onStatus=message=>{
    if(state.driver!==driver||state.closing)return;
    notify(message);log(message);
  };
  driver.onDisconnect = () => {
    if(state.driver!==driver)return;
    state.epoch++;
    state.live = false;
    calibration.reset();
    resetSpectroscopy();
    state.wavelengths=null;state.factorySignature=null;
    $("deviceInfo").textContent = "Instrument unplugged";
    notify("Instrument unplugged. Reconnect to continue.", true);
    log("USB device removed. Acquisition paused; dark/reference cleared.");
    draw();update();
    void recovery?.start();
  };
  const check=()=>{if(signal?.aborted)throw new Error('USB recovery cancelled.');};
  const cancel=()=>{void driver.disconnect().catch(()=>{});};
  signal?.addEventListener('abort',cancel,{once:true});
  try {
  check();
  await driver.connect(device);
  check();
  if(recovered&&moduleSerial&&(driver.serialNumber||device.serialNumber||'')!==moduleSerial) {
    throw new Error('Spectrometer module identity changed; choose Connect USB to select it explicitly.');
  }
  state.demo = false;
  state.epoch++;
  if(!recovered)clearFrame();
  else {
    state.wavelengths=null;state.factorySignature=null;
    calibration.reset();resetSpectroscopy();
  }
  // Capture controls remain busy until EEPROM coefficients and grid identity
  // are loaded. A failure is explicit; never silently acquire a pixel-only axis.
  try {
    if(!await loadFactoryWavelengths())throw new Error('USB session changed while loading factory wavelengths.');
    check();
    if(recovered&&integration!==null)await driver.setIntegrationTime(integration);
    check();
  } catch(error) {
    await driver.disconnect();
    throw error;
  }
  check();
  if(!recovered) {
    recovery?.setIntegration(driver.integrationTime);
    recovery?.setModuleSerial(driver.serialNumber||device.serialNumber||'');
  }
  const d = driver.device;
  $("deviceInfo").textContent =
    (d.productName || "Spectrometer") + " · " + (driver.serialNumber || d.serialNumber || "No serial reported") +
    (['usb4000','jaz'].includes(driver.profile) ? ' · '+driver.modelName+' legacy'+(driver.profile==='jaz'?' · channel '+driver.channel:'')+' · '+(driver.highSpeed?'high speed':'full speed') : ' · OBP');
  log("Connected: " + (d.productName || "OBP spectrometer") + ".");
  notify(['usb4000','jaz'].includes(driver.profile)
    ? driver.modelName+' ready. Factory wavelengths loaded; electric dark correction is always on. Capture to begin.'
    : 'OBP ready. Factory wavelengths loaded. Set integration time and capture a spectrum.');
  } catch(error) {
    await driver.disconnect().catch(()=>{});
    throw error;
  } finally {signal?.removeEventListener('abort',cancel);}
}

$('connect').addEventListener('click',()=>run(async()=>{
  const options=driverOptions();
  // requestDevice remains inside the user's click gesture.
  const {driver,device}=await selectSpectrometer(options);
  recovery?.remember(device,{options,integration:null});
  await openHardwareSession(driver,device);
}));
$('retryUSB').addEventListener('click',()=>{void recovery?.start().finally(update);});

$("demo").addEventListener("click", () => {
  recovery?.forget();
  state.demo = true;
  state.driver = null;
  state.epoch++;
  clearFrame();
  $("deviceInfo").textContent = "Simulated instrument · 1024 pixels";
  notify("Demo mode: all spectra and wavelengths are simulated.");
  log("Demo session started.");
  update();
  run(async()=>{if(await loadFactoryWavelengths())await acquire(settings());});
});

$("disconnect").addEventListener("click", async () => {
  if (state.closing) return;
  state.closing = true;
  recovery?.forget();
  state.live = false;
  state.epoch++;
  state.demo = false;
  calibration.reset();
  resetSpectroscopy();
  state.wavelengths=null;state.factorySignature=null;
  update();
  try {
    if (state.driver) await state.driver.disconnect();
    notify("Disconnected. The last captured frame remains available for export.");
    log("Session disconnected.");
  } catch (error) {
    notify("USB close failed: " + error.message, true);
    log(error.message);
  } finally {
    state.closing = false;
    $("deviceInfo").textContent = "No instrument selected";
    update();
  }
});

async function prepare(config) {
  if(!state.wavelengths && !await loadFactoryWavelengths())throw new Error("Factory wavelength loading cancelled.");
  if (!state.demo && state.driver.integrationTime !== config.integration) {
    resetSpectroscopy();
    await state.driver.setIntegrationTime(config.integration);
    recovery?.setIntegration(config.integration);
  }
}
function demoSpectrum(integration, raw) {
  const result = new Uint16Array(1024);
  const phase = Date.now() / 1700;
  for (let i = 0; i < result.length; i++) {
    const nm = 350 + i * 450 / 1023;
    const gaussian = (center, width, height) =>
      height * Math.exp(-0.5 * Math.pow((nm-center)/width, 2));
    const signal = gaussian(436, 4, 19000) + gaussian(546, 8, 42000) +
      gaussian(611 + Math.sin(phase), 15, 26000);
    const value = 700 + signal * integration / 100000 +
      (Math.random() - 0.5) * 300 + (raw ? 300 * Math.sin(i * 0.7) : 0);
    result[i] = Math.max(0, Math.min(65535, Math.round(value)));
  }
  return result;
}
async function acquire(config, {reference = false} = {}) {
  const epoch = state.epoch, demo = state.demo;
  let intensities;
  if (demo) {
    await new Promise(resolve => setTimeout(resolve, 120));
    intensities = demoSpectrum(config.integration, config.raw);
  } else intensities = await state.driver.getSpectrum({ raw: config.raw });
  if (epoch !== state.epoch) return;
  state.frames++;
  state.reviewing=false;
  const context=calibrationContext();
  const alignment=!reference && calibration.active ? {...calibration.active} : null;
  const grid=state.wavelengths ? alignment
    ? alignGrid(state.wavelengths,alignment,context) : state.wavelengths.slice() : null;
  state.frame = {
    calibration:alignment,
    ...(alignment?{factoryWavelengths:state.wavelengths.slice()}:{}),
    captureId: crypto.randomUUID(), label:config.label || "",
    intensities,
    ...(!demo && ['usb4000','jaz'].includes(state.driver.profile)?{detector:{
      activeStart:0,rawPixelCount:state.driver.lastRawSpectrum.length,autoscaleLevel:state.driver.autoscaleLevel,
      opticalDarkMean:Array.from(state.driver.opticalDarkPixels).reduce((a,b)=>a+b,0)/state.driver.opticalDarkPixels.length *
        (state.driver.autoscaleLevel?65535/state.driver.autoscaleLevel:1)
    }}:{}),
    ...(!demo && state.driver.profile==='jaz'?{channel:state.driver.channel}:{}),
    wavelengths: grid,
    integration: config.integration,
    mode: !demo && ['usb4000','jaz'].includes(state.driver.profile) ? 'device-counts'
      : config.raw ? "raw" : "corrected",
    profile: demo ? 'demo' : state.driver.profile || 'obp',
    timestamp: new Date().toISOString(),
    source: demo ? "simulated" : "hardware",
    serial: demo ? "DEMO" : state.driver.serialNumber || state.driver.device.serialNumber || ""
  };
  renderFrame();
  return state.frame;
}
$("capture").addEventListener("click", () => run(async () => {
  const config = settings(), epoch = state.epoch;
  await prepare(config);
  if (epoch !== state.epoch) return;
  const frame=await acquire(config);
  if(frame && $('autoSave').checked) await collections.save(frame);
  if (epoch === state.epoch && active()) {
    notify(state.demo ? "Simulated frame captured." : "Spectrum captured.");
    log("Single frame captured.");
  }
}));
$("live").addEventListener("click", () => run(async () => {
  const config = settings(), epoch = state.epoch;
  const recording=$('recordLive').checked;
  const interval=recording?integerInput('recordInterval',1,3600)*1000:0;
  const limit=recording?integerInput('recordLimit',1,2000):0;
  const datasetId=recording?await collections.ensureActive():null;
  await prepare(config);
  if (epoch !== state.epoch) return;
  state.live = true;
  update();
  notify(state.demo ? "Live demo · simulated spectra." : "Live acquisition running.");
  log("Live acquisition started.");
  let saved=0,lastSaved=-Infinity;
  // Acquisition and persistence are both serialized: no unsaved write backlog.
  while (state.live && epoch === state.epoch && active()) {
    const frame=await acquire(config);
    if(frame && recording && performance.now()-lastSaved>=interval) {
      await collections.save(frame,datasetId);lastSaved=performance.now();saved++;
      $('saveStatus').textContent='Recording '+saved+' / '+limit+' frames saved';
      if(saved>=limit)state.live=false;
    }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  state.live = false;
  if (epoch === state.epoch) {
    notify(recording ? "Recording stopped. " + saved + " frames saved to dataset." : "Live acquisition stopped.");
    log("Live acquisition stopped.");
  }
}));
$("stop").addEventListener("click", () => {
  state.live = false;
  notify("Stopping after the current frame…");
  update();
});
function calibrationContext() {
  if(!state.wavelengths||!state.factorySignature||!active())return null;
  return {
    serial:state.demo?'DEMO':state.driver.serialNumber||state.driver.device.serialNumber||'',
    source:state.demo?'simulated':'hardware',deviceProfile:state.demo?'demo':state.driver.profile||'obp',
    pixelCount:state.wavelengths.length,factorySignature:state.factorySignature
  };
}
async function loadFactoryWavelengths() {
  const epoch=state.epoch;
  const grid=state.demo?Float64Array.from({length:1024},(_,i)=>350+i*450/1023)
    : await state.driver.getWavelengths();
  const signature=await gridSignature(grid, !state.demo && state.driver.profile==='usb4000'
    ? 'usb4000:oceanview:raw0:3648:v1' : !state.demo && state.driver.profile==='jaz'
      ? 'jaz:raw0:2048:channel'+state.driver.channel+':v1' : '');
  if(epoch!==state.epoch)return false;
  state.wavelengths=grid;state.factorySignature=signature;
  calibration.setContext(calibrationContext());
  return true;
}
$('calibrate').addEventListener('click',()=>run(async()=>{
  if(!await loadFactoryWavelengths())return;
  notify('Factory wavelengths loaded for new captures. Existing spectra were kept; capture again to use the loaded axis.');
  log('Loaded factory wavelength grid.');
}));

function renderFrame() {
  const f = state.frame;
  if (!f) return;
  let peakIndex = 0;
  for (let i = 1; i < f.intensities.length; i++) {
    if (f.intensities[i] > f.intensities[peakIndex]) peakIndex = i;
  }
  $("pixels").textContent = f.intensities.length.toLocaleString();
  $("peak").textContent = signalCounts(f)[peakIndex].toLocaleString(undefined,{maximumFractionDigits:1});
  $("position").textContent = f.wavelengths
    ? f.wavelengths[peakIndex].toFixed(2) + " nm" : "px " + peakIndex;
  $("legend").textContent = (f.source === "simulated" ? "SIMULATED · " : "") + f.mode +
    (f.calibration ? " · aligned: " + f.calibration.name : f.wavelengths ? " · factory axis" : " · pixel axis");
  $("frameInfo").textContent = (state.reviewing ? "Saved capture" : "Frame " + state.frames) +
    (f.label ? " · " + f.label : "") + " · " +
    f.integration.toLocaleString() + " µs · " + new Date(f.timestamp).toLocaleTimeString();
  draw();
}

/** Use actual wavelengths rather than assuming uniform sample spacing. */
function draw() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);
  const f = state.frame;
  $("empty").style.display = f ? "none" : "grid";
  plotBox = null;
  if (!f) return;
  const left = 65, right = 20, top = 15, bottom = 48;
  const width = w-left-right, height = h-top-bottom;
  if (width <= 0 || height <= 0) return;
  refreshSpectroscopy();
  const values = displayValues, xValues = f.wavelengths;
  if(!values)return; // Never mislabel unprocessed counts as absorbance/%T.
  let xMin = 0, xMax = values.length - 1, maximum = 0;
  if (xValues) {
    xMin = Infinity; xMax = -Infinity;
    for (const value of xValues) {
      xMin = Math.min(xMin, value); xMax = Math.max(xMax, value);
    }
  }
  if (xMax === xMin) xMax = xMin + 1;
  let minimum=0;
  for (const value of values) if(Number.isFinite(value)){maximum=Math.max(maximum,value);minimum=Math.min(minimum,value);}
  const counts=$('displayMode').value==='counts';
  const yMin=minimum<0?minimum*1.08:0;
  const yMax=Math.max(counts?100:1,maximum*1.08);
  const px = i => left + ((xValues ? xValues[i] : i)-xMin)/(xMax-xMin)*width;
  const py = value => top + height - (value-yMin)/(yMax-yMin)*height;
  ctx.font = "12px system-ui"; ctx.lineWidth = 1;
  for (let n = 0; n <= 4; n++) {
    const y = top + height * n / 4;
    ctx.strokeStyle = "#344353";
    ctx.beginPath(); ctx.moveTo(left,y); ctx.lineTo(w-right,y); ctx.stroke();
    ctx.fillStyle = "#adbdcd"; ctx.textAlign = "right";
    ctx.fillText((yMax-(yMax-yMin)*n/4).toLocaleString(undefined,{maximumFractionDigits:2}),left-10,y+4);
  }
  for (let n = 0; n <= 4; n++) {
    const x = left + width*n/4, value = xMin + (xMax-xMin)*n/4;
    ctx.textAlign = "center";
    ctx.fillText(xValues ? value.toFixed(1) : Math.round(value),x,h-25);
  }
  ctx.fillText(xValues ? "Wavelength (nm)" : "Detector pixel",left+width/2,h-5);
  ctx.save(); ctx.translate(14,top+height/2); ctx.rotate(-Math.PI/2);
  ctx.fillText(counts?"Intensity (counts)":$("displayMode").value==='absorbance'?"Absorbance (AU)":"Transmittance (%)",0,0); ctx.restore();
  ctx.beginPath();
  let gap=true;
  for (let i=0;i<values.length;i++) {
    if(!Number.isFinite(values[i])) {gap=true;continue;}
    if(gap)ctx.moveTo(px(i),py(values[i]));else ctx.lineTo(px(i),py(values[i]));
    gap=false;
  }
  ctx.strokeStyle = "#82d5cb"; ctx.lineWidth = 1.7; ctx.stroke();
  plotBox = { left, width, xMin, xMax };
}
canvas.addEventListener("pointermove", event => {
  const f = state.frame, box = plotBox;
  if (!f || !box) return;
  const rect = canvas.getBoundingClientRect();
  const fraction = Math.max(0,Math.min(1,(event.clientX-rect.left-box.left)/box.width));
  const target = box.xMin + fraction*(box.xMax-box.xMin);
  let index;
  if (f.wavelengths) {
    index = 0;
    for (let i = 1; i < f.wavelengths.length; i++) {
      if (Math.abs(f.wavelengths[i]-target) < Math.abs(f.wavelengths[index]-target)) index = i;
    }
  } else index = Math.max(0, Math.min(f.intensities.length-1, Math.round(target)));
  $("cursor").textContent = "Pixel " + index +
    (f.wavelengths ? " · " + f.wavelengths[index].toFixed(3) + " nm" : "") +
    " · " + (displayValues&&Number.isFinite(displayValues[index])
      ? displayValues[index].toLocaleString(undefined,{maximumFractionDigits:4})+
        ($('displayMode').value==='counts'?' counts':$('displayMode').value==='absorbance'?' AU':' %')
      : 'invalid / reference required');
});
canvas.addEventListener("pointerleave", () => {
  $("cursor").textContent = "Move over the plot to inspect a sample.";
});
new ResizeObserver(draw).observe(canvas.parentElement);

$('export').addEventListener('click',()=>{
  if(!state.frame)return;
  const f=state.frame;
  downloadFile('ocean-'+f.source+'-'+f.timestamp.replace(/[:.]/g,'-')+'.csv',
    datasetCSV({name:'Single capture'},[f]),'text/csv;charset=utf-8');
  log('CSV exported with wavelength calibration provenance.');
});
$("clearLog").addEventListener("click", () => { $("log").textContent = ""; });
if (!navigator.usb || !window.isSecureContext) {
  notify("USB acquisition needs a WebUSB-capable browser over HTTPS or localhost. Demo mode is available.");
}
$('deviceHelp').addEventListener('click',()=>$('helpDialog').showModal());
$('closeHelp').addEventListener('click',()=>$('helpDialog').close());
collections=new DatasetPanel({
  getFrame:()=>state.frame,
  canEdit:()=>!state.busy&&!state.live&&!state.closing,
  isLive:()=>state.live,
  review:frame=>{
    state.frame=frame;state.reviewing=true;$('sampleLabel').value=frame.label||'';
    renderFrame();notify('Reviewing a saved capture. Capture a new frame to return to acquisition.');update();
  },
  update,notify,log
});
calibration=new CalibrationPanel({
  canEdit:()=>!state.busy&&!state.live&&!state.closing&&!collections.busy,
  isConnected:active,run,notify,log,
  capture:async()=>{
    const epoch=state.epoch,config=settings();
    await prepare(config);
    if(epoch!==state.epoch||!await loadFactoryWavelengths())return null;
    const frame=await acquire(config,{reference:true});
    if(!frame||epoch!==state.epoch)return null;
    return {frame,context:calibrationContext()};
  },
  show:frame=>{state.frame=frame;state.reviewing=false;renderFrame();update();}
});
canvas.addEventListener('click',event=>{
  const f=state.frame,box=plotBox;if(!f||!box)return;
  const rect=canvas.getBoundingClientRect();
  const ratio=Math.max(0,Math.min(1,(event.clientX-rect.left-box.left)/box.width));
  const target=box.xMin+ratio*(box.xMax-box.xMin);
  let pixel=Math.round(target);
  if(f.wavelengths){pixel=0;for(let p=1;p<f.wavelengths.length;p++) {
    if(Math.abs(f.wavelengths[p]-target)<Math.abs(f.wavelengths[pixel]-target))pixel=p;
  }}
  calibration.pickPixel(pixel,f.captureId);
});
for(const id of ['integration','mode']) $(id).addEventListener('input',()=>{resetSpectroscopy();draw();update();});
$('displayMode').addEventListener('change',draw);
for(const [id,kind] of [['captureDark','dark'],['captureWhite','reference']]) {
  $(id).addEventListener('click',()=>run(async()=>{
    const config=settings(),epoch=state.epoch;
    await prepare(config);
    if(epoch!==state.epoch)return;
    const frame=await acquire(config);
    if(!frame||epoch!==state.epoch)return;
    spectroscopySession.capture(kind,frame);
    draw();notify(kind==='dark'?'Dark captured. Unblock the source for the reference.':'Reference captured. Insert the sample for measurement.');
  }));
}
if(navigator.usb)recovery=new USBRecovery({
  usb:navigator.usb,
  onSettled:update,
  canAttempt:()=>!state.busy&&!state.closing&&!collections?.busy,
  onStatus:message=>{notify(message);log(message);update();},
  attempt:async(device,{options,integration,moduleSerial},signal)=>{
    if(signal.aborted)throw new Error('USB recovery cancelled.');
    const driver=createSpectrometerForDevice(device,options);
    state.busy=true;update();
    try {await openHardwareSession(driver,device,{recovered:true,integration,moduleSerial,signal});}
    finally {state.busy=false;update();}
  }
});
initializeWorkspace();
update();
draw();
collections.init().then(()=>calibration.init(collections.store));

