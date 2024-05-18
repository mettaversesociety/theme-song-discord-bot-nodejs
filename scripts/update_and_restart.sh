#!/bin/bash

# Navigate to the project directory
cd /home/edwin/Documents/Coding/theme-song-discord-bot-nodejs

# Pull the latest changes from Git
git pull

# Restart the systemd service
sudo systemctl restart discord-bot.service

echo "Update and restart complete."
