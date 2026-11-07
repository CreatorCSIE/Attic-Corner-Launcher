@echo off
rem Attic portable self-update entry (thin wrapper: defeats default ExecutionPolicy=Restricted;
rem visible console = the AV fallback surface). No args = full-path bootstrap; args pass through
rem to attic-update.ps1 (fast path -Zip -WaitPid -Sha256 injected by the launcher).
rem Immunize against inherited polluted PSModulePath (CI pwsh7 / dev shells rewrite it and the
rem 5.1 child loses system modules -> Get-FileHash CommandNotFound). Restoring the default is
rem a no-op in clean environments.
set "PSModulePath=%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0attic-update.ps1" %*
