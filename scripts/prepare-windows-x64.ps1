# sherpa-onnx-sys 1.13.3 automatically downloads x64 MT libraries. Use the
# official MD libraries with the dynamic MSVC CRT to match Rust's default
# Windows runtime, retaining the project's existing runtime configuration.
$ErrorActionPreference = 'Stop'
$version = '1.13.3'
$name = "sherpa-onnx-v$version-win-x64-static-MD-Release-lib"
$destination = Join-Path $env:RUNNER_TEMP $name
$archive = "$destination.tar.bz2"
$url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$version/$name.tar.bz2"

Invoke-WebRequest -Uri $url -OutFile $archive
tar -xjf $archive -C $env:RUNNER_TEMP
if ($LASTEXITCODE -ne 0) { throw 'Failed to extract sherpa-onnx x64 libraries' }

$libDirectory = Join-Path $destination 'lib'
if (-not (Test-Path (Join-Path $libDirectory 'sherpa-onnx-c-api.lib'))) {
    throw "Missing sherpa-onnx x64 static library: $libDirectory"
}
"SHERPA_ONNX_LIB_DIR=$libDirectory" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
Write-Host "Prepared sherpa-onnx $version Windows x64 libraries."
