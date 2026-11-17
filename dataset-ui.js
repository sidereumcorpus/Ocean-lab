import { DatasetStore, MAX_FRAMES, framePeak, encodeBackup, decodeBackup, datasetCSV } from './datasets.js?v=pixels-3';
const $=id=>document.getElementById(id);
export function downloadFile(name,content,type) {
  const url=URL.createObjectURL(new Blob([content],{type}));
  const link=document.createElement('a');link.href=url;link.download=name;
  document.body.appendChild(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const fileName=name=>(name.replace(/[^a-z0-9_-]+/gi,'-').slice(0,70)||'dataset');

export class DatasetPanel {
  constructor(callbacks) {
    this.callbacks=callbacks;this.store=new DatasetStore();
    this.datasets=[];this.frames=[];this.activeId='';this.ready=false;this.busy=false;
    this.reviewedId='';
  }
  async init() {
    this.bind();
    try {
      await this.store.open();this.ready=true;
      await this.refresh();
      $('storageStatus').textContent='Saved on this browser and device. Export JSON backups before clearing browser data.';
    } catch(error) {
      this.ready=false;
      $("autoSave").checked=false;$("recordLive").checked=false;
      $('storageStatus').textContent='Storage unavailable: '+error.message+' You can still capture and export individual frames.';
      this.callbacks.log(error.message);
    }
    this.update();
  }
  get dataset(){return this.datasets.find(d=>d.id===this.activeId);}
  async refresh() {
    this.datasets=await this.store.list();
    if(!this.datasets.some(d=>d.id===this.activeId))this.activeId=this.datasets[0]?.id||'';
    this.frames=this.activeId?await this.store.frames(this.activeId):[];
    const select=$('datasetSelect');select.replaceChildren();
    const empty=new Option('Choose a dataset', '');select.add(empty);
    for(const d of this.datasets)select.add(new Option(d.name,d.id));
    select.value=this.activeId;
    $('datasetTitle').value=this.dataset?.name||'';
    $('datasetNotes').value=this.dataset?.notes||'';
    this.render();
  }
  update() {
    const locked=this.busy||!this.callbacks.canEdit();
    for(const id of ['datasetSelect','datasetName','createDataset','datasetTitle','datasetNotes',
      'saveDatasetDetails','deleteDataset','saveFrame','exportDataset','backupDataset','importDataset',
      'autoSave','recordLive','recordInterval','recordLimit','sampleLabel']) {
      $(id).disabled=!this.ready||locked;
    }
    for(const id of ['datasetTitle','datasetNotes','saveDatasetDetails','deleteDataset','exportDataset','backupDataset']) {
      if(!this.dataset)$(id).disabled=true;
    }
    if(!this.callbacks.getFrame())$('saveFrame').disabled=true;
    $('recordState').textContent=$('recordLive').checked
      ? this.callbacks.isLive()?'Recording to dataset':'Ready to record. Start live to collect the configured series.'
      : 'Live mode is preview-only. Enable recording above to save a series.';
    for(const button of $('captureRows').querySelectorAll('button'))button.disabled=locked;
  }
  async action(operation) {
    if(this.busy||!this.callbacks.canEdit())return;
    this.busy=true;this.callbacks.update();this.update();
    try{await operation();}
    catch(error){this.callbacks.notify(error.name==='QuotaExceededError'
      ? 'Browser storage is full. Export a backup, then remove older datasets.' : error.message,true);}
    finally{this.busy=false;this.callbacks.update();this.update();}
  }
  async ensureActive() {
    if(!this.ready)throw new Error('Dataset storage is unavailable. Turn off saving or export individual frames.');
    if(!this.dataset) {
      const d=await this.store.create($('datasetName').value.trim()||'Dataset '+new Date().toLocaleString());
      this.activeId=d.id;await this.refresh();
    }
    return this.activeId;
  }
  async save(frame,datasetId=null) {
    const id=datasetId||await this.ensureActive();
    if(this.frames.length>=MAX_FRAMES && !this.frames.some(f=>f.captureId===frame.captureId)) {
      throw new Error('Dataset limit reached ('+MAX_FRAMES+' frames). Create another dataset.');
    }
    const item=await this.store.saveFrame(id,frame);
    // Dataset changes are disabled during recording, so active ID stays stable.
    await this.refresh();
    $('saveStatus').textContent='Saved '+new Date(frame.timestamp).toLocaleTimeString()+' · '+this.frames.length+' captures';
    return item;
  }
  render() {
    $('datasetSummary').textContent=this.dataset
      ? this.frames.length+' captures · '+this.frames.filter(f=>f.source==='hardware').length+' hardware · '+
        this.frames.filter(f=>f.source==='simulated').length+' simulated'
      : 'Create a dataset or save a frame to start a collection.';
    const tbody=$('captureRows');tbody.replaceChildren();
    // A bounded table keeps long recording sessions responsive.
    const visible=this.frames.slice(-100).reverse();
    $('historyNote').textContent=this.frames.length>100?'Showing the newest 100 captures. Exports include all '+this.frames.length+'.':'';
    if(!visible.length) {
      const tr=document.createElement('tr'),td=document.createElement('td');
      td.colSpan=5;td.textContent='No saved captures yet.';tr.append(td);tbody.append(tr);
    }
    for(const frame of visible) {
      const tr=document.createElement('tr');tr.classList.toggle('selected',frame.id===this.reviewedId);
      const peak=framePeak(frame);
      const cells=[frame.label||new Date(frame.timestamp).toLocaleTimeString(),
        frame.source==='simulated'?'SIMULATED':frame.profile.toUpperCase(),
        frame.integration.toLocaleString()+' µs'+(frame.calibration?' · aligned':''),
        peak.intensity.toLocaleString()+(peak.wavelength===null?'':' @ '+peak.wavelength.toFixed(2)+' nm')];
      for(const value of cells){const td=document.createElement('td');td.textContent=value;tr.append(td);}
      const actions=document.createElement('td');
      const review=document.createElement('button');review.textContent='Review';
      review.setAttribute('aria-label','Review '+(frame.label||frame.timestamp));
      review.addEventListener('click',()=>{
        if(this.busy||!this.callbacks.canEdit())return;
        this.reviewedId=frame.id;this.callbacks.review(frame);this.render();this.update();
      });
      const remove=document.createElement('button');remove.textContent='Delete';remove.className='danger';
      remove.setAttribute('aria-label','Delete capture '+(frame.label||frame.timestamp));
      remove.addEventListener('click',()=>this.action(async()=>{
        if(!confirm('Delete this saved capture? Export a backup first if you need to keep it.'))return;
        await this.store.deleteFrame(frame.id);await this.refresh();
      }));
      actions.append(review,remove);tr.append(actions);tbody.append(tr);
    }
    this.update();
  }
  bind() {
    $('recordLive').addEventListener('change',()=>this.update());
    $('datasetSelect').addEventListener('change',()=>this.action(async()=>{
      this.activeId=$('datasetSelect').value;this.reviewedId='';await this.refresh();
    }));
    $('createDataset').addEventListener('click',()=>this.action(async()=>{
      const name=$('datasetName').value.trim();
      const d=await this.store.create(name);this.activeId=d.id;$('datasetName').value='';
      await this.refresh();this.callbacks.notify('Dataset created. Captures can now be saved here.');
    }));
    $('saveDatasetDetails').addEventListener('click',()=>this.action(async()=>{
      await this.store.update({...this.dataset,name:$('datasetTitle').value,notes:$('datasetNotes').value});
      await this.refresh();this.callbacks.notify('Dataset name and notes saved.');
    }));
    $('deleteDataset').addEventListener('click',()=>this.action(async()=>{
      if(!confirm('Delete dataset "'+this.dataset.name+'" and all '+this.frames.length+' captures? Export a JSON backup first.'))return;
      await this.store.deleteDataset(this.activeId);this.activeId='';await this.refresh();
    }));
    $('saveFrame').addEventListener('click',()=>this.action(async()=>{
      const f=this.callbacks.getFrame();if(!f)return;
      await this.save({...f,label:$('sampleLabel').value.trim()||f.label||''});
      this.callbacks.notify('Frame saved to '+this.dataset.name+'.');
    }));
    $('exportDataset').addEventListener('click',()=>this.action(async()=>{
      downloadFile(fileName(this.dataset.name)+'.csv',datasetCSV(this.dataset,this.frames),'text/csv;charset=utf-8');
      this.callbacks.notify('Dataset CSV exported with all captures and acquisition metadata.');
    }));
    $('backupDataset').addEventListener('click',()=>this.action(async()=>{
      downloadFile(fileName(this.dataset.name)+'.ocean.json',encodeBackup(this.dataset,this.frames),'application/json');
      this.callbacks.notify('JSON backup exported. Import it on another browser or computer.');
    }));
    $('importDataset').addEventListener('click',()=>$('importFile').click());
    $('importFile').addEventListener('change',()=>this.action(async()=>{
      const file=$('importFile').files[0];$('importFile').value='';if(!file)return;
      if(file.size>256*1024*1024)throw new Error('Backup exceeds the 256 MB import limit.');
      const parsed=decodeBackup(await file.text());
      const d=await this.store.importBackup(parsed);this.activeId=d.id;await this.refresh();
      this.callbacks.notify('Backup imported as a new dataset. Existing datasets were kept.');
    }));
  }
}
