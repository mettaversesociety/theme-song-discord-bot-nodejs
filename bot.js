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
const { DisTube } = require("distube");
const { SoundCloudPlugin } = require("@distube/soundcloud");
const distube = new DisTube(client, {
  plugins: [new SoundCloudPlugin()],
});
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
      .setRequired(true)
  )
  .addIntegerOption((option) =>
    option
      .setName("duration")
      .setDescription("The duration of the theme song")
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName("username")
      .setDescription("The username of the user to set the theme song for")
      .setRequired(false)
  );

async function registerCommands() {
  try {
    const rest = new REST({ version: "9" }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      {
        body: [setThemeCommand.toJSON()],
      }
    );
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
      { upsert: true }
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

async function playThemeSong(channel, url, duration, username) {
  try {
    if (url.includes("soundcloud.com")) {
        const scPlugin = new SoundCloudPlugin();
        const song = await scPlugin.search(url, "track", 1);
        const stream = await song[0].stream;
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
            player.stop();
            connection.destroy();
        }, duration * 1000);
        player.on(AudioPlayerStatus.Idle, () => {
            connection.destroy();
        });
        connection.on("error", (error) => {
            console.error("Error in Voice Connection: ", error);
        });
    } else if (url.includes("youtube.com") || url.includes("youtu.be")) {
        const info = await ytdl.getInfo(url);
      const stream = ytdl.downloadFromInfo(info, {
        filter: "audioonly",
      });
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
    }
  } catch (error) {
    console.error("Error playing theme song:", error);
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;

  if (interaction.commandName === "set-theme") {
    const url = interaction.options.getString("url");
    const duration = interaction.options.getInteger("duration");
    const username = interaction.options.getString("username");
    const userId = interaction.user.id;

    await setMemberThemeSong(userId, url, duration, username);
    await interaction.reply(`Theme song set for ${username}!`);
  }
});

client.login(process.env.DISCORD_TOKEN);
