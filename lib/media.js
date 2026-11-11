import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-600)}`)));
  });
}

export async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  const j = JSON.parse(out);
  const v = j.streams.find((s) => s.codec_type === 'video');
  return {
    duration: parseFloat(j.format.duration) || 0,
    hasAudio: j.streams.some((s) => s.codec_type === 'audio'),
    width: v?.width, height: v?.height,
  };
}

export async function lastFrame(video, outPng) {
  await run('ffmpeg', ['-y', '-sseof', '-0.15', '-i', video, '-frames:v', '1', '-update', '1', outPng]);
  return outPng;
}

/** Placeholder clip so the whole app is testable without a GPU. */
export async function mockClip(outFile, { width, height, seed, seconds = 2 }) {
  const hue = seed % 360;
  await run('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=24:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=${220 + (seed % 440)}:duration=${seconds}`,
    '-vf', `hue=h=${hue}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', outFile,
  ]);
}

/** Trim + normalise every enabled clip, then concatenate. */
export async function stitch(clips, outFile, { width, height, fps = 24 }, tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const parts = [];
  for (const [i, c] of clips.entries()) {
    const info = await probe(c.path);
    const end = c.trimEnd > 0 ? Math.min(c.trimEnd, info.duration) : info.duration;
    const part = path.join(tmpDir, `part${String(i).padStart(3, '0')}.mp4`);
    const args = ['-y', '-i', c.path];
    if (!info.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    args.push(
      '-ss', String(c.trimStart || 0), '-to', String(end),
      '-map', '0:v:0', '-map', info.hasAudio ? '0:a:0' : '1:a:0',
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps},setsar=1`,
      '-af', 'aresample=48000', '-ac', '2',
      '-c:v', 'libx264', '-crf', '14', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
      '-shortest', part,
    );
    await run('ffmpeg', args);
    parts.push(part);
  }
  const list = path.join(tmpDir, 'list.txt');
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', outFile]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
