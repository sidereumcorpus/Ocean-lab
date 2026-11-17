import { validateCalibration } from './calibration.js';
/** Local, dependency-free dataset storage and portable file formats. */
export const MAX_FRAMES = 2000;
const MAX_PIXELS = 32768;
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
function text(value, max, name) {
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid ' + name + '.');
  return value;
}
function date(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid capture date.');
  return new Date(value).toISOString();
}
export function normalizeFrame(frame) {
  if (!frame || typeof frame !== 'object') throw new Error('Invalid frame.');
  const values = frame.intensities;
  if (!(Array.isArray(values) || values instanceof Uint16Array) ||
      !values.length || values.length > MAX_PIXELS) throw new Error('Invalid intensity array.');
  for (const v of values) {
    if (!Number.isInteger(v) || v < 0 || v > 65535) throw new Error('Intensity must be uint16.');
  }
  let wavelengths = null;
  if (frame.wavelengths !== null && frame.wavelengths !== undefined) {
    const w = frame.wavelengths;
    if (!(Array.isArray(w) || w instanceof Float64Array) || w.length !== values.length ||
        Array.from(w).some(v => typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error('Wavelength and intensity arrays must match and contain finite numbers.');
    }
    wavelengths = Float64Array.from(w);
  }
  if (!Number.isInteger(frame.integration) || frame.integration < 1 || frame.integration > 0xffffffff) {
    throw new Error('Invalid integration time.');
  }
  if (!['hardware','simulated'].includes(frame.source)) throw new Error('Invalid data source.');
  if (!['raw','corrected','device-counts'].includes(frame.mode)) throw new Error('Invalid spectrum type.');
  if (!['demo','obp','usb4000'].includes(frame.profile)) throw new Error('Invalid instrument profile.');
  if ((frame.source === 'simulated') !== (frame.profile === 'demo')) {
    throw new Error('Simulated data must retain its demo profile.');
  }
  const normalized = {
    captureId: typeof frame.captureId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(frame.captureId)
      ? frame.captureId : uuid(),
    label: text(frame.label || '',120,'sample label'),
    intensities: Uint16Array.from(values), wavelengths,
    integration: frame.integration, mode:frame.mode, profile:frame.profile,
    source:frame.source, serial:text(frame.serial || '',200,'serial'), timestamp:date(frame.timestamp)
  };
  if(frame.calibration !== undefined) normalized.calibration=frame.calibration===null?null:validateCalibration(frame.calibration);
  if(normalized.calibration) {
    const c=normalized.calibration,base=frame.factoryWavelengths;
    if(!wavelengths || !(Array.isArray(base)||base instanceof Float64Array) || base.length!==values.length ||
      c.pixelCount!==values.length || c.serial!==normalized.serial || c.source!==normalized.source ||
      c.deviceProfile!==normalized.profile || Array.from(base).some((v,i)=>
        typeof v!=='number'||!Number.isFinite(v)||Math.abs(wavelengths[i]-(v+c.offsetNm))>1e-7)) {
      throw new Error('Calibration provenance does not match the saved spectrum.');
    }
    normalized.factoryWavelengths=Float64Array.from(base);
  }
  return normalized;
}
export function framePeak(frame) {
  let index = 0;
  for (let i=1;i<frame.intensities.length;i++) if(frame.intensities[i]>frame.intensities[index]) index=i;
  return { index, intensity:frame.intensities[index], wavelength:frame.wavelengths ? frame.wavelengths[index] : null };
}
export function encodeBackup(dataset, frames) {
  return JSON.stringify({format:'ocean-lab-dataset',version:1,
    dataset:{name:dataset.name,notes:dataset.notes,createdAt:dataset.createdAt},
    frames:frames.map(f => {const v=normalizeFrame(f);return {...v,
      intensities:Array.from(v.intensities),wavelengths:v.wavelengths?Array.from(v.wavelengths):null,
      ...(v.factoryWavelengths?{factoryWavelengths:Array.from(v.factoryWavelengths)}:{})};})});
}
export function decodeBackup(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  if (!data || data.format !== 'ocean-lab-dataset' || data.version !== 1 ||
      !data.dataset || !Array.isArray(data.frames) || data.frames.length > MAX_FRAMES) {
    throw new Error('Unsupported Ocean Lab backup.');
  }
  const name=text(data.dataset.name,120,'dataset name').trim();
  if(!name)throw new Error('Dataset name cannot be empty.');
  return {dataset:{name,notes:text(data.dataset.notes || '',10000,'notes'),
    createdAt:date(data.dataset.createdAt)},frames:data.frames.map(normalizeFrame)};
}
function csvCell(value) {
  let s=String(value);
  if(typeof value === 'string' && /^[\s]*[=+@\-]/.test(s)) s="'"+s;
  return '"'+s.replace(/"/g,'""')+'"';
}
/** Long-form CSV: rows remain valid when captures have different pixel grids. */
export function datasetCSV(dataset, frames) {
  const rows=['dataset,capture_id,sample_label,timestamp_utc,source,profile,serial,spectrum_type,integration_us,pixel,wavelength_nm,intensity_counts,calibration_kind,calibration_id,calibration_name,offset_nm,reference_nm,reference_peak_pixel,factory_wavelength_nm'];
  for(const frame of frames) {
    const f=normalizeFrame(frame);
    for(let p=0;p<f.intensities.length;p++) rows.push([
      dataset.name,f.captureId,f.label,f.timestamp,f.source,f.profile,f.serial,
      f.mode,f.integration,p,f.wavelengths?f.wavelengths[p]:'',f.intensities[p],
      f.calibration?.kind||(f.wavelengths?'factory':'none'),f.calibration?.id||'',f.calibration?.name||'',
      f.calibration?.offsetNm??'',f.calibration?.referenceNm??'',f.calibration?.peakPixel??'',
      f.factoryWavelengths?f.factoryWavelengths[p]:f.wavelengths?f.wavelengths[p]:''
    ].map(csvCell).join(','));
  }
  return rows.join('\r\n');
}

export class DatasetStore {
  constructor() { this.db=null; }
  async open() {
    if(this.db)return this;
    if(typeof indexedDB === 'undefined')throw new Error('Local dataset storage is unavailable in this browser.');
    this.db=await new Promise((resolve,reject)=>{
      const request=indexedDB.open('ocean-lab-datasets',2);
      request.onupgradeneeded=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains('datasets'))db.createObjectStore('datasets',{keyPath:'id'});
        if(!db.objectStoreNames.contains('frames')) {
          const frames=db.createObjectStore('frames',{keyPath:'id'});
          frames.createIndex('datasetId','datasetId',{unique:false});
        }
        if(!db.objectStoreNames.contains('calibrations'))db.createObjectStore('calibrations',{keyPath:'id'});
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(new Error('Close other Ocean Lab tabs to finish opening dataset storage.'));
    });
    this.db.onversionchange=()=>{this.db.close();this.db=null;};
    return this;
  }
  _tx(names,mode,body) {
    return new Promise((resolve,reject)=>{
      if(!this.db){reject(new Error('Dataset storage is not open.'));return;}
      const tx=this.db.transaction(names,mode);
      let result;
      tx.oncomplete=()=>resolve(result);
      tx.onabort=()=>reject(tx.error || new Error('Dataset operation was cancelled.'));
      tx.onerror=()=>{}; // onabort reports failures after rollback.
      try{body(tx,value=>{result=value;});}catch(error){tx.abort();reject(error);}
    });
  }
  async listCalibrations() {
    return this._tx(['calibrations'],'readonly',(tx,done)=>{
      tx.objectStore('calibrations').getAll().onsuccess=e=>done(e.target.result);
    });
  }
  async saveCalibration(profile) {
    const clean=validateCalibration(profile);
    return this._tx(['calibrations'],'readwrite',(tx,done)=>{
      tx.objectStore('calibrations').put(clean);done(clean);
    });
  }
  async list() {
    return this._tx(['datasets'],'readonly',(tx,done)=>{
      tx.objectStore('datasets').getAll().onsuccess=e=>done(e.target.result.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)));
    });
  }
  async frames(datasetId) {
    return this._tx(['frames'],'readonly',(tx,done)=>{
      tx.objectStore('frames').index('datasetId').getAll(datasetId).onsuccess=e=>
        done(e.target.result.sort((a,b)=>a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id)));
    });
  }
  async create(name, notes='') {
    name=text(name,120,'dataset name').trim();if(!name)throw new Error('Give the dataset a name.');
    const dataset={id:uuid(),name,notes:text(notes,10000,'notes'),createdAt:now(),updatedAt:now()};
    await this._tx(['datasets'],'readwrite',(tx,done)=>{tx.objectStore('datasets').add(dataset);done(dataset);});
    return dataset;
  }
  async update(dataset) {
    const name=text(dataset.name,120,'dataset name').trim();if(!name)throw new Error('Give the dataset a name.');
    const item={...dataset,name,notes:text(dataset.notes || '',10000,'notes'),updatedAt:now()};
    await this._tx(['datasets'],'readwrite',tx=>tx.objectStore('datasets').put(item));
    return item;
  }
  async saveFrame(datasetId,frame) {
    const clean=normalizeFrame(frame);
    const item={...clean,id:datasetId+':'+clean.captureId,datasetId};
    return this._tx(['datasets','frames'],'readwrite',(tx,done)=>{
      const datasets=tx.objectStore('datasets'), frames=tx.objectStore('frames');
      datasets.get(datasetId).onsuccess=e=>{
        const dataset=e.target.result;
        if(!dataset){tx.abort();return;}
        frames.get(item.id).onsuccess=existing=>{
          frames.index('datasetId').count(datasetId).onsuccess=count=>{
            if(!existing.target.result && count.target.result>=MAX_FRAMES){tx.abort();return;}
            frames.put(item);datasets.put({...dataset,updatedAt:now()});done(item);
          };
        };
      };
    });
  }
  async deleteFrame(id) { return this._tx(['frames'],'readwrite',tx=>tx.objectStore('frames').delete(id)); }
  async deleteDataset(id) {
    return this._tx(['datasets','frames'],'readwrite',tx=>{
      tx.objectStore('datasets').delete(id);
      const frames=tx.objectStore('frames');
      frames.index('datasetId').openCursor(IDBKeyRange.only(id)).onsuccess=e=>{
        const cursor=e.target.result;if(cursor){cursor.delete();cursor.continue();}
      };
    });
  }
  async importBackup(parsed) {
    const dataset={...parsed.dataset,id:uuid(),updatedAt:now()};
    const frames=parsed.frames.map(f=>({...normalizeFrame(f),captureId:uuid()}));
    // A single transaction: import either succeeds fully or writes nothing.
    await this._tx(['datasets','frames'],'readwrite',tx=>{
      tx.objectStore('datasets').add(dataset);
      for(const f of frames)tx.objectStore('frames').add({...f,id:dataset.id+':'+f.captureId,datasetId:dataset.id});
    });
    return dataset;
  }
}
