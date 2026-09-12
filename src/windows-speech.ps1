param(
  [Parameter(Mandatory=$true)][string]$InputPath,
  [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voice = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'en-*' } | Select-Object -First 1
  if (-not $voice) { throw 'An English Windows speech voice is required.' }
  $synth.SelectVoice($voice.VoiceInfo.Name)
  $synth.Rate = -1
  $synth.SetOutputToWaveFile($OutputPath)
  $synth.Speak([System.IO.File]::ReadAllText($InputPath, [System.Text.Encoding]::UTF8))
} finally {
  $synth.Dispose()
}
