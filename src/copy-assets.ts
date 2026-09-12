import { copyFileSync } from 'node:fs';
copyFileSync(new URL('./windows-speech.ps1', import.meta.url), new URL('../dist/windows-speech.ps1', import.meta.url));
