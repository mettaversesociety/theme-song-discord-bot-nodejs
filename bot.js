require("dotenv").config();
const { Client, GatewayIntentBits, Partials, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require("discord.js");
const { SlashCommandBuilder } = require("@discordjs/builders");
const { REST } = require("@discordjs/rest");
const { Routes } = require("discord-api-types/v9");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState, // Add this import
  VoiceConnectionDisconnectReason,
} = require("@discordjs/voice");
const ytdl = require("ytdl-core");
const MongoClient = require("mongodb").MongoClient;
const ffmpeg = require("ffmpeg-static");
process.env.FFMPEG_BINARY = ffmpeg;

const scdl = require('soundcloud-downloader').default;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [
    Partials.Message, // Enable partial messages
    Partials.Channel, // Enable partial channels
    Partials.Reaction // Enable partial reactions
],
});

const mongoClient = new MongoClient(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

let defaultVolumeLevel = 0.4; // Default to 40% if none is found in the database

async function connectToMongoDB() {
  try {
      await mongoClient.connect();
      console.log("Connected to MongoDB");

      const db = mongoClient.db("theme_songsDB");

      // Initialize collections
      volumeCollection = db.collection("volumeSettings");

      // Fetch the existing default volume from the collection
      const volumeDoc = await volumeCollection.findOne({ _id: "defaultVolume" });
      if (volumeDoc && volumeDoc.value !== undefined) {
          defaultVolumeLevel = volumeDoc.value;
      } else {
          // Initialize the volume in the database if not present
          await volumeCollection.insertOne({ _id: "defaultVolume", value: defaultVolumeLevel });
      }
  } catch (error) {
      console.error("Error connecting to MongoDB or fetching default volume:", error);
  }
}

connectToMongoDB();

const rolesCollection = mongoClient.db("theme_songsDB").collection("approvedRoles");
const usersCollection = mongoClient.db("theme_songsDB").collection("approvedUsers");

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  try {
      await loadApprovedRolesCache();
      await loadApprovedUsersCache();
  } catch (error) {
      console.error("Error loading caches on startup:", error);
  }

  registerCommands();
});

async function loadApprovedRolesCache() {
  try {
      const roles = await rolesCollection.find({}).toArray();
      roles.forEach(({ guildId, roleIds }) => {
          approvedRolesCache.set(guildId, roleIds);
      });
      console.log('Approved roles cache loaded from MongoDB.');
  } catch (error) {
      console.error('Error loading approved roles cache:', error);
  }
}

async function loadApprovedUsersCache() {
  try {
      const users = await usersCollection.find({}).toArray();
      users.forEach(({ guildId, userIds }) => {
          approvedUsersCache.set(guildId, userIds);
      });
      console.log('Approved users cache loaded from MongoDB.');
  } catch (error) {
      console.error('Error loading approved users cache:', error);
  }
}

const approvedRolesCache = new Map(); // Store approved roles by guild ID
const approvedUsersCache = new Map(); // Store approved users by guild ID
const soundboardState = {}; // In-memory state to track paginated soundboard pages

async function hasApprovedRole(member) {
  const approvedRoles = approvedRolesCache.get(member.guild.id) || [];
  const approvedUsers = approvedUsersCache.get(member.guild.id) || [];
  return approvedUsers.includes(member.id) || member.roles.cache.some(role => approvedRoles.includes(role.id));
}

async function approveRoleOrUser(interaction) {
  const member = interaction.guild.members.cache.get(interaction.user.id);
  const isOwner = interaction.guild.ownerId === interaction.user.id;
  const hasPermission = isOwner || await hasApprovedRole(member);

  if (!hasPermission) {
      await interaction.reply({
          content: "You do not have permission to approve roles or users.",
          ephemeral: true,
      });
      return;
  }

  const role = interaction.options.getRole("role");
  const user = interaction.options.getUser("user");

  if (!role && !user) {
      await interaction.reply({
          content: "You must specify a role or a user to approve.",
          ephemeral: true,
      });
      return;
  }

  if (role) {
      let approvedRoles = approvedRolesCache.get(interaction.guild.id) || [];
      if (!approvedRoles.includes(role.id)) {
          approvedRoles.push(role.id);
          approvedRolesCache.set(interaction.guild.id, approvedRoles);
          await rolesCollection.updateOne(
            { guildId: interaction.guild.id },
            { $addToSet: { roleIds: role.id } },
            { upsert: true }
          );
      }
      await interaction.reply({
          content: `Role ${role.name} has been approved to manage theme songs.`,
          ephemeral: true,
      });
  }

  if (user) {
      let approvedUsers = approvedUsersCache.get(interaction.guild.id) || [];
      if (!approvedUsers.includes(user.id)) {
          approvedUsers.push(user.id);
          approvedUsersCache.set(interaction.guild.id, approvedUsers);
          await usersCollection.updateOne(
            { guildId: interaction.guild.id },
            { $addToSet: { userIds: user.id } },
            { upsert: true }
          );
      }
      await interaction.reply({
          content: `User ${user.tag} has been approved to manage theme songs.`,
          ephemeral: true,
      });
  }
}

async function disapproveRoleOrUser(interaction) {
  const member = interaction.guild.members.cache.get(interaction.user.id);
  const isOwner = interaction.guild.ownerId === interaction.user.id;
  const hasPermission = isOwner || await hasApprovedRole(member);

  if (!hasPermission) {
      await interaction.reply({
          content: "You do not have permission to disapprove roles or users.",
          ephemeral: true,
      });
      return;
  }

  const role = interaction.options.getRole("role");
  const user = interaction.options.getUser("user");

  if (!role && !user) {
      await interaction.reply({
          content: "You must specify a role or a user to disapprove.",
          ephemeral: true,
      });
      return;
  }

  if (role) {
      let approvedRoles = approvedRolesCache.get(interaction.guild.id) || [];
      if (approvedRoles.includes(role.id)) {
          approvedRoles = approvedRoles.filter(id => id !== role.id);
          approvedRolesCache.set(interaction.guild.id, approvedRoles);
          await rolesCollection.updateOne(
              { guildId: interaction.guild.id },
              { $pull: { roleIds: role.id } }
          );
      }
      await interaction.reply({
          content: `Role ${role.name} has been disapproved from managing theme songs.`,
          ephemeral: true,
      });
  }

  if (user) {
      let approvedUsers = approvedUsersCache.get(interaction.guild.id) || [];
      if (approvedUsers.includes(user.id)) {
          approvedUsers = approvedUsers.filter(id => id !== user.id);
          approvedUsersCache.set(interaction.guild.id, approvedUsers);
          await usersCollection.updateOne(
              { guildId: interaction.guild.id },
              { $pull: { userIds: user.id } }
          );
      }
      await interaction.reply({
          content: `User ${user.tag} has been disapproved from managing theme songs.`,
          ephemeral: true,
      });
  }
}

function retrieveUserIdByUsername(members, username) {
  let normalizedUsername;

  if (username) {
    // Check if the username is a mention (starts with <@ and ends with >)
    if (username.startsWith("<@") && username.endsWith(">")) {
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

const players = new Map();
const voiceConnections = new Map();

async function maintainConnection(channel, player) {
  // console.log('count connections', voiceConnections.size)
  // console.log('count players', players.size)
  const guildId = channel.guild.id;
  let connection = voiceConnections.get(guildId);

  if (connection) {
      if (connection.joinConfig.channelId !== channel.id) {
          // console.log(`Bot needs to move from channelId=${connection.joinConfig.channelId} to channelId=${channel.id}`);

          if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
            // console.log(`Destroying previous connection in channelId=${connection.joinConfig.channelId}`);
            connection.destroy();
          }

          connection = joinVoiceChannel({
              channelId: channel.id,
              guildId,
              adapterCreator: channel.guild.voiceAdapterCreator,
          });

          setupConnectionEvents(connection, player);
          voiceConnections.set(guildId, connection);
          // console.log(`Moved connection to new channel: ${channel.name}`);
      } else {
          // console.log('Bot is already connected to this channel.');
      }
    } else {
        connection = joinVoiceChannel({
            channelId: channel.id,
            guildId,
            adapterCreator: channel.guild.voiceAdapterCreator,
        });

        setupConnectionEvents(connection, player);
        voiceConnections.set(guildId, connection);
        // console.log(`Successfully connected to ${channel.name}`);
    }
}

function setupConnectionEvents(connection, player) {
  connection.on('stateChange', async (oldState, newState) => {
      // console.log(`Connection transitioned from ${oldState.status} to ${newState.status} : channelId=${connection.joinConfig.channelId}, guildId=${connection.joinConfig.guildId}`);
      
      if (newState.status === VoiceConnectionStatus.Disconnected) {
          try {
              if (newState.reason !== 'WebSocketClose') {
                console.log('Attempting to reconnect...');
                await entersState(connection, VoiceConnectionStatus.Connecting, 5000);
              }
          } catch (error) {
              console.error('Unable to connect within 5 seconds', error);
              connection.destroy();
          }
      }
  });

  connection.on('error', (error) => {
      console.error('Voice connection error:', error);
  });

  // Subscribe to the player if the connection is not already subscribed or if the subscription is different
  if (!connection.state.subscription || connection.state.subscription.player !== player) {
      connection.subscribe(player);
  }
}

async function setupPlayerEvents(player, stream, timeoutId) {
  let resource;

  try {
    // Fetch volume settings for all users in the voice channel    
    resource = createAudioResource(stream, { inlineVolume: true });
    if (resource.volume) {
      resource.volume.setVolume(defaultVolumeLevel);
    }
  } catch (error) {
      console.error('Error setting volume:', error);
  }

  // Remove all existing listeners to prevent leaks
  player.removeAllListeners('error');
  player.removeAllListeners(AudioPlayerStatus.Idle);

  player.on('error', (error) => {
      console.error('AudioPlayer error:', error);
      if (timeoutId) clearTimeout(timeoutId); // Clear the timeout if there's an error
      if (stream) stream.destroy(); // Ensure stream is destroyed on error
  });

  player.on(AudioPlayerStatus.Idle, () => {
      // console.log('AudioPlayer is idle. Cleaning up resources.');
      // Cleanup resources
      if (timeoutId) clearTimeout(timeoutId); // Clear the timeout when playback is idle
      if (stream) stream.destroy(); // Ensure stream is destroyed when playback is idle
      if (resource) resource.playStream.destroy(); // Clean up resource if necessary
      
      // Remove all listeners to avoid memory leaks
      player.removeAllListeners();
  });

  player.play(resource);
}

function getPlayer(guildId) {
  // Check if a player already exists
  let player = players.get(guildId);
  if (!player) {
      player = createAudioPlayer();
      players.set(guildId, player);
  }
  return player;
}

const setVolumeCommand = new SlashCommandBuilder()
  .setName("volume")
  .setDescription("Set the default volume for the bot")
  .addIntegerOption((option) =>
      option
        .setName("volume")
        .setDescription("Volume level (0-100)")
        .setRequired(true),
  )

const approveRoleOrUserCommand = new SlashCommandBuilder()
  .setName("approve-role-or-user")
  .setDescription("Approve a role or user to manage theme songs")
  .addRoleOption((option) =>
      option.setName("role")
          .setDescription("The role to approve")
          .setRequired(false),
  )
  .addUserOption((option) =>
      option.setName("user")
          .setDescription("The user to approve")
          .setRequired(false),
  );

  const disapproveRoleOrUserCommand = new SlashCommandBuilder()
  .setName("disapprove-role-or-user")
  .setDescription("Disapprove a role or user to manage theme songs")
  .addRoleOption((option) =>
      option.setName("role")
          .setDescription("The role to disapprove")
          .setRequired(false),
  )
  .addUserOption((option) =>
      option.setName("user")
          .setDescription("The user to disapprove")
          .setRequired(false),
  );

const setThemeCommand = new SlashCommandBuilder()
  .setName("set-theme")
  .setDescription("Set a user's theme song")
  .addStringOption((option) =>
    option
      .setName("url")
      .setDescription("The URL of the theme song")
      .setRequired(true),
  )
  .addIntegerOption((option) =>
    option
      .setName("duration")
      .setDescription("The duration of the theme song")
      .setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName("username")
      .setDescription("The username of the user to set the theme song for")
      .setRequired(false),
  ); // make this optional as it's only for server managers

  const addSoundbiteCommand = new SlashCommandBuilder()
  .setName("add-soundbite")
  .setDescription("Add a new soundbite to your collection")
  .addStringOption((option) =>
    option
      .setName("title")
      .setDescription("The title of the soundbite")
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("url")
      .setDescription("The URL of the soundbite")
      .setRequired(true),
  );

const deleteSoundbiteCommand = new SlashCommandBuilder()
  .setName("delete-soundbite")
  .setDescription("Delete a soundbite from your collection")
  .addStringOption((option) =>
    option
      .setName("title")
      .setDescription("The title of the soundbite to delete")
      .setRequired(true),
  );

const viewSoundboardCommand = new SlashCommandBuilder()
  .setName("soundboard")
  .setDescription("View your soundboard");

const playYoutubeCommand = new SlashCommandBuilder()
  .setName("yt")
  .setDescription("Play Youtube")
  .addStringOption((option) =>
    option
      .setName("url")
      .setDescription("The URL of the youtube video")
      .setRequired(true),
  );

const skipYoutubeCommand = new SlashCommandBuilder()
  .setName("skip")
  .setDescription("Skip Youtube playback");

async function registerCommands() {
  try {
    const rest = new REST({ version: "9" }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: [
        setVolumeCommand.toJSON(),
        approveRoleOrUserCommand.toJSON(),
        disapproveRoleOrUserCommand.toJSON(),
        setThemeCommand.toJSON(),
        addSoundbiteCommand.toJSON(),
        deleteSoundbiteCommand.toJSON(),
        viewSoundboardCommand.toJSON(),
        playYoutubeCommand.toJSON(),
        skipYoutubeCommand.toJSON()
      ],
    });
    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error(error);
  }
}

async function setMemberThemeSong(userId, url, duration, username) {
  // Regular expressions for SoundCloud and YouTube URLs
  const soundcloudRegex = /^(https?:\/\/)?(www\.)?soundcloud\.com\/.+$/;
  const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;
  
  // Validate the URL
  if (typeof url !== 'string' || (!soundcloudRegex.test(url) && !youtubeRegex.test(url))) {
    console.error("Invalid URL format. Please provide a valid SoundCloud or YouTube URL.");
    throw new Error("Invalid URL format. Please provide a valid SoundCloud or YouTube URL.");
  }

  try {
    const usersCollection = mongoClient
      .db("theme_songsDB")
      .collection("themeSongs");
      
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
    const usersCollection = mongoClient
      .db("theme_songsDB")
      .collection("themeSongs");
    const user = await usersCollection.findOne({ _id: userId });
    return user ? user.theme_song : null;
  } catch (error) {
    console.error("Error getting theme song:", error);
    return null;
  }
}

async function playSoundBite(interaction, channel, url) {
  if (url.includes("soundcloud.com")) {
    try {
      await interaction.deferUpdate();
      const player = getPlayer(channel.guild.id);
      await maintainConnection(channel, player);
      // const trackInfo = await scdl.getInfo(url);
      const stream = await scdl.download(url);

      // Get the IDs of users in the voice channel
      const userIds = channel.members.map(member => member.user.id);

      setupPlayerEvents(player, stream);
    } catch (error) {
      console.error("Error playing soundbite:", error);
    }
  } else {
    // Respond quickly to prevent the "interaction failed" warning
    await interaction.deferUpdate();
    console.log("Invalid SoundCloud URL provided.");
  }
}

async function playYoutube(channel, url) {
  if (url.includes("youtube.com") || url.includes("youtu.be")) {
    try {
      const player = getPlayer(channel.guild.id);
      await maintainConnection(channel, player);
      const stream = ytdl(url, { quality: "highestaudio" });
      setupPlayerEvents(player, stream);
    } catch (error) {
        console.error("Error playing YouTube component:", error);
    }
  } else {
      console.log("Invalid YouTube URL provided.");
  }
}

async function playThemeSong(channel, url, duration) {
  try {
    const player = getPlayer(channel.guild.id);
    await maintainConnection(channel, player);

    let stream;

    if (url.includes("soundcloud.com")) {
        stream = await scdl.download(url);
    } else if (url.includes("youtube.com") || url.includes("youtu.be")) {
        stream = ytdl(url, { quality: 'highestaudio' });
    } else {
        console.log("Invalid URL provided.");
        return;
    }

    const timeoutId = setTimeout(() => {
        if (player.state.status !== AudioPlayerStatus.Idle) {
            player.stop();
        }
    }, duration * 1000);
    
    setupPlayerEvents(player, stream, timeoutId);

  } catch (error) {
      console.error("Error playing theme song:", error);
  }
}

async function addSoundbite(title, url) {
  try {
    const soundboardCollection = mongoClient.db("theme_songsDB").collection("soundboard");
    
    // Regex pattern to check if URL is a SoundCloud URL
    const soundcloudRegex = /^(https?:\/\/)?(www\.)?(soundcloud\.com)\/[\w\-]+\/[\w\-]+(?=$|[?])/;

    // Check if the URL is a valid SoundCloud URL
    if (!soundcloudRegex.test(url)) {
      return {
        success: false,
        message: "The URL provided is not a valid SoundCloud URL. Please provide a valid SoundCloud URL."
      };
    }

    // Check for existing soundbite with the same title
    const existingSoundbite = await soundboardCollection.findOne({ title });
    if (existingSoundbite) {
      console.log(`Soundbite with title "${title}" already exists.`);
      return {
        success: false,
        message: `A soundbite with the title "${title}" already exists. Please choose a different title.`
      };
    }
    
    // Insert new soundbite if no duplicate is found
    await soundboardCollection.insertOne({ title, url });
    console.log(`Soundbite "${title}" added to the soundboard`);
    
    return {
      success: true,
      message: `Soundbite "${title}" added successfully!`
    };
  } catch (error) {
    console.error("Error adding soundbite:", error);
    return {
      success: false,
      message: "An error occurred while adding the soundbite. Please try again later."
    };
  }
}

async function deleteSoundbite(title) {
  try {
    const soundboardCollection = mongoClient.db("theme_songsDB").collection("soundboard");
    await soundboardCollection.deleteOne({ title });
    console.log(`Soundbite "${title}" deleted from the soundboard`);
} catch (error) {
    console.error("Error deleting soundbite:", error);
  }
}

const itemsPerPage = 20; // Number of items per page

async function getSoundboard(page = 0) {
  try {
    const soundboardCollection = mongoClient.db("theme_songsDB").collection("soundboard");
    
    const totalItems = await soundboardCollection.countDocuments();
    const totalPages = Math.ceil(totalItems / itemsPerPage);

    const soundboard = await soundboardCollection.find({})
        .skip(page * itemsPerPage)
        .limit(itemsPerPage)
        .toArray();

    return {
        soundboard,
        currentPage: page,
        totalPages,
    };
  } catch (error) {
    console.error("Error fetching soundboard:", error);
    return {
      soundboard: [],
      currentPage: 0,
      totalPages: 0,
    };
  }
}

client.on("interactionCreate", async (interaction) => {
  let userId = interaction.user.id;

  // Ensure soundboard state is initialized
  if (!soundboardState[userId]) {
    const initialPage = 0;
    const { soundboard, currentPage, totalPages } = await getSoundboard(initialPage);
    soundboardState[userId] = { page: currentPage, totalPages, soundboard };
  } 

  const state = soundboardState[userId];

  if (interaction.isCommand()) {

    if (interaction.commandName === 'volume') {
      const volume = interaction.options.getInteger('volume');

      // Validate the volume level
      if (volume < 0 || volume > 100) {
          await interaction.reply({
            content: `Volume must be between 0 and 100.`,
            ephemeral: true,
          });
    
          return;
      }

      // Convert to a decimal value (0-1)
      defaultVolumeLevel = volume / 100;

      try {
        // Update the volume in the MongoDB collection
        await volumeCollection.updateOne(
            { _id: "defaultVolume" },
            { $set: { value: defaultVolumeLevel } },
            { upsert: true }
        );

        await interaction.reply({
          content: `Default volume set to ${volume}%.`,
          ephemeral: true,
        });
  
      } catch (error) {
          console.error("Error updating volume in MongoDB:", error);
          await interaction.reply({
            content: 'Failed to set volume. Please try again later.',
            ephemeral: true,
          });
      }

    } else if (interaction.commandName === "approve-role-or-user") {
      await approveRoleOrUser(interaction);
    }

    else if (interaction.commandName === "disapprove-role-or-user") {
      await disapproveRoleOrUser(interaction);
    }


    else if (interaction.commandName === "set-theme") {

      const url = interaction.options.getString("url");
      const duration = interaction.options.getInteger("duration") || 10;
      const username = interaction.options.getString("username");

      try {
        // Fetch all members
        const members = await interaction.guild.members.fetch();
        if (username) {
          const member = interaction.guild.members.cache.get(interaction.user.id);
          const isOwner = interaction.guild.ownerId === interaction.user.id;
          const hasPermission = isOwner || await hasApprovedRole(member);

          if (!hasPermission) {
              // If not server owner, discard the username argument
              await interaction.reply({
                  content: "You do not have permission to set theme songs for other users.",
                  ephemeral: true,
              });
              return;
          } 
          
          userId = retrieveUserIdByUsername(members, username);
        }

        if (userId) {
          // If userId is already found, use it
          await setMemberThemeSong(userId, url, duration, username);
          await interaction.reply({
            content: `Theme song set for ${username || interaction.user.username}: max ${duration} seconds.`,
            ephemeral: true,
          });
        } else {
          // If userId is not found, try to find the user by username or globalName
          const user = members.find((member) => {
            return (
              member.user.username === username ||
              member.user.globalName === username
            );
          });

          if (user) {
            userId = user.id;
            await setMemberThemeSong(userId, url, duration, username);
            await interaction.reply({
              content: `Theme song set for ${username || interaction.user.username}: max ${duration} seconds.`,
              ephemeral: true,
            });
          } else {
            await interaction.reply({
              content: `No user found with the specified username: ${username}`,
              ephemeral: true,
            });
          }
        }
      } catch (error) {
        console.error("Failed during interaction handling:", error);
        await interaction.reply({
          content: "An error occurred while setting the theme song.",
          ephemeral: true,
        });
      }
    } else if (interaction.commandName === "add-soundbite") {
      const title = interaction.options.getString("title");
      const url = interaction.options.getString("url");

      // Call the addSoundbite function and handle the response
      const response = await addSoundbite(title, url);

      await interaction.reply({
        content: response.message,
        ephemeral: true
      });

    } else if (interaction.commandName === "delete-soundbite") {
      const title = interaction.options.getString("title");

      await deleteSoundbite(title);
      await interaction.reply({
        content: `Soundbite "${title}" deleted!`,
        ephemeral: true
      });

    } else if (interaction.commandName === "soundboard") {
      const initialPage = 0;
      const { soundboard, currentPage, totalPages } = await getSoundboard(initialPage);

      // Store state for the user
      soundboardState[userId] = { page: currentPage, totalPages };

      await sendSoundboard(interaction, soundboard, currentPage, totalPages, false);

    } else if (interaction.commandName === "yt") {
      const url = interaction.options.getString("url");

      const channel = interaction.member.voice.channel;
      if (channel) {
        await playYoutube(channel, url)
        await interaction.reply({
          content: `Playing youtube!`,
          ephemeral: true
        });
      } else {
        await interaction.reply({
            content: "You need to be in a voice channel to play a YouTube video.",
            ephemeral: true
        });
      }
    } else if (interaction.commandName === "skip") {
      const channel = interaction.member.voice.channel;
      if (!channel) {
        return interaction.reply({
          content: "You need to be in a voice channel to skip playback.",
          ephemeral: true,
        });
      }
  
      const player = getPlayer(channel.guild.id);
      if (player) {
        player.stop();
        return interaction.reply({
          content: "Playback skipped.",
          ephemeral: true,
        });
      } else {
        return interaction.reply({
          content: "There's no active playback to skip.",
          ephemeral: true,
        });
      }
    }
  } else if (interaction.isButton()) {
    const userId = interaction.user.id;
    const [action, title] = interaction.customId.split('-');

    if (action === 'play') {
      const state = soundboardState[userId];
      const soundboard = await getSoundboard(state.page);
      const soundbite = soundboard.soundboard.find(sb => sb.title === title);

      if (soundbite) {
        const channel = interaction.member.voice.channel;
        if (channel) {
          await playSoundBite(interaction, channel, soundbite.url);
        } else {
          await interaction.reply({
            content: "You need to be in a voice channel to play a soundbite.",
            ephemeral: true,
          });
        }
      } else  {
        console.warn('Soundbite not found for title:', title);
        interaction.reply({
            content: "You tried to use an old Soundboard instance. Generate a new soundboard instead.",
            ephemeral: true
        });
        return;
      }
    } else if (action === 'previous' || action === 'next') {
      if (action === 'previous') {
        state.page = Math.max(0, state.page - 1); // Prevent going below page 0
      } else if (action === 'next') {
          state.page = Math.min(state.totalPages - 1, state.page + 1); // Prevent going above totalPages
      }

      try {
          const { soundboard, currentPage, totalPages } = await getSoundboard(state.page);
          state.soundboard = soundboard;
          state.page = currentPage;
          state.totalPages = totalPages;

        await sendSoundboard(interaction, soundboard, currentPage, totalPages, true);

      } catch (error) {
          console.error('Error fetching soundboard:', error);
          await interaction.reply({
              content: "An error occurred while fetching the soundboard. Please try again later.",
              ephemeral: true
          });
      }
    }
  }
});

async function sendSoundboard(interaction, soundboard, currentPage, totalPages, edit = false) {
  const components = [];

  if (soundboard.length === 0) {
    try {
      await interaction.reply({
          content: "Your soundboard is empty.",
          ephemeral: true,
      });
    } catch (error) {
        console.error("Error sending empty soundboard message:", error);
    }
    return;
  }

  // Create soundboard buttons (5x5 grid)
  for (let i = 0; i < soundboard.length; i += 5) {
      const row = new ActionRowBuilder();
      const slice = soundboard.slice(i, i + 5);
      slice.forEach(soundbite => {
          const playButton = new ButtonBuilder()
              .setCustomId(`play-${soundbite.title}`)
              .setLabel(`${soundbite.title}`)
              .setStyle(ButtonStyle.Primary);
          row.addComponents(playButton);
      });
      components.push(row);
  }

  // Create pagination row
  const paginationRow = new ActionRowBuilder();

  // Previous Page Button
  const prevButton = new ButtonBuilder()
      .setCustomId('previous-page')
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 0);

  // Next Page Button
  const nextButton = new ButtonBuilder()
      .setCustomId('next-page')
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === totalPages - 1);
  
  paginationRow.addComponents(prevButton, nextButton);
  components.push(paginationRow);

  try {
    // Send initial message or update existing message
    if (edit) {
        await interaction.update({
            content: `Your Soundboard (Page ${currentPage + 1} of ${totalPages}):`,
            components: components,
            ephemeral: true,
        });
    } else {
        await interaction.reply({
            content: `Your Soundboard (Page ${currentPage + 1} of ${totalPages}):`,
            components: components,
            ephemeral: true,
        });
    }
  } catch (error) {
    console.error("Error sending soundboard:", error);
  }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (oldState.channelId === newState.channelId) {
    return; // No change in state
  }

  const member = newState.member;
  const themeSongData = await getMemberThemeSong(member.id);
  const newChannel = newState.guild.channels.cache.get(newState.channelId);

  if (newChannel && themeSongData) {
      const { url, duration, username } = themeSongData;
      try {
          // console.log(`Successfully connected to ${newChannel.name}`);
          playThemeSong(newChannel, url, duration);
      } catch (error) {
          console.error('Error attempting to rejoin or play theme song:', error);
      }
  }
});

client.login(process.env.DISCORD_TOKEN);
