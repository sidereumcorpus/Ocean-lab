/** Reconnect only an explicitly selected, already-authorized USB device.
 * No chooser, transfer retry, guessed model, or automatic scan/recording resume.
 * Each attempt creates a fresh driver session in the supplied callback.
 */
export class USBRecovery {
  constructor({usb,attempt,onStatus=()=>{},onSettled=()=>{},canAttempt=()=>true,delayMs=750,pollMs=1000,maxPolls=30,maxAttempts=3}) {
    Object.assign(this,{usb,attempt,onStatus,onSettled,canAttempt,delayMs,pollMs,maxPolls,maxAttempts});
    this.target=null;this.running=false;this.armed=false;this._controller=null;
    this._connected=event=>{
      if(this.armed&&this.matches(event.device))this.start();
    };
    usb.addEventListener('connect',this._connected);
  }
  remember(device,settings) {
    this.forget();
    this.target={device,vendorId:device.vendorId,productId:device.productId,
      serial:device.serialNumber||'',settings:structuredClone(settings)};
  }
  setIntegration(integration) {
    if(this.target)this.target.settings.integration=integration;
  }
  setModuleSerial(serial) { if(this.target)this.target.settings.moduleSerial=serial||''; }
  matches(device) {
    const t=this.target;
    if(!t||!device||device.vendorId!==t.vendorId||device.productId!==t.productId)return false;
    // A replacement object without a serial is ambiguous: require a new chooser
    // selection instead of opening a different same-model instrument.
    return device===t.device || Boolean(t.serial&&device.serialNumber===t.serial);
  }
  forget() {
    this.armed=false;this.target=null;
    this._controller?.abort();this._controller=null;
    // running remains true until the in-flight attempt has closed its driver.
  }
  async _pause(ms,signal) {
    if(signal.aborted)throw new Error('USB recovery cancelled.');
    await new Promise((resolve,reject)=>{
      const cancel=()=>{clearTimeout(timer);reject(new Error('USB recovery cancelled.'));};
      const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},ms);
      signal.addEventListener('abort',cancel,{once:true});
    });
  }
  start() {
    if(!this.target||this.running)return this._work||Promise.resolve(false);
    this.armed=true;this.running=true;
    const target=this.target,controller=new AbortController();this._controller=controller;
    const signal=controller.signal;
    this._work=(async()=>{
      let attempts=0;
      this.onStatus('USB interrupted. Stabilize the cable; waiting to reconnect to the same device.');
      await this._pause(this.delayMs,signal); // Debounce contact bounce.
      for(let poll=0;poll<this.maxPolls;poll++) {
        if(signal.aborted||this.target!==target)return false;
        if(this.canAttempt()) {
          const devices=await this.usb.getDevices();
          if(signal.aborted||this.target!==target)return false;
          const matches=devices.filter(device=>this.matches(device));
          // Do not choose between multiple devices with duplicate serials.
          const device=matches.length===1?matches[0]:null;
          if(device) {
            attempts++;
            this.onStatus('Reconnecting USB ('+attempts+'/'+this.maxAttempts+')…');
            try {
              await this.attempt(device,structuredClone(target.settings),signal);
              if(signal.aborted||this.target!==target)return false;
              target.device=device;this.armed=false;
              this.onStatus('USB restored. Acquisition is paused; capture again or restart live. Retake dark/reference spectra.');
              return true;
            } catch(error) {
              if(signal.aborted)return false;
              this.onStatus('USB reconnect failed: '+error.message);
              if(attempts>=this.maxAttempts) {
                this.armed=false;
                this.onStatus('Automatic reconnect stopped after '+attempts+' attempts. Secure the cable, then choose Retry USB or Connect USB.');
                return false;
              }
            }
          }
        }
        await this._pause(this.pollMs,signal);
      }
      this.onStatus('USB device not restored. Secure the cable, then choose Retry USB. A matching device reattachment can also restart recovery.');
      return false;
    })().catch(error=>{if(!signal.aborted)this.onStatus('USB recovery stopped: '+error.message);return false;})
      .finally(()=>{this.running=false;if(this._controller===controller)this._controller=null;this.onSettled();});
    return this._work;
  }
  dispose() { this.forget();this.usb.removeEventListener('connect',this._connected); }
}
