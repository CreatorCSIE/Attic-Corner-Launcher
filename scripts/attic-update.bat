@echo off
rem Attic portable self-update entry (thin wrapper: defeats default ExecutionPolicy=Restricted;
rem visible console = the AV fallback surface). No args = full-path bootstrap; args pass through
rem to attic-update.ps1 (fast path -Zip -WaitPid -Sha256 injected by the launcher).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0attic-update.ps1" %*
