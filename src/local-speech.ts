import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export async function localSpeech(text: string): Promise<Buffer> {
  const directory = await mkdtemp(path.join(tmpdir(), 'english-tts-'));
  const input = path.join(directory, 'input.txt');
  const output = path.join(directory, 'output.wav');
  try {
    await writeFile(input, text, 'utf8');
    const command = process.platform === 'win32' ? 'powershell.exe' : 'espeak-ng';
    const args = process.platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./windows-speech.ps1', import.meta.url)), '-InputPath', input, '-OutputPath', output]
      : ['-v', 'en-us', '-s', '145', '-f', input, '-w', output];
    // Learner/model text is read from a file; it is never shell code or an argument.
    await promisify(execFile)(command, args, { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
    return await readFile(output);
  } finally {
    const relative = path.relative(tmpdir(), directory);
    if (!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(directory).startsWith('english-tts-')) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
