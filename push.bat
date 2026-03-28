@echo off
cd /d "C:\Users\Ovindu\Documents\Ardeno Studio\ardeno-engine"
echo Pushing to GitHub...
git add -A
set /p msg="Commit message (or press Enter for 'update: latest changes'): "
if "%msg%"=="" set msg=update: latest changes
git commit -m "%msg%"
git push
echo.
echo Done! Changes pushed to GitHub.
pause
