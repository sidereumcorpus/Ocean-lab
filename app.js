import { selectSpectrometer } from "./spectrometer.js";
import { DatasetPanel } from "./dataset-ui.js";

const $ = id => document.getElementById(id);
const state = {
  driver: null, demo: false, busy: false, live: false,
  closing: false, epoch: 0, frame: null, wavelengths: null, frames: 0, reviewing: false
};
const canvas = $("plot");
const ctx = canvas.getContext("2d");
let plotBox = null;
let collections;

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
  const dataBusy = Boolean(collections?.busy);
  const legacy = connected && !state.demo && state.driver.profile === 'usb4000';
  const corrected = document.querySelector('#mode option[value="corrected"]');
  const raw = document.querySelector('#mode option[value="raw"]');
  corrected.disabled = legacy;
  raw.textContent = legacy ? 'Device counts (USB4000)' : 'Raw ADC';
  if (legacy) $('mode').value = 'raw';
  $('integration').min = legacy ? '3800' : '1';
  $('integration').max = legacy ? '65535000' : '4294967295';
  $('integration').step = legacy ? '10' : '1';
  $('deviceNote').textContent = legacy
    ? 'USB4000: 3840 readout samples include non-active detector regions. Normal mode uses 3800–65535000 µs in 10 µs increments. No host corrections are applied.'
    : 'Wavelengths assume a full, unbinned detector readout.';
  $("status").textContent = state.closing ? "Disconnecting…"
    : state.demo ? "Demo · simulated"
    : state.driver && state.driver.connected ? "USB connected"
    : state.busy ? "Working…" : "Disconnected";
  $("connect").disabled = connected || state.busy || dataBusy || state.closing ||
    !navigator.usb || !window.isSecureContext;
  $("demo").disabled = connected || state.busy || dataBusy || state.closing;
  $("disconnect").disabled = !connected || state.closing;
  ["capture","live","calibrate"].forEach(id => {
    $(id).disabled = !connected || state.busy || dataBusy || state.live || state.closing;
  });
  if(state.reviewing) $("calibrate").disabled=true;
  $("stop").disabled = !state.live;
  $("export").disabled = !state.frame;
  $("integration").disabled = state.busy || state.live || state.closing;
  $("mode").disabled = state.busy || state.live || state.closing;
  $("settings").disabled = connected || state.busy || dataBusy || state.closing;
  if(collections) collections.update();
}
function clearFrame() {
  state.frame = null;
  state.reviewing = false;
  state.wavelengths = null;
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

$("connect").addEventListener("click", () => run(async () => {
  // Keep connect before the first await; USB chooser needs user activation.
  const {driver,device} = await selectSpectrometer(driverOptions());
  state.driver = driver;
  driver.onDisconnect = () => {
    state.epoch++;
    state.live = false;
    $("deviceInfo").textContent = "Instrument unplugged";
    notify("Instrument unplugged. Reconnect to continue.", true);
    log("USB device removed.");
    update();
  };
  await driver.connect(device);
  state.demo = false;
  state.epoch++;
  clearFrame();
  const d = driver.device;
  $("deviceInfo").textContent =
    (d.productName || "Spectrometer") + " · " + (driver.serialNumber || d.serialNumber || "No serial reported") +
    (driver.profile === "usb4000" ? " · USB4000 legacy · " + (driver.highSpeed ? "high speed" : "full speed") : " · OBP");
  log("Connected: " + (d.productName || "OBP spectrometer") + ".");
  notify(driver.profile === 'usb4000'
    ? 'USB4000 detected automatically. Capture device counts, then Load wavelengths. No endpoint values are needed.'
    : 'OBP connected. Set integration time and capture a spectrum.');
}));

$("demo").addEventListener("click", () => {
  state.demo = true;
  state.driver = null;
  state.epoch++;
  clearFrame();
  $("deviceInfo").textContent = "Simulated instrument · 1024 pixels";
  notify("Demo mode: all spectra and wavelengths are simulated.");
  log("Demo session started.");
  update();
  run(() => acquire(settings()));
});

$("disconnect").addEventListener("click", async () => {
  if (state.closing) return;
  state.closing = true;
  state.live = false;
  state.epoch++;
  state.demo = false;
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
  if (!state.demo) await state.driver.setIntegrationTime(config.integration);
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
async function acquire(config) {
  const epoch = state.epoch, demo = state.demo;
  let intensities;
  if (demo) {
    await new Promise(resolve => setTimeout(resolve, 120));
    intensities = demoSpectrum(config.integration, config.raw);
  } else intensities = await state.driver.getSpectrum({ raw: config.raw });
  if (epoch !== state.epoch) return;
  state.frames++;
  state.reviewing=false;
  state.frame = {
    captureId: crypto.randomUUID(), label:config.label || "",
    intensities,
    wavelengths: state.wavelengths ? state.wavelengths.slice() : null,
    integration: config.integration,
    mode: !demo && state.driver.profile === 'usb4000' ? 'device-counts'
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
$("calibrate").addEventListener("click", () => run(async () => {
  const epoch = state.epoch;
  if (!state.frame) {
    const config = settings();
    await prepare(config);
    if (epoch !== state.epoch) return;
    await acquire(config);
    if (epoch !== state.epoch) return;
  }
  let wavelengths;
  if (state.demo) {
    wavelengths = Float64Array.from(
      { length: state.frame.intensities.length },
      (_, i) => 350 + i * 450 / (state.frame.intensities.length - 1)
    );
  } else wavelengths = await state.driver.getWavelengths();
  if (epoch !== state.epoch) return;
  if (wavelengths.length !== state.frame.intensities.length) {
    throw new Error("Wavelength and intensity lengths differ.");
  }
  state.wavelengths = wavelengths;
  state.frame.wavelengths = wavelengths.slice();
  // Updating the same capture adds its calibration without duplicating a row.
  if(collections.ready && collections.frames.some(f=>f.captureId===state.frame.captureId)) {
    await collections.save(state.frame);
  }
  renderFrame();
  notify(state.demo ? "Simulated wavelength axis loaded."
    : "Wavelength coefficients loaded from the instrument.");
  log("Wavelength axis loaded.");
}));

function renderFrame() {
  const f = state.frame;
  if (!f) return;
  let peakIndex = 0;
  for (let i = 1; i < f.intensities.length; i++) {
    if (f.intensities[i] > f.intensities[peakIndex]) peakIndex = i;
  }
  $("pixels").textContent = f.intensities.length.toLocaleString();
  $("peak").textContent = f.intensities[peakIndex].toLocaleString();
  $("position").textContent = f.wavelengths
    ? f.wavelengths[peakIndex].toFixed(2) + " nm" : "px " + peakIndex;
  $("legend").textContent = (f.source === "simulated" ? "SIMULATED · " : "") + f.mode;
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
  const values = f.intensities, xValues = f.wavelengths;
  let xMin = 0, xMax = values.length - 1, maximum = 0;
  if (xValues) {
    xMin = Infinity; xMax = -Infinity;
    for (const value of xValues) {
      xMin = Math.min(xMin, value); xMax = Math.max(xMax, value);
    }
  }
  if (xMax === xMin) xMax = xMin + 1;
  for (const value of values) maximum = Math.max(maximum, value);
  const yMax = Math.max(100, Math.ceil(maximum * 1.08 / 100) * 100);
  const px = i => left + ((xValues ? xValues[i] : i)-xMin)/(xMax-xMin)*width;
  const py = value => top + height - value/yMax*height;
  ctx.font = "12px system-ui"; ctx.lineWidth = 1;
  for (let n = 0; n <= 4; n++) {
    const y = top + height * n / 4;
    ctx.strokeStyle = "#344353";
    ctx.beginPath(); ctx.moveTo(left,y); ctx.lineTo(w-right,y); ctx.stroke();
    ctx.fillStyle = "#adbdcd"; ctx.textAlign = "right";
    ctx.fillText(Math.round(yMax*(1-n/4)).toLocaleString(),left-10,y+4);
  }
  for (let n = 0; n <= 4; n++) {
    const x = left + width*n/4, value = xMin + (xMax-xMin)*n/4;
    ctx.textAlign = "center";
    ctx.fillText(xValues ? value.toFixed(1) : Math.round(value),x,h-25);
  }
  ctx.fillText(xValues ? "Wavelength (nm)" : "Detector pixel",left+width/2,h-5);
  ctx.save(); ctx.translate(14,top+height/2); ctx.rotate(-Math.PI/2);
  ctx.fillText("Intensity (counts)",0,0); ctx.restore();
  const gradient = ctx.createLinearGradient(0,top,0,top+height);
  gradient.addColorStop(0,"rgba(130,213,203,.25)");
  gradient.addColorStop(1,"rgba(130,213,203,.015)");
  ctx.beginPath(); ctx.moveTo(px(0),py(0));
  for (let i = 0; i < values.length; i++) ctx.lineTo(px(i),py(values[i]));
  ctx.lineTo(px(values.length-1),py(0)); ctx.closePath();
  ctx.fillStyle = gradient; ctx.fill();
  ctx.beginPath();
  for (let i = 0; i < values.length; i++) {
    if (i === 0) ctx.moveTo(px(i),py(values[i]));
    else ctx.lineTo(px(i),py(values[i]));
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
    " · " + f.intensities[index].toLocaleString() + " counts";
});
canvas.addEventListener("pointerleave", () => {
  $("cursor").textContent = "Move over the plot to inspect a sample.";
});
new ResizeObserver(draw).observe(canvas.parentElement);

$("export").addEventListener("click", () => {
  const f = state.frame;
  if (!f) return;
  // Prefix formula initiators in untrusted metadata for spreadsheet safety.
  const csvCell = value => {
    let text = String(value);
    if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g,'""') + '"';
  };
  const rows = [
    "pixel,wavelength_nm,intensity_counts,integration_us,spectrum_type,source,serial,timestamp_utc,profile"
  ];
  for (let i = 0; i < f.intensities.length; i++) {
    const values = [i, f.wavelengths ? f.wavelengths[i] : "", f.intensities[i],
      f.integration, f.mode, f.source, f.serial, f.timestamp, f.profile];
    rows.push(values.map(csvCell).join(","));
  }
  const blob = new Blob([rows.join("\r\n")], { type:"text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url;
  link.download = "ocean-" + f.source + "-" + f.timestamp.replace(/[:.]/g,"-") + ".csv";
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  log("CSV exported.");
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
update();
draw();
collections.init();

