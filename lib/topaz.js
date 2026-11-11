import fs from 'node:fs';
import { run } from './media.js';

/**
 * Upscales with Topaz Video AI's bundled ffmpeg (tvai_* filters).
 * Requires Topaz Video AI installed + logged in on the machine running this server.
 */
export function topazAvailable(cfg) {
  return !!(cfg?.topaz?.ffmpeg && fs.existsSync(cfg.topaz.ffmpeg));
}

export async function topazUpscale(cfg, input, output, { filter } = {}) {
  const t = cfg.topaz;
  await run(t.ffmpeg, [
    '-y', '-i', input,
    '-vf', filter || t.filter || 'tvai_up=model=iris-3:scale=2',
    ...(t.videoArgs || ['-c:v', 'libx265', '-crf', '16', '-pix_fmt', 'yuv420p10le']),
    '-c:a', 'copy', output,
  ]);
}
