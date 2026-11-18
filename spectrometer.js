import { JazSpectrometer } from './jaz.js?v=disconnect-1';
import { OceanOBPSpectrometer } from './ocean-obp.js?v=disconnect-1';
import { USB4000Spectrometer } from './usb4000.js?v=disconnect-1';

/** Choose protocol after the vendor-only chooser, before sending any commands. */
export function createSpectrometerForDevice(device, options = {}) {
  const profile = options.profile || 'auto';
  if (!['auto','usb4000','jaz','obp'].includes(profile)) throw new Error('Unknown instrument profile.');
  if (device.vendorId !== 0x2457) throw new Error('Not an Ocean Optics device.');
  const isUSB4000 = device.productId === 0x1022;
  if (profile === 'usb4000' && !isUSB4000) {
    throw new Error('Selected device is not a USB4000 (PID 1022).');
  }
  const isJaz = device.productId === 0x2000;
  if(profile==='jaz'&&!isJaz)throw new Error('Selected device is not a Jaz (PID 2000).');
  if (profile === 'obp' && (isUSB4000||isJaz)) {
    throw new Error('This instrument uses the legacy protocol. Choose Auto or its model profile.');
  }
  return isJaz ? new JazSpectrometer(options) : isUSB4000 ? new USB4000Spectrometer(options) : new OceanOBPSpectrometer(options);
}

/** Must be called directly from a click handler for transient user activation. */
export async function selectSpectrometer(options = {}) {
  if (!navigator.usb || !globalThis.isSecureContext) {
    throw new Error('Use a WebUSB-capable browser over HTTPS or localhost.');
  }
  const device = await navigator.usb.requestDevice({filters:[{vendorId:0x2457}]});
  return { device, driver:createSpectrometerForDevice(device,options) };
}
