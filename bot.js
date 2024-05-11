require('dotenv').config();
const { SlashCommandBuilder } = require('@discordjs/builders');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const ytdl = require('ytdl-core');
const MongoClient = require('mongodb').MongoClient;
const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

const mongoClient = new MongoClient(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

async function connectToMongoDB() {
  try {
    await mongoClient.connect();
    console.log('Connected to MongoDB');
  } catch (error) {
    console.error('Error connecting to MongoDB', error);
  }
}

connectToMongoDB();

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

const setThemeCommand = new SlashCommandBuilder()
  .setName('set-theme')
  .setDescription('Set a user\'s theme song')
  .addStringOption(option =>
    option.setName('url')
      .setDescription('The URL of the theme song')
      .setRequired(true)
  )
  .addIntegerOption(option =>
    option.setName('duration')
      .setDescription('The duration of the theme song')
      .setRequired(true)
  )
  .addStringOption(option =>
    option.setName('username')
      .setDescription('The username of the user to set the theme song for')
      .setRequired(false) // make this optional, as it's only for server managers
  );

async function registerCommands() {
  try {
    console.log('Started refreshing application (/) commands.');
    const rest = new REST({ version: '9' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: [setThemeCommand.toJSON()] },
    );
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
}

registerCommands();

async function setMemberThemeSong(userId, url) {
  try {
    const usersCollection = mongoClient.db('theme_songsDB').collection('userData');
    await usersCollection.updateOne({ _id: userId }, { $set: { theme_song: url } }, { upsert: true });
  } catch (error) {
    console.error('Error updating theme song:', error);
  }
}

async function playThemeSong(channel, url) {
  try {
    const stream = ytdl(url, { filter: 'audioonly' });
    const resource = createAudioResource(stream);
    const player = createAudioPlayer();
    const connection = await joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });

    player.play(resource);

    connection.subscribe(player);

    player.on(AudioPlayerStatus.Idle, () => {
      connection.destroy(); // Leave the channel after the song has finished playing
    });

    connection.on('error', (error) => {
      console.error('Error playing theme song:', error);
    });
  } catch (error) {
    console.error('Error playing theme song:', error);
  }
}

async function getMemberThemeSong(userId) {
  try {
    const usersCollection = mongoClient.db('theme_songsDB').collection('userData');
    const user = await usersCollection.findOne({ _id: userId });
    return user ? user.theme_song : null;
  } catch (error) {
    console.error('Error getting theme song:', error);
    return null;
  }
}

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;
    const { commandName } = interaction;
  
    if (commandName === 'set-theme') {
      const url = interaction.options.getString('url');
      const duration = interaction.options.getInteger('duration');
      const username = interaction.options.getString('username');
  
      // Check if the user has the ADMINISTRATOR permission
      const member = interaction.member;
      if (username && !member.permissions.has('ADMINISTRATOR')) {
        await interaction.reply('You do not have permission to set theme songs for other users.');
        return;
      }
  
      let userId;
      if (username) {
        // Get the user ID from the username
        const user = interaction.guild.members.cache.find(member => member.user.username === username);
        if (!user) {
          await interaction.reply(`User not found: ${username}`);
          return;
        }
        userId = user.id;
      } else {
        userId = interaction.user.id;
      }
  
      await setMemberThemeSong(userId, url);
      await interaction.reply(`Theme song set for ${username ? username : 'you'}`);
    }
  });
  
  client.on('voiceStateUpdate', async (oldState, newState) => {
    if (!newState.channelId || !oldState.channelId) return;
  
    const guildId = oldState.guildId;
    const guild = client.guilds.cache.get(guildId);
    const channel = guild.channels.cache.get(newState.channelId);
  
    const userId = oldState.member.id;
    const themeSongUrl = await getMemberThemeSong(userId);
  
    if (themeSongUrl) {
      await playThemeSong(channel, themeSongUrl);
    }
  });
  
  client.login(process.env.DISCORD_TOKEN);
  