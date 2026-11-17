/** View-only workspace navigation. Switching tabs never resets acquisition. */
export function initializeWorkspace() {
  function activate(group,name,{focus=false}={}) {
    const tabs=[...document.querySelectorAll('[data-tab-group="'+group+'"]')];
    const selected=tabs.find(tab=>tab.dataset.tab===name);if(!selected)return;
    for(const tab of tabs) {
      const on=tab===selected;tab.setAttribute('aria-selected',String(on));tab.tabIndex=on?0:-1;
      const panel=document.getElementById(tab.getAttribute('aria-controls'));panel.hidden=!on;
    }
    if(focus)selected.focus();
    try{sessionStorage.setItem('ocean-lab-tab-'+group,name);}catch(_){}
    // Canvas remains visible, but a layout change may adjust its available area.
    window.dispatchEvent(new Event('resize'));
  }
  for(const group of ['workspace','calibration']) {
    const tabs=[...document.querySelectorAll('[data-tab-group="'+group+'"]')];
    for(const tab of tabs) {
      tab.addEventListener('click',()=>activate(group,tab.dataset.tab));
      tab.addEventListener('keydown',event=>{
        let index=tabs.indexOf(tab);
        if(event.key==='ArrowRight')index=(index+1)%tabs.length;
        else if(event.key==='ArrowLeft')index=(index-1+tabs.length)%tabs.length;
        else if(event.key==='Home')index=0;
        else if(event.key==='End')index=tabs.length-1;
        else return;
        event.preventDefault();activate(group,tabs[index].dataset.tab,{focus:true});
      });
    }
    try{const saved=sessionStorage.getItem('ocean-lab-tab-'+group);if(saved)activate(group,saved);}catch(_){}
  }
  for(const button of document.querySelectorAll('[data-open-tab]')) {
    button.addEventListener('click',()=>activate('workspace',button.dataset.openTab,{focus:true}));
  }
  const settings=document.getElementById('settingsDialog');
  document.getElementById('openSettings').addEventListener('click',()=>settings.showModal());
  document.getElementById('closeSettings').addEventListener('click',()=>settings.close());
  const recording=document.getElementById('recordLive'),fields=document.getElementById('recordingFields');
  const updateRecording=()=>{fields.hidden=!recording.checked;};
  recording.addEventListener('change',updateRecording);updateRecording();
}
