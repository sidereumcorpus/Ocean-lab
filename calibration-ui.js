import { findLinePeak, matchesCalibration, validateCalibration } from './calibration.js?v=recovery-1';
const $=id=>document.getElementById(id);
export class CalibrationPanel {
  constructor(callbacks) {
    this.callbacks=callbacks;this.profiles=[];this.active=null;this.reference=null;this.context=null;this.draft=null;this.store=null;
    this.bind();
  }
  async init(store) {
    this.store=store;
    try{this.profiles=await store.listCalibrations();}
    catch(error){this.store=null;this.callbacks.log('Calibration profile storage: '+error.message);}
    this.renderProfiles();this.update();
  }
  reset() {
    this.active=null;this.context=null;this.reference=null;this.draft=null;
    $('alignmentPreview').textContent='Capture an isolated reference line to start.';
    this.renderProfiles();this.update();
  }
  setContext(context) {
    if(this.context && (this.context.factorySignature!==context.factorySignature||this.context.serial!==context.serial||this.context.source!==context.source)) {
      this.reference=null;this.draft=null;
      $('alignmentPreview').textContent='Instrument or factory grid changed. Capture a fresh reference.';
    }
    this.context=context;
    if(this.active&&!matchesCalibration(this.active,context))this.active=null;
    this.renderProfiles();this.update();
  }
  renderProfiles() {
    const select=$('alignmentProfiles'),selected=select.value;select.replaceChildren(new Option('Choose matching profile',''));
    if(this.context) for(const p of this.profiles.filter(p=>matchesCalibration(p,this.context))) {
      select.add(new Option(p.name+' · '+p.offsetNm.toFixed(3)+' nm',p.id));
    }
    if([...select.options].some(o=>o.value===selected))select.value=selected;
  }
  update() {
    const locked=!this.callbacks.canEdit();
    $('captureReference').disabled=locked||!this.callbacks.isConnected();
    for(const id of ['referenceNm','peakSeed','peakRadius','alignmentName','alignmentProfiles'])$(id).disabled=locked;
    $('showReference').disabled=locked||!this.reference;
    $('previewAlignment').disabled=locked||!this.reference;
    $('saveAlignment').disabled=locked||!this.draft||!this.context?.serial||!this.store;
    $('applyAlignment').disabled=locked||!this.context?.serial||!$('alignmentProfiles').value;
    $('factoryAlignment').disabled=locked||!this.active;
    $('alignmentStatus').textContent=this.active
      ? 'Next captures: '+this.active.name+' · offset '+this.active.offsetNm.toFixed(4)+' nm · '+this.active.serial
      : 'Next captures: factory wavelengths (no alignment offset).';
    $('alignmentIdentity').textContent=this.context
      ? this.context.serial?'Instrument: '+this.context.serial+' · '+this.context.pixelCount+' samples'+(this.context.source==='simulated'?' · SIMULATED':'')
        : 'This instrument reports no serial number. Preview is available; saving and applying a persistent profile requires a serial number.'
      : 'Capture a reference or load factory wavelengths to find matching saved profiles.';
  }
  setReference(frame,context) {
    this.setContext(context);
    this.reference={...frame,intensities:frame.intensities.slice(),wavelengths:frame.wavelengths.slice()};
    let peak=0;for(let p=1;p<frame.intensities.length;p++)if(frame.intensities[p]>frame.intensities[peak])peak=p;
    $('peakSeed').value=peak;
    if(!$('alignmentName').value)$('alignmentName').value='Line alignment '+new Date().toLocaleDateString();
    this.invalidate();this.update();
  }
  invalidate() {
    this.draft=null;
    $('alignmentPreview').textContent=this.reference
      ? 'Reference captured. Select the intended line on the plot, or enter its pixel, then Preview alignment.'
      : 'Capture an isolated reference line to start.';
    this.update();
  }
  pickPixel(pixel,frameId) {
    if(!this.callbacks.canEdit()||!this.reference||frameId!==this.reference.captureId)return;
    $('peakSeed').value=pixel;this.invalidate();
  }
  bind() {
    $('captureReference').addEventListener('click',()=>this.callbacks.run(async()=>{
      const result=await this.callbacks.capture();if(!result)return;
      this.setReference(result.frame,result.context);
      this.callbacks.notify('Reference captured without saving to your dataset. Enter the known line wavelength and preview.');
    }));
    $('showReference').addEventListener('click',()=>{
      if(this.callbacks.canEdit()&&this.reference)this.callbacks.show(this.reference);
    });
    for(const id of ['referenceNm','peakSeed','peakRadius'])$(id).addEventListener('input',()=>this.invalidate());
    $('alignmentProfiles').addEventListener('change',()=>this.update());
    $('previewAlignment').addEventListener('click',()=>this.callbacks.run(async()=>{
      const known=Number($('referenceNm').value),seed=Number($('peakSeed').value),radius=Number($('peakRadius').value);
      if(!$('referenceNm').value.trim()||!Number.isFinite(known)||known<=0||known>100000)throw new Error('Enter a known reference wavelength greater than 0 nm.');
      if(!$('peakSeed').value.trim())throw new Error('Select the reference peak pixel.');
      const peak=findLinePeak(this.reference.intensities,this.reference.wavelengths,seed,radius);
      this.draft={...peak,referenceNm:known,offsetNm:known-peak.measuredNm,context:{...this.context}};
      const table=document.createElement('table');
      for(const [label,value] of [['Detected peak pixel',peak.pixel.toFixed(4)],['Factory wavelength',peak.measuredNm.toFixed(4)+' nm'],
        ['Known / aligned wavelength',known.toFixed(4)+' nm'],['Proposed offset',this.draft.offsetNm.toFixed(4)+' nm']]) {
        const tr=document.createElement('tr'),th=document.createElement('th'),td=document.createElement('td');th.textContent=label;td.textContent=value;tr.append(th,td);table.append(tr);
      }
      $('alignmentPreview').replaceChildren(table);
      if(Math.abs(this.draft.offsetNm)>10){const note=document.createElement('p');note.textContent='Large shift: check the source wavelength and selected line before saving.';$('alignmentPreview').append(note);}
      this.callbacks.notify('Alignment preview ready. Nothing has been applied yet.');
    }));
    $('saveAlignment').addEventListener('click',()=>this.callbacks.run(async()=>{
      if(!this.draft||!this.store)throw new Error('Preview an alignment before saving.');
      const p=validateCalibration({kind:'single-line-offset',version:1,id:crypto.randomUUID(),name:$('alignmentName').value.trim(),
        serial:this.draft.context.serial,source:this.draft.context.source,deviceProfile:this.draft.context.deviceProfile,
        factorySignature:this.draft.context.factorySignature,pixelCount:this.draft.context.pixelCount,
        peakPixel:this.draft.pixel,measuredNm:this.draft.measuredNm,referenceNm:this.draft.referenceNm,
        offsetNm:this.draft.offsetNm,createdAt:new Date().toISOString()});
      if(!matchesCalibration(p,this.context))throw new Error('Instrument or factory grid changed. Capture another reference.');
      await this.store.saveCalibration(p);this.profiles.push(p);this.active=p;this.renderProfiles();$('alignmentProfiles').value=p.id;
      this.callbacks.notify('Calibration saved and enabled for NEW captures. Existing spectra and factory coefficients were kept.');
      this.callbacks.log('Enabled alignment '+p.name+' ('+p.offsetNm.toFixed(4)+' nm).');
    }));
    $('applyAlignment').addEventListener('click',()=>this.callbacks.run(async()=>{
      const profile=this.profiles.find(p=>p.id===$('alignmentProfiles').value);
      if(!profile||!matchesCalibration(profile,this.context))throw new Error('No matching calibration for this instrument and grid.');
      this.active=profile;this.callbacks.notify('Selected calibration enabled for NEW captures. Existing spectra were kept.');
    }));
    $('factoryAlignment').addEventListener('click',()=>this.callbacks.run(async()=>{
      this.active=null;this.callbacks.notify('Factory wavelengths enabled for NEW captures. Saved spectra were kept.');
    }));
  }
}
