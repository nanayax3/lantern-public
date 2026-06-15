@echo off
REM ── Start Lantern ──────────────────────────────────────────────
REM Double-click this to open Lantern. A terminal window opens and
REM stays open while Lantern runs — that's normal; it's the engine.
REM To close Lantern, close that window (or close the Lantern app).
REM
REM If it ever says 'pnpm is not recognized', the toolchain moved —
REM open a terminal and run:  npm install -g pnpm
REM ────────────────────────────────────────────────────────────────

title Lantern
cd /d "%~dp0"

echo Starting Lantern... (this window stays open while it runs)
echo.

call pnpm dev

REM If pnpm dev exits/crashes, keep the window open so the error is readable.
echo.
echo Lantern has stopped. Press any key to close this window.
pause >nul
