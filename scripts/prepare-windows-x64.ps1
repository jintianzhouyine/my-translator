# Use MD speech libraries to match Rust's default dynamic Windows CRT.
# The Node helper supplies bounded downloads, progress, verification and caching.
$ErrorActionPreference = 'Stop'
node (Join-Path $PSScriptRoot 'prepare-windows-speech.mjs')
if ($LASTEXITCODE -ne 0) { throw "Speech library preparation failed with exit code $LASTEXITCODE" }
