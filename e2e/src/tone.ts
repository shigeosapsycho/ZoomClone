import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 16-bit mono PCM WAV of a sine tone with a syllable-rate amplitude wobble; Chromium loops it as
 * the fake microphone. A steady sine reads like hum to the capture chain's noise suppression and
 * gain control and comes out flattened (about 0.08 on the tile meters, measured), while a 2 Hz
 * wobble between a tenth and full amplitude passes as a voice (about 0.5 at its peak). The wobble
 * never reaches silence and completes whole cycles inside the file, so the loop is seamless and
 * the speaker detection sees continuous audio.
 */
export function writeToneWav(
  path: string,
  opts = { hz: 440, seconds: 2, rate: 48_000, wobbleHz: 2 },
): void {
  const samples = opts.seconds * opts.rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / opts.rate;
    const envelope = 0.55 + 0.45 * Math.sin(2 * Math.PI * opts.wobbleHz * t);
    const value = Math.round(Math.sin(2 * Math.PI * opts.hz * t) * envelope * 0.5 * 32767);
    data.writeInt16LE(value, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(opts.rate, 24);
  header.writeUInt32LE(opts.rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([header, data]));
}
