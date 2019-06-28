#!/usr/bin/env bash

# set which display to use
export DISPLAY=:0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../" >/dev/null 2>&1 && pwd)"

# kill child processes on exit
trap 'kill $(jobs -pr)' SIGINT SIGTERM EXIT

# turn off screensaver
xset s noblank
xset s off
xset -dpms

# hide cursor
unclutter -idle 0.5 -root &

# disable some chrome warning messages
sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' /home/pi/.config/chromium/Default/Preferences
sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/' /home/pi/.config/chromium/Default/Preferences

# launch server
echo 'Launching server'
GOOGLE_APPLICATION_CREDENTIALS="$ROOT/google-auth.json" node "$ROOT/index.js" &

# wait for server to be responsive
echo 'Waiting for server to respond'
while ! nc -vz localhost 3000; do
    sleep 2
done

# launch chromium in kiosk mode
echo 'Launching chromium'
/usr/bin/chromium-browser --noerrdialogs --disable-infobars --kiosk http://localhost:3000
