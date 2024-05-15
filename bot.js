const { Client, GatewayIntentBits, SlashCommandBuilder } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const { MongoClient } = require('mongodb');
const scdl = require('soundcloud-downloader').default;
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const ytdl = require('ytdl-core');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const mongoClient = new MongoClient(process.env.MONGODB_URI);

const setThemeCommand = new SlashCommandBuilder()
  .setName("set-theme")
  .setDescription("Set a theme song for a user")
  .addStringOption((option) => option.setName("url").setDescription("The URL of the theme song").setRequired(true))
  .addIntegerOption((option) => option.setName("duration").setDescription("Duration in seconds").setRequired(false))
  .addStringOption((option) => option.setName("username").setDescription("The username of the user to set the theme song for").setRequired(false));

const addSoundbiteCommand = new SlashCommandBuilder()
  .setName("add-soundbite")
  .setDescription("Add a new soundbite to your collection")
  .addStringOption((option) => option.setName("title").setDescription("The title of the soundbite").setRequired(true))
  .addStringOption((option) => option.setName("url").setDescription("The URL of the soundbite").setRequired(true));

const deleteSoundbiteCommand = new SlashCommandBuilder()
  .setName("delete-soundbite")
  .setDescription("Delete a soundbite from your collection")
  .addStringOption((option) => option.setName("title").setDescription("The title of the soundbite to delete").setRequired(true));

const viewSoundboardCommand = new SlashCommandBuilder()
  .setName("view-soundboard")
  .setDescription("View your soundboard");

const playYoutubeCommand = new SlashCommandBuilder()
  .setName("yt")
  .setDescription("Play Youtube")
  .addStringOption((option) => option.setName("url").setDescription("The URL of the youtube video").setRequired(true));

async function registerCommands() {
  try {
    const rest = new REST({ version: "9" }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: [
        setThemeCommand.toJSON(),
        addSoundbiteCommand.toJSON(),
        deleteSoundbiteCommand.toJSON(),
        viewSoundboardCommand.toJSON(),
        playYoutubeCommand.toJSON()
      ],
    });
    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error(error);
  }
}

async function setMemberThemeSong(userId, url, duration, username) {
  try {
    const usersCollection = mongoClient.db("theme_songsDB").collection("userData");
    await usersCollection.updateOne(
      { _id: userId },
      { $set: { theme_song: { url, duration, username } } },
      { upsert: true },
    );
  } catch (error) {
    console.error("Error updating theme song:", error);
  }
}

async function getMemberThemeSong(userId) {
  try {
    const usersCollection = mongoClient.db("theme_songsDB").collection("userData");
    const user = await usersCollection.findOne({ _id: userId });
    return user ? user.theme_song : null;
  } catch (error) {
    console.error("Error getting theme song:", error);
    return null;
  }
}

async function playSoundBite(channel, url) {
  if (url.includes("soundcloud.com")) {
    try {
      const stream = await scdl.download(url);
      const resource = createAudioResource(stream);
      const player = createAudioPlayer();
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
      });

      player.play(resource);
      connection.subscribe(player);

      player.on(AudioPlayerStatus.Idle, () => connection.destroy());
    } catch (error) {
      console.error("Error playing SoundCloud track:", error);
    }
  } else {
    console.error("Only SoundCloud URLs are supported at the moment.");
  }
}

async function playYoutube(channel, url) {
  try {
    const stream = ytdl(url, { filter: 'audioonly' });
    const resource = createAudioResource(stream);
    const player = createAudioPlayer();
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });

    player.play(resource);
    connection.subscribe(player);

    player.on(AudioPlayerStatus.Idle, () => connection.destroy());
  } catch (error) {
    console.error("Error playing YouTube video:", error);
  }
}

function retrieveUserIdByUsername(members, username) {
  console.log("USERNAME ", username);
  let normalizedUsername;
  if (username) {
    // Check if the username is a mention (starts with <@ and ends with >)
    if (username.startsWith("<@") && username.endsWith(">")) {
      console.log("PRETTY");
      const userId = username.slice(2, -1); // Remove the <> and parse the ID
      return userId;
    }
    // Normalize username if it includes a discriminator (e.g., 'username#1234')
    normalizedUsername = username.split("#")[0];
  }
  // Ensure the member list is an array, regardless of the input data structure
  let memberList;
  if (members instanceof Map) {
    memberList = Array.from(members.values());
  } else if (Array.isArray(members)) {
    memberList = members;
  } else {
    memberList = Object.values(members);
  }
  // Find member by username or nickname (display name)
  const user = memberList.find((member) => {
    const actualUsername = member.user && member.user.username;
    const discriminator = member.user && member.user.discriminator;
    const memberNickname = member.user && member.user.globalName;
    const displayName = actualUsername + "#" + discriminator; // Combine username and discriminator
    return (
      actualUsername === normalizedUsername ||
      displayName === username ||
      memberNickname === username
    );
  });
  // Check if user was found and return user ID or null
  if (user) {
    return user.user.id;
  } else {
    console.log(`No user found with the specified username: ${username}`);
    return null;
  }
}

async function addSoundbite(userId, title, url) {
  try {
    const usersCollection = mongoClient.db("theme_songsDB").collection("userData");
    await usersCollection.updateOne(
      { _id: userId },
      { $push: { soundboard: { title, url } } },
      { upsert: true },
    );
    console.log(`Soundbite added for user ${userId}`);
  } catch (error) {
    console.error("Error adding soundbite:", error);
  }
}

async function deleteSoundbite(userId, title) {
  try {
    const usersCollection = mongoClient.db("theme_songsDB").collection("userData");
    await usersCollection.updateOne(
      { _id: userId },
      { $pull: { soundboard: { title } } },
    );
    console.log(`Soundbite deleted for user ${userId}`);
  } catch (error) {
    console.error("Error deleting soundbite:", error);
  }
}

async function getSoundboard(userId) {
  try {
    const usersCollection = mongoClient.db("theme_songsDB").collection("userData");
    const user = await usersCollection.findOne({ _id: userId });
    return user ? user.soundboard : [];
  } catch (error) {
    console.error("Error fetching soundboard:", error);
    return [];
  }
}

client.on("interactionCreate", async (interaction) => {
  if (interaction.isCommand()) {
    let userId = interaction.user.id;
    if (interaction.commandName === "set-theme") {
      const url = interaction.options.getString("url");
      const duration = interaction.options.getInteger("duration");
      const username = interaction.options.getString("username");
      try {
        const members = await interaction.guild.members.fetch();
        if (username) {
          userId = retrieveUserIdByUsername(members, username);
        }
        console.log("User ID:", userId);
        if (userId) {
          await setMemberThemeSong(userId, url, duration, username);
          await interaction.reply(`Theme song set successfully for ${username ? username : interaction.user.username}!`);
        } else {
          await interaction.reply(`Failed to set theme song. User not found.`);
        }
      } catch (error) {
        console.error("Error setting theme song:", error);
        await interaction.reply("An error occurred while setting the theme song.");
      }
    } else if (interaction.commandName === "add-soundbite") {
      const title = interaction.options.getString("title");
      const url = interaction.options.getString("url");
      try {
        await addSoundbite(userId, title, url);
        await interaction.reply(`Soundbite "${title}" added successfully!`);
      } catch (error) {
        console.error("Error adding soundbite:", error);
        await interaction.reply("An error occurred while adding the soundbite.");
      }
    } else if (interaction.commandName === "delete-soundbite") {
      const title = interaction.options.getString("title");
      try {
        await deleteSoundbite(userId, title);
        await interaction.reply(`Soundbite "${title}" deleted successfully!`);
      } catch (error) {
        console.error("Error deleting soundbite:", error);
        await interaction.reply("An error occurred while deleting the soundbite.");
      }
    } else if (interaction.commandName === "view-soundboard") {
      try {
        const soundboard = await getSoundboard(userId);
        if (soundboard.length > 0) {
          const soundboardList = soundboard.map((sb, index) => `${index + 1}. ${sb.title} - ${sb.url}`).join("\n");
          await interaction.reply(`Your soundboard:\n${soundboardList}`);
        } else {
          await interaction.reply("Your soundboard is empty.");
        }
      } catch (error) {
        console.error("Error fetching soundboard:", error);
        await interaction.reply("An error occurred while fetching your soundboard.");
      }
    } else if (interaction.commandName === "yt") {
      const url = interaction.options.getString("url");
      const channel = interaction.member.voice.channel;
      if (!channel) {
        await interaction.reply("You need to join a voice channel first!");
        return;
      }
      try {
        await playYoutube(channel, url);
        await interaction.reply(`Playing YouTube video: ${url}`);
      } catch (error) {
        console.error("Error playing YouTube video:", error);
        await interaction.reply("An error occurred while attempting to play the YouTube video.");
      }
    }
  }
});

client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag}!`);
  registerCommands();
  mongoClient.connect().then(() => {
    console.log("Connected to MongoDB");
  }).catch(e => {
    console.error('Error connecting to MongoDB:', e);
  });
});

client.login(process.env.DISCORD_TOKEN);
