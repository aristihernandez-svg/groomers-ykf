@echo off
title Groomers YKF — Auto Deploy
color 1F
echo.
echo  ========================================
echo   ✈  Groomers YKF — Auto Deploy
echo  ========================================
echo.

REM ── CONFIG — change this path if needed ──
set REPO_PATH=%USERPROFILE%\groomers-ykf
set INDEX_PATH=%~dp0index.html

REM ── Check if index.html exists next to this script ──
if not exist "%INDEX_PATH%" (
    echo  ❌ ERROR: index.html not found next to this script.
    echo     Make sure index.html and deploy.bat are in the same folder.
    echo.
    pause
    exit /b 1
)

REM ── Check if repo folder exists, clone if not ──
if not exist "%REPO_PATH%" (
    echo  📥 Cloning repository for the first time...
    echo.
    gh repo clone aristihernandez-svg/groomers-ykf "%REPO_PATH%"
    if errorlevel 1 (
        echo.
        echo  ❌ Clone failed. Make sure GitHub CLI is installed and you are logged in.
        echo     Install from: https://cli.github.com
        echo     Then run: gh auth login
        echo.
        pause
        exit /b 1
    )
)

REM ── Copy new index.html and sw.js into the repo ──
echo  📄 Copying files into repo...
copy /Y "%INDEX_PATH%" "%REPO_PATH%\index.html" >nul
set SW_PATH=%~dp0sw.js
if exist "%SW_PATH%" copy /Y "%SW_PATH%" "%REPO_PATH%\sw.js" >nul
echo     Done.
echo.

REM ── Pull latest first to avoid conflicts ──
echo  🔄 Pulling latest from GitHub...
cd /d "%REPO_PATH%"
git pull origin main --quiet
echo     Done.
echo.

REM ── Stage, commit and push ──
echo  📤 Pushing to GitHub...
git add index.html sw.js
git diff --cached --quiet
if errorlevel 1 (
    git commit -m "Update Groomers YKF app"
    git push origin main
    if errorlevel 1 (
        echo.
        echo  ❌ Push failed. Check your internet connection and GitHub login.
        pause
        exit /b 1
    )
    echo.
    echo  ========================================
    echo   ✅ Done! App deployed successfully.
    echo   🌐 Live in ~2 min at:
    echo   aristihernandez-svg.github.io/groomers-ykf
    echo  ========================================
) else (
    echo.
    echo  ℹ️  No changes detected — index.html is already up to date.
    echo     Nothing was pushed.
)

echo.
pause
