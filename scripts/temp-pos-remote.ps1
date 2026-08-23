$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$line = Get-Content (Join-Path $root '.env.local') | Where-Object { $_ -match '^SUPABASE_DB_URL=' } | Select-Object -First 1
if (-not $line) { throw 'SUPABASE_DB_URL .env.local faylida topilmadi.' }
$dbUrl = $line.Substring('SUPABASE_DB_URL='.Length).Trim().Trim('"').Trim("'")
if (-not $dbUrl) { throw 'SUPABASE_DB_URL bo‘sh.' }
if ($args -contains 'transaction-port') { $dbUrl = $dbUrl -replace ':5432/', ':6543/' }
$stdout = Join-Path $root 'scripts\.temp-pos-stdout.log'
$stderr = Join-Path $root 'scripts\.temp-pos-stderr.log'
$cliArgs = @('supabase','db','push','--db-url',$dbUrl)
if (-not ($args -contains 'push')) { $cliArgs += '--dry-run' }
$process = Start-Process -FilePath 'npx.cmd' -ArgumentList $cliArgs -WorkingDirectory $root -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
$text = ((Get-Content $stdout -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $stderr -Raw -ErrorAction SilentlyContinue)).Replace($dbUrl,'[DB_URL_REDACTED]')
Write-Output $text.Trim()
Remove-Item $stdout,$stderr -Force -ErrorAction SilentlyContinue
if ($process.ExitCode -ne 0) { exit $process.ExitCode }
