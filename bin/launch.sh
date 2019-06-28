#!/usr/bin/env bash

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
GOOGLE_APPLICATION_CREDENTIALS="$(git rev-parse --show-toplevel)/google-auth.json" node index.js &

# wait for server to be responsive
echo 'Waiting for server to respond'
while ! nc -vz localhost 3000; do
    sleep 2
done

# launch chromium in kiosk mode
echo 'Launching chromium'
DISPLAY=:0 /usr/bin/chromium-browser --noerrdialogs --disable-infobars --kiosk http://localhost:3000
