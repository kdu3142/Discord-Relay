import { Client, GatewayIntentBits, Events } from 'discord.js';
import config from './config.js';
import logger from './logger.js';
import { isBotCalled, isGuildAllowed } from './filters.js';
import { formatMessageEvent } from './payload.js';
import { sendToN8n } from './relay.js';
import { startWebUI as startConfigWebUI } from './webui.js';

// Create Discord client with required intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Client ready event
client.once(Events.ClientReady, (readyClient) => {
  logger.info('Discord bot is ready!', {
    botTag: readyClient.user.tag,
    botId: readyClient.user.id,
    guilds: readyClient.guilds.cache.size,
  });
});

// Message create event handler
client.on(Events.MessageCreate, async (message) => {
  try {
    // Skip if not in a guild (DMs not supported in this version)
    if (!message.guild) {
      return;
    }

    // Check if guild is allowed (if restriction is configured)
    if (!isGuildAllowed(message.guild)) {
      logger.debug('Message from disallowed guild, skipping', {
        guildId: message.guild.id,
        guildName: message.guild.name,
      });
      return;
    }

    // Check if bot was called
    const { called, rule, cleanContent } = isBotCalled(message, client);

    if (!called) {
      return; // Bot was not called, ignore message
    }

    logger.info('Bot was called', {
      messageId: message.id,
      channelId: message.channel.id,
      channelName: message.channel.name,
      guildId: message.guild.id,
      guildName: message.guild.name,
      authorId: message.author.id,
      authorUsername: message.author.username,
      rule,
      cleanContent,
    });

    // Format the payload
    const payload = formatMessageEvent(message, 'message_create', rule);

    // Send to n8n
    const result = await sendToN8n(payload);

    if (!result.success) {
      logger.error('Failed to relay message to n8n', {
        messageId: message.id,
        error: result.error,
        status: result.status,
      });
    }
  } catch (error) {
    logger.error('Error processing message', {
      error: error.message,
      stack: error.stack,
      messageId: message.id,
    });
  }
});

// Error handling
client.on(Events.Error, (error) => {
  logger.error('Discord client error', {
    error: error.message,
    stack: error.stack,
  });
});

client.on(Events.Warn, (warning) => {
  logger.warn('Discord client warning', { warning });
});

// Handle process signals for graceful shutdown
const shutdown = async (signal) => {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  
  try {
    client.destroy();
    logger.info('Discord client destroyed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { error: error.message });
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle unhandled rejections
process.on('unhandledRejection', (error) => {
  logger.error('Unhandled promise rejection', {
    error: error.message,
    stack: error.stack,
  });
});

// Check if web UI should be started
const enableWebUI = process.env.START_WEBUI === 'true' || process.env.START_WEBUI === '1';

if (enableWebUI) {
  logger.info('Starting configuration Web UI...');
  startConfigWebUI();
}

// Start the bot (only if token is configured)
if (config.discord.token && 
    config.discord.token !== 'your_discord_bot_token_here' &&
    config.discord.token.trim() !== '') {
  logger.info('Starting Discord relay bot...');
  client.login(config.discord.token).catch((error) => {
    logger.error('Failed to login to Discord', {
      error: error.message,
      stack: error.stack,
    });
    // Don't exit if web UI is enabled - allow user to fix config
    if (!enableWebUI) {
      process.exit(1);
    }
  });
} else {
  if (enableWebUI) {
    logger.warn('Discord bot token not configured. Please configure via web UI at http://localhost:' + (process.env.WEBUI_PORT || 3001));
  } else {
    logger.error('Discord bot token not configured. Please set DISCORD_TOKEN in config.env file or enable web UI.');
    process.exit(1);
  }
}
