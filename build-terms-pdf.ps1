# Обёртка: генерирует terms.pdf из terms.html (см. build-terms-pdf.js).
# Запускать после любой правки текста оферты в terms.html.
#   powershell -ExecutionPolicy Bypass -File .\build-terms-pdf.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
node (Join-Path $here 'build-terms-pdf.js')
