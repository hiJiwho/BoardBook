@echo off
title COM7 Serial Monitor (115200 Baud)
echo ==================================================
echo BoardBook COM Port Diagnostics - 115200 Baud
echo ==================================================
echo.

echo [1] Checking available ports:
powershell -Command "[System.IO.Ports.SerialPort]::getportnames()"
echo.

echo [2] Monitoring COM7 (115200 Baud)...
echo If you see nothing, COM7 might be the wrong port.
echo Press Ctrl + C to stop.
echo --------------------------------------------------

:: Use 115200 Baud (Micro:bit default)
powershell -Command "$p = New-Object System.IO.Ports.SerialPort COM7,115200,None,8,one; $p.Open(); while($p.IsOpen) { if ($p.BytesToRead -gt 0) { $data = $p.ReadExisting(); Write-Host $data -NoNewline -ForegroundColor Cyan } }"

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Failed to open COM7. 
    echo Please check if COM7 is correct or already in use.
)
pause
