---
name: publicar-plugin
description: Compile e publique o plugin Change Review nas quatro instalacoes locais do Obsidian de area-trabalho.
---

# Publicar o plugin no Obsidian

Execute no PowerShell a partir da raiz deste repositorio. Compile a versao atual,
copie somente os tres arquivos do plugin e confira os hashes. Nao altere
`data.json` nem outros arquivos nas instalacoes.

```powershell
$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
$targets = @(
  'C:\Users\wsantos\Desktop\source\area-trabalho\Projetos\_Conecta\.obsidian',
  'C:\Users\wsantos\Desktop\source\area-trabalho\Projetos\_Conecta\.obsidian-template',
  'C:\Users\wsantos\Desktop\source\area-trabalho\.obsidian',
  'C:\Users\wsantos\Desktop\source\area-trabalho\.obsidian-template'
)
$files = @('main.js', 'manifest.json', 'styles.css')
foreach ($target in $targets) {
  if (-not (Test-Path -LiteralPath $target -PathType Container)) {
    throw "Pasta de configuracao nao encontrada: $target"
  }
}
Push-Location (Join-Path $root 'plugin-src')
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao compilar o plugin.' }
} finally {
  Pop-Location
}
$dist = Join-Path $root 'plugin-dist'
foreach ($file in $files) {
  if (-not (Test-Path -LiteralPath (Join-Path $dist $file) -PathType Leaf)) {
    throw "Arquivo do plugin nao encontrado: $file"
  }
}
foreach ($target in $targets) {
  $destination = Join-Path $target 'plugins\live-git-diff'
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  foreach ($file in $files) {
    $source = Join-Path $dist $file
    $copy = Join-Path $destination $file
    Copy-Item -LiteralPath $source -Destination $copy -Force
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash) {
      throw "Verificacao falhou: $copy"
    }
  }
  Write-Output "Publicado: $destination"
}
```

Informe as quatro pastas publicadas ou qualquer falha. Se o Obsidian estiver
aberto, avise que pode ser necessario recarregar o plugin.
