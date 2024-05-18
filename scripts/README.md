So, for a service file named discord-bot.service, you would use:

sudo systemctl status discord-bot to check the status.
sudo systemctl start discord-bot to start the service.
sudo systemctl stop discord-bot to stop the service.
sudo systemctl restart discord-bot to restart the service.
sudo systemctl enable discord-bot to enable the service to start on boot.
sudo systemctl disable discord-bot to disable the service from starting on boot.
Here are some examples with explanations:

Checking the Status:
sudo systemctl status discord-bot
This command checks the current status of the discord-bot service.

Starting the Service:
sudo systemctl start discord-bot
This command starts the discord-bot service.

Stopping the Service:
sudo systemctl stop discord-bot
This command stops the discord-bot service.

Restarting the Service:
sudo systemctl restart discord-bot
This command restarts the discord-bot service.

Enabling the Service to Start on Boot:
sudo systemctl enable discord-bot
This command sets the discord-bot service to start automatically when the system boots.

Disabling the Service from Starting on Boot:
sudo systemctl disable discord-bot
This command prevents the discord-bot service from starting automatically when the system boots.

Viewing the Logs:
sudo journalctl -u discord-bot -f
This command shows the logs for the discord-bot service. The -f option follows the log output in real-time.

By omitting the .service suffix, these commands become easier to use and are more in line with typical systemctl usage patterns.

---
The sudo systemctl daemon-reload command is used to reload the systemd manager configuration. You should use it whenever you make changes to service files or create new service files in the /etc/systemd/system/ directory.

Specifically, you should run sudo systemctl daemon-reload in the following situations:

Adding New Service Files: Whenever you create a new service file (e.g., discord-bot.service), you should run sudo systemctl daemon-reload to notify systemd of the new service.

Modifying Existing Service Files: If you modify the content of an existing service file (e.g., editing the ExecStart directive or changing the Restart policy), you must run sudo systemctl daemon-reload for changes to take effect.

Deleting Service Files: If you delete a service file manually, running sudo systemctl daemon-reload will make systemd clean up its entries corresponding to the removed file.

Example Use Case:
You create or edit a service file:

sudo nano /etc/systemd/system/discord-bot.service
After saving the file, reload the systemd manager configuration:

sudo systemctl daemon-reload
Finally, start, restart, or enable the service as needed:

sudo systemctl start discord-bot
sudo systemctl enable discord-bot
Failing to run systemctl daemon-reload after updating service files may result in the changes not being applied immediately, with the possible persistence of an old service configuration.