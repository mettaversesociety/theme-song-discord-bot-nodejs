#!/bin/bash

# Navigate to the project directory
cd /home/edwin/Documents/Coding/theme-song-discord-bot-nodejs

git reset --hard

# Pull the latest changes from Git
git pull

# Restart the systemd service
sudo systemctl restart discord-bot

echo "Update and restart complete."
