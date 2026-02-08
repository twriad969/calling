const MU_LAW_MAX = 0x1FFF;
const MU_LAW_BIAS = 0x84;

function clamp16(sample) {
  return Math.max(-32768, Math.min(32767, sample));
}

function muLawEncodeSample(sample) {
  let pcm = clamp16(sample);
  let sign = (pcm < 0) ? 0x80 : 0x00;
  if (pcm < 0) pcm = -pcm;
  pcm += MU_LAW_BIAS;
  if (pcm > MU_LAW_MAX) pcm = MU_LAW_MAX;

  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent -= 1;
  }
  const mantissa = (pcm >> (exponent + 3)) & 0x0F;
  const muLaw = ~(sign | (exponent << 4) | mantissa);
  return muLaw & 0xFF;
}

function muLawDecodeSample(muLaw) {
  muLaw = ~muLaw & 0xFF;
  const sign = muLaw & 0x80;
  const exponent = (muLaw >> 4) & 0x07;
  const mantissa = muLaw & 0x0F;
  let pcm = ((mantissa << 3) + MU_LAW_BIAS) << exponent;
  pcm -= MU_LAW_BIAS;
  return sign ? -pcm : pcm;
}

function aLawEncodeSample(sample) {
  let pcm = clamp16(sample);
  let sign = pcm < 0 ? 0x80 : 0x00;
  if (pcm < 0) pcm = -pcm;

  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent -= 1;
  }
  let mantissa;
  if (exponent === 0) {
    mantissa = (pcm >> 4) & 0x0F;
  } else {
    mantissa = (pcm >> (exponent + 3)) & 0x0F;
  }
  let aLaw = (exponent << 4) | mantissa;
  aLaw ^= (sign ? 0xD5 : 0x55);
  return aLaw & 0xFF;
}

function aLawDecodeSample(aLaw) {
  aLaw ^= 0x55;
  const sign = aLaw & 0x80;
  const exponent = (aLaw >> 4) & 0x07;
  const mantissa = aLaw & 0x0F;
  let pcm;
  if (exponent === 0) {
    pcm = (mantissa << 4) + 8;
  } else {
    pcm = ((mantissa << 4) + 0x108) << (exponent - 1);
  }
  return sign ? -pcm : pcm;
}

function decodeG711(payload, codec) {
  const samples = new Int16Array(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    samples[i] = codec === 'PCMA'
      ? aLawDecodeSample(payload[i])
      : muLawDecodeSample(payload[i]);
  }
  return samples;
}

function encodeG711(samples, codec) {
  const payload = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    payload[i] = codec === 'PCMA'
      ? aLawEncodeSample(samples[i])
      : muLawEncodeSample(samples[i]);
  }
  return payload;
}

function upsample8kTo24k(samples8k) {
  const out = new Int16Array(samples8k.length * 3);
  for (let i = 0; i < samples8k.length; i += 1) {
    const s0 = samples8k[i];
    const s1 = i + 1 < samples8k.length ? samples8k[i + 1] : s0;
    out[i * 3] = s0;
    out[i * 3 + 1] = s0 + ((s1 - s0) / 3);
    out[i * 3 + 2] = s0 + ((s1 - s0) * 2 / 3);
  }
  return out;
}

function downsample24kTo8k(samples24k) {
  const len = Math.floor(samples24k.length / 3);
  const out = new Int16Array(len);
  for (let i = 0; i < len; i += 1) {
    const idx = i * 3;
    const avg = (samples24k[idx] + samples24k[idx + 1] + samples24k[idx + 2]) / 3;
    out[i] = avg;
  }
  return out;
}

function int16ToBase64(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    buf.writeInt16LE(samples[i], i * 2);
  }
  return buf.toString('base64');
}

function base64ToInt16(base64) {
  const buf = Buffer.from(base64, 'base64');
  const samples = new Int16Array(buf.length / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = buf.readInt16LE(i * 2);
  }
  return samples;
}

module.exports = {
  decodeG711,
  encodeG711,
  upsample8kTo24k,
  downsample24kTo8k,
  int16ToBase64,
  base64ToInt16
};
