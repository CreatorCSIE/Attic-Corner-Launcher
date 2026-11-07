# attic-update.ps1 — Attic 便携包自更新脚本（文件系统腿唯一正典：验/解/换/启）。
# 双模（plan.md「测试版通道与更新执行面」条，2026-11-03 定稿）：
#   快路径  attic-update.bat -Zip <绝对路径> -WaitPid <n> -Sha256 <hex>
#           = 启动器已完成网络腿（下载+校验），脚本只等旧进程消失→再验→解→换→重启；
#   全路径  双击 attic-update.bat（无参）
#           = bootstrap 自救：读 version.txt→查 GitHub API（返回序即答案，零本地 semver）
#           →已是最新即退→下载→验→解→等旧进程→换→重启。
# 信任分界：锚 = https + GitHub 官方域 + asset digest（Get-FileHash 双消费点）；
#           minisign 不归本脚本管（Inno/plugin 面）。
# 失败语义：换体失败 = robocopy 前旧文件原封不动 + 重启旧 exe + 控制台留错。
# 依赖：Windows 10+ 内置 powershell / tar(bsdtar) / robocopy / Get-FileHash。

[CmdletBinding()]
param(
    [string]$Zip,
    # 旧主程序 PID（$PID 是只读自动变量，参数名须避开）。
    [int]$WaitPid = 0,
    [string]$Sha256
)

$ErrorActionPreference = 'Stop'
$Dir = $PSScriptRoot
$Staging = Join-Path $Dir 'update'
# /MIR 排除面：脚本对自身 + 版本锚（换体不自我清除、锚随目录走）。
$KeepFiles = @('attic-update.ps1', 'attic-update.bat', 'version.txt')

function Write-Step([string]$msg) { Write-Host "[attic-update] $msg" }
function Fail([string]$msg) {
    Write-Host "[attic-update] 失败：$msg"
    exit 1
}

# ---------- 文件系统腿（快/全路径共用） ----------

function Get-Verified([string]$zipPath, [string]$sha256) {
    if (-not (Test-Path $zipPath)) { Fail "构件不存在：$zipPath" }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
    if ($actual -ne $sha256.ToLowerInvariant()) { Fail "digest 校验不符（期望 $sha256 实得 $actual）" }
    Write-Step 'digest 校验通过'
}

function Invoke-Extract([string]$zipPath) {
    $tmp = Join-Path $Staging ('extract-' + (Get-Date -Format 'yyyyMMddHHmmss'))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    tar -xf $zipPath -C $tmp
    if ($LASTEXITCODE -ne 0) { Fail "解压失败（tar 退出码 $LASTEXITCODE）" }
    # zip 顶层是版本目录（release.yml 打包面），取唯一子目录为换体源。
    $inner = @(Get-ChildItem -Directory $tmp)
    if ($inner.Count -eq 1) { return $inner[0].FullName }
    return $tmp
}

function Wait-OldProcess {
    if ($WaitPid -gt 0) {
        Write-Step "等待旧进程 #$WaitPid 退出…"
        while (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500 }
    } else {
        # 全路径自救：按当前 exe 名等同名进程清零（含本形态多开）。
        $exeName = (Get-VersionAnchor).exe
        $name = [System.IO.Path]::GetFileNameWithoutExtension($exeName)
        while (Get-Process -Name $name -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500 }
    }
}

function Invoke-Swap([string]$src) {
    # robocopy /MIR 镜像换体；/XF 排除脚本对与版本锚，/XD 保护暂存目录不被 purge（源就在其中）。
    # 退出码 <8 皆成功（0=无变化，1=有复制）。
    $rc = @($src, $Dir, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XD', $Staging) + @('/XF') + $KeepFiles
    & robocopy @rc | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "换体失败（robocopy 退出码 $LASTEXITCODE，旧文件未被清除）" }
    Write-Step '换体完成'
}

function Invoke-Launch {
    $exeName = (Get-VersionAnchor).exe
    $exe = Join-Path $Dir $exeName
    if (-not (Test-Path $exe)) { Fail "新主程序不存在：$exe" }
    Start-Process -FilePath $exe -WorkingDirectory $Dir
    Write-Step "已重启 $exeName"
}

# ---------- 网络腿（全路径专用） ----------

function Get-VersionAnchor {
    $f = Join-Path $Dir 'version.txt'
    if (-not (Test-Path $f)) { Fail '缺少 version.txt（非标准便携目录，无法自救）' }
    $kv = @{}
    foreach ($line in Get-Content $f) {
        $i = $line.IndexOf('=')
        if ($i -gt 0) { $kv[$line.Substring(0, $i).Trim()] = $line.Substring($i + 1).Trim() }
    }
    if (-not $kv['version'] -or -not $kv['exe'] -or -not $kv['repo']) { Fail 'version.txt 缺字段（version/exe/repo）' }
    return $kv
}

function Get-Arch {
    switch ($env:PROCESSOR_ARCHITECTURE) {
        'AMD64' { 'x64' }
        'ARM64' { 'arm64' }
        default { Fail "不支持的架构 $env:PROCESSOR_ARCHITECTURE" }
    }
}

function Invoke-QueryRelease($anchor) {
    $ver = $anchor['version']
    $nightly = $ver -like '*-nightly.*'
    $base = "https://api.github.com/repos/$($anchor['repo'])/releases"
    if ($nightly) {
        $list = Invoke-RestMethod -Uri "$base`?per_page=30" -Headers @{ 'User-Agent' = 'attic-update' }
        $rel = @($list | Where-Object { $_.prerelease -and -not $_.draft -and $_.tag_name -like '*-nightly.*' }) | Select-Object -First 1
    } else {
        $rel = Invoke-RestMethod -Uri "$base/latest" -Headers @{ 'User-Agent' = 'attic-update' }
    }
    if (-not $rel) { Fail '轨道内无可用发布' }
    $tag = $rel.tag_name -replace '^v', ''
    if ($tag -eq $ver) { Write-Step "已是最新（$tag），无需更新"; exit 0 }
    Write-Step "发现新版 $tag（当前 $ver）"
    $want = "attic-tauri-windows-$(Get-Arch)-$tag-portable.zip"
    $asset = @($rel.assets) | Where-Object { $_.name -eq $want } | Select-Object -First 1
    if (-not $asset) { Fail "发布内无匹配构件：$want" }
    if ($asset.browser_download_url -notlike 'https://github.com/*') { Fail '构件直链不在 GitHub 官方域' }
    if ($asset.digest -notlike 'sha256:*') { Fail '构件未回填 digest，拒绝裸装' }
    return @{ url = $asset.browser_download_url; name = $asset.name; sha256 = $asset.digest.Substring(7) }
}

function Invoke-Download($rel, [string]$dest) {
    Write-Step "下载 $($rel.name)…"
    Invoke-WebRequest -Uri $rel.url -OutFile $dest -UseBasicParsing
    return $dest
}

# ---------- 主流程 ----------

New-Item -ItemType Directory -Force -Path $Staging | Out-Null
try {
    if ($Zip) {
        # 快路径：启动器已下载并校验；脚本再验一次（双消费点）后进文件系统腿。
        if (-not $Sha256) { Fail '快路径缺 -Sha256' }
        Get-Verified $Zip $Sha256
        $src = Invoke-Extract $Zip
        Wait-OldProcess
        Invoke-Swap $src
        Invoke-Launch
    } else {
        # 全路径：bootstrap 自救（下载失败 = 原地报错退出，旧文件未动）。
        $anchor = Get-VersionAnchor
        $rel = Invoke-QueryRelease $anchor
        $dest = Join-Path $Staging $rel.name
        Invoke-Download $rel $dest | Out-Null
        Get-Verified $dest $rel.sha256
        $src = Invoke-Extract $dest
        Wait-OldProcess
        Invoke-Swap $src
        Invoke-Launch
    }
} finally {
    Remove-Item -Recurse -Force $Staging -ErrorAction SilentlyContinue
}
