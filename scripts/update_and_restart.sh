#!/bin/bash

# Navigate to the project directory
cd /home/edwin/Documents/Coding/theme-song-discord-bot-nodejs

# Pull the latest changes from Git
git pull

# Restart the systemd service
sudo systemctl restart bot.js

echo "Update and restart complete."
