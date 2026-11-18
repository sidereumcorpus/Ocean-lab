/** Session-only derived views. Archived intensity arrays remain device counts.
 * Invalid ratio pixels are NaN, never zero, Infinity or an invented epsilon.
 * Keep a validity gap in plots and export raw counts for reproducible analysis.
 */
export function spectroscopy(sample, dark, reference, mode = 'transmittance') {
  if (!['transmittance','absorbance'].includes(mode)) throw new Error('Unknown spectroscopy mode.');
  if (!sample?.length || dark?.length !== sample.length || reference?.length !== sample.length) {
    throw new Error('Sample, dark and reference grids must have matching lengths.');
  }
  return Float64Array.from(sample,(value,i)=>{
    const numerator=value-dark[i], denominator=reference[i]-dark[i];
    if (![value,dark[i],reference[i]].every(Number.isFinite) || numerator<=0 || denominator<=0) return NaN;
    const ratio=numerator/denominator;
    if (!Number.isFinite(ratio) || ratio<=0) return NaN;
    const result=mode==='absorbance' ? -Math.log10(ratio) : 100*ratio;
    return Number.isFinite(result) ? result : NaN;
  });
}

// Older archived captures may have no black-pixel metadata; keep their
// original counts readable rather than inventing a correction baseline.
export function usesOpticalDark(frame) {
  return ['usb4000','jaz'].includes(frame.profile) && frame.detector != null;
}

export function signalCounts(frame, subtractOpticalDark = usesOpticalDark(frame)) {
  const baseline = subtractOpticalDark ? frame.detector?.opticalDarkMean : 0;
  if (!Number.isFinite(baseline)) throw new Error('Optical dark data unavailable for this capture.');
  // Float64 preserves negative noise rather than wrapping into uint16.
  return Float64Array.from(frame.intensities,value=>value-baseline);
}

export class SpectroscopySession {
  constructor() { this.clear(); }
  clear() { this.dark=null;this.reference=null; }
  key(frame,optical) {
    return JSON.stringify([frame.source,frame.serial,frame.profile,frame.mode,
      frame.integration,frame.intensities.length,Boolean(optical),frame.channel??null]);
  }
  capture(kind,frame,optical=usesOpticalDark(frame)) {
    if (!['dark','reference'].includes(kind)) throw new Error('Invalid reference kind.');
    const key=this.key(frame,optical);
    if (this[kind==='dark'?'reference':'dark']?.key!==key) this.clear();
    this[kind]={key,values:signalCounts(frame,optical)};
  }
  process(frame,mode,optical=usesOpticalDark(frame)) {
    const signal=signalCounts(frame,optical);
    if(mode==='counts')return signal;
    const key=this.key(frame,optical);
    if(this.dark?.key!==key || this.reference?.key!==key) {
      throw new Error('Capture matching dark and reference spectra at this integration time first.');
    }
    return spectroscopy(signal,this.dark.values,this.reference.values,mode);
  }
}
