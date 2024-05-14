require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { SlashCommandBuilder } = require("@discordjs/builders");
const { REST } = require("@discordjs/rest");
const { Routes } = require("discord-api-types/v9");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
} = require("@discordjs/voice");
const ytdl = require("ytdl-core");
const MongoClient = require("mongodb").MongoClient;
const ffmpeg = require("ffmpeg-static");

process.env.FFMPEG_BINARY = ffmpeg;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

const { DisTube } = require("distube");
const { SoundCloudPlugin } = require("@distube/soundcloud");
const distube = new DisTube(client, {
    ffmpeg: {
        path: ffmpegStatic
    },
    leaveOnEmpty: true,
    leaveOnFinish: true,
    leaveOnStop: true,
    plugins: [new SoundCloudPlugin()],
});

distube.on('play', (queue) => {
    const connection = queue.voiceConnection;  // Get the voice connection from the queue
    connection.once("stateChange", (oldState, newState) => {
        if (newState.status === "disconnected") {
            console.log("Disconnected!");
        }
    });
});

distube.on('error', (channel, error) => {
    console.error('DisTube error:', channel, error);
});

const mongoClient = new MongoClient(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

async function connectToMongoDB() {
  try {
    await mongoClient.connect();
    console.log("Connected to MongoDB");
  } catch (error) {
    console.error("Error connecting to MongoDB", error);
  }
}

connectToMongoDB();

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}!`);
  registerCommands();
});

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
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("username")
      .setDescription("The username of the user to set the theme song for")
      .setRequired(false),
  ); // make this optional as it's only for server managers

async function registerCommands() {
  try {
    const rest = new REST({ version: "9" }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: [setThemeCommand.toJSON()],
    });
    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error(error);
  }
}

async function setMemberThemeSong(userId, url, duration, username) {
  try {
    const usersCollection = mongoClient
      .db("theme_songsDB")
      .collection("userData");
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
      .collection("userData");
    const user = await usersCollection.findOne({ _id: userId });
    return user ? user.theme_song : null;
  } catch (error) {
    console.error("Error getting theme song:", error);
    return null;
  }
}

async function playThemeSong(channel, url, duration = 10, username) {
    if (url.includes("soundcloud.com")) {
        try {
            const queue = await distube.play(channel, url, {
              textChannel: channel,
              member: channel.members.get(username),
            });
        
            // Setting the timeout to stop the music after specified 'duration'
            setTimeout(() => {
              distube.stop(channel.guild.id);
            }, duration * 1000);
        
          } catch (error) {
            console.error("Error playing theme song:", error);
          }
    
    } else if (url.includes("youtube.com") || url.includes("youtu.be")) {
        try {
            const stream = ytdl(url, { quality: "highestaudio" });
            const resource = createAudioResource(stream);
            const player = createAudioPlayer();
            const connection = joinVoiceChannel({
              channelId: channel.id,
              guildId: channel.guild.id,
              adapterCreator: channel.guild.voiceAdapterCreator,
            });
            connection.subscribe(player);
            player.play(resource);
        
            setTimeout(() => {
              player.stop(); // Stops playing after the specified duration (in seconds)
              connection.destroy(); // Optionally destroy the connection immediately after stopping the player
            }, duration * 1000);
        
            player.on(AudioPlayerStatus.Idle, () => {
              connection.destroy(); // Additional cleanup role in case something else causes the player to stop
            });
        
            connection.on("error", (error) => {
              console.error("Error in Voice Connection: ", error);
            });
          } catch (error) {
            console.error("Error playing theme song:", error);
          }        
    }
}

distube.on('playSong', (queue, song) => {
    queue.textChannel.send(`Playing ${song.name}`);
});
  
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
    // console.log("MMM ", member);
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

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand() || interaction.commandName !== "set-theme")
    return;

  const url = interaction.options.getString("url");
  const duration = interaction.options.getInteger("duration");
  const username = interaction.options.getString("username");
  let userId = interaction.user.id;

  try {
    // Fetch all members
    const members = await interaction.guild.members.fetch();
    userId = retrieveUserIdByUsername(members, username);
    console.log("User ID:", userId);

    if (userId) {
      // If userId is already found, use it
      await setMemberThemeSong(userId, url, duration, username);
      await interaction.reply({
        content: `Theme song set for ${username || interaction.user.username}.`,
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
          content: `Theme song set for ${username || interaction.user.username}.`,
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
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  if (oldState.channelId === newState.channelId || !newState.channelId) {
    return; // No change in state or user left a channel
  }

  const member = newState.member;
  const themeSongData = await getMemberThemeSong(member.id);
  if (themeSongData) {
    const { url, duration, username } = themeSongData;
    const channel = newState.guild.channels.cache.get(newState.channelId);
    if (channel) {
      playThemeSong(channel, url, duration, username);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
