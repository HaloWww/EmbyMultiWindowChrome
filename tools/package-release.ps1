$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'manifest.json') -Raw | ConvertFrom-Json
$names = @('manifest.json', 'background.js', 'bridge.js', 'emby-entry.js', 'emby-entry.css',
    'hls.js', 'hls.worker.js', 'HLS-LICENSE.txt', 'player.js', 'player.html', 'player.css',
    'options.js', 'options.html', 'options.css', 'README.md', 'start-diagnostics.cmd',
    'tools', 'tests', 'userscript')
$sourcePaths = $names | ForEach-Object { Join-Path $projectRoot $_ }
$destination = Join-Path $projectRoot ('dist/EmbyMultiWindowChrome-' + $manifest.version + '.zip')
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Force }
$archive = [System.IO.Compression.ZipFile]::Open($destination, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($sourcePath in $sourcePaths) {
        $item = Get-Item -LiteralPath $sourcePath
        $files = if ($item.PSIsContainer) { Get-ChildItem -LiteralPath $sourcePath -File -Recurse } else { @($item) }
        foreach ($file in $files) {
            $entryName = $file.FullName.Substring($projectRoot.TrimEnd('\').Length + 1).Replace('\', '/')
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName,
                $entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    }
} finally { $archive.Dispose() }
Write-Output $destination
