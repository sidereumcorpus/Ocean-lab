import { USB4000Spectrometer } from './usb4000.js?v=jaz-1';

/** Ocean Optics Jaz USB, VID 2457 / PID 2000.
 * Shares the legacy session queue, bounded reads and EEPROM helpers, NOT the
 * USB4000 acquisition format. OEM datasheet 013-RD000-000-05-201109 pp.14–23.
 * Spectrum: exactly 4096 bytes EP2, uint16 LE, no header/footer/sync byte.
 * One channel per connection. Set channel before connecting; changing channels
 * requires reconnect so reference spectra/calibration cannot cross channels.
 */
export class JazSpectrometer extends USB4000Spectrometer {
  constructor(options = {}) {
    super(options);
    this.profile='jaz';this.modelName='Jaz';this.productId=0x2000;
    this.readoutPixels=2048;this.pixelCount=2048;
    this.minIntegrationTime=1000;this.maxIntegrationTime=65530000;
    Object.defineProperty(this,'channel',{value:options.channel ?? 0,enumerable:true});this.channelCount=null;
    if(!Number.isInteger(this.channel)||this.channel<0||this.channel>14) {
      throw new RangeError('Jaz channel must be an integer 0–14.');
    }
  }

  // Four significant digits, at best 10 µs resolution. Reject unrepresentable
  // values rather than silently exporting a different integration time.
  static integrationStep(microseconds) {
    return 10 ** Math.max(1,Math.floor(Math.log10(Math.max(1000,microseconds)))-3);
  }

  integrationStep(microseconds) { return JazSpectrometer.integrationStep(microseconds); }

  async _initializeDevice(session) {
    // Query count BEFORE legacy module commands: a stack without a spectrometer
    // makes those commands undefined. Do not send USB4000 FE or trigger 0A.
    await this._write(session,Uint8Array.of(0xc0));
    const count=(await this._readBytes(session,1,1))[0];
    if(count<1||count>15)throw new Error('Jaz reports no valid spectrometer modules.');
    if(this.channel>=count)throw new Error('Jaz channel '+this.channel+' unavailable; stack has '+count+' spectrometers.');
    if(this._buffers.get(1)?.length)throw new Error('Unexpected Jaz module-count reply length.');
    this.channelCount=count;
    await this._write(session,Uint8Array.of(0xc1,this.channel));
    this.highSpeed=this._endpoints.get(2)>64; // descriptors, no USB4000 status.
    this.serialNumber=await this._readSlot(session,0); // selected module serial.
    const saturation=await this._readSlotBytes(session,17);
    this.autoscaleLevel=new DataView(saturation.buffer,saturation.byteOffset).getUint16(6,true)||null;
    // Integration setter is cached by DPU and applied on the next 09 request.
    // Establish a known state without attempting an undocumented readback.
    await this._sendIntegration(session,100000);
  }

  _invalidate(reason) { super._invalidate(reason);this.channelCount=null; }

  async _readSlot(session,index) {
    const bytes=await this._readSlotBytes(session,index);
    // Jaz explicitly permits garbage after the first null. Never remove nulls
    // and concatenate the garbage into a serial or polynomial coefficient.
    return new TextDecoder('ascii').decode(bytes.slice(2)).split('\0')[0].trim();
  }

  async _sendIntegration(session,microseconds) {
    const bytes=new Uint8Array(5);bytes[0]=0x02;
    new DataView(bytes.buffer).setUint32(1,microseconds,true);
    await this._write(session,bytes);
    this.integrationTime=microseconds;
  }

  async setIntegrationTime(microseconds) {
    if(!Number.isInteger(microseconds)||microseconds<this.minIntegrationTime||microseconds>this.maxIntegrationTime) {
      throw new RangeError('Jaz integration time must be 1000–65530000 µs.');
    }
    const step=JazSpectrometer.integrationStep(microseconds);
    if(microseconds%step)throw new RangeError('Jaz integration time requires '+step+' µs increments at this exposure.');
    return this._enqueue(()=>this._transaction(session=>this._sendIntegration(session,microseconds)));
  }

  async getSpectrum({raw=true}={}) {
    if(!raw)throw new Error('Jaz supports device counts; OBP corrected mode is unavailable.');
    return this._enqueue(()=>this._transaction(async session=>{
      await this._write(session,Uint8Array.of(0x09));
      const bytes=await this._readBytes(session,2,4096);
      if([...this._buffers.values()].some(b=>b.length))throw new Error('Unexpected trailing Jaz response data. Reconnect.');
      const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      const rawCounts=Uint16Array.from({length:2048},(_,p)=>view.getUint16(p*2,true));
      this.lastRawSpectrum=rawCounts;
      this.opticalDarkPixels=rawCounts.slice(2,24); // SeaBreeze JAZ indices 2..23.
      const gain=this.autoscaleLevel?65535/this.autoscaleLevel:1;
      return Uint16Array.from(rawCounts,v=>Math.min(65535,Math.round(v*gain)));
      // No trailing read: Jaz has no 0x69 sync packet at either USB speed.
    }));
  }
}
