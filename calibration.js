/** Single-line wavelength alignment. Detector samples are never resampled. */
export function wavelengthAt(grid,pixel) {
  if(!grid || pixel<0 || pixel>grid.length-1 || !Number.isFinite(pixel)) throw new Error('Peak is outside the wavelength grid.');
  const left=Math.floor(pixel), fraction=pixel-left;
  return grid[left]+fraction*((grid[Math.min(left+1,grid.length-1)])-grid[left]);
}

export function findLinePeak(intensities,grid,seed,radius=12) {
  if(!intensities || !grid || intensities.length!==grid.length || grid.length<3) throw new Error('Load the factory wavelengths before aligning a line.');
  if(!Number.isInteger(seed)||seed<0||seed>=grid.length)throw new Error('Choose a detector pixel within this reference spectrum.');
  if(!Number.isInteger(radius)||radius<2||radius>100)throw new Error('Search radius must be 2–100 pixels.');
  const start=Math.max(0,seed-radius),end=Math.min(grid.length-1,seed+radius);
  let peak=start,minimum=Infinity;
  for(let p=start;p<=end;p++) {
    if(!Number.isFinite(intensities[p]) || !Number.isFinite(grid[p]))throw new Error('Reference contains invalid samples.');
    minimum=Math.min(minimum,intensities[p]);if(intensities[p]>intensities[peak])peak=p;
  }
  if(peak===start||peak===end||peak===0||peak===grid.length-1)throw new Error('Peak is at the search boundary. Select closer to the center of an isolated line.');
  const a=intensities[peak-1],b=intensities[peak],c=intensities[peak+1];
  if(b>=65535)throw new Error('Reference peak is saturated. Reduce integration time and capture again.');
  if(b-minimum<3 || (a===b && c===b))throw new Error('No distinct peak found. Use a brighter, isolated reference line.');
  const curvature=a-2*b+c;
  if(curvature>=0)throw new Error('No resolved local maximum at the selected peak.');
  // Three-point parabolic interpolation gives a fractional detector position.
  // Its precision is not a statement of absolute wavelength uncertainty.
  const fraction=Math.max(-0.5,Math.min(0.5,0.5*(a-c)/curvature));
  const pixel=peak+fraction;
  return {pixel,integerPixel:peak,measuredNm:wavelengthAt(grid,pixel),counts:b};
}

export async function gridSignature(grid, readoutConvention = '') {
  const bytes=new Uint8Array(grid.length*8),view=new DataView(bytes.buffer);
  for(let i=0;i<grid.length;i++) {
    if(!Number.isFinite(grid[i]))throw new Error('Factory wavelength grid is invalid.');
    view.setFloat64(i*8,grid[i],true);
  }
  // Same wavelengths do not imply the same sample mapping. Include the
  // convention to reject profiles made with the old cropped sample window.
  const tag=new TextEncoder().encode(readoutConvention);
  const identity=new Uint8Array(bytes.length+tag.length);
  identity.set(bytes);identity.set(tag,bytes.length);
  const hash=await crypto.subtle.digest('SHA-256',identity);
  return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
}

export function validateCalibration(profile) {
  if(!profile || profile.kind!=='single-line-offset' || profile.version!==1)throw new Error('Unsupported calibration profile.');
  const string=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
  if(!string(profile.id,100)||!string(profile.name,120)||!string(profile.serial,200)||
      !['hardware','simulated'].includes(profile.source)||!['usb4000','jaz','obp','demo'].includes(profile.deviceProfile)||
      ((profile.source==='simulated')!==(profile.deviceProfile==='demo'))||
      !/^[a-f0-9]{64}$/.test(profile.factorySignature)||
      !Number.isInteger(profile.pixelCount)||profile.pixelCount<3||profile.pixelCount>32768||
      !Number.isFinite(profile.referenceNm)||profile.referenceNm<=0||profile.referenceNm>100000||
      !Number.isFinite(profile.measuredNm)||!Number.isFinite(profile.offsetNm)||
      !Number.isFinite(profile.peakPixel)||profile.peakPixel<=0||profile.peakPixel>=profile.pixelCount-1||
      Math.abs(profile.offsetNm-(profile.referenceNm-profile.measuredNm))>1e-8||
      typeof profile.createdAt!=='string'||!Number.isFinite(Date.parse(profile.createdAt))) {
    throw new Error('Invalid calibration metadata.');
  }
  return {kind:profile.kind,version:1,id:profile.id,name:profile.name,serial:profile.serial,
    source:profile.source,deviceProfile:profile.deviceProfile,factorySignature:profile.factorySignature,
    pixelCount:profile.pixelCount,referenceNm:profile.referenceNm,measuredNm:profile.measuredNm,
    peakPixel:profile.peakPixel,offsetNm:profile.offsetNm,createdAt:new Date(profile.createdAt).toISOString()};
}

export function matchesCalibration(profile,context) {
  try {const p=validateCalibration(profile);return Boolean(context.serial)&&
    p.serial===context.serial&&p.source===context.source&&p.deviceProfile===context.deviceProfile&&
    p.pixelCount===context.pixelCount&&p.factorySignature===context.factorySignature;
  }catch(_){return false;}
}

export function alignGrid(factory,profile,context) {
  if(!matchesCalibration(profile,context))throw new Error('Calibration does not match this instrument and factory grid.');
  return Float64Array.from(factory,value=>value+profile.offsetNm);
}
