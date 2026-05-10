param(
  [string] $Subject = "CN=Wechat Like Screenshot Dev Signing",
  [string[]] $Files = @(
    "releases\wechat-like-screenshot-portable.exe",
    "releases\wechat-like-screenshot-setup.exe"
  )
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$now = Get-Date
$cert = Get-ChildItem -Path Cert:\CurrentUser\My -CodeSigningCert |
  Where-Object { $_.Subject -eq $Subject -and $_.NotAfter -gt $now.AddMonths(1) } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1

if (-not $cert) {
  $cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $Subject `
    -CertStoreLocation Cert:\CurrentUser\My `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy NonExportable `
    -NotAfter $now.AddYears(3)
}

$certPath = Join-Path $repoRoot "releases\wechat-like-screenshot-dev-signing.cer"
Export-Certificate -Cert $cert -FilePath $certPath -Force | Out-Null

foreach ($storeName in @("Root", "TrustedPublisher")) {
  $storePath = "Cert:\CurrentUser\$storeName"
  $trusted = Get-ChildItem -Path $storePath | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
  if (-not $trusted) {
    Import-Certificate -FilePath $certPath -CertStoreLocation $storePath | Out-Null
  }
}

foreach ($file in $Files) {
  $path = Resolve-Path (Join-Path $repoRoot $file)
  $signature = Set-AuthenticodeSignature -FilePath $path -Certificate $cert -HashAlgorithm SHA256
  if ($signature.Status -ne "Valid") {
    throw "Signing failed for $path with status $($signature.Status): $($signature.StatusMessage)"
  }
}

Get-AuthenticodeSignature -FilePath ($Files | ForEach-Object { Join-Path $repoRoot $_ }) |
  Select-Object Path, Status, SignerCertificate |
  Format-List
